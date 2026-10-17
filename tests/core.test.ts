import test from 'node:test';
import assert from 'node:assert/strict';
import { Core, ASSET, NETWORK, type Binding, type Snapshot } from '../adapter/core.js';
import { amount, validateConfig } from '../adapter/config.js';

function bind(id: string, value: string): Binding {
  return { id, agent: id, amount: value, network: NETWORK, asset: ASSET, payTo: 'recipient', digest: `digest-${id}` };
}
function check(s: Snapshot) {
  assert.equal(BigInt(s.available) + BigInt(s.reserved) + BigInt(s.inFlight) + BigInt(s.spent), BigInt(s.total));
  for (const [field, phase] of [['reserved', 'Reserved'], ['inFlight', 'InFlight'], ['spent', 'Settled']] as const) {
    assert.equal(BigInt(s[field]), s.entries.filter(e => e.phase === phase).reduce((sum, e) => sum + BigInt(e.binding.amount), 0n));
  }
}
test('integer conversion rejects invalid money and never rounds', () => {
  assert.equal(amount('9007199254740993.123456'), '9007199254740993123456');
  assert.equal(amount('0.000001'), '1');
  for (const v of ['-1', '1e2', 'NaN', '0.0000001', '1.0000000', '01', ' 1', '.1', '', null, 0.1, String(2n ** 256n)]) assert.throws(() => amount(v));
  assert.throws(() => validateConfig({}));
});
test('budget decisions, ambiguity, exact binding and terminal idempotence', async () => {
  const c = new Core();
  const a = bind('A', '60'), b = bind('B', '50');
  try {
    assert.equal((await c.send({ op: 'init', total: '100' })).allowed, true);
    assert.equal((await c.send({ op: 'init', total: '1000' })).allowed, false);
    assert.equal((await c.send({ op: 'reserve', binding: a, now: '1', expiresAt: '10' })).allowed, true);
    assert.equal((await c.apply('handoff', a, { now: '2' })).allowed, true);
    for (const now of ['3', '100000']) {
      assert.equal((await c.apply('release', a, { now })).allowed, false);
      assert.equal((await c.apply('unknown', a, { now })).state?.inFlight, '60');
    }
    assert.equal((await c.send({ op: 'reserve', binding: b, now: '3', expiresAt: '10' })).reason, 'insufficient_available_budget');
    for (const altered of [{ ...a, amount: '61' }, { ...a, digest: 'other' }, { ...a, payTo: 'other' }, { ...a, agent: 'other' }, { ...a, asset: 'bad' }, { ...a, network: 'bad' }]) {
      assert.equal((await c.apply('paid', altered)).allowed, false);
    }
    const paid = await c.apply('paid', a);
    const duplicate = await c.apply('paid', a);
    assert.deepEqual(paid.state, duplicate.state);
    assert.equal(duplicate.reason, 'duplicate_confirmation');
    assert.equal((await c.apply('unpaidFinal', a, { evidence: 'simulator:never-paid-and-disabled' })).allowed, false);
    assert.equal((await c.apply('release', a)).allowed, false);
    check(duplicate.state!);
  } finally { await c.close(); }
});
test('release excludes late handoff, expiry boundary, final evidence and cancellation', async () => {
  const c = new Core();
  const a = bind('A', '4'), b = bind('B', '3');
  try {
    await c.send({ op: 'init', total: '20' });
    await c.send({ op: 'reserve', binding: a, now: '1', expiresAt: '10' });
    assert.equal((await c.apply('handoff', a, { now: '10' })).reason, 'reservation_expired');
    const released = await c.apply('release', a);
    assert.deepEqual((await c.apply('release', a)).state, released.state);
    assert.equal((await c.apply('handoff', a, { now: '2' })).allowed, false);
    assert.equal((await c.send({ op: 'reserve', binding: a, now: '1', expiresAt: '10' })).allowed, false);
    await c.send({ op: 'reserve', binding: b, now: '1', expiresAt: '10' });
    await c.apply('handoff', b, { now: '2' });
    await c.send({ op: 'cancel' });
    assert.equal((await c.send({ op: 'reserve', binding: bind('C', '1'), now: '1', expiresAt: '10' })).reason, 'task_canceled');
    assert.equal((await c.apply('unpaidFinal', b)).allowed, false);
    assert.equal((await c.apply('unpaidFinal', b, { evidence: 'expired' })).allowed, false);
    const final = await c.apply('unpaidFinal', b, { evidence: 'simulator:never-paid-and-disabled' });
    assert.equal(final.state?.available, '20');
    assert.deepEqual((await c.apply('unpaidFinal', b, { evidence: 'simulator:never-paid-and-disabled' })).state, final.state);
    check(final.state!);
  } finally { await c.close(); }
});
test('wire validation rejects negatives, floats, oversized monetary syntax, unsupported asset', async () => {
  const c = new Core();
  try {
    for (const total of ['-1', '1.5', 10, '', '1e3']) assert.equal((await c.send({ op: 'init', total })).allowed, false);
    await c.send({ op: 'init', total: '100' });
    for (const value of ['-2', '2.3', '0', 'bad']) assert.equal((await c.send({ op: 'reserve', binding: bind('bad', value), now: '1', expiresAt: '2' })).allowed, false);
    assert.equal((await c.send({ op: 'reserve', binding: { ...bind('bad', '1'), asset: 'other' }, now: '1', expiresAt: '2' })).allowed, false);
  } finally { await c.close(); }
});
test('concurrent agents serialize; arbitrary event mixtures preserve totals and terminal entries', async () => {
  const c = new Core();
  try {
    await c.send({ op: 'init', total: '97' });
    const bindings = Array.from({ length: 40 }, (_, i) => bind(String(i), String(i % 9 + 1)));
    const replies = await Promise.all(bindings.map(binding => c.send({ op: 'reserve', binding, now: '1', expiresAt: '10' })));
    replies.forEach(r => check(r.state!));
    let seed = 9271;
    const terminal = new Map<string, string>();
    for (let i = 0; i < 250; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const binding = bindings[seed % bindings.length];
      const op = ['handoff', 'paid', 'unknown', 'release', 'unpaidFinal'][Math.floor(seed / 40) % 5];
      const r = await c.apply(op, binding, { now: String(seed % 20), evidence: 'simulator:never-paid-and-disabled' });
      check(r.state!);
      for (const e of r.state!.entries) {
        if (terminal.has(e.binding.id)) assert.equal(e.phase, terminal.get(e.binding.id));
        if (e.phase === 'Released' || e.phase === 'Settled') terminal.set(e.binding.id, e.phase);
      }
    }
  } finally { await c.close(); }
});
