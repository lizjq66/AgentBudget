import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { Core, type Command, type Reply } from '../core.js';
import { Store, type Fault, noFault } from './store.js';

// Append the command durably BEFORE executing it. Recovery applies every
// committed command exactly once, including the last command without a reply.
// No network or wallet side effect is permitted until the reply is also durable.
export class DurableCore {
  private raw = new Core();
  private poisoned = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private store: Store, private fault: Fault = noFault) {}
  async restore(total: string) {
    const fingerprint = createHash('sha256').update(readFileSync('.lake/build/bin/agentbudget')).digest('hex');
    const previous = this.store.get<string>('meta', 'core-binary');
    if (previous && previous !== fingerprint) throw new Error('Lean binary changed: explicit migration required');
    this.store.put('meta', 'core-binary', fingerprint);
    const events = this.store.db.prepare('SELECT * FROM events ORDER BY seq').all();
    for (let i = 0; i < events.length; i++) {
      const row = events[i];
      if (row.seq !== i + 1) throw new Error('noncontiguous durable history');
      const reply = await this.raw.send(JSON.parse(row.command as string));
      if (row.reply !== null && !isDeepStrictEqual(reply, JSON.parse(row.reply as string))) throw new Error(`replay mismatch at ${row.seq}`);
      if (row.reply === null) this.store.db.prepare('UPDATE events SET reply=? WHERE seq=?').run(JSON.stringify(reply), row.seq);
    }
    if (!events.length) await this.send({ op: 'init', total });
    const snapshot = await this.raw.send({ op: 'inspect' });
    if (snapshot.state?.total !== total) throw new Error('restored budget differs from configuration');
    return snapshot;
  }
  send(command: Command): Promise<Reply> {
    const frozen = JSON.parse(JSON.stringify(command)) as Command;
    const work = this.tail.then(async () => {
      if (this.poisoned) throw new Error('manager stopped after persistence/core failure; restart required');
      try {
        const seq = this.store.db.prepare('INSERT INTO events(command) VALUES (?)').run(JSON.stringify(frozen)).lastInsertRowid;
        this.fault(`${frozen.op}:intent`);
        const reply = await this.raw.send(frozen);
        this.fault(`${frozen.op}:applied`);
        this.store.db.prepare('UPDATE events SET reply=? WHERE seq=?').run(JSON.stringify(reply), seq);
        this.fault(`${frozen.op}:committed`);
        return reply;
      } catch (error) { this.poisoned = true; throw error; }
    });
    this.tail = work.catch(() => {});
    return work;
  }
  async close() { await this.tail; await this.raw.close(); }
}
