# 方案：AI 对话窗口 X 按钮语义纠正（关闭窗口 ≠ 删除会话）

> 状态：已定方案（方案 A），未实施。
> 起因：用户反馈「只是关闭 AI 对话的窗口，却把对话删除了」。
> 日期：2026-11-01。

## 一、问题

AI 对话窗口右上角的 X 按钮，当前真实语义是 `deleteSession`——不可逆硬删链路：
同步销毁内存 store + 异步删磁盘 JSONL（`dialogStorageService.deleteConversation`）
+ 异步删后端消息库（`message_delete_by_conversation`）。

用户的真实需求：X 按钮只做「关闭窗口」（从多窗口视图移除），会话数据必须保留，
之后可从历史面板 / 快速切换恢复。

根因有三处入口错把「关闭窗口」实现成了「删除会话」，且 QuickSwitchPanel 还有一条
用「内存瞬时消息数 ≤2」免确认直删的脆弱分支（paging/后台/流式时序下内存 messages
可能瞬时偏小，导致带内容的会话被零确认硬删）。

## 二、方案 A（定稿）

**核心：分离「关闭窗口」与「删除会话」两个动作。**

- 窗口 X（对话窗口本身的关闭按钮）→ 只做 `removeFromMultiView`（纯 viewStore 操作，
  只过滤 `multiSessionIds`，不碰内存 store / JSONL / 后端消息）。
- 删除会话动作集中到 QuickSwitchPanel（快速切换浮层）与历史面板，保留二次确认。

### 三处入口改法

| # | 入口 | 文件:行 | 当前行为 | 改后行为 |
|---|---|---|---|---|
| 1 | SessionCell（多窗口格子右上角 X） | `SessionCell.tsx:106-108` (`handleClose`) | 弹确认 → `deleteSession` | `useViewStore.getState().removeFromMultiView(sessionId)`，无确认、无弹窗 |
| 2 | SessionTab（会话标签 X） | `SessionTabs.tsx:75-78` (`handleClose`) → `SessionTab.tsx:127` | 弹确认 → `deleteSession` | `removeFromMultiView(sessionId)`，无确认、无弹窗 |
| 3 | QuickSwitchPanel（快速切换列表 X） | `QuickSwitchPanel.tsx:193-199` (`handleDeleteSession`) | `LOW_VALUE_MESSAGE_COUNT≤2` 免确认直删，否则弹确认 | **保留删除语义**，但去掉 `LOW_VALUE_MESSAGE_COUNT` 免确认分支，统一走二次确认 |

### 边界与不受影响项

- `removeFromMultiView`（`viewStore.ts:356`）已是纯视图操作，无需改动。
- `deleteSession`（`sessionStoreManager.ts:238`）本身不动——它仍是删除动作的权威实现，
  只是窗口 X 不再调用它。历史面板 `SessionHistoryPanel` 的删除入口保持不变（本就有确认）。
- `SessionDeleteConfirm` 组件不删——QuickSwitchPanel 与历史面板仍复用。
- SessionTabs / SessionCell 中因窗口 X 改语义而不再使用的 `SessionDeleteConfirm` 引用、
  `deleteConfirmTarget` state、相关 import 一并清理（避免死代码）。
- SessionTabs 的 `canClose`（`visibleSessions.length > 1`，至少保留一个会话）守卫保留——
  关闭最后一个窗口格无意义，应禁用 X 或回退为新建会话占位。
- 若被关闭的会话是当前 `activeSessionId`，需把活跃切到视图内剩余会话（参照
  `deleteSession` 在 `sessionStoreManager.ts:286-292` 的切换逻辑；`removeFromMultiView`
  本身不切活跃，需在调用处或 viewStore 补一个「移出后若失活则切到剩余首个」的协调，
  避免活跃会话被移出视图后主区域悬空）。

## 三、验收

- [ ] SessionCell / SessionTab 的 X 点击后：会话从多窗口视图消失，但
  `sessionStoreManager.stores` 仍含该会话、JSONL 文件仍在、后端消息仍在。
- [ ] 被关闭的会话是活跃会话时，活跃自动切到视图内剩余会话，主区域不悬空。
- [ ] QuickSwitchPanel 的 X 对任意会话均弹二次确认，不再有 `≤2 免确认` 路径。
- [ ] 从历史面板 / 快速切换仍可恢复被「关闭窗口」的会话回多窗口视图。
- [ ] `pnpm exec tsc --noEmit` + `pnpm lint` 通过。
- [ ] 更新/新增对应 vitest：SessionCell / SessionTabs 的 X 应调 `removeFromMultiView`
  而非 `deleteSession`；QuickSwitchPanel 删除统一走确认（覆盖原 `≤2` 用例改为始终确认）。

## 四、风险提示

- 切换活跃会话的协调是本方案唯一需要新增逻辑的点（`removeFromMultiView` 不切活跃）。
  实施时须复用既有切换路径，勿新写第二条活跃切换逻辑（AGENTS.md「唯一权威，禁止多写路径」）。
- 若未来引入「按数量驱逐 / 后台超时回收」，受保护会话豁免（`isProtectedSession`）逻辑
  不受本方案影响，二者独立。
