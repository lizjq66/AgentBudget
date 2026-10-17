import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { start, agentCall, type BrokerConnection, type Worker } from './durable/process.js';
import type { AuthorityConnection } from './durable/broker.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, data: { type: 'string' }, fault: { type: 'string', default: 'handoff:committed' } } });
if (!values.data) throw new Error('请指定 --data 持久化目录；重用目录会恢复原任务，不会创建新预算');
const config = loadConfig(values.config);
const directory = resolve(values.data);
const authority = await start<AuthorityConnection>({ role: 'authority', directory: `${directory}/authority`, taskId: 'demo', config });
let broker: Worker | undefined;
try {
  let running = await start<BrokerConnection>({ role: 'broker', directory: `${directory}/broker`, taskId: 'demo', config, authority: authority.connection, fault: values.fault });
  broker = running.worker;
  console.log('A 申请购买；故障注入点：', values.fault);
  try { console.log(await agentCall(running.connection, 'A', '/purchase', 'purchase-A')); }
  catch (error) { console.log('请求中断：', String(error)); }
  await broker.kill();
  console.log('重启钱包进程，从持久化历史恢复同一任务与同一付款标识');
  running = await start<BrokerConnection>({ role: 'broker', directory: `${directory}/broker`, taskId: 'demo', config, authority: authority.connection });
  broker = running.worker;
  console.log('恢复后：', JSON.stringify(await agentCall(running.connection, 'A', '/status'), null, 2));
  try { console.log('B：', await agentCall(running.connection, 'B', '/purchase', 'purchase-B')); }
  catch (error) { console.log('B 被拒绝：', String(error)); }
  await sleep(config.paymentResultDelayMs);
  console.log('最终：', JSON.stringify(await broker.call('recover'), null, 2));
  console.log('数据已保留：', directory);
} finally { await broker?.stop(); await authority.worker.stop(); }
