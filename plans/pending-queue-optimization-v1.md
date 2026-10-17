# 对话排队（pendingQueue）优化方案 v1（Rev2：加入按钮状态机 + 队列项编辑撤回）

> 状态：**方案稿**（仅分析 + 规划，未实现）。
> 背景：对照 `temp/ZCode` 的 v4 对话队列（CLI 权威态 + queue 命令面 + autoDrain 暂停）与 Polaris 现状（`pendingQueue` 纯前端内存态）的差距分析（2026-10-18 会话）。
> 对照基准：`temp/ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts`、`temp/ZCode/packages/core/src/runtime/methods/prompt-admission.ts`、`temp/ZCode/packages/ui/src/v4/ConversationQueuePanel.tsx`、`temp/ZCode/packages/ui/src/v4/ConversationComposer.tsx`（按钮状态机）、`temp/ZCode/packages/ui/src/v4/SessionPane.tsx`（撤回编辑）。
> 结论基调：**保留「纯前端内存态」架构（不迁后端权威态），用三个增量补丁解决正确性风险（失败丢队、代际错发、派发竞争），用四个 UI 增强对齐 ZCode 的暂停、状态可视化、按钮状态机与队列项编辑撤回。**
> 目标：P1 正确性优先（低成本），P2 体验增强（中成本）；不做架构级迁移（P3 列为后续演进）。
> **Rev2 变更（2026-10-18）**：新增「增强 3：发送/中断按钮状态机」与「增强 4：队列项编辑撤回」，与 ZCode 对齐；原方案文件清单/验收同步扩展。

---

## 一、问题定义（当前实现定位）

**现状代码**：`src/stores/conversationStore/createConversationStore.ts` 1836-1884 行（入队/出队/立即发送）+ `src/components/Chat/input/ChatInput.tsx` 1140-1340 行（入队分支）+ `src/components/Chat/input/PendingQueueCard.tsx`（UI）。

**ZCode 对比差距**（详见会话分析，此处仅列落地相关结论）：

| 维度 | ZCode（CLI 权威） | Polaris 现状 |
|---|---|---|
| 入队判定 | 后端 `admitPrompt` 统一收口，busy 即自动入队 | 前端 `isStreaming` 判断 |
| 出队时机 | session-ready + goal gate 后 `drainPendingInput` | `session_end` / interrupt 兜底后 `dispatchNextPending` |
| 状态机 | `queued/reserved/promoting` 三段 | 无（仅 `queueDispatching` 布尔防重入） |
| 失败语义 | admission 显式 `rejected` 返回 UI | **sendMessage 失败静默丢队首** |
| 暂停 | stop/error 自动暂停 + 恢复横幅 | **无暂停概念** |
| 排序/编辑 | 拖拽排序 + 单条编辑 | 仅删除 / 立即发送 |
| **按钮状态机** | **streaming + 空草稿 → Stop；有草稿 → 发送键（入队）** | **流式中恒显中断键（1943-1950 行），有草稿也无法发送** |
| **队列项编辑** | **撤回队列项到 composer 编辑（deleteQueueItem 权威删除成功后恢复原文）** | **仅删除/立即发送，无编辑** |

**Polaris 特有风险清单（按优先级）**：

1. **P1 失败丢队**：`dispatchNextPending` 在 `finally` 里判断 `!isStreaming` 继续发下一条（1862-1865 行），但 `sendMessage` 失败时（catch 内把 `isStreaming=false`），**队首已被 `const [next, ...rest]` 移除**，失败项静默丢失、队列继续空转发下一条 → 用户消息无声消失。
2. **P1 代际错发**：`sendPendingNow` 在流式中 `interrupt()` 后 `waitFor(() => !get().isStreaming, 7000)`（1881 行），**等待期间用户可能切会话/开新会话**，等待返回后 `sendMessage` 把旧会话的消息发到**新会话**。`interrupt` 自身有 conversationId 代际校验（2117-2118 行），但 `sendPendingNow` 没有。
3. **P1 派发竞争**：interrupt 兜底路径（2126-2127 行）`void dispatchNextPending()` 与用户点击 `sendPendingNow` 可**同时触发**；`queueDispatching` 只在 dispatchNextPending 入口检查一次，sendPendingNow 只在入口检查一次——两处没有互斥锁，存在双发/乱序窗口。
4. **P2 无暂停**：session_end `reason=error` 时队列仍自动派发下一条（eventHandler.ts 300-302 行），AI 报错后连环发送。
5. **P2 无状态可视化**：用户看不到哪条正在发送（无 `dispatch` 状态），ZCode 有 `queued/reserved/promoting` 三态投影。
6. **P2 按钮状态机缺失**：流式中恒显中断键（ChatInput.tsx 1943-1950 行 `isStreaming && onInterrupt`），**即使用户输入了新内容也无法发送**——只能干等当前回复结束或先中断。ZCode 是 `showStopControl = canStop && !hasDraftToSubmit`（ConversationComposer.tsx 1136 行）：**有草稿 → 发送键（点击入队）；空输入 → 中断键**。这直接影响「流式中预输入」的核心场景——用户一边听回复一边打字，却必须手动中断才能发。
7. **P2 队列项不可编辑**：用户入队后发现写错/想改，只能删除重打。ZCode 支持撤回队列项到 composer（deleteQueueItem 权威删除成功 → 恢复原文草稿），且有草稿冲突守卫 + 代际校验（SessionPane.tsx 3163-3208 行）。

---

## 二、优化方案（三个补丁 + 两个增强，按优先级实施）

### 补丁 A（P1，必做）：失败保留 + 重试

**位置**：`src/stores/conversationStore/createConversationStore.ts` `dispatchNextPending`（1848-1867 行）。

**改动**：
- `sendMessage` 返回 boolean（成功 true / 失败 false），`dispatchNextPending` 依据返回值决定去留：
  - 成功 → 队首已消费，继续发下一条（现状行为）。
  - 失败 → **把该条放回队首**（`set({ pendingQueue: [next, ...rest] })`）并**终止本轮派发**（不再自动发下一条），避免连环失败刷屏；由用户手动重发 / 下次 session_end 再触发。
- 失败重试**不加自动重试计数**：一次失败即停，避免失败循环。用户可点「立即发送」或直接重发。

**连带改动**：`sendMessage` 现有 catch 分支（2060-2067 行附近）设置 `error` 后 `return false`；成功路径 `return true`。**保持签名兼容**：`sendMessage` 返回 `Promise<boolean>`，现有调用方（`ChatInput` 的 `onSend`、`dispatchNextPending`、`sendPendingNow`）不受影响（不消费返回值时忽略即可，TypeScript 不报错）。

**为什么不自动重试**：失败可能是引擎不可用/会话丢失，自动重试会反复触发后端错误，与 ZCode「admission 显式 rejected 交给 UI 决策」一致——失败是用户可见事件，不是静默重试的输入。

### 补丁 B（P1，必做）：sendPendingNow 代际校验

**位置**：`createConversationStore.ts` `sendPendingNow`（1872-1884 行）。

**改动**：
- 在 `waitFor(!isStreaming)` 返回后、`sendMessage` 前，**校验 `get().conversationId` 是否仍是发起时捕获的 `conversationId`**（与 interrupt 兜底 2117 行同款代际校验）：
  - 一致 → 正常发送。
  - 不一致（用户切会话）→ **恢复该条回队列**（`set({ pendingQueue: [target, ...get().pendingQueue] })`，放回队首）并 return，不误发到新会话。
- 同时把「从队列移除」从**发起时**挪到**发送前一刻**（校验通过后），消除「移除后校验失败 → 消息丢」的窗口。（现状 1877 行先移除再中断等待，有 7s 窗口，若用户切会话该条就丢了。）

**边界**：等待期间队列被 `clearPendingQueue` 清空 → 校验 conversationId 失败后放回队首？此时应**尊重清空**：若 `pendingQueue` 已不含该 id（被 clear/remove 过），放回动作改为「不恢复」（因为用户已显式取消）。实现上先检查 `get().pendingQueue.some(m => m.id === id)`，不存在则丢弃。

### 补丁 C（P1，必做）：派发互斥锁

**位置**：`createConversationStore.ts` `dispatchNextPending` + `sendPendingNow` 入口。

**改动**：
- 现有 `queueDispatching: boolean` 升级为互斥语义：`sendPendingNow` 入口**也检查并占用** `queueDispatching`（现状只检查 dispatchNextPending 入口）。
- 具体：`sendPendingNow` 开头 `if (st.queueDispatching) return`；并在 `dispatchNextPending` 的 `finally` 里 `set({ queueDispatching: false })`（现状已是如此），使两者互斥。
- 补充：`sendPendingNow` 内 `interrupt()` + `waitFor` 期间**保持 `queueDispatching=true`**（占住锁），防止 dispatchNextPending 趁机派发下一条造成乱序。
- 效果：任何时刻只有一条在「中断等待 → 发送」路径中，双发窗口消除。

### 增强 1（P2）：暂停/恢复语义（对齐 ZCode autoDrain）

**位置**：`types.ts`（状态）+ `eventHandler.ts`（触发）+ `PendingQueueCard.tsx`（UI）。

**改动**：
- 新增 `queuePaused: boolean` + `queuePauseReason: 'error' | 'stopped' | null` 状态。
- `session_end` 处理（eventHandler.ts 268-310 行）：
  - `reason === 'error'` → `set({ queuePaused: true, queuePauseReason: 'error' })`，**不触发 dispatchNextPending**。
  - `reason === 'completed'` 或正常结束 → 现有 `dispatchNextPending` 行为不变。
  - 用户主动中断（isInterrupting）→ 不暂停（与现有 error 提示抑制逻辑一致，285-291 行）。
- 新增 action `resumePendingQueue()`：`set({ queuePaused: false, queuePauseReason: null })` + `void dispatchNextPending()`。
- UI（`PendingQueueCard`）：`queuePaused` 时显示暂停横幅（含 reason 文案 + 「恢复发送」按钮），替代自动派发。队列胶囊本体逻辑不变。
- **注意**：`session_end` 正常结束但队列为空时 `dispatchNextPending` 已是 noop（1849-1851 行守卫），暂停仅影响非空队列。

### 增强 2（P2）：派发状态可视化（对齐 ZCode dispatch 三态）

**位置**：`types.ts`（PendingMessage 扩展）+ `PendingQueueCard.tsx`（UI）。

**改动**：
- `PendingMessage` 扩展 `status?: 'queued' | 'sending'`（不引入 'promoting' 语义，纯前端无 reserve 概念）。
- `dispatchNextPending` 派发时把队首置 `status: 'sending'`；失败回队首时恢复 `'queued'`（配合补丁 A）。
- `sendPendingNow` 同理。
- UI：正在发送的条目显示 spinner / 高亮（`opacity-60` + 小 spinner），其余 `queued` 状态不变。成本极低（一个布尔派生样式），但对「哪条正在发」的可感知提升明显。

### 增强 3（P2）：发送/中断按钮状态机（对齐 ZCode `showStopControl`）

**位置**：`src/components/Chat/input/ChatInput.tsx` 1943-1960 行（按钮渲染）+ 1474 行（canSend）。

**ZCode 参照**：`ConversationComposer.tsx` 1136 行 `showStopControl = canStop && !hasDraftToSubmit`；1130-1134 行 `canSend = ... && hasDraftToSubmit && ...`。

**改动**：
- **中断键显示条件**从 `isStreaming && onInterrupt`（1943 行）改为 `isStreaming && onInterrupt && !hasDraftToSubmit`：
  - `hasDraftToSubmit = value.trim() || attachments.length > 0 || contextBlocksRef.current.length > 0`（与 `canSend` 同源，1474 行）。
  - 有草稿 → 显示**发送键**（点击走 `handleSend`，流式分支自动入队——现有 1151-1223 行逻辑已支持）。
  - 空输入 → 显示**中断键**（点击 `onInterrupt`）。
- **发送键点击语义**：流式中点击发送键 = 入队（现有 `handleSend` 的 isStreaming 分支已实现 1152 行），无需新逻辑；空闲时点击 = 直接发送（现有行为不变）。
- `canSend` 逻辑本身不变（1474 行），但注意：流式中 `isStreaming` 为 true 时 `canSend` 仍为 true（它只看内容/disabled，不看 isStreaming），所以发送键 enabled 状态正确。

**UI 细节**：发送键在流式+有草稿时保持 primary 样式（与空闲发送一致），可加角标「将入队」提示（可选，不做硬性要求）；中断键保持现有 danger 样式。

**边界**：
- 编辑模式（editMode）下保持现有行为：流式中不会进入编辑模式（编辑入口在非流式），无需特殊处理。
- 语音命令 `send`（1346-1350 行）在流式中不发送（保持现状）——按钮状态机只管按钮，语音路径不动。
- `pendingQueue` 非空但输入框为空时：Enter 已支持发送队首（1145-1147 行），此时按钮显示哪个？**有草稿 → 发送键；无草稿 → 中断键**（与 ZCode 一致——队列项不是「草稿」，空输入时仍显示中断，Enter 快捷键负责队列首条发送）。

### 增强 4（P2）：队列项编辑撤回（对齐 ZCode `onEditItem`）

**位置**：`src/components/Chat/input/PendingQueueCard.tsx`（UI）+ `createConversationStore.ts`（action）+ `types.ts`（action 签名）。

**ZCode 参照**：`SessionPane.tsx` 3163-3208 行 `handleEditQueueItem`：① composer 有内容/busy → 冲突 toast 拒绝；② `resolveQueuedComposerRestore` 从投影取原文；③ `deleteQueueItem`（权威删除）成功后恢复原文到 composer；④ ACK 返回前 pane 已切换 → 放弃恢复（代际校验）。

**Polaris 改动（纯前端，无后端协议）**：
- 新增 action `editPending(id)`：
  1. 从 `pendingQueue` 找目标项；找不到 → return。
  2. **草稿冲突守卫**：`inputDraft.text` 非空或 attachments 非空 → toast 提示「输入框已有内容，请先清空或发送」，return（对齐 ZCode 的 `composerDraftStateRef.current.hasContent` 冲突提示）。
  3. 从队列移除该条（对齐 ZCode「权威删除成功后恢复」：此处删除即成功，因队列是纯前端态，无后端 ACK 等待）。
  4. 把 `target.text` 恢复到输入框草稿（`updateInputDraft({ text: target.text, attachments: [], contextBlocks: [] })`），聚焦输入框。
- **附件处理**：队列项带附件时（`target.attachments` 非空），恢复到草稿的 attachments（对齐 ZCode 恢复完整 QueueItem 语义）；Polaris 草稿支持 attachments，直接恢复即可。
- UI（`PendingQueueCard`）：每条目加「编辑」按钮（Pencil 图标，与现有 X 删除并排），点击调 `editPending(msg.id)`。
- **不引入「撤回等待中」状态**：纯前端队列删除即成功，无 ZCode 的 `pendingEditQueueItemId` ACK 等待（后端权威才需要）。

**边界**：
- 编辑恢复的是**入队时文本**（`msg.text`，可能是上下文块打包后的内容），不是原始输入——与 ZCode 恢复 QueueItem.text 一致（也是打包后文本），接受。
- `status === 'sending'` 的条目不可编辑（正在发），UI 禁用编辑按钮（与 `dispatchLocked` 对齐）。

---

## 三、涉及文件清单

| 文件 | 改动 |
|---|---|
| `src/types/chat.ts` | `PendingMessage` 增加 `status?` 字段（增强 2） |
| `src/stores/conversationStore/types.ts` | 增加 `queuePaused/queuePauseReason` 状态 + `resumePendingQueue` action（增强 1）；`queueDispatching` 注释更新为互斥锁语义（补丁 C）；`editPending` action 签名（增强 4） |
| `src/stores/conversationStore/createConversationStore.ts` | 补丁 A（sendMessage 返回 bool + dispatchNextPending 失败回队首）、补丁 B（sendPendingNow 代际校验 + 移动移除时机）、补丁 C（sendPendingNow 占用锁）、增强 2（status 置位）、增强 4（editPending action） |
| `src/stores/conversationStore/eventHandler.ts` | 增强 1：session_end reason=error 暂停队列、抑制自动派发 |
| `src/stores/conversationStore/useActiveSession.ts` | 暴露 `resumePendingQueue` / `queuePaused` / `editPending` 给 UI |
| `src/components/Chat/input/PendingQueueCard.tsx` | 增强 1 暂停横幅 + 恢复按钮；增强 2 派发中 spinner；增强 4 编辑按钮 |
| `src/components/Chat/input/ChatInput.tsx` | **增强 3**：中断键显示条件改为 `isStreaming && onInterrupt && !hasDraftToSubmit`（1943 行）；`hasDraftToSubmit` 复用 `canSend` 内容判定（1474 行） |

## 四、验收标准

1. **补丁 A**：vitest 新增 `pendingQueue.dispatch.test.ts`：
   - sendMessage 失败 → 队首保留、队列不继续派发、`isStreaming=false`；
   - sendMessage 成功 → 队首消费、自动派发下一条。
   - 参照现有 `eventHandler.sessionEnd.test.ts` / `eventHandler.interrupt.test.ts` 的 store 装配方式。
2. **补丁 B**：`sendPendingNow` 在等待期间 conversationId 变化 → 该条放回队首（或尊重 clear 丢弃），**不发到新会话**。
3. **补丁 C**：`sendPendingNow` 与 `dispatchNextPending` 并发调用 → 只有一条进入发送路径（`queueDispatching` 互斥断言）。
4. **增强 1**：session_end reason=error 且队列非空 → `queuePaused=true`、不自动派发；`resumePendingQueue()` 后正常派发。
5. **增强 2**：派发中条目 `status='sending'`，UI 显示高亮/spinner。
6. **增强 3**：vitest 或手工验证 ChatInput：
   - 流式 + 输入框有内容 → 显示发送键（点击入队，队列 +1）；
   - 流式 + 输入框为空 → 显示中断键（点击中断）；
   - 空闲 + 有内容 → 发送键（直接发送）；
   - 回归：现有 `ChatInput` 相关测试不回归。
7. **增强 4**：`editPending(id)`：
   - 输入框为空 → 队列项移除 + 原文恢复草稿；
   - 输入框非空 → toast 冲突提示、队列不变；
   - `status='sending'` 条目 → 编辑按钮禁用。
8. **回归**：`pnpm exec tsc --noEmit` + `pnpm test:run`（conversationStore 相关）+ `pnpm lint` 通过；现有 `eventHandler.sessionEnd.test.ts` / `eventHandler.interrupt.test.ts` 不回归。

## 五、明确不做（边界声明）

- **不迁后端权威队列**（ZCode CLI 权威态）：改动面 = 协议 AIEvent + 后端 `ai_chat_core` admission + session-v2 状态机 + 插件契约，超出本次「排队正确性」目标。列为后续演进项（P3），如出现「多端同会话排队」需求再启动。
- **不做队列持久化**：ZCode 明确不持久化（进程死亡即丢）；Polaris 会话切换即清空（1827 行）与之一致，是合理取舍。
- **不做拖拽排序**：当前 PendingQueueCard 的删除/立即发送/编辑（增强 4）已覆盖主要场景；拖拽排序需引入 dnd-kit，属额外体验增强，可后续单独评估。
- **不做自动重试**：失败即停、用户可见，避免失败循环刷屏。
- **增强 4 不做后端权威删除 ACK 等待**：纯前端队列删除即成功，无需 ZCode 的 `pendingEditQueueItemId` ACK 状态（那是对齐后端权威态才需要）。

---

## 六、风险与依赖

- **sendMessage 返回类型变更**：`Promise<void> → Promise<boolean>`，需检查全部调用点（`ChatInput.onSend`、`sendPendingNow`、`dispatchNextPending`、`useActiveSession` 透传）。TS 对忽略返回值无报错，风险低；但需跑 `pnpm exec tsc --noEmit` 确认。
- **eventHandler 测试装配**：`eventHandler.sessionEnd.test.ts` 已存在 mock 装配（300 行 `typeof get().dispatchNextPending === 'function'` 防御），新增 `queuePaused` 状态时需同步 mock 默认值，避免破坏既有测试。
- **暂停语义与「用户主动中断」交互**：中断（isInterrupting）不暂停队列（增强 1 已明确），与 eventHandler 285-291 行的 error 抑制逻辑保持一致。
