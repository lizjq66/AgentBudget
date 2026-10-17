import { Authority } from './authority.js';
import { Broker } from './broker.js';
import { validateConfig } from '../config.js';

process.umask(0o077);
let runtime: Authority | Broker | undefined;
process.on('message', async (message: any) => {
  try {
    let result: unknown;
    if (message.op === 'start' && !runtime) {
      const fault = (point: string) => { if (point === message.fault) process.kill(process.pid, 'SIGKILL'); };
      const config = validateConfig(message.config);
      runtime = message.role === 'authority'
        ? new Authority(message.directory, message.taskId, config, fault)
        : new Broker(message.directory, message.taskId, config, message.authority, fault);
      result = await runtime.start();
    } else if (message.op === 'close') {
      await runtime?.close();
      process.send?.({ id: message.id, result: true }, () => process.exit(0));
      return;
    } else if (runtime instanceof Broker) result = await runtime.admin(message.op, message.args);
    else throw new Error('unsupported worker operation');
    process.send?.({ id: message.id, result });
  } catch (error) {
    process.send?.({ id: message.id, error: String(error) });
  }
});
process.on('disconnect', () => { void runtime?.close().finally(() => process.exit(0)); });
