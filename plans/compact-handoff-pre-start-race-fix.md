# 压缩交接空窗竞态修复（compact handoff pre-start race）

> 2026-11-06。用户报告「压缩交接失败 / 压缩引擎未产出简报内容」。
> 前一轮修复（a5213717）针对的是 finishMessage 归档竞态；本次是另一个更早的主竞态。

## 问题

压缩会话 `sendMessage` 返回后、引擎产出首个事件之前（claude-code 等 CLI 引擎有 1~3s 空窗），
`waitKernelSessionStreamEnd` 查后端 lifecycle 状态（session-v2 权威）得到 idle（事件日志尚空，
`session_start` 由首事件补写，`ai_chat_core.rs:1255`），提前 resolve →
`extractLastAssistantText` 空 → `emptyBriefing`；finally 还 interrupt+销毁刚起步的压缩会话。

SimpleAI 不受影响（`start_session` 同步发 `SessionStart`）；claude-code / opencode 基本必现。

旧实现（e998033d 迁移前）订阅 store 本地 `isStreaming`，而 `sendMessage` 乐观置 true，
入口检查不成立，天然免疫——迁移到后端权威后失去该信号。

## 方案（最小改动）

`waitKernelSessionStreamEnd` 增加可选 `requireRunEvidence` 语义：

- **关闭（默认）**：行为与现状完全一致（idle 即 resolve），零回归；
- **开启**：必须先观测到 `running`（订阅推送或一次性查询任一来源），此后才认 idle/error
  下降沿；从未观测到 running 则保持等待，由调用方 timeout 兜底（压缩场景 15min 已有）。

不改后端：dispatch 受理即写 lifecycle start 会与 claude temp_id→real_id 事件记账机制冲突
（lifecycle 按事件真实 session_id 记账），改动面大且影响跨端语义。

## 改动点

1. `src/session-v2/hooks/useKernelSessionState.ts`：
   `waitKernelSessionStreamEnd(sessionId, { requireRunEvidence?: boolean, ... })`。
   订阅回调与一次性兜底查询两处都要遵守该门控（否则空窗查询仍提前 resolve）。
   注意：`state: 'none'`（kernel 无此会话）在 requireRunEvidence 下**不**提前 resolve——
   一次性查询查不到会话（如前端 store 尚未建 conversationId 映射的极早期）同样处于空窗。
2. `src/services/contextCompactHandoff.ts`：`waitForIdle` 传 `requireRunEvidence: true`。
   发送失败路径不受影响（`sendMessage` catch 置 error，`:146` 早退）。
3. 测试：`src/session-v2/tests/case-4c-kernel-session-state.test.ts` 补
   requireRunEvidence 用例（空窗 idle 不 resolve / 观测 running 后下降沿 resolve / 超时仍兜底）；
   既有 4 个用例必须保持全绿（默认语义零变更）。

## 另一个消费方的影响评估

`radioBroadcastController.ts:937` 也用 `waitKernelSessionStreamEnd`（simple-ai，免疫空窗；
未传 requireRunEvidence，行为不变）。若后续电台切 CLI 引擎，同样需要传 true。

## 验收

- [x] 新用例：requireRunEvidence 下「订阅前查询 idle + 稍后 running→idle」resolve（模拟空窗）
- [x] 新用例：requireRunEvidence 下从未 running → 由 timeout reject（不提前 resolve）
- [x] 默认（不传）4 个既有用例零回归
- [x] `pnpm typecheck` / `pnpm lint` 通过
