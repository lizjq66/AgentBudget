import { readFileSync } from 'node:fs';

export function amount(value: unknown, field = 'amount'): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) {
    throw new Error(`${field}: 请提供非负十进制字符串，最多 6 位小数（USDC），禁止浮点数/指数/负数`);
  }
  const [whole, frac = ''] = value.split('.');
  const units = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
  if (units >= 2n ** 256n) throw new Error(`${field}: exceeds uint256`);
  return String(units);
}
export interface Config {
  total: string;
  agents: { A: string; B: string };
  quotes: { A: string; B: string };
  reservationTtlMs: number; signingDelayMs: number; requestTimeoutMs: number;
  paymentResultDelayMs: number; authorizationValiditySeconds: number;
}
export function validateConfig(raw: unknown): Config {
  const c = raw as Config;
  if (!c || typeof c !== 'object') throw new Error('配置必须为 JSON 对象');
  amount(c.total, 'total');
  for (const agent of ['A', 'B'] as const) {
    if (amount(c.agents?.[agent], `agents.${agent}`) === '0' || amount(c.quotes?.[agent], `quotes.${agent}`) === '0') {
      throw new Error('购买金额和报价必须大于零');
    }
  }
  for (const field of ['reservationTtlMs', 'signingDelayMs', 'requestTimeoutMs', 'paymentResultDelayMs', 'authorizationValiditySeconds'] as const) {
    if (!Number.isSafeInteger(c[field]) || c[field] < 0 || c[field] > 2_147_483_647) throw new Error(`${field}: 缺失或不是有效非负整数`);
  }
  if (!c.reservationTtlMs || !c.requestTimeoutMs || c.authorizationValiditySeconds < 10) throw new Error('TTL/timeout 必须为正；SDK 验证需要授权窗口至少 10 秒');
  return c;
}
export function loadConfig(file?: string): Config {
  if (!file) throw new Error('请指定 --config 文件；示例：npm run demo -- --config examples/demo.json --scenario timeout');
  return validateConfig(JSON.parse(readFileSync(file, 'utf8')));
}
