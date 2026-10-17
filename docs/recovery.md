# 崩溃恢复、可信结果与钱包权限

检查日期：2026-10-17。此阶段是可运行的本地持久化实验，继续使用同一个 Lean 决策核心，不连接链或真实资金。

## 运行与展示

    npm ci
    npm run build
    npm test
    npm run demo:recovery -- --config examples/demo.json --data runtime-data/first

默认在 handoff:committed 强制 SIGKILL 钱包进程：授权已持久化、Lean 已允许交出，但 HTTP 尚未发送。演示随后启动新进程，恢复同一任务，查询并按需重发同一份授权，显示 A 的状态和 B 的拒绝原因。总预算、可用、预留、在途、花费均以最小单位显示；服务结果与付款分别记录。

可用 --fault wallet:signed 展示签完但未交出时崩溃，恢复后释放；用 --fault wallet:after-send 展示服务请求结束后、预算确认前崩溃。每次展示新故障请指定新目录。重复使用目录会恢复原预算和原请求，**不会重置资金或再次制造已完成请求的故障**。更改配置请用新目录；当前不做已存在任务的迁移。

npm run demo 仍是 V1 内存演示；npm run replay 仍是 V1 JSONL 观察日志重放。这两个命令不提供恢复功能。新命令的数据在 runtime-data，包含模拟私钥及授权，已加入 gitignore，不应公开分享。不要一边运行一边手工复制部分 SQLite 文件作为备份。

## 工程结构

    Agent A/B → scoped bearer HTTP → 钱包 Broker → Lean JSON 行进程
                                         ↕
                              SQLite 命令/回复/签名 outbox
                                         ↓
                           真实 SDK 签名与 HTTP 付款请求
                                         ↓
                        独立模拟结算进程 → 持久化付款/禁用
                                         ↓
                            Ed25519 签名结果 → Broker 校验

| 文件 | 职责 |
|---|---|
| adapter/durable/store.ts | SQLite WAL + synchronous FULL；单独 owner 数据库持有写事务，防止两个管理者打开同一目录 |
| adapter/durable/core.ts | 命令先持久化，再调用 Lean，再持久化回复；启动逐条重放并比较已有回复 |
| adapter/durable/broker.ts | 唯一钱包私钥持有者、签名 outbox、恢复规则、Agent 权限和结果验证入口 |
| adapter/durable/authority.ts | 独立收费服务、SDK 验证、持久化模拟结算、永久禁用和证据签名 |
| adapter/durable/evidence.ts | Ed25519 签名、固定公钥、完整绑定和新鲜查询 challenge 校验 |
| adapter/durable/worker.ts / process.ts | 独立进程、可信控制器 IPC、故障注入和生命周期 |
| adapter/recovery-demo.ts | 启动、强制崩溃、重启与终态展示 |
| tests/durable.test.ts | 真 SIGKILL 测试、越权请求、证据伪造、恢复与禁用验证 |

## 恢复顺序

1. 创建包含 nonce 和签名摘要的 job，先落盘；请求 Lean 预留。核心命令在执行前落盘，避免执行成功但回复丢失后遗忘决定。
2. 签名只在预留获准后生成；完整原始付款 payload 先落盘。
3. 向 Lean 提交 handoff；命令与回复均落盘后，才允许把授权发送给服务。
4. 重启时重新运行同一个 Lean 二进制，用原始命令和时间重放。已记录的回复必须一致；没有回复的最后一个命令重新计算并补记。
5. Reserved 安全释放：它对应的授权从未获得发送许可。InFlight 继续占用：先查询证据，未确定则只能重发已保存的原始签名和 nonce。
6. 相同 Agent + requestId 永远映射原 job；不能通过重复请求生成第二份授权。Settled / Released 不会再次发送。

启动恢复完成之前不开放 Agent HTTP。配置、任务、固定证据公钥或 Lean 二进制变化会拒绝恢复，要求显式迁移。历史缺少匹配 job、回复重放不同或数据库损坏也应停止；不重建空预算继续工作。命令持久化或 Lean 通信失败后，本次核心实例停止接受新转换。

这里先记录可恢复决定，再做外部动作，不提供跨 SQLite 和网络的原子事务。网络可重复发送；避免重复结算依赖模拟器按完整付款标识幂等处理，未来链上适配必须提供相应保证。

## 结果信任

控制器通过私有父子进程 IPC 配置结算方公钥和查询能力。Broker 固定该公钥，并要求每份证据同时匹配任务、完整 Binding、随机 challenge、状态和模拟交易标识。HTTP 200、服务失败、超时或签名授权过期都不会直接改变花费。

paid 证据允许确认；disabled 证据表示该模拟器持久化了“未付款且永不再接受该授权”的禁用记录。已付款不可改成禁用。未知、等待、签名错误、上下文错误、查询失败都保留 InFlight。禁用记录跨结算进程重启保留，迟到原授权仍被拒绝。

这些证据是 **AgentBudget 自定义的本地模拟协议**，不是 x402 标准查询接口，也不是链上未付款证明。模拟付款用持久化 dueAt 表示到期结算；重启查询时按该时间恢复结果。这不是链共识或 RPC 最终性模型。SDK 的报价、EIP-3009 payload、EOA 签名校验和 HTTP 头仍是真实调用，合约预执行、结算和证据权威是模拟。

## Agent 钱包权限

每个 Agent 只有自身 bearer capability。购买接口只接受 requestId，金额、资产、网络和收款方来自配置及严格匹配的报价。Agent 不能指定另一 Agent、注入签名内容、读私钥、提交 paid/unpaidFinal、取消任务或禁用付款。取消和禁用仅向可信父进程 IPC 开放。钱包回复不包含可付款授权。

这是进程与 API 权限隔离。钱包密钥目前以明文保存在受目录权限保护的本地数据库中，**不是 HSM，也不防拥有同一操作系统用户权限的恶意代码读取磁盘或修改程序**。父进程是可信控制器。真正运行不可信 Agent 仍需不同 OS 用户、容器/沙箱或外部钱包服务，并收紧网络访问。

## 证明与测试边界

原有 Lean 守恒、终态幂等和释放/授权互斥证明继续适用。新增 replay_prefix_suffix 证明：从相同已提交前缀继续执行，与连续执行整个事件序列相同。它假设持久化保存了正确事件，**没有证明 SQLite、TypeScript、签名、文件系统或 SDK 正确性**。

自动测试在 14 个钱包/核心边界使用 SIGKILL，包括 reserve/handoff/paid 的 intent、applied、committed，以及签名前后、发送前后和证据验证之后；另测结算进程崩溃、永久禁用跨重启、重复请求、配置/公钥变化、单一管理者锁、越权接口、跨 Agent 请求和伪造证据。测试是进程崩溃验证，没有做真实断电、磁盘写入失败、文件回滚、备份恢复或硬件故障验证。SQLite 的磁盘同步保证还依赖操作系统和存储设备。

下一步最适合接手：用独立钱包服务替换本地密钥；为真实 facilitator 定义证据校验与最终性条件；增加磁盘故障与备份迁移测试。A2A 仍未接入，不将内部任务称作 A2A 兼容。
