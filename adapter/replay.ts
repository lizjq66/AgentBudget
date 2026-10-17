import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { Core, type Command, type Reply } from './core.js';

// Recompute recorded decisions with the very same executable. No signatures
// are transmitted and no service calls are repeated. This is not recovery.
export async function replay(file: string): Promise<number> {
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const core = new Core();
  let checked = 0;
  try {
    for (const row of rows) {
      if (row.kind !== 'core') continue;
      const actual = await core.send(row.request as Command);
      if (!isDeepStrictEqual(actual, row.reply as Reply)) throw new Error(`Replay mismatch at seq ${row.seq}`);
      checked++;
    }
    if (!checked) throw new Error('日志中没有核心事件');
    return checked;
  } finally { await core.close(); }
}
if (process.argv[1]?.endsWith('/replay.ts')) {
  if (!process.argv[2]) { console.error('用法: npm run replay -- artifacts/xxx.jsonl'); process.exitCode = 1; }
  else replay(process.argv[2]).then(n => console.log(`通过：${n} 个 Lean 决策和状态完全一致`)).catch(e => { console.error(String(e)); process.exitCode = 1; });
}
