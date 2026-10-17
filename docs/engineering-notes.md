# 工程笔记

检查日期：2026-10-16。区分规范要求、已发布 SDK 实现、本项目设计及实际测试，不引用 issue 提案作为规范。

## 已核实来源与版本

| 来源 | 版本 / 定位 | 本次用途 |
|---|---|---|
| [x402 官方仓库](https://github.com/x402-foundation/x402) | 当前官方仓库指向 x402-foundation；不把 main 当固定发布版 | 确认官方实现入口 |
| [x402 v2 规范](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) | v2，检查当日 main，滚动文档 | 402、PaymentRequired、PaymentPayload、SettleResponse 及 HTTP 头 |
| [exact EVM 规范](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md) | 检查当日 main，滚动文档 | exact 方案与 EVM 授权机制 |
| [@x402/core](https://www.npmjs.com/package/@x402/core/v/2.28.0) | npm 2.28.0，锁定包及 integrity 见 package-lock.json | 客户端、消息类型、HTTP 编解码、花费策略 |
| [@x402/evm](https://www.npmjs.com/package/@x402/evm/v/2.28.0) | npm 2.28.0，同上 | server/client/facilitator 三个角色 |
| [A2A 发布版规范](https://a2a-protocol.org/v1.0.0/specification/) | 1.0.0；此次未安装或运行 A2A SDK | 任务创建、查询、取消与重试研究 |

SDK 结论以安装的 **2.28.0 包代码**及测试为准。已检查的包内路径（`node_modules/@x402/evm/dist/esm/`）和 SHA-256：

```text
chunk-DLPUE5VK.mjs              27984f3ae779fcc26f6b6fae9194d0f0383573ead4bb253e865504c3df944e34
exact/facilitator/index.mjs     cac1eca2694990485d0b34c556ee8109c2b510c10bdbba607dcc3c45b6eb40c3
exact/server/index.mjs          ece083ee374514fc53cb4d8b9bf7b346b81a901b3e1745375b0ec5a44b86053b
```

Lean 4.34.0，本机工具链 commit `293d5d0c0c3f3dded4688b3ccd6a33939ac5102b`。无 Mathlib 或链上依赖。

## 阶段一：一次真实 SDK 消息流程

接触组件：EVM server scheme 将整数资产报价整理为 PaymentRequirements；core 生成/解析 HTTP 付款头；client scheme 生成 EIP-3009 授权并调用 signer；facilitator scheme 验证内容及签名。

本地 `GET /service/A` 返回 402，Agent 收到报价后通过 SDK 签名，再携带 PAYMENT-SIGNATURE 重试；服务用 SDK 验证并返回 PAYMENT-RESPONSE。此处使用手写 Node HTTP 路由，没有使用 Express 中间件或自动付款 fetch wrapper，便于把 Lean 审批放在明确的发送边界。

AgentBudget 自己承担：预算批准、签名权限顺序、重试身份与本地服务。SDK 验证中的合约存在性和 eth_call 是模拟。结算完全是我们的账本，不冒充链验证。来源：包源码、正常 HTTP 集成测试。

## 阶段二：可执行的 Lean 决策

SDK 在调用 signer 前生成 nonce 和有效期；我们在签名回调内部先以 nonce 建立预留，并将 `hashTypedData` 摘要绑定到预留。摘要覆盖 from、to、value、nonce、有效期和签名域。完成签名后，先收到 Lean 的 handoff 批准，再交出授权。

保留不可变绑定比只按金额或 Agent 名称匹配更可靠。Reserved 的 TTL 与 EIP-3009 授权有效期是两个不同的期限，单位也不同。授权过期不作为释放 InFlight 的证据。

Lean 中守恒通过状态分类汇总及提交检查维持，定理对任意事件列表归纳。终态不变对完整管理者归纳，不仅验证演示中的 A/B 数字。TypeScript 不维护预算副本。来源：本项目设计、Lean 编译器验核、直接调用可执行文件的测试。

联调发现：Lean 的 JSON 对象输出顺序不必与 TypeScript 一致，绑定使用结构化比较；账务整数通过 JSON 字符串传递。

## 阶段三：未知付款的处理

`AbortSignal.timeout` 终止客户端等待，却不撤销服务端已接受的付款。服务继续结算，Lean 保留 InFlight，直到查询得到最终结果。服务 500 也可以同时带有成功付款结果，二者分开记录。

模拟器只在从未 paid 时原子地标记 disabled，所有延迟结算和后续请求都会检查该状态，之后才允许发送 `unpaidFinal`。链上没有自动等价物。本地查询失败只发送 unknown，不回收额度。来源：本项目设计、超时/禁用/重复/取消/服务失败测试。

包中 HTTPFacilitatorClient 提供 `/verify`、`/settle`、`/supported`；当前 EVM facilitator 有 pending settlement store 用于重试对账，但这不等价于向客户端提供通用、可信的“从未付款且今后不可付款”证明接口。我们没有发现可直接替代此证据的公开通用 API，亦未实现它。参考路径：`@x402/core/dist/esm/chunk-FV2JN4FK.mjs` 与 EVM facilitator 类型声明。

## 阶段四：可调整演示与研究接口

改用 1.000001 / 2.345678 USDC 的测试发现 `x402Client` 默认单笔上限为 $1。检查 2.28.0 的 `SpendControls` 后，将 `allowedAssets[].maxAmountPerPayment` 设为本次请求的最小单位整数。它是 SDK 默认防护，不是协议限额；不能替代共享预算，最终批准仍在 Lean。来源：失败测试、SDK 类型/代码及修复后测试。

提供 JSONL 逐事件重放：保留原输入时间，重算每次批准/拒绝及完整状态并比较。重放不再签名或发送请求，不代表 crash recovery。来源：本项目设计、重放测试。

## A2A 研究结果（未接入）

以固定的 [1.0.0 规范](https://a2a-protocol.org/v1.0.0/specification/) 为准：

- 创建：SendMessage 可以返回 Task 或直接 Message，taskId 由服务端生成；不能假设每次消息都有 Task（§3.1.1、§3.4.2）。
- 查询：GetTask 用 taskId 取当前状态、产物及可选历史（§3.1.3）。
- 取消：CancelTask 是请求取消，可能失败并返回 TaskNotCancelableError；不具备付款撤销语义（§3.1.5）。
- 重试：§3.3.1 声明 Get 操作幂等；SendMessage **可以**通过 messageId 去重，并非保证；CancelTask 幂等，但已清理的重复取消可返回 TaskNotFoundError。因此未来不能因重发任务消息就新建付款。

需要特别验证的文档差异：检查当日 `latest` 页面与固定 1.0.0 页面内容不同。1.0.0 §3.2.2 的 `returnImmediately` 说明默认阻塞到终态/中断态，但 §3.3.3 仍有立即返回的概述。首个 A2A 适配应固定 SDK 版本并对这个行为做契约测试，不能将概述或 `latest` 的变化当成已发布的一致要求。

AgentBudget 的 UUID 只是一次本地演示会话。没有 Agent Card、A2A 端点或认证，故没有兼容性声明。预算取消规则是本项目设计。

## 未验证问题与下一步

- 测试网：没有 RPC、余额读取、真实 eth_call、交易回执、链上授权撤销或确认数实验。
- 真实最终未付款：必须同时证明历史未付款和未来不可付款；需要处理 RPC 视图不一致、链上时间、重组、已广播交易及 nonce 状态。
- 钱包：本地私钥与适配层同进程；真实部署须隔离权限，避免绕过 Lean 批准。当前模型假设适配层可信。
- 持久化：日志没有事务提交、fsync、恢复后的授权控制，不能承诺恢复安全。
- A2A：尚未运行官方 SDK 的任务创建/取消/重试实验，上述结论来自规范，不来自 SDK 测试。
- VDSI：空工作区及同级 README 未发现 VDSI，保持独立；没有往其他项目添加依赖。

学习顺序建议：先看 `advance` 的四态迁移，再看 SDK signer 回调与 handoff 的顺序，最后运行 timeout 与 unpaid，对比“等待结束”和“可以安全回收”为什么不是同一回事。
