import { fork } from 'node:child_process';
import type { Config } from '../config.js';
import type { AuthorityConnection } from './broker.js';

export interface Start {
  role: 'broker' | 'authority'; directory: string; taskId: string; config: Config;
  authority?: AuthorityConnection; fault?: string;
}
export interface BrokerConnection { url: string; tokens: { A: string; B: string }; walletAddress: string }
export class Worker {
  readonly child = fork(new URL('./worker.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  private next = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  readonly exited = new Promise<void>(resolve => {
    this.child.once('exit', () => { for (const p of this.pending.values()) p.reject(new Error('worker exited')); this.pending.clear(); resolve(); });
  });
  constructor() {
    this.child.on('message', (m: any) => {
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    });
    this.child.on('error', error => { for (const p of this.pending.values()) p.reject(error); this.pending.clear(); });
  }
  call<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.child.connected) return Promise.reject(new Error('worker disconnected'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ ...args, op, id }, error => { if (error) { this.pending.delete(id); reject(error); } });
    });
  }
  async stop() {
    if (this.child.connected) await this.call('close').catch(() => {});
    await this.exited;
  }
  async kill() { this.child.kill('SIGKILL'); await this.exited; }
}
export async function start<T>(options: Start): Promise<{ worker: Worker; connection: T }> {
  const worker = new Worker();
  try { return { worker, connection: await worker.call<T>('start', { ...options }) }; }
  catch (error) { await worker.kill(); throw error; }
}
export async function agentCall(connection: BrokerConnection, agent: 'A' | 'B', path: string, requestId?: string) {
  const response = await fetch(connection.url + path, {
    method: requestId === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${connection.tokens[agent]}`, 'Content-Type': 'application/json' },
    body: requestId === undefined ? undefined : JSON.stringify({ requestId }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}
