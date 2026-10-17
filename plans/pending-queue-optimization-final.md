# 对话排队（pendingQueue）优化 — 最终定稿

> 状态：**定稿（确定实施方案）**。基于 `plans/pending-queue-optimization-v1.md`（过程稿）二次规划，收口为两批次交付。
> 决策依据：`v1` 提出 3 补丁 + 4 增强；本次二次规划按「**收益/成本比 + 用户体验友好度**」重排为 **批次 1（核心必做，一次交付）** + **批次 2（体验完善，单独交付）**。
> 对照基准：`temp/ZCode` v4 队列（`queue.ts` 命令面 / `prompt-admission.ts` 入队收口 / `ConversationComposer.tsx` 按钮状态机 / `SessionPane.tsx` 编辑撤回）。
> 架构前提：**保留纯前端内存态**，不迁后端权威队列（理由见「边界」）。

---

## 〇、定稿结论（一句话）

**批次 1（5 项，必做）**：正确性三补丁（失败保留 / 代际校验 / 派发互斥）+ 两个用户点名 UX（流式可发送按钮状态机、队列项编辑撤回）——这 5 项是本方案收益最大部分，一个 PR 交付。

**批次 2（2 项，可选，单独交付）**：失败暂停横幅（对齐 autoDrain）+ 派发中 spinner。收益存在但独立于核心闭环，不阻塞批次 1。

---

## 一、批次 1（核心必做）

### 补丁 A：失败保留 + 停止空转（P1，正确性）

**位置**：`createConversationStore.ts` `dispatchNextPending`（1848-1867）+ `sendMessage`（2069-2080）。

**现状缺陷**：`const [next, ...rest]` 先出队（1853），`sendMessage` 失败后 catch 只置 `isStreaming=false`，**队首已丢**；`finally` 见 `!isStreaming` 继续发下一条（1863-1865）→ 用户消息无声消失 + 连环空转。

**改动**：
- `sendMessage` 返回类型 `Promise<void> → Promise<boolean>`（types.ts:636）：
  - 成功：try 末尾（2070 行后）`return true`；
  - 失败：catch（2071-2080）置 error 后 `return false`。
- `dispatchNextPending` 消费返回值：
  - `true` → 队首已消费，`finally` 继续 `dispatchNextPending()`（现状行为）；
  - `false` → **队首放回**（`set({ pendingQueue: [next, ...rest] })`），**终止本轮派发**（不递归），等用户手动重发 / 下次 session_end 再触发。
- 失败时 toast 提示「发送失败，已保留在待发队列」（用户可点「立即发送」重试）——不再无声。

**与增强 1 的关系**：补丁 A 治「单条发送失败丢失」，增强 1 治「AI 回复失败后整个队列连环发」——场景不同，批次 2 单独评估，不阻塞批次 1。

### 补丁 B：sendPendingNow 代际校验（P1，正确性）

**位置**：`createConversationStore.ts` `sendPendingNow`（1872-1884）。

**现状缺陷**：先移除（1877）→ 流式则 `interrupt()` + `waitFor(!isStreaming, 7000)`（1879-1881）→ 发送。等待窗口内用户切会话 → 消息发到**新会话**或静默丢失。`interrupt` 自身有 conversationId 代际校验（2117-2118），sendPendingNow 没有。

**改动**：
- 「从队列移除」从发起时（1877）**后移到发送前一刻**（校验通过后），消除「移除后校验失败 → 丢」窗口；
- `waitFor` 返回后校验 `get().conversationId` 是否仍为发起时捕获值：
  - 一致 → 移除 + `sendMessage`；
  - 不一致 → 若 `pendingQueue` 仍含该 id（未被 clear/remove）则**放回队首**，否则丢弃（尊重用户显式取消）。

### 补丁 C：派发互斥锁（P1，正确性）

**位置**：`createConversationStore.ts` `dispatchNextPending` + `sendPendingNow` 入口。

**现状缺陷**：`interrupt` 兜底 `void dispatchNextPending()`（2127/2139）与用户点 `sendPendingNow` 可同时触发；`queueDispatching` 只挡 dispatchNextPending 入口，sendPendingNow 不占用 → 双发/乱序窗口。

**改动**：
- `sendPendingNow` 入口：`if (st.queueDispatching) return`，并 `set({ queueDispatching: true })`；贯穿 interrupt 等待，`finally` 释放；
- 效果：任意时刻只有一条在「中断等待 → 发送」路径。

### 增强 3：发送/中断按钮状态机（P2，用户点名 UX）

**位置**：`ChatInput.tsx` 1943-1960（按钮渲染）+ 1474（canSend）。

**ZCode 参照**：`showStopControl = canStop && !hasDraftToSubmit`（Composer.tsx:1136）——有草稿发发送键，空草稿发中断键。

**改动**（一处条件 + 一个派生常量，改动极小）：
- 新增 `hasDraftToSubmit = value.trim() || attachments.length > 0 || contextBlocksRef.current.length > 0`（复用 canSend 内容判定，1474）；
- 中断键显示条件 `isStreaming && onInterrupt` → `isStreaming && onInterrupt && !hasDraftToSubmit`；
- 流式 + 有草稿 → **发送键**（点击走 `handleSend` → 现有 1152 分支自动入队，不新写逻辑）；
- 流式 + 空 → **中断键**（不变）；
- 空闲 + 有内容 → **发送键**（直接发送，不变）。

**UX 细则**：
- 发送键在流式 + 有草稿时保持 primary 样式，tooltip 提示「发送（流式中将排队）」；
- 队列非空但输入框空 → 仍显示中断键（Enter 已支持发队首，1145-1147，不重复入口）；
- 语音 `send` 命令流式中不发送（1346-1350）保持现状，按钮状态机不管语音路径。

### 增强 4：队列项编辑撤回（P2，用户点名 UX）

**位置**：`createConversationStore.ts`（action）+ `types.ts`（签名）+ `PendingQueueCard.tsx`（UI）。

**ZCode 参照**：`handleEditQueueItem`（SessionPane.tsx:3163-3208）——草稿冲突守卫 → 权威删除 → 恢复原文。Polaris 纯前端队列「删除即成功」，省略 ACK 等待态。

**改动**（新 action `editPending(id)`）：
1. 队列中找不到该 id → return；
2. **草稿冲突守卫**：`inputDraft.text` 非空或 attachments 非空 → toast「输入框已有内容，请先清空或发送」，return；
3. 从队列移除该条；
4. 恢复 `target.text`（含 attachments）到 store 草稿 `updateInputDraft(...)`——**UI 自动同步**（ChatInput:242 inputDraft effect），再 `chat:focus-input` 事件聚焦（复用 250 行现有机制）。

**依赖支撑**：`PendingMessage` 增加 `status?: 'queued' | 'sending'` 字段——`status='sending'` 的条目禁用编辑按钮（正在发不可撤回）。该字段同时供批次 2 spinner 使用，一步到位。

**UI**：每条目加 Pencil 编辑按钮（与 X 删除并排）；sending 条目禁用。

---

## 二、批次 2（体验完善，单独交付，不阻塞批次 1）

### 增强 1：失败暂停 / 恢复横幅（对齐 ZCode autoDrain）

- `types.ts` 增 `queuePaused: boolean` + `queuePauseReason: 'error' | 'stopped' | null`；
- `eventHandler.ts` session_end（268-310）`reason === 'error'` → `queuePaused=true`、**抑制 dispatchNextPending**；用户主动中断（isInterrupting）不暂停；
- 新 action `resumePendingQueue()`：解除暂停 + `void dispatchNextPending()`；
- `PendingQueueCard` 暂停横幅（reason 文案 + 「恢复发送」按钮）。

### 增强 2：派发中 spinner

- 批次 1 已加 `status` 字段，此处仅 UI：`status='sending'` 条目显示小 spinner / 高亮。

---

## 三、文件清单（批次 1）

| 文件 | 改动 |
|---|---|
| `src/types/chat.ts` | `PendingMessage` 增 `status?: 'queued'\|'sending'`（增强 4 支撑） |
| `src/stores/conversationStore/types.ts` | `sendMessage` 返回 `Promise<boolean>`（补丁 A）；`editPending` 签名（增强 4） |
| `src/stores/conversationStore/createConversationStore.ts` | 补丁 A（return true/false + 失败回队首停派发）、补丁 B（代际校验 + 移除时机后移）、补丁 C（sendPendingNow 占锁）、增强 4（editPending action�� |
| `src/stores/conversationStore/useActiveSession.ts` | `editPending` 透传；`sendMessage` 包装层透传返回值（一行） |
| `src/components/Chat/input/ChatInput.tsx` | 增强 3：`hasDraftToSubmit` + 中断键条件；tooltip 「将排队」 |
| `src/components/Chat/input/PendingQueueCard.tsx` | 增强 4：编辑按钮（Pencil）+ sending 禁用 |

**批次 2 追加**：`eventHandler.ts`（暂停触发）、`PendingQueueCard.tsx`（横幅 + spinner）。

## 四、验收标准（批次 1）

1. **补丁 A**：vitest `pendingQueue.dispatch.test.ts`——sendMessage 失败 → 队首保留、不继续派发、isStreaming=false；成功 → 队首消费、自动派发下一条。
2. **补丁 B**：`sendPendingNow` 等待期间 conversationId 变化 → 放回队首（或尊重 clear 丢弃），不发到新会话。
3. **补丁 C**：`sendPendingNow` 与 `dispatchNextPending` 并发 → 仅一条进入发送路径。
4. **增强 3**：流式+有内容 → 发送键（点击入队，队列 +1）；流式+空 → 中断键；空闲+有内容 → 发送键直接发送。
5. **增强 4**：`editPending(id)` 输入框空 → 队列移除 + 草稿恢复（UI 自动同步）+ 聚焦；输入框非空 → toast 冲突、队列不变；sending 条目按钮禁用。
6. **回归**：`pnpm exec tsc --noEmit` + `pnpm test:run`（conversationStore）+ `pnpm lint`；现有 `eventHandler.sessionEnd.test.ts` / `eventHandler.interrupt.test.ts` 不回归。

## 五、边界（明确不做，已确认）

- **不迁后端权威队列**（ZCode CLI 权威态）：需改 AIEvent 协议 + `ai_chat_core` admission + session-v2 状态机 + 插件契约，成本远超收益。仅当出现「多端同会话排队」需求再启动（P3 演进）。
- **不做队列持久化**：与 ZCode 一致（进程死亡即丢），会话切换即清空是合理取舍。
- **不做拖拽排序**：删除 / 立即发送 / 编辑（增强 4）已覆盖主要场景；dnd-kit 属额外依赖，后续单独评估。
- **不做自动重试**：失败即停、用户可见（toast），避免失败循环刷屏。

## 六、风险与依赖

- **sendMessage 返回类型变更**（void → boolean）：调用点 = `dispatchNextPending` / `sendPendingNow` / `useActiveSessionActions` 包装 / `App.tsx onSend`。TS 忽略返回值不报错，但 `useActiveSessionActions().sendMessage` 包装（244-255）需补 `return` 透传，否则 kernel 返回丢失——批次 1 已列入文件清单。
- **eventHandler 测试装配**：新增字段 `queuePaused`（批次 2）需同步 mock 默认值；批次 1 不动 eventHandler，风险更低。
- **补丁 B 与补丁 C 交互**：`sendPendingNow` 占锁期间 interrupt 兜底（2127）的 `dispatchNextPending` 会因锁被挡——正是期望语义（互斥）。