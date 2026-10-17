# 验收记录

日期：2026-10-16。环境：macOS arm64，Node 25.8.1，npm 11.11.0，Lean 4.34.0。

实际运行：

```bash
npm test
npm run demo -- --config examples/normal.json --scenario normal --log artifacts/normal-verified.jsonl
npm run demo -- --config examples/demo.json --scenario timeout --log artifacts/timeout-final.jsonl
npm run replay -- artifacts/normal-verified.jsonl
npm run replay -- artifacts/timeout-final.jsonl
```

结果：**14 个测试通过，0 失败**；Lean 构建通过、TypeScript 类型检查通过。正常演示的 14 个核心事件、超时演示的 11 个核心事件重放后，决策、原因和完整状态逐项一致。日志是本机生成产物，`artifacts/` 不纳入版本管理。

| 最低验收条件 | 实际证据 |
|---|---|
| 预算足够，两位 Agent 均完成购买 | 正常 HTTP/SDK 集成测试与 normal 演示 |
| 总请求超额时不能同时获准 | A 在途时 B 被 Lean 拒绝；40 个并发申请由 FIFO 串行化 |
| 超时不释放在途额度 | timeout 测试及演示；release 拒绝，查询失败仍保留 InFlight |
| 释放后迟到签名不能交出 | late-signature 测试无 authorization.handoff、无模拟器账本条目；另测 TTL 边界 |
| 重复确认不重复记账 | 直接核心测试、SDK 集成测试，重复结果后完整状态相同 |
| 冲突内容、非法金额拒绝 | 金额/摘要/Agent/收款方/资产/网络冲突；负数、超精度、浮点/指数；SDK 坏签名与改值验证失败 |
| 改配置无需改代码 | 两组独立金额配置正常购买，其中一组 A=1.000001、B=2.345678 |
| 证明通过、演示同一核心 | 演示进程启动 `.lake/build/bin/agentbudget`，Main 调用被证明的 `step` |

额外验证：取消任务后 A 仍结算；模拟器最终未付款证据回收后可供 B 使用；同一授权 HTTP 重试只有一笔模拟结算；服务 500 仍计已付款；250 个确定性混合事件逐步检查守恒与终态不变。

## 观察到的账务结果

单位均为 USDC 最小单位（1 USDC = 1,000,000）。

| 演示时点 | 总预算 | 可用 | Reserved | InFlight | Settled |
|---|---:|---:|---:|---:|---:|
| normal 最终，A/B 均交付 | 230000 | 60000 | 0 | 0 | 170000 |
| timeout：A HTTP 超时 | 100000 | 40000 | 0 | 60000 | 0 |
| timeout：B 请求 50000 被拒 | 100000 | 40000 | 0 | 60000 | 0 |
| timeout：A 最终付款及重复确认 | 100000 | 40000 | 0 | 0 | 60000 |

## 证明依赖审计

`npm test` 包含 `lake env lean Audit.lean`，输出：

```text
initial_budget_conserved  [propext, Quot.sound]
run_valid                 [propext, Quot.sound]
ledger_final_idempotent    [propext, Quot.sound]
run_terminal              [propext, Quot.sound]
released_never_inFlight    [propext, Quot.sound]
released_no_handoff       [propext]
```

这些是 Lean 标准逻辑基础；项目没有自定义公理或 `sorry`。源码扫描也未发现 `sorryAx`。审计打印并展示依赖，不应被解读为已经证明 TypeScript 和网络正确。

安装依赖时曾发现旧版 viem/ws 和 esbuild 的审计问题；改为锁定 viem 2.57.7、tsx 4.23.15 后，npm 安装审计报告 **0 vulnerabilities**。这只是检查当日的依赖数据库结果。

## 尚未验收

没有真实测试网交易、真实合约预执行、链上最终非付款证明、A2A SDK 交互、钱包权限隔离或进程崩溃恢复。所有相关限制保留在 README 和工程笔记中。
