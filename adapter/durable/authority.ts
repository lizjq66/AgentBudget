import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { verifyTypedData } from 'viem';
import { ExactEvmScheme as Verifier } from '@x402/evm/exact/facilitator';
import { ExactEvmScheme as QuoteScheme } from '@x402/evm/exact/server';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ASSET, NETWORK, type Binding } from '../core.js';
import { amount, type Config } from '../config.js';
import { payloadMatches, type Agent } from '../x402.js';
import { Store, noFault, type Fault } from './store.js';
import { attest, keyPair, type EvidenceBody } from './evidence.js';
import { body, json, matchesToken } from './http.js';

export const RECIPIENT = '0x0000000000000000000000000000000000000001';
interface Payment { taskId: string; binding: Binding; status: 'pending' | 'paid' | 'disabled'; dueAt: number | null; payload?: PaymentPayload }

export class Authority {
  private store: Store;
  private keys: ReturnType<typeof keyPair>;
  private token: string;
  private quotes = new Map<Agent, PaymentRequirements>();
  private active = new Set<Promise<void>>();
  private verifier = new Verifier({
    getAddresses: () => [RECIPIENT],
    getCode: async ({ address }) => address.toLowerCase() === ASSET ? '0x01' : undefined,
    readContract: async ({ functionName }) => {
      if (functionName !== 'transferWithAuthorization') throw new Error('unsupported simulated contract read');
      return undefined;
    },
    verifyTypedData: async args => verifyTypedData(args as Parameters<typeof verifyTypedData>[0]),
    writeContract: async () => { throw new Error('chain disabled'); },
    sendTransaction: async () => { throw new Error('chain disabled'); },
    waitForTransactionReceipt: async () => { throw new Error('chain disabled'); },
  });
  url = '';
  private server = createServer((req, res) => {
    const work = (async () => {
      const agent = req.url?.split('/').at(-1) as Agent;
      if (req.method === 'POST' && req.url === `/service/${agent}` && this.quotes.has(agent)) {
        const q = this.quotes.get(agent)!;
        const header = req.headers['payment-signature'];
        if (typeof header !== 'string') {
          const quote: PaymentRequired = { x402Version: 2, resource: { url: `${this.url}/service/${agent}`, description: 'Durable local service', mimeType: 'application/json' }, accepts: [q] };
          return json(res, 402, quote, { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(quote) });
        }
        const input = await body(req);
        const binding = input.binding as Binding;
        const payload = decodePaymentSignatureHeader(header);
        if (input.taskId !== this.taskId || binding?.agent !== agent || !payloadMatches(binding, payload)) throw new Error('payment context mismatch');
        // A terminal ledger result remains queryable/retryable after authorization expiry.
        let p = this.lookup(binding);
        if (!p || p.status === 'pending') {
          const verified = await this.verifier.verify(payload, q);
          if (!verified.isValid) return json(res, 402, verified);
          // Re-read after await: a concurrent disable may have committed meanwhile.
          p = this.lookup(binding);
          if (!p) {
            p = { taskId: this.taskId, binding, payload, status: 'pending', dueAt: Date.now() + this.config.paymentResultDelayMs };
            this.store.put('payments', binding.id, p);
            this.fault('authority:accepted');
          }
        }
        if (p.status === 'pending') {
          await sleep(Math.max(0, p.dueAt! - Date.now()));
          p = this.lookup(binding)!;
        }
        if (p.status === 'disabled') return json(res, 409, { error: 'authorization permanently disabled' });
        this.fault('authority:paid');
        return json(res, 200, { result: `durable result for ${agent}`, payment: 'paid' }, {
          'PAYMENT-RESPONSE': encodePaymentResponseHeader({ success: true, network: NETWORK, transaction: `sim:${binding.id}` }),
        });
      }
      if (req.method !== 'POST' || !['/evidence', '/disable'].includes(req.url ?? '')) return json(res, 404, { error: 'not found' });
      if (!matchesToken(req.headers.authorization, this.token)) return json(res, 403, { error: 'authority capability required' });
      const input = await body(req);
      const b = input.binding as Binding;
      if (input.taskId !== this.taskId || !b?.id || typeof input.challenge !== 'string' || !/^[0-9a-f]{64}$/.test(input.challenge)) throw new Error('invalid evidence request');
      let p = this.lookup(b);
      if (req.url === '/disable' && p?.status !== 'paid') {
        // Tombstones are persisted even if the original HTTP request never arrived.
        // Any later request with this nonce is now rejected, including after restart.
        p = { taskId: this.taskId, binding: b, status: 'disabled', dueAt: null };
        this.store.put('payments', b.id, p);
        this.fault('authority:disabled');
      }
      const result: EvidenceBody = {
        version: 'agentbudget.simulator-evidence.v1', taskId: this.taskId, binding: b,
        challenge: input.challenge, status: p?.status ?? 'unknown',
        transaction: p?.status === 'paid' ? `sim:${b.id}` : null,
      };
      json(res, 200, attest(result, this.keys.privateKey));
    })().catch(error => { if (!res.headersSent) json(res, 400, { error: String(error) }); else res.end(); });
    this.active.add(work);
    void work.finally(() => this.active.delete(work));
  });
  constructor(directory: string, private taskId: string, private config: Config, private fault: Fault = noFault) {
    this.store = new Store(directory);
    const identity = { schema: 1, taskId, config };
    const old = this.store.get('meta', 'identity');
    if (old && !isDeepStrictEqual(old, identity)) { this.store.close(); throw new Error('authority configuration changed'); }
    this.store.put('meta', 'identity', identity);
    this.keys = this.store.get('meta', 'keys') ?? keyPair();
    this.token = this.store.get('meta', 'token') ?? randomBytes(32).toString('hex');
    this.store.put('meta', 'keys', this.keys);
    this.store.put('meta', 'token', this.token);
  }
  private lookup(binding: Binding): Payment | undefined {
    const p = this.store.get<Payment>('payments', binding.id);
    if (!p) return undefined;
    if (p.taskId !== this.taskId || !isDeepStrictEqual(p.binding, binding)) throw new Error('conflicting payment identity');
    // Persisted simulated due time survives authority restart. No chain finality claim.
    if (p.status === 'pending' && p.dueAt !== null && p.dueAt <= Date.now()) {
      p.status = 'paid';
      this.store.put('payments', binding.id, p);
    }
    return p;
  }
  async start() {
    const scheme = new QuoteScheme();
    for (const agent of ['A', 'B'] as const) {
      const parsed = await scheme.parsePrice({ amount: amount(this.config.quotes[agent]), asset: ASSET, extra: { name: 'USDC', version: '2' } }, NETWORK);
      this.quotes.set(agent, await scheme.enhancePaymentRequirements({ scheme: 'exact', network: NETWORK, asset: parsed.asset, amount: parsed.amount, payTo: RECIPIENT, maxTimeoutSeconds: this.config.authorizationValiditySeconds, extra: { ...parsed.extra, assetTransferMethod: 'eip3009' } }, { x402Version: 2, scheme: 'exact', network: NETWORK }, []));
    }
    await new Promise<void>((r, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', r); });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('no listener');
    this.url = `http://127.0.0.1:${address.port}`;
    return { url: this.url, publicKey: this.keys.publicKey, token: this.token };
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise<void>(r => this.server.close(() => r()));
    await Promise.all(this.active);
    this.store.close();
  }
}
