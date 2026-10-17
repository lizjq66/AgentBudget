import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// A separate SQLite write transaction is a process-lifetime owner lock.
// The OS releases it on SIGKILL; no PID files, expired leases or stale-lock deletion.
export class Store {
  readonly db: DatabaseSync;
  private owner: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.owner = new DatabaseSync(join(directory, 'owner.sqlite'));
    try { this.owner.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
    catch { this.owner.close(); throw new Error('another process owns this runtime directory'); }
    try {
      this.db = new DatabaseSync(join(directory, 'state.sqlite'));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, command TEXT NOT NULL, reply TEXT);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      if (Object.values(this.db.prepare('PRAGMA quick_check').get()!)[0] !== 'ok') throw new Error('database integrity check failed');
      chmodSync(join(directory, 'state.sqlite'), 0o600);
      chmodSync(join(directory, 'owner.sqlite'), 0o600);
    } catch (error) { this.owner.close(); throw error; }
  }
  get<T>(table: 'meta' | 'jobs' | 'payments', id: string): T | undefined {
    const key = table === 'meta' ? 'key' : 'id';
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE ${key}=?`).get(id);
    return row ? JSON.parse(row.value as string) as T : undefined;
  }
  put(table: 'meta' | 'jobs' | 'payments', id: string, value: unknown) {
    const key = table === 'meta' ? 'key' : 'id';
    this.db.prepare(`INSERT INTO ${table} (${key},value) VALUES (?,?) ON CONFLICT(${key}) DO UPDATE SET value=excluded.value`).run(id, JSON.stringify(value));
  }
  all<T>(table: 'jobs' | 'payments'): T[] {
    return this.db.prepare(`SELECT value FROM ${table} ORDER BY id`).all().map(row => JSON.parse(row.value as string) as T);
  }
  close() { this.db.close(); this.owner.close(); }
}

export type Fault = (point: string) => void;
export const noFault: Fault = () => {};
