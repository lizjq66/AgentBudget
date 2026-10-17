import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const NETWORK = 'eip155:84532' as const;
export const ASSET = '0x036cbd53842c5426634e7929541ec2318f3dcf7e' as const;
export interface Binding { id: string; agent: string; amount: string; network: string; asset: string; payTo: string; digest: string }
export interface Snapshot {
  total: string; available: string; reserved: string; inFlight: string; spent: string; canceled: boolean;
  entries: { binding: Binding; expiresAt: string; phase: string }[];
}
export interface Reply { allowed: boolean; reason: string; state: Snapshot | null }
export type Command = Record<string, unknown>;
export interface RecordLine { kind: string; [key: string]: unknown }

export class Journal {
  records: RecordLine[] = [];
  private latest?: Snapshot;
  constructor(readonly file?: string, readonly verbose = false) {
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '', { flag: 'wx' });
    }
  }
  add(record: RecordLine) {
    const row: RecordLine = { seq: this.records.length, ...record };
    this.records.push(row);
    if (this.file) appendFileSync(this.file, JSON.stringify(row) + '\n');
    if (this.verbose) {
      const r = row.reply as Reply | undefined;
      if (r?.state) {
        this.latest = r.state;
        const command = row.request as Command;
        const b = command.binding as Binding | undefined;
        console.log(`[${row.seq}] ${b?.agent ?? '任务'} ${command.op} → ${r.allowed ? '允许' : '拒绝'}: ${r.reason}`);
      } else if (record.kind === 'sdk.quote') {
        console.log(`[${row.seq}] ${record.agent} 获得 SDK 报价（完整内容见日志）`);
      } else if (record.kind === 'final') {
        console.log(`[${row.seq}] 结束；付款状态 ${JSON.stringify(record.paymentStates)}`);
      } else console.log(`[${row.seq}] ${JSON.stringify(record)}`);
      if (this.latest) {
        const s = this.latest;
        console.log(`  最小单位 | 总额 ${s.total} | 可用 ${s.available} | 预留 ${s.reserved} | 在途 ${s.inFlight} | 已花费 ${s.spent}`);
      }
    }
  }
}

// A single process and FIFO queue: all agents share this one serialized core.
export class Core {
  private child: ChildProcessWithoutNullStreams;
  private pending: { resolve: (r: Reply) => void; reject: (e: Error) => void; command: Command }[] = [];
  private failed?: Error;
  private closed = false;
  constructor(readonly journal = new Journal()) {
    this.child = spawn(resolve('.lake/build/bin/agentbudget'), [], { stdio: 'pipe' });
    let stderr = '';
    this.child.stderr.on('data', d => { stderr += d; });
    const fail = (err: Error) => { this.failed = err; this.pending.splice(0).forEach(p => p.reject(err)); };
    this.child.on('error', fail);
    this.child.on('exit', code => { if (!this.closed) fail(new Error(`Lean exited (${code}): ${stderr}`)); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      const p = this.pending.shift();
      if (!p) return fail(new Error('unsolicited Lean response'));
      try {
        const reply: Reply = JSON.parse(line);
        this.journal.add({ kind: 'core', request: p.command, reply });
        p.resolve(reply);
      } catch (e) { p.reject(e as Error); fail(e as Error); }
    });
    this.child.stdin.on('error', fail);
  }
  send(command: Command): Promise<Reply> {
    if (this.failed || this.closed) return Promise.reject(this.failed ?? new Error('core closed'));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject, command });
      this.child.stdin.write(JSON.stringify(command) + '\n');
    });
  }
  apply(op: string, binding: Binding, extra: Command = {}) {
    return this.send({ op, binding, now: String(Date.now()), ...extra });
  }
  async close() {
    this.closed = true;
    this.child.stdin.end();
    if (this.child.exitCode === null) await new Promise<void>(r => this.child.once('exit', () => r()));
  }
}
