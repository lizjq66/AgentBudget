import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { start, agentCall, type BrokerConnection } from '../adapter/durable/process.js';
import type { AuthorityConnection } from '../adapter/durable/broker.js';
import { keyPair, attest, verifyEvidence, type EvidenceBody } from '../adapter/durable/evidence.js';
import { ASSET, NETWORK } from '../adapter/core.js';
import type { Config } from '../adapter/config.js';
import { Store } from '../adapter/durable/store.js';
import { encodePaymentSignatureHeader } from '@x402/core/http';

const config: Config = { total: '0.10', agents: { A: '0.06', B: '0.05' }, quotes: { A: '0.06', B: '0.05' }, reservationTtlMs: 5000, signingDelayMs: 0, requestTimeoutMs: 1000, paymentResultDelayMs: 5, authorizationValiditySeconds: 120 };
const directory = () => mkdtempSync(join(tmpdir(), 'agentbudget-recovery-'));

test('signed evidence rejects forgery, wrong key, stale challenge and conflicting context', () => {
  const k = keyPair();
  const b: EvidenceBody = { version: 'agentbudget.simulator-evidence.v1', taskId: 't', binding: { id: 'nonce', agent: 'A', amount: '60000', network: NETWORK, asset: ASSET, payTo: 'recipient', digest: 'digest' }, challenge: 'fresh', status: 'paid', transaction: 'sim:nonce' };
  const e = attest(b, k.privateKey);
  assert.equal(verifyEvidence(e, k.publicKey, 't', b.binding, 'fresh').status, 'paid');
  assert.throws(() => verifyEvidence(e, keyPair().publicKey, 't', b.binding, 'fresh'));
  assert.throws(() => verifyEvidence(e, k.publicKey, 't', b.binding, 'old'));
  assert.throws(() => verifyEvidence(e, k.publicKey, 'other', b.binding, 'fresh'));
  assert.throws(() => verifyEvidence(e, k.publicKey, 't', { ...b.binding, amount: '1' }, 'fresh'));
  assert.throws(() => verifyEvidence({ ...e, body: { ...b, status: 'disabled' } }, k.publicKey, 't', b.binding, 'fresh'));
});

test('SIGKILL recovery at durable payment boundaries', { timeout: 120000 }, async t => {
  for (const fault of ['wallet:planned', 'reserve:intent', 'reserve:applied', 'reserve:committed', 'wallet:signed', 'handoff:intent', 'handoff:applied', 'handoff:committed', 'wallet:before-send', 'wallet:after-send', 'evidence:verified', 'paid:intent', 'paid:applied', 'paid:committed']) {
    await t.test(fault, async () => {
      const dir = directory();
      const authority = await start<AuthorityConnection>({ role: 'authority', directory: `${dir}/authority`, taskId: 'test', config });
      let broker = await start<BrokerConnection>({ role: 'broker', directory: `${dir}/broker`, taskId: 'test', config, authority: authority.connection, fault });
      try {
        await assert.rejects(agentCall(broker.connection, 'A', '/purchase', 'one'));
        await broker.worker.exited;
        broker = await start<BrokerConnection>({ role: 'broker', directory: `${dir}/broker`, taskId: 'test', config, authority: authority.connection });
        const result = await agentCall(broker.connection, 'A', '/purchase', 'one');
        const beforeHandoff = fault.startsWith('reserve:') || fault === 'wallet:planned' || fault === 'wallet:signed';
        assert.equal(result.phase, fault === 'wallet:planned' ? 'NotReserved' : beforeHandoff ? 'Released' : 'Settled');
        assert.equal(result.state.spent, beforeHandoff ? '0' : '60000');
        const repeated = await agentCall(broker.connection, 'A', '/purchase', 'one');
        assert.equal(repeated.paymentId, result.paymentId);
        assert.deepEqual(repeated.state, result.state);
        if (!beforeHandoff) await assert.rejects(agentCall(broker.connection, 'B', '/purchase', 'two'), /budget/i);
      } finally { await broker.worker.stop(); await authority.worker.stop(); }
    });
  }
});

test('authority crash retains in-flight budget; durable authority restart resolves same payment', { timeout: 15000 }, async () => {
  const dir = directory();
  let authority = await start<AuthorityConnection>({ role: 'authority', directory: `${dir}/authority`, taskId: 'test', config, fault: 'authority:accepted' });
  let broker = await start<BrokerConnection>({ role: 'broker', directory: `${dir}/broker`, taskId: 'test', config, authority: authority.connection });
  try {
    const pending = await agentCall(broker.connection, 'A', '/purchase', 'one');
    assert.equal(pending.phase, 'InFlight');
    await assert.rejects(agentCall(broker.connection, 'B', '/purchase', 'two'));
    await authority.worker.exited;
    await broker.worker.stop();
    const pinned = authority.connection.publicKey;
    authority = await start<AuthorityConnection>({ role: 'authority', directory: `${dir}/authority`, taskId: 'test', config });
    assert.equal(authority.connection.publicKey, pinned);
    broker = await start<BrokerConnection>({ role: 'broker', directory: `${dir}/broker`, taskId: 'test', config, authority: authority.connection });
    const settled = await agentCall(broker.connection, 'A', '/purchase', 'one');
    assert.equal(settled.phase, 'Settled');
    assert.equal(settled.paymentId, pending.paymentId);
    assert.equal(settled.state.spent, '60000');
  } finally { await broker.worker.stop(); await authority.worker.stop(); }
});

test('capabilities, owner lock, configuration pin, cancellation and durable disable', { timeout: 20000 }, async () => {
  const dir = directory();
  const slow = { ...config, paymentResultDelayMs: 3000, requestTimeoutMs: 100 };
  const authority = await start<AuthorityConnection>({ role: 'authority', directory: `${dir}/authority`, taskId: 'test', config: slow });
  let broker = await start<BrokerConnection>({ role: 'broker', directory: `${dir}/broker`, taskId: 'test', config: slow, authority: authority.connection });
  try {
    assert.equal((await fetch(broker.connection.url + '/status')).status, 403);
    for (const path of ['/sign', '/paid', '/cancel', '/disable']) assert.equal((await fetch(broker.connection.url + path, { method: 'POST', headers: { Authorization: `Bearer ${broker.connection.tokens.A}` } })).status, 403);
    assert.equal((await fetch(broker.connection.url + '/purchase', { method: 'POST', headers: { Authorization: `Bearer ${broker.connection.tokens.A}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'bad', agent: 'B' }) })).status, 400);
    await assert.rejects(start({ role: 'broker', directory: `${dir}/broker`, taskId: 'test', config: slow, authority: authority.connection }), /owns/);
    const pending = await agentCall(broker.connection, 'A', '/purchase', 'one');
    assert.equal(pending.phase, 'InFlight');
    await assert.rejects(agentCall(broker.connection, 'B', '/reconcile', 'one'), /unknown/);
    await broker.worker.call('cancel');
    assert.equal((await agentCall(broker.connection, 'A', '/reconcile', 'one')).phase, 'InFlight');
    const released = await broker.worker.call('disable', { args: { agent: 'A', requestId: 'one' } });
    assert.equal(released.phase, 'Released');
    await broker.worker.stop();
    await assert.rejects(start({ role: 'broker', directory: `${dir}/broker`, taskId: 'test', config: { ...slow, total: '1' }, authority: authority.connection }), /configuration/);
    await assert.rejects(start({ role: 'broker', directory: `${dir}/broker`, taskId: 'test', config: slow, authority: { ...authority.connection, publicKey: keyPair().publicKey } }), /pinned/);
    broker = await start<BrokerConnection>({ role: 'broker', directory: `${dir}/broker`, taskId: 'test', config: slow, authority: authority.connection });
    await sleep(slow.paymentResultDelayMs);
    assert.equal((await agentCall(broker.connection, 'A', '/purchase', 'one')).phase, 'Released');
    await assert.rejects(agentCall(broker.connection, 'B', '/purchase', 'two'), /cancel/i);
  } finally { await broker.worker.stop(); await authority.worker.stop(); }
});

test('disabled tombstone survives authority SIGKILL and rejects original signed authorization', { timeout: 15000 }, async () => {
  const dir = directory();
  let authority = await start<AuthorityConnection>({ role: 'authority', directory: `${dir}/authority`, taskId: 'test', config });
  let broker = await start<BrokerConnection>({ role: 'broker', directory: `${dir}/broker`, taskId: 'test', config, authority: authority.connection, fault: 'wallet:before-send' });
  try {
    await assert.rejects(agentCall(broker.connection, 'A', '/purchase', 'one'));
    await broker.worker.exited;
    const store = new Store(`${dir}/broker`);
    const job = store.all<any>('jobs')[0];
    store.close();
    const disabled = await fetch(authority.connection.url + '/disable', { method: 'POST', headers: { Authorization: `Bearer ${authority.connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: 'test', binding: job.binding, challenge: 'a'.repeat(64) }) });
    assert.equal((await disabled.json()).body.status, 'disabled');
    await authority.worker.kill();
    authority = await start<AuthorityConnection>({ role: 'authority', directory: `${dir}/authority`, taskId: 'test', config });
    const late = await fetch(authority.connection.url + '/service/A', { method: 'POST', headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(job.payload), 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: 'test', binding: job.binding }) });
    assert.equal(late.status, 409);
    await late.arrayBuffer();
    broker = await start<BrokerConnection>({ role: 'broker', directory: `${dir}/broker`, taskId: 'test', config, authority: authority.connection });
    const result = await agentCall(broker.connection, 'A', '/purchase', 'one');
    assert.equal(result.phase, 'Released');
    assert.equal(result.state.available, '100000');
  } finally { await broker.worker.stop(); await authority.worker.stop(); }
});
