import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';
import { Core, Journal } from './core.js';
import { amount, loadConfig } from './config.js';
import { AgentAdapter, LocalService } from './x402.js';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, scenario: { type: 'string', default: 'timeout' },
  log: { type: 'string' }, step: { type: 'boolean', default: false },
} });
const scenarios = ['normal', 'timeout', 'cancel', 'late-signature', 'unpaid', 'retry', 'service-failure'];
async function main() {
  const config = loadConfig(values.config);
  const scenario = values.scenario!;
  if (!scenarios.includes(scenario)) throw new Error(`scenario 必须为 ${scenarios.join(', ')}`);
  if (['timeout', 'cancel', 'unpaid', 'retry'].includes(scenario) && config.paymentResultDelayMs <= config.requestTimeoutMs) {
    throw new Error(`${scenario} 场景需要 paymentResultDelayMs > requestTimeoutMs；请调整配置`);
  }
  const taskId = randomUUID();
  const file = values.log ?? `artifacts/${scenario}-${taskId}.jsonl`;
  const journal = new Journal(file, true);
  journal.add({ kind: 'session', taskId, scenario, config, mode: 'local-simulation', sdk: '2.28.0' });
  const core = new Core(journal);
  const service = new LocalService(config, journal, scenario === 'service-failure');
  const terminal = values.step ? createInterface({ input: stdin, output: stdout }) : undefined;
  const pause = async (message: string) => { if (terminal) await terminal.question(`${message}，按回车继续…`); };
  try {
    await core.send({ op: 'init', total: amount(config.total) });
    await service.start();
    const a = new AgentAdapter('A', core, service, config);
    const b = new AgentAdapter('B', core, service, config);
    await pause('A 准备购买');
    const resultA = await a.purchase({ releaseDuringSigning: scenario === 'late-signature' });
    journal.add({ kind: 'agent.result', agent: 'A', status: resultA.status, serviceResult: resultA.serviceResult });
    if (scenario === 'cancel') await core.send({ op: 'cancel' });
    if (resultA.binding && service.ledger.has(resultA.binding.id)) {
      if (scenario === 'timeout' || scenario === 'cancel') {
        await core.apply('release', resultA.binding); // deliberately refused while in flight
        await a.reconcile(resultA.binding, true); // query failure keeps occupancy
      }
      if (scenario === 'unpaid' && service.disable(resultA.binding.id)) await a.reconcile(resultA.binding);
      if (scenario === 'retry' && resultA.payload) {
        const retried = await a.send(resultA.binding, resultA.payload);
        journal.add({ kind: 'agent.retry', status: retried.status });
      }
    }
    await pause('B 请求同一预算（付款结果可在等待期间返回，但须查询后才更新核心）');
    const resultB = await b.purchase();
    journal.add({ kind: 'agent.result', agent: 'B', status: resultB.status, serviceResult: resultB.serviceResult });
    await pause('查询最终付款结果');
    await service.drain();
    for (const [adapter, result] of [[a, resultA], [b, resultB]] as const) {
      if (result.binding && service.ledger.has(result.binding.id)) {
        await adapter.reconcile(result.binding);
        await adapter.reconcile(result.binding); // duplicate final result is intentionally replayed
      }
    }
    const final = await core.send({ op: 'inspect' });
    journal.add({ kind: 'final', state: final.state, paymentStates: [...service.ledger.values()].map(e => ({ id: e.binding.id, status: e.status })) });
    console.log(`\n完整日志: ${file}\n重放: npm run replay -- ${file}`);
  } finally { terminal?.close(); await service.close(); await core.close(); }
}
main().catch(e => { console.error(String(e)); process.exitCode = 1; });
