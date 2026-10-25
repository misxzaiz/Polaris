# SimpleAI 中断→再发送竞态修复 spec

> 状态：实施中（2026-10-25）
> 来源：会话中断→再发消息「各种各样的问题」分析（含「立即发送」同款症状）
> 前置文档：`plans/ai-chat-interrupt-continue-root-cause.md`（2026-10-23 首轮根因，其 A/B 两条前端侧至今未修，本 spec 收口）

## 一、问题与根因（六条，均已钉死到代码行）

| # | 病灶 | 位置 | 症状 |
|---|---|---|---|
| R1 | SimpleAI continue 无引擎级互斥：旧轮未真正退出即 spawn 新 run_chat_loop，双循环并发（历史双写覆盖、is_running 被旧轮误清） | `simple_ai/mod.rs:543` `ai_chat_core.rs:1892` | 回显错乱/历史丢失 |
| R2 | 前端 session_end/error 无轮次代际过滤：旧轮迟到的 SessionEnd(Aborted) 误杀新轮流式态（turnId 后端每请求生成、前端零消费；turnEpoch 只护了 interrupt 兜底定时器） | `eventHandler.ts:376` | 新一轮「发出去没反应」/消息分裂 |
| R3 | cap.ai.chat 流式失败只发 `stream.error`（无 sessionId、前端无消费者），continue 排他门拒绝后前端 isStreaming 永久 true | `ai_chat_capability.rs:748` | 永远转圈、无报错 |
| R4 | SimpleAI continue 不发 session_start，前端 status 只认 session_start → 续聊永远灰点（首轮 root cause A 前端侧） | `simple_ai/mod.rs:531` `sessionStoreManager.ts:686` | 「会话没有启动中」 |
| R5 | interrupt() ACK≠真正停下；sendPendingNow 3s / interrupt 5s 兜底超时后本地强制收尾并照发，主动冲进 R1/R2 竞态 | `createConversationStore.ts:2075,2406` | 中断「没反应」后各种异常 |
| R6 | 不可中断窗口：compact 摘要请求不接 abort_rx、MCP 工具调用无 abort 竞速——中断长时间不生效，放大 R5 触发率 | `compact.rs:299` `tools/mod.rs:221,231` | 点停止长时间无响应 |

## 二、修复方案

### B1/B2（对应 R1）：SimpleAI 引擎级轮次互斥
- `SimpleAISession` 增加两个会话级字段（`session.rs`）：
  - `turn_lock: Arc<tokio::sync::Mutex<()>>` —— 同一会话的轮次串行化锁；
  - `run_done_rx: Option<watch::Receiver<bool>>` —— 当前 run 的收尾信号（run 任务持 sender，epilogue 置 true）。
- `start_session` / `continue_session` 的 spawn 任务统一模式：
  1. 持 `turn_lock`（并发 continue 排队）；
  2. 若旧 run 在跑：向**旧 abort 通道**发中断（「立即发送」= 先停旧轮语义），等待 `run_done` 置位（在 sessions 锁外等，不阻塞 interrupt 的 try_lock 快路径）；
  3. 创建新 abort 通道 + 新 done 通道，写回 session（is_running=true、run_done_rx 替换）；
  4. 跑 run_chat_loop；epilogue 写回历史 + is_running=false + `done_tx.send(true)`。
- panic 监督任务（B2.d）同样补发 done 信号，防 panic 后续 continue 永等。

### B3（对应 R3）：cap.ai.chat 流式失败发可路由终态
- `ai_chat_capability.rs` invoke_stream 失败分支：除保留 `stream.error`（补 `sessionId` 字段作原始观测通道）外，追加两条走 `{contextId, payload}` 信封的事件：`{type:'error', sessionId, error}` + `{type:'session_end', sessionId, reason:'error'}`（与引擎错误路径同构）。contextId 取 `options.contextId`（缺省 main），前端 eventRouter 可路由、error handler 置 error + isStreaming=false、session_end handler 收尾。

### B4（对应 R6）：compact 与 MCP 接入中断
- `compact_history` → `summarize_range_rolling` → `request_summary(_once)` 透传 `abort_rx`，摘要请求的 `send_with_retry` 由 `None` 改 `Some(abort_rx)`；`compact_history` 对 `AppError::Interrupted` 直接上抛（此时 messages 未被改动，无需回滚）。chat_loop 的 `?` 将其送至 wrapper 发 SessionEnd(Aborted)。
- `tools/mod.rs` 两处 `pool.call` 用 `tokio::select!` 与 abort 竞速，中断时返回失败 ToolOutcome（"工具调用已被用户中断"）。

### F1（对应 R2）：前端终态事件按 turnId 代际过滤
- `eventRouter.ts`：解析信封 `turnId`，随 `_routeSessionId` 一并注入事件（`_turnId`）。
- `conversationStore` 新增状态 `activeTurnId: string | null` + 动作 `observeTurnEvent(turnId, eventType): boolean`：非终态事件推进 activeTurnId（若为**新轮首事件**且 isStreaming=false，顺带重挂流式态——兜底路径下旧轮终态先于新轮事件到达、未被过滤时的自愈）；终态事件（session_end/error）turnId ≠ activeTurnId 时返回 false。
- `sessionStoreManager.dispatchEvent` 在 handleAIEvent 之前调用 `observeTurnEvent`，false 即整事件丢弃（同时保护元数据 status 更新与 EventBus 广播）。**仅在事件带 `_turnId` 且 activeTurnId 非空时过滤**——旧事件源（scheduler/dispatch 直投、测试）不带 `_turnId`，语义不变。

### F2（对应 R4）：续聊乐观置 running
- `sendMessage` 在 dispatch 成功后把 `sessionMetadata[sessionId].status` 乐观置 `'running'`（SimpleAI 等续聊不发 session_start 的引擎，会话格子不再灰点）。失败路径不置（B3 的 error/session_end 事件会经 dispatchEvent 置 error/idle）。

### F3（对应 R5）：中断等待语义收紧
- `interrupt()`：后端 ACK 后有界等待 `isStreaming` 复位（session_end 到达，8s 上界，5s 兜底定时器仍作最后防线）再 resolve——调用方拿到的语义变为「本轮已真正结束或后端已死」。
- `sendPendingNow`：随 interrupt() 语义强化，二级等待缩为衔接性 2s；强制收尾兜底保留（B1/F1 落地后即使提前发送也安全）。

## 三、修复后时序（对照 spec 前时序图）

```
t0 用户中断 → abort 置位（不变）
t1 旧轮在工具/压缩中（B4 后窗口大幅收窄）→ 兜底超时，前端本地收尾 + 照发
t2 continue 到达后端：turn_lock 排队 → 等旧轮 run_done（旧轮真正退出、发完收尾事件）
t3 新轮启动（新 abort/done 通道）
t4 旧轮迟到 SessionEnd（仅 t1 路径可能）：turnId ≠ activeTurnId → 前端丢弃（F1）
   —— 新轮流式不再被误杀；引擎侧无双循环（B1）；历史无双写覆盖
```

## 四、验收用例

1. **中断→立即发送**（SimpleAI）：流式中点停止，马上在队列点「立即发送」→ 旧轮停、新轮完整输出，无消息分裂、无残留转圈；会话格子变 running（F2）。
2. **工具执行中中断**：AI 正在跑长 bash/MCP 工具时点停止 → bash 轮询路径秒停；MCP 调用即停（B4）；随后发消息正常。
3. **压缩中中断**：上下文压缩提示「正在压缩上下文…」时点停止 → 中断即时生效，随后 continue 正常。
4. **排他门拒绝**：构造 lifecycle running 假态（或后端慢）下 continue → 前端出现明确错误提示且 isStreaming 复位（B3），不再永久转圈。
5. **跨端**：另一端加入的会话，中断/续聊后两端状态一致（turnId 过滤对 WS 事件同样生效）。
6. 既有测试全绿：`pnpm typecheck` / `pnpm lint` / `pnpm test:run` / `cargo check`（本机不可 cargo test --lib，以 check 代替——AGENTS.md 九）。

## 五、实施记录

- **spec**：a6aa30f6
- **B1/B2 引擎级轮次互斥**：3381b681 —— `session.rs` 增 `turn_lock` + `run_done_rx`；`mod.rs` start/continue 统一「持锁贯穿 run + 旧轮在跑先发中断并等 run_done（收尾事件发出后置位）再开新轮」，panic 监督补发 done 信号，continue 兜底路径（会话缺失）保持旧行为。
- **B3 可路由失败终态**：2891a325 —— `ai_chat_capability.rs` 失败分支追加 `error`+`session_end(reason=error)` 双事件（`{contextId,payload}` 信封）；continue 排他门拒绝从闭包 `return` 改为 match 值（此前会绕过失败分发）；`stream.error` 保留并补 `sessionId`。
- **B4 不可中断窗口收窄**：45fae73b —— `compact.rs` 全链路（compact_history → summarize_range_rolling → request_summary(_once)）透传 abort_rx，Interrupted 直接上抛；`tools/mod.rs` 两处 `pool.call` 以 `mcp_call_raced` select 竞速。
- **F1/F2/F3 前端收敛**：23a3108b —— `eventRouter.ts` 提取信封 turnId 注入 `_turnId`；`sessionStoreManager.dispatchEvent` 入口经 `observeTurnEvent` 闸门（旧轮迟到终态整事件丢弃）；新轮首事件顺带重挂 isStreaming（兜底路径自愈）；`sendMessage` 受理后乐观置 running；`interrupt()` ACK 后有界等待收尾再 resolve、`sendPendingNow` 二级等待缩为 2s。新增 `turnFilter.test.ts`（7 用例）。
- **验证**：`tsc --noEmit` 0 错；eslint 改动文件 0 error（1 warning 为存量非改动行）；vitest 全量 2323 passed（唯一失败 `pluginLifecycleSubscriber.test.ts` 2 例经 stash 对照确认为 HEAD 上即失败的存量问题，与本改动无关）；`cargo check` 0 error、改动文件无新增 warning；`cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过。本机 cargo test --lib 不可用（AGENTS.md 九），以 check 代替。
- **遗留观察项**：跨端真机手测（验收 1-5）待做；kill 型引擎（Codex/Pi）的 continue 语义未在本 spec 范围（旧根因 C 仍在）。
