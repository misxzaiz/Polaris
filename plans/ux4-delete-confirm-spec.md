# UX-4 删除会话零确认不可逆 — 修复 spec

## 目标
删除会话是三重硬删（内存 dispose + JSONL `deleteConversation` + 后端 `message_delete_by_conversation`，
见 `src/stores/conversationStore/sessionStoreManager.ts:238-267`），且两个入口均零确认直调，
属不可逆破坏性操作无防护。本次为两个删除入口接入现有 `ConfirmDialog`，并修正误导性按钮语义。

## 改动点
1. `QuickSwitchPanel.tsx`：`handleDeleteSession` 先弹确认（ConfirmDialog，type=danger）再
   `deleteSession`；确认框经 `createPortal(document.body)` 渲染——根容器 `z-20` +
   `pointer-events-none` 会困住子元素（同 `NewSessionPanel` portal 先例）。
2. `SessionHistoryPanel.tsx`：`handleDelete` 前同样接 ConfirmDialog（文件尾部与 forkTarget 并列）。
3. 低价值会话跳过确认（≤2 条消息直删保持轻快）：
   - QuickSwitch 侧：内存 store `messages.length` 可取才判定；store 不存在（如重启后未恢复）取不到 → 一律确认（宁多勿漏）。
   - 历史侧：`UnifiedHistoryItem.messageCount`（historyService.ts:80，后端索引）可靠，直接判定。
   - 舍弃：活跃会话消息数（`useActiveSessionMessages`）只覆盖当前会话，删除目标是任意非活跃会话，不采用。
4. `QuickSwitchContent.tsx`：删除按钮 `title="关闭"` → `t('history.deleteSession')`（chat.json:411
   已有 key），补 `aria-label`；hover 危险色已有既有 `hover:text-danger` token，不新增硬编码色。

## 交互细节
- Esc / 取消 = 不删（ConfirmDialog 原语自带，不回退 disableEscape）。
- ConfirmDialog 无 loading/pending 原语：`onConfirm` 内先清 target 再执行删除（退场动画后回调，
  `exit()` 幂等 + `onExited` 仅触发一次，天然防重复提交）。
- 文案：QuickSwitchPanel 文件内硬编码中文风格（同「已续接到新会话」）；SessionHistoryPanel 沿用
  `t(key, '中文默认值')` 既有模式。正文展示会话标题 + 「本地与消息库记录不可恢复」后果 + losses 列表。

## 验收
- `pnpm typecheck` 零错误。
- 两个入口：点删除 → 出确认框（含标题/后果）→ 确认才删；Esc/取消不删。
- ≤2 条消息会话（store 可取到 / 历史条目有计数）直删无确认。
- 快切面板按钮悬停提示为「删除会话」，读屏可获同样语义。

## 回滚
单个 `fix(chat)` 提交 revert 即可；spec 提交独立（`docs(plans)`），无代码耦合。
禁触清单：`createConversationStore.ts` / `eventHandler.ts`（并行会话 C2 领地）。
