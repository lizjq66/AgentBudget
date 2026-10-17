import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core, Journal, type Binding } from '../adapter/core.js';
import { amount, validateConfig, type Config } from '../adapter/config.js';
import { AgentAdapter, LocalService, payloadMatches } from '../adapter/x402.js';
import { replay } from '../adapter/replay.js';

const baseline: Config = {
  total: '0.21', agents: { A: '0.07', B: '0.08' }, quotes: { A: '0.07', B: '0.08' },
  reservationTtlMs: 2000, signingDelayMs: 0, requestTimeoutMs: 1000,
  paymentResultDelayMs: 5, authorizationValiditySeconds: 120,
};
async function fixture(config: Config, body: (c: Core, s: LocalService, a: AgentAdapter, b: AgentAdapter) => Promise<void>, serviceFails = false) {
  validateConfig(config);
  const c = new Core(new Journal()), s = new LocalService(config, c.journal, serviceFails);
  try {
    await c.send({ op: 'init', total: amount(config.total) });
    await s.start();
    await body(c, s, new AgentAdapter('A', c, s, config), new AgentAdapter('B', c, s, config));
  } finally { await s.close(); await c.close(); }
}
test('normal purchases use actual SDK over HTTP; changed configuration and replay', async () => {
  for (const config of [baseline, { ...baseline, total: '7.123456', agents: { A: '1.000001', B: '2.345678' }, quotes: { A: '1.000001', B: '2.345678' } }]) {
    await fixture(config, async (c, s, a, b) => {
      const ra = await a.purchase(), rb = await b.purchase();
      assert.equal(ra.status, 'delivered'); assert.equal(rb.status, 'delivered');
      assert.ok(ra.serviceResult); assert.ok(rb.serviceResult);
      assert.equal(s.delivered, 2);
      assert.equal((await c.send({ op: 'inspect' })).state?.spent, String(BigInt(amount(config.agents.A)) + BigInt(amount(config.agents.B))));
      assert.equal(c.journal.records.filter(r => r.kind === 'sdk.verify').length, 2);
      const file = join(mkdtempSync(join(tmpdir(), 'agentbudget-')), 'events.jsonl');
      writeFileSync(file, c.journal.records.map(r => JSON.stringify(r)).join('\n'));
      assert.equal(await replay(file), c.journal.records.filter(r => r.kind === 'core').length);
    });
  }
});
test('oversubscription while timeout pending, failed query, duplicate settlement', async () => {
  await fixture({ ...baseline, total: '0.10', requestTimeoutMs: 30, paymentResultDelayMs: 180 }, async (c, s, a, b) => {
    const ra = await a.purchase();
    assert.equal(ra.status, 'pending_confirmation');
    assert.equal((await c.send({ op: 'inspect' })).state?.inFlight, amount(baseline.agents.A));
    assert.equal((await c.apply('release', ra.binding!)).allowed, false);
    assert.equal((await a.reconcile(ra.binding!, true)).state?.inFlight, amount(baseline.agents.A));
    assert.match((await b.purchase()).status, /insufficient_available_budget/);
    await s.drain();
    const paid = await a.reconcile(ra.binding!);
    assert.equal(paid.state?.spent, amount(baseline.agents.A));
    assert.deepEqual((await a.reconcile(ra.binding!)).state, paid.state);
  });
});
test('late signature after release is never handed to service', async () => {
  await fixture({ ...baseline, signingDelayMs: 20 }, async (c, s, a) => {
    const r = await a.purchase({ releaseDuringSigning: true });
    assert.match(r.status, /invalid_transition/);
    assert.equal(r.payload, undefined);
    assert.equal(s.ledger.size, 0);
    assert.equal(c.journal.records.filter(r => r.kind === 'authorization.handoff').length, 0);
    assert.equal((await c.send({ op: 'inspect' })).state?.available, amount(baseline.total));
  });
});
test('signature exceeding configured reservation TTL cannot hand off', async () => {
  await fixture({ ...baseline, reservationTtlMs: 5, signingDelayMs: 25 }, async (c, s, a) => {
    assert.match((await a.purchase()).status, /reservation_expired/);
    assert.equal(s.ledger.size, 0);
    assert.equal((await c.send({ op: 'inspect' })).state?.reserved, '0');
  });
});
test('cancel blocks B, preserves A, and late A still settles', async () => {
  await fixture({ ...baseline, requestTimeoutMs: 30, paymentResultDelayMs: 160 }, async (c, s, a, b) => {
    const r = await a.purchase();
    assert.equal(r.status, 'pending_confirmation');
    assert.equal((await c.send({ op: 'cancel' })).state?.inFlight, amount(baseline.agents.A));
    assert.match((await b.purchase()).status, /task_canceled/);
    await s.drain();
    assert.equal((await a.reconcile(r.binding!)).state?.spent, amount(baseline.agents.A));
  });
});
test('closed-world final nonpayment can release and blocks any late retry', async () => {
  await fixture({ ...baseline, total: '0.10', requestTimeoutMs: 30, paymentResultDelayMs: 180 }, async (c, s, a, b) => {
    const r = await a.purchase();
    assert.equal(r.status, 'pending_confirmation');
    assert.equal(s.disable(r.binding!.id), true);
    assert.equal((await a.reconcile(r.binding!)).state?.available, amount('0.10'));
    assert.equal((await a.send(r.binding!, r.payload!)).status, 'authorization_not_inflight');
    const rb = await b.purchase();
    assert.equal(rb.status, 'pending_confirmation');
    await s.drain(); await b.reconcile(rb.binding!);
    assert.equal(s.ledger.get(r.binding!.id)?.status, 'disabled');
    assert.equal((await c.send({ op: 'inspect' })).state?.spent, amount(baseline.agents.B));
  });
});
test('retry reuses same signed authorization; only one ledger payment', async () => {
  await fixture({ ...baseline, requestTimeoutMs: 30, paymentResultDelayMs: 150 }, async (c, s, a) => {
    const r = await a.purchase();
    assert.equal(r.status, 'pending_confirmation');
    await a.send(r.binding!, r.payload!);
    assert.equal(s.ledger.size, 1);
    await s.drain(); await a.reconcile(r.binding!);
    assert.equal(c.journal.records.filter(r => r.kind === 'simulator.settlement').length, 1);
    assert.equal((await c.send({ op: 'inspect' })).state?.spent, amount(baseline.agents.A));
  });
});
test('service 500 remains paid, not nonpayment', async () => {
  await fixture(baseline, async (c, _s, a) => {
    assert.equal((await a.purchase()).status, 'service_failed');
    assert.equal((await c.send({ op: 'inspect' })).state?.spent, amount(baseline.agents.A));
  }, true);
});
test('SDK rejects bad signature and amount; adapter rejects conflicting payload and quote', async () => {
  await fixture(baseline, async (c, s, a) => {
    const r = await a.purchase();
    assert.equal(r.status, 'delivered');
    const bad = structuredClone(r.payload!);
    (bad.payload as { signature: string }).signature = `0x${'00'.repeat(65)}`;
    assert.equal((await s.verifier.verify(bad, s.quotes.get('A')!)).isValid, false);
    const conflict = structuredClone(r.payload!);
    (conflict.payload as { authorization: { value: string } }).authorization.value = '1';
    assert.equal((await s.verifier.verify(conflict, s.quotes.get('A')!)).isValid, false);
    assert.equal(payloadMatches(r.binding!, conflict), false);
    assert.throws(() => s.register(r.binding!, conflict));
    const altered: Binding = { ...r.binding!, amount: String(BigInt(r.binding!.amount) + 1n) };
    assert.equal((await c.apply('paid', altered)).reason, 'conflicting_payment_content');
  });
  await fixture({ ...baseline, quotes: { ...baseline.quotes, A: '0.070001' } }, async (_c, s, a) => {
    assert.match((await a.purchase()).status, /quote_does_not_match/);
    assert.equal(s.ledger.size, 0);
  });
});
