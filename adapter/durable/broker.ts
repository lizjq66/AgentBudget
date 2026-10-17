import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData, type Hex, type TypedDataDefinition } from 'viem';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { ASSET, NETWORK, type Binding } from '../core.js';
import { amount, type Config } from '../config.js';
import { payloadMatches, type Agent } from '../x402.js';
import { Store, noFault, type Fault } from './store.js';
import { DurableCore } from './core.js';
import { fingerprint, verifyEvidence, type Evidence } from './evidence.js';
import { RECIPIENT } from './authority.js';
import { body, identifier, json, matchesToken } from './http.js';

export interface AuthorityConnection { url: string; publicKey: string; token: string }
interface Job { requestId: string; agent: Agent; binding: Binding; payload?: PaymentPayload }

export class Broker {
  private store: Store;
  private core: DurableCore;
  private account;
  private tokens: Record<Agent, string>;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private server = createServer((req, res) => {
    void (async () => {
      const agent = (['A', 'B'] as const).find(a => matchesToken(req.headers.authorization, this.tokens[a]));
      if (!agent) return json(res, 403, { error: 'agent capability required' });
      if (req.method === 'GET' && req.url === '/status') return json(res, 200, await this.serial(() => this.status()));
      if (req.method !== 'POST' || !['/purchase', '/reconcile'].includes(req.url ?? '')) return json(res, 403, { error: 'operation not granted to agents' });
      const input = await body(req);
      if (Object.keys(input).some(key => key !== 'requestId')) throw new Error('agents may only provide requestId');
      const requestId = identifier(input.requestId);
      const result = await this.serial(async () => {
        if (req.url === '/purchase') return this.purchase(agent, requestId);
        const job = this.store.get<Job>('jobs', `${agent}:${requestId}`);
        if (!job) throw new Error('unknown requestId for this agent');
        await this.reconcile(job);
        return this.summary(job);
      });
      json(res, 200, result);
    })().catch(error => { if (!res.headersSent) json(res, 400, { error: String(error) }); else res.end(); });
  });
  constructor(directory: string, private taskId: string, private config: Config, private authority: AuthorityConnection, private fault: Fault = noFault) {
    const u = new URL(authority.url);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.pathname !== '/') throw new Error('local simulator endpoint required');
    this.store = new Store(directory);
    const identity = { schema: 1, taskId, config, authority: fingerprint(authority.publicKey) };
    const old = this.store.get('meta', 'identity');
    if (old && !isDeepStrictEqual(old, identity)) { this.store.close(); throw new Error('configuration or pinned authority changed; migration required'); }
    this.store.put('meta', 'identity', identity);
    let key = this.store.get<Hex>('meta', 'wallet-key');
    if (!key) { key = `0x${randomBytes(32).toString('hex')}`; this.store.put('meta', 'wallet-key', key); }
    this.account = privateKeyToAccount(key);
    this.tokens = this.store.get('meta', 'agent-capabilities') ?? { A: randomBytes(32).toString('hex'), B: randomBytes(32).toString('hex') };
    this.store.put('meta', 'agent-capabilities', this.tokens);
    this.core = new DurableCore(this.store, fault);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('broker closing'));
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async start() {
    await this.core.restore(amount(this.config.total));
    // Recovery is complete before the agent listener exists.
    await this.recover();
    await new Promise<void>((r, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', r); });
    const a = this.server.address();
    if (!a || typeof a === 'string') throw new Error('no broker listener');
    return { url: `http://127.0.0.1:${a.port}`, tokens: this.tokens, walletAddress: this.account.address };
  }
  private async status() { return (await this.core.send({ op: 'inspect' })).state!; }
  private async entry(job: Job) { return (await this.status()).entries.find(e => e.binding.id === job.binding.id); }
  private async summary(job: Job) {
    const state = await this.status();
    return { requestId: job.requestId, agent: job.agent, paymentId: job.binding.id,
      service: this.store.get('meta', `service:${job.binding.id}`) ?? null,
      queryError: this.store.get('meta', `query-error:${job.binding.id}`) ?? null,
      phase: state.entries.find(e => e.binding.id === job.binding.id)?.phase ?? 'NotReserved', state };
  }
  private async apply(op: string, job: Job, extra: Record<string, unknown> = {}) {
    return this.core.send({ op, binding: job.binding, now: String(Date.now()), ...extra });
  }
  private validQuote(q: PaymentRequirements, agent: Agent) {
    return q?.scheme === 'exact' && q.network === NETWORK && q.asset.toLowerCase() === ASSET &&
      q.amount === amount(this.config.agents[agent]) && q.payTo.toLowerCase() === RECIPIENT &&
      q.extra?.name === 'USDC' && q.extra?.version === '2' && q.extra?.assetTransferMethod === 'eip3009' &&
      q.maxTimeoutSeconds === this.config.authorizationValiditySeconds;
  }
  private async purchase(agent: Agent, requestId: string) {
    const key = `${agent}:${requestId}`;
    const existing = this.store.get<Job>('jobs', key);
    if (existing) { await this.resume(existing); return this.summary(existing); }
    const response = await fetch(`${this.authority.url}/service/${agent}`, { method: 'POST', signal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    if (response.status !== 402) throw new Error('expected 402 quote');
    const required = decodePaymentRequiredHeader(response.headers.get('payment-required')!);
    await response.arrayBuffer();
    const q = required.accepts[0];
    if (required.x402Version !== 2 || required.accepts.length !== 1 || !this.validQuote(q, agent) || required.extensions) throw new Error('unsupported or conflicting quote');
    let job: Job | undefined;
    const scheme = new ExactEvmScheme({
      address: this.account.address,
      signTypedData: async args => {
        const typed = args as TypedDataDefinition;
        job = { requestId, agent, binding: { id: String(args.message.nonce), agent, amount: q.amount, network: NETWORK, asset: ASSET, payTo: RECIPIENT, digest: hashTypedData(typed) } };
        this.store.put('jobs', key, job);
        this.fault('wallet:planned');
        const now = Date.now();
        const reserved = await this.core.send({ op: 'reserve', binding: job.binding, now: String(now), expiresAt: String(now + this.config.reservationTtlMs) });
        if (!reserved.allowed) throw new Error(reserved.reason);
        await sleep(this.config.signingDelayMs);
        return this.account.signTypedData(typed);
      },
    });
    const client = new x402Client().setSpendControls({ allowedAssets: [{ network: NETWORK, asset: ASSET, maxAmountPerPayment: q.amount }] }).register(NETWORK, scheme);
    const payload = await client.createPaymentPayload(required);
    if (!job || !payloadMatches(job.binding, payload)) throw new Error('signed binding mismatch');
    job.payload = payload;
    this.store.put('jobs', key, job); // durable outbox, inaccessible to agent HTTP clients
    this.fault('wallet:signed');
    const handoff = await this.apply('handoff', job);
    if (!handoff.allowed) { await this.apply('release', job); return this.summary(job); }
    await this.transmit(job);
    await this.reconcile(job);
    return this.summary(job);
  }
  private async transmit(job: Job) {
    if ((await this.entry(job))?.phase !== 'InFlight') return;
    if (!job.payload || !payloadMatches(job.binding, job.payload)) throw new Error('missing or inconsistent outbox; retained pending');
    this.fault('wallet:before-send');
    try {
      const response = await fetch(`${this.authority.url}/service/${job.agent}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(job.payload) },
        body: JSON.stringify({ taskId: this.taskId, binding: job.binding }), signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      // HTTP success/failure is never accepted as accounting evidence.
      const serviceResult = await response.json();
      this.store.put('meta', `service:${job.binding.id}`, { status: response.status, result: serviceResult });
    } catch { /* timeout, malformed response and network failure all remain unknown */ }
    this.fault('wallet:after-send');
  }
  private async reconcile(job: Job, disable = false): Promise<boolean> {
    if ((await this.entry(job))?.phase !== 'InFlight') return true;
    const challenge = randomBytes(32).toString('hex');
    let verified;
    try {
      const response = await fetch(`${this.authority.url}/${disable ? 'disable' : 'evidence'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.authority.token}` },
        body: JSON.stringify({ taskId: this.taskId, binding: job.binding, challenge }), signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      if (!response.ok) throw new Error('authority query failed');
      const evidence = await response.json() as Evidence;
      verified = verifyEvidence(evidence, this.authority.publicKey, this.taskId, job.binding, challenge);
      this.store.put('meta', `evidence:${job.binding.id}`, evidence);
      this.store.put('meta', `query-error:${job.binding.id}`, null);
    } catch (error) {
      this.store.put('meta', `query-error:${job.binding.id}`, { error: String(error) });
      await this.apply('unknown', job);
      return false;
    }
    this.fault('evidence:verified');
    if (verified.status === 'paid') await this.apply('paid', job);
    else if (verified.status === 'disabled') await this.apply('unpaidFinal', job, { evidence: 'simulator:never-paid-and-disabled' });
    else { await this.apply('unknown', job); return false; }
    return true;
  }
  private async resume(job: Job) {
    const entry = await this.entry(job);
    if (!entry) return; // planned but never reserved: no authorization could leave
    if (!isDeepStrictEqual(entry.binding, job.binding)) throw new Error('recovery binding mismatch');
    if (entry.phase === 'Reserved') { await this.apply('release', job); return; }
    if (entry.phase !== 'InFlight') return;
    if (await this.reconcile(job)) return;
    // Re-send ONLY the durable original signature/nonce, never create another.
    await this.transmit(job);
    await this.reconcile(job);
  }
  private async recover() {
    const jobs = this.store.all<Job>('jobs');
    const state = await this.status();
    for (const entry of state.entries) {
      if (!jobs.some(j => isDeepStrictEqual(j.binding, entry.binding))) throw new Error('durable history has no matching job; fail closed');
    }
    for (const job of jobs) await this.resume(job);
  }
  // Private parent IPC is the operator interface. Never exposed on agent HTTP.
  admin(op: string, args: Record<string, unknown> = {}) {
    return this.serial(async () => {
      if (op === 'recover') { await this.recover(); return this.status(); }
      if (op === 'cancel') return this.core.send({ op: 'cancel' });
      if (op === 'disable') {
        const agent = args.agent;
        if (agent !== 'A' && agent !== 'B') throw new Error('invalid agent');
        const job = this.store.get<Job>('jobs', `${agent}:${identifier(args.requestId)}`);
        if (!job) throw new Error('unknown job');
        await this.reconcile(job, true);
        return this.summary(job);
      }
      throw new Error('unknown operator command');
    });
  }
  async close() {
    this.closing = true;
    this.server.closeAllConnections();
    if (this.server.listening) await new Promise<void>(r => this.server.close(() => r()));
    await this.queue;
    await this.core.close();
    this.store.close();
  }
}
