import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData, verifyTypedData, type TypedDataDefinition, type Hex } from 'viem';
import { x402Client } from '@x402/core/client';
import {
  encodePaymentRequiredHeader, decodePaymentRequiredHeader,
  encodePaymentSignatureHeader, decodePaymentSignatureHeader,
  encodePaymentResponseHeader, decodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ExactEvmScheme as ClientScheme } from '@x402/evm/exact/client';
import { ExactEvmScheme as ServerScheme } from '@x402/evm/exact/server';
import { ExactEvmScheme as FacilitatorScheme } from '@x402/evm/exact/facilitator';
import type { ClientEvmSigner, FacilitatorEvmSigner } from '@x402/evm';
import { ASSET, NETWORK, Core, Journal, type Binding } from './core.js';
import { amount, type Config } from './config.js';

export type Agent = 'A' | 'B';
type Auth = { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex };
type Signed = { authorization: Auth; signature: Hex };
const payTo = '0x0000000000000000000000000000000000000001';
const authorizationTypes = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] } as const;

export function typedPayload(p: PaymentPayload): TypedDataDefinition {
  const a = (p.payload as Signed).authorization;
  return {
    domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: ASSET },
    types: authorizationTypes, primaryType: 'TransferWithAuthorization',
    message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
  };
}
export function payloadMatches(b: Binding, p: PaymentPayload): boolean {
  try {
    const a = (p.payload as Signed).authorization;
    return p.x402Version === 2 && p.accepted.scheme === 'exact' && p.accepted.network === b.network &&
      p.accepted.asset.toLowerCase() === b.asset && p.accepted.payTo.toLowerCase() === b.payTo &&
      p.accepted.amount === b.amount && a.nonce === b.id && a.value === b.amount &&
      a.to.toLowerCase() === b.payTo && hashTypedData(typedPayload(p)) === b.digest;
  } catch { return false; }
}

interface LedgerEntry {
  binding: Binding; payload: PaymentPayload; status: 'pending' | 'paid' | 'disabled';
  accepted: boolean; completion?: Promise<void>; result?: SettleResponse;
}

// A closed-world local ledger. There is no RPC URL, live key, or chain writer.
// "disabled" is final ONLY in this simulator; it is not an on-chain claim.
export class LocalService {
  readonly ledger = new Map<string, LedgerEntry>();
  readonly quotes = new Map<Agent, PaymentRequirements>();
  readonly verifier: FacilitatorScheme;
  readonly server: Server;
  url = '';
  delivered = 0;
  constructor(readonly config: Config, readonly journal: Journal, readonly serviceFails = false) {
    const noChain = async (): Promise<never> => { throw new Error('Live chain operations disabled'); };
    const signer: FacilitatorEvmSigner = {
      getAddresses: () => [payTo],
      getCode: async ({ address }) => address.toLowerCase() === ASSET ? '0x01' : undefined,
      readContract: async ({ functionName }) => {
        // SDK eth_call preflight: simulated success, not a real contract execution.
        if (functionName === 'transferWithAuthorization') return undefined;
        throw new Error(`Unexpected SDK read: ${functionName}`);
      },
      verifyTypedData: async args => verifyTypedData(args as Parameters<typeof verifyTypedData>[0]),
      writeContract: noChain, sendTransaction: noChain, waitForTransactionReceipt: noChain,
    };
    this.verifier = new FacilitatorScheme(signer);
    this.server = createServer((req, res) => {
      void (async () => {
        const agent = req.url?.split('/').at(-1) as Agent;
        const requirements = this.quotes.get(agent);
        if (req.method !== 'GET' || !requirements || req.url !== `/service/${agent}`) { res.writeHead(404).end(); return; }
        const header = req.headers['payment-signature'];
        if (typeof header !== 'string') {
          const required: PaymentRequired = {
            x402Version: 2, resource: { url: `${this.url}/service/${agent}`, description: 'Local research result', mimeType: 'application/json' },
            accepts: [requirements],
          };
          res.writeHead(402, { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required), 'Content-Type': 'application/json' });
          res.end(JSON.stringify(required)); return;
        }
        const payload = decodePaymentSignatureHeader(header);
        const nonce = (payload.payload as Signed).authorization?.nonce;
        const entry = this.ledger.get(nonce);
        if (!entry || !payloadMatches(entry.binding, payload)) { res.writeHead(409).end('unregistered or conflicting payment'); return; }
        const verification = await this.verifier.verify(payload, requirements);
        this.journal.add({ kind: 'sdk.verify', paymentId: nonce, verification, chainReads: 'simulated' });
        if (!verification.isValid) { res.writeHead(402).end(JSON.stringify(verification)); return; }
        if (entry.status === 'disabled') { res.writeHead(409).end('permanently disabled in simulator'); return; }
        if (!entry.completion) {
          entry.accepted = true;
          entry.completion = sleep(this.config.paymentResultDelayMs).then(() => {
            if (entry.status !== 'pending') return;
            entry.status = 'paid';
            entry.result = { success: true, network: NETWORK, transaction: `sim:${nonce}`, payer: (payload.payload as Signed).authorization.from };
            this.journal.add({ kind: 'simulator.settlement', paymentId: nonce, result: entry.result });
          });
        }
        await entry.completion;
        if (entry.status !== 'paid' || !entry.result) { res.writeHead(409).end('disabled before settlement'); return; }
        this.delivered++;
        const result = { agent, result: this.serviceFails ? null : `deterministic research result from Agent ${agent}`, serviceStatus: this.serviceFails ? 'failed' : 'delivered' };
        this.journal.add({ kind: 'service.result', paymentId: nonce, ...result });
        res.writeHead(this.serviceFails ? 500 : 200, {
          'PAYMENT-RESPONSE': encodePaymentResponseHeader(entry.result), 'Content-Type': 'application/json',
        });
        res.end(JSON.stringify(result));
      })().catch(error => {
        this.journal.add({ kind: 'service.error', error: String(error) });
        if (!res.headersSent) res.writeHead(400);
        res.end('invalid payment request');
      });
    });
  }
  async start() {
    const scheme = new ServerScheme();
    for (const agent of ['A', 'B'] as const) {
      const parsed = await scheme.parsePrice({ amount: amount(this.config.quotes[agent]), asset: ASSET, extra: { name: 'USDC', version: '2' } }, NETWORK);
      const q = await scheme.enhancePaymentRequirements({
        scheme: 'exact', network: NETWORK, asset: parsed.asset, amount: parsed.amount,
        payTo, maxTimeoutSeconds: this.config.authorizationValiditySeconds,
        extra: { ...parsed.extra, assetTransferMethod: 'eip3009' },
      }, { x402Version: 2, scheme: 'exact', network: NETWORK }, []);
      this.quotes.set(agent, q);
    }
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') throw new Error('No local listener');
    this.url = `http://127.0.0.1:${addr.port}`;
  }
  register(binding: Binding, payload: PaymentPayload) {
    if (!payloadMatches(binding, payload)) throw new Error('signed_payload_binding_mismatch');
    const old = this.ledger.get(binding.id);
    if (old) { if (JSON.stringify(old.payload) !== JSON.stringify(payload)) throw new Error('conflicting retry'); return; }
    this.ledger.set(binding.id, { binding, payload, status: 'pending', accepted: false });
  }
  disable(id: string): boolean {
    const e = this.ledger.get(id);
    if (!e || e.status === 'paid') return false;
    e.status = 'disabled';
    this.journal.add({ kind: 'simulator.finalNonpayment', paymentId: id, neverPaid: true, futurePaymentDisabled: true });
    return true;
  }
  async drain() { await Promise.all([...this.ledger.values()].map(e => e.completion)); }
  async close() {
    await this.drain();
    this.server.closeAllConnections();
    if (this.server.listening) await new Promise<void>(r => this.server.close(() => r()));
  }
}

export interface Purchase { binding?: Binding; payload?: PaymentPayload; status: string; serviceResult?: unknown }
export class AgentAdapter {
  // Ephemeral, unexported account per agent: no credentials, funding or RPC.
  private account = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  constructor(readonly agent: Agent, readonly core: Core, readonly service: LocalService, readonly config: Config) {}
  async purchase(options: { releaseDuringSigning?: boolean } = {}): Promise<Purchase> {
    let binding: Binding | undefined;
    let payload: PaymentPayload | undefined;
    try {
      const quoteResponse = await fetch(`${this.service.url}/service/${this.agent}`);
      if (quoteResponse.status !== 402) throw new Error('expected_HTTP_402');
      const required = decodePaymentRequiredHeader(quoteResponse.headers.get('payment-required')!);
      await quoteResponse.arrayBuffer();
      const q = required.accepts[0];
      if (!q || q.scheme !== 'exact' || q.network !== NETWORK || q.asset.toLowerCase() !== ASSET || q.amount !== amount(this.config.agents[this.agent]) || q.payTo.toLowerCase() !== payTo) {
        throw new Error('quote_does_not_match_agent_request');
      }
      this.core.journal.add({ kind: 'sdk.quote', agent: this.agent, required });
      const signer: ClientEvmSigner = {
        address: this.account.address,
        signTypedData: async args => {
          const typed = args as TypedDataDefinition;
          binding = {
            id: String(args.message.nonce), agent: this.agent, amount: q.amount,
            network: NETWORK, asset: ASSET, payTo, digest: hashTypedData(typed),
          };
          const now = Date.now();
          const r = await this.core.send({ op: 'reserve', binding, now: String(now), expiresAt: String(now + this.config.reservationTtlMs) });
          if (!r.allowed) throw new Error(r.reason);
          if (options.releaseDuringSigning) await this.core.apply('release', binding);
          await sleep(this.config.signingDelayMs);
          return this.account.signTypedData(typed);
        },
      };
      // SDK 2.28.0 defaults to a $1 per-payment cap. Set this asset's cap from
      // the requested atomic amount; shared-budget approval still belongs to Lean.
      const client = new x402Client()
        .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: ASSET, maxAmountPerPayment: q.amount }] })
        .register(NETWORK, new ClientScheme(signer));
      payload = await client.createPaymentPayload(required);
      if (!binding || !payloadMatches(binding, payload)) throw new Error('signed_payload_binding_mismatch');
      const handoff = await this.core.apply('handoff', binding);
      if (!handoff.allowed) {
        await this.core.apply('release', binding);
        throw new Error(handoff.reason);
      }
      this.service.register(binding, payload);
      return await this.send(binding, payload);
    } catch (e) {
      this.core.journal.add({ kind: 'agent.rejected', agent: this.agent, reason: String(e) });
      // A prepared signature never leaves this object on a denied handoff.
      return { binding, status: String(e) };
    }
  }
  async send(binding: Binding, payload: PaymentPayload): Promise<Purchase> {
    // Every send/retry consults the same core and requires existing InFlight.
    const current = await this.core.send({ op: 'inspect' });
    const e = current.state?.entries.find(e => e.binding.id === binding.id);
    if (e?.phase !== 'InFlight' || !isDeepStrictEqual(e.binding, binding) || !payloadMatches(binding, payload)) {
      return { binding, status: 'authorization_not_inflight' };
    }
    this.core.journal.add({ kind: 'authorization.handoff', paymentId: binding.id, digest: binding.digest });
    try {
      const response = await fetch(`${this.service.url}/service/${this.agent}`, {
        headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload) },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      const serviceResult: unknown = await response.json();
      const header = response.headers.get('payment-response');
      if (header) {
        const result = decodePaymentResponseHeader(header);
        this.core.journal.add({ kind: 'sdk.response', paymentId: binding.id, result });
        // In local mode the closed-world ledger corroborates even HTTP failures.
        await this.reconcile(binding);
      } else await this.core.apply('unknown', binding);
      return { binding, payload, status: response.ok ? 'delivered' : 'service_failed', serviceResult };
    } catch (error) {
      this.core.journal.add({ kind: 'transport.unknown', paymentId: binding.id, error: String(error) });
      await this.core.apply('unknown', binding);
      return { binding, payload, status: 'pending_confirmation' };
    }
  }
  async reconcile(binding: Binding, queryFails = false) {
    const e = this.service.ledger.get(binding.id);
    if (queryFails || !e || e.status === 'pending') {
      this.core.journal.add({ kind: 'query.unknown', paymentId: binding.id, queryFails });
      return this.core.apply('unknown', binding);
    }
    if (e.status === 'disabled') return this.core.apply('unpaidFinal', binding, { evidence: 'simulator:never-paid-and-disabled' });
    return this.core.apply('paid', e.binding);
  }
}
