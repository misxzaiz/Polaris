# 优化：Prompt 历史上键召回（对齐 ZCode 已验证实现）

> 状态：已实施 · 代码完成 · 归属：前端 · 类型：UX 优化 + bugfix
> 实施结果（2026-10-18）：M1/M2/M3 代码全部落地；`tsc --noEmit` 通过；新增单测 16/16 通过；
> 受影响的 kernel 测试 21/21 通过；改动文件 eslint 无新增问题（2 个非空断言 warning 为存量）；
> 全量 `pnpm test:run` 有 85 个失败——暂存改动复跑基线完全一致（12 文件 / 85 failed），
> 均为存量环境性失败（fetch failed 等），与本改动无关。
> **待真机验收**：桌面端重启后按 ↑ 可召回、双工作区隔离——本机未运行桌面端，未验证。
> 参考：`temp/ZCode/packages/ui/src/lib/promptHistory.ts`、`promptHistoryStorage.ts`、
> `LexicalChatInput.tsx PromptHistoryPlugin`、`v4/ConversationComposer.tsx（提交事务）`、
> `lib/editorUpdateTags.ts`（方向键吞键教训）
> 现状分析：见本文「问题清单」，根因均已对照 ZCode 源码逐条核实（2026-10-18）。

## 问题现象与根因清单（P1–P8）

现状代码集中在 `src/components/Chat/input/ChatInput.tsx`：

- 历史存储：`sentHistoryRef`（纯内存 useRef，新→旧 unshift，上限 100）
- 记录点：空闲发送 ~L1311、流式入队 ~L1203；斜杠命令分支（~L1236 发送但不记录）
- 按键处理：`handleKeyDown` ~L1381–1421

| # | 问题 | 根因（已核实） | ZCode 对照 |
|---|---|---|---|
| P1 | 进入浏览态后 **ArrowUp 失效**，上下不对称 | ArrowUp 分支要求 `value === ''`；召回后 value 非空，上键落回 textarea 原生光标移动；下键（L1408 无 value 条件）可继续 | `currentIndex === null && text.length > 0` 才放行 → 浏览态可整段上下翻 |
| P2 | 历史**不持久化**、跨会话/工作区串味 | 内存 ref + 单实例 ChatInput（App.tsx 无 key）；刷新/重启全丢 | per-workspace localStorage 持久化（其注释明确记录修过同款问题） |
| P3 | 记历史**无事务**，发送失败也记 | `onSend` fire-and-forget，调用后无条件 unshift | 发送前快照 + append + 失败 `rollbackPromptHistory()`（含相等性检查防并发覆盖） |
| P4 | 无 IME / 修饰键防护 | `handleKeyDown` 不查 `isComposing`、不查 shift/ctrl/alt/meta；中文组词中按 ↑ 会被当召回打断 | 显式拒绝 `disabled || shift || ctrl || meta || alt || isComposing` |
| P5 | `savedCurrentInputRef` 是**假机制** | 该 ref 只在 `value === ''` 时写入，永远存 `''`；将来放宽条件会静默读到脏数据 | ZCode 无此设计（down 翻尽返回 `""`，索引置 null） |
| P6 | `/nexus /agent /dispatch` 发送**不入史** | 命令分支调用 `onSend(sendText)` 后直接 return，绕过记录点 | append 是单点函数，所有提交路径共用 |
| P7 | 翻历史**污染会话草稿** | 召回值经 `debouncedPersistDraft` 写入 Store 草稿，中途切会话草稿残留被动召回的旧词 | draft 与 history 是两套独立状态 |
| P8 | 轻微：上限/规范化弱、disabled 时仍响应 | 上限 100 无 trim 规范化；无工作区也可召回 | 上限 30 + 读侧 normalize；`disabled` 直接放行 |

## 设计（唯一权威、单一写路径）

### 1. 纯函数模块（新增，无副作用、可单测）

`src/components/Chat/input/promptHistory.ts`（与 `chatCommandRouter.ts` 同层，输入框专属逻辑不进 services）：

```ts
export const MAX_PROMPT_HISTORY = 30;

/** append：trim、仅与最后一条比对去重（不破坏 A,B,A 非连续重复）、截断 */
export function appendPromptHistoryEntry(entries, entry, limit?): string[];
/** 导航：up 聚最旧（clamp 0）；down 翻尽得下一次 index=null、value=''；空史 shouldHandle=false */
export function navigatePromptHistory(entries, currentIndex|null, "up"|"down");
export function normalizePromptHistoryEntries(raw: unknown[]): string[];
```

内部约定 entries 为**旧→新**序（对齐 ZCode），空间管理集中在模块内。

### 2. 持久化服务（新增，走总线，零后端改动）

`src/services/promptHistoryService.ts`：范式照抄 `configDispatchService.ts`——
`invoke('router_dispatch', { req: { target: 'cap.kv', payload: { action: 'get'|'set', key, value } } })`。

- key：`prompt-history:<workspacePath || 'no-workspace'>`（对齐 ZCode per-workspace 语义；
  工作区切换时重读）
- value：JSON 数组（旧→新），落库前 `normalizePromptHistoryEntries`
- 读失败/解析失败 → 返回 `[]`，不阻塞输入框；写失败 → warn 日志，不重试
- 存储落在 `<DataRoot>/stores/kv.db`（kv_capability 已有事务 + 审计），不引 localStorage

### 3. ChatInput 接线（收敛写路径）

改动集中在 ChatInput.tsx 既有节点，语义对齐 ZCode：

- **接管条件**（替换 L1399/L1408 两分支的公共前置条件）：
  `!isBrowsing && (value === '' )` 才允许 ArrowUp 进入；`isBrowsing` 时 up/down 都接管；
  且统一先排除 `event.shiftKey/ctrlKey/metaKey/altKey/nativeEvent.isComposing`。
  建议面板优先级不变（保留 L1382 在前）。
- **回填**：`setLocalText(entry)` 后 `historyIndex` 只由 navigate 结果驱动；
  `isBrowsing` 态下用户真实编辑（handleInputChange L664 已有）退出浏览态，语义保留。
- **记录**：空闲发送、流式入队、斜杠命令（cmd.sendText）**三处统一调用**模块函数，
  但改为：`const before = history; append` 后**记录快照**；
  `const ok = await onSend(...)`（`sendMessage` 已返回 boolean，createConversationStore.ts:1975/结束处 `return true` / 失败 `return false`），
  `ok === false` 时 `historyRef.current = before`(回滚)。编辑模式依旧不入史（保持现状）。
- **删除 P5 假机制**：`savedCurrentInputRef` 整体移除——down 翻尽由 navigate 返回 `value=''` 表达。
- **P7 决策**：浏览态召回值**不写**草稿 Store（跳过 `debouncedPersistDraft`），仅真实编辑写；
  回到 `''` 时也无需回写（草稿本来就是浏览前的状态）。
- P8：`disabled` 时整个历史接管短路放行；上限统一 30。

### 4. 状态示意（唯一所有者）

```
存储事实:  cap.kv(key=prompt-history:<ws>)   ← 写入点仅 1 个: promptHistoryService.set
内存缓存:  ChatInput.historyRef (useRef)      ← 写入点仅 1 个: promptHistory.append/rollback
浏览索引:  ChatInput.historyIndex (state)    ← 仅 handleKeyDown(经 navigate) 与 发送重置 写
草稿:      inputDraft (Store)                ← 仅 onChange(真实编辑) 写；浏览召回不写
```

风险与对策：

- **异步加载竞态**：ChatInput 挂载/切工作区后 load 未完成就发送 → 记录进内存 ref，
  load 完成后用 append 幂等解（append 会忽略重复且无人覆盖全量数组）；不使用超时掩盖。
- **占用**：ChatInput 已 2010 行，本次只动上述节点并**顺带净删**，不重排其余逻辑。

## 分阶段实施（每阶段独立可提交、可回退）

| 阶段 | 内容 | 验证 |
|---|---|---|
| M1 纯函数 + 单测 | 建 `promptHistory.ts`（append/navigate/normalize），ChatInput 换用；**同步做 P1/P4/P5**（接管条件、IME/修饰键、删假 ref） | 新增 vitest：up-clamp / down 翻尽 / 去重 A,B,A / trim / 上限 / 空史 shouldHandle=false；`pnpm test -- --run` + `tsc --noEmit` |
| M2 持久化 | 建 `promptHistoryService.ts`（cap.kv），挂载/切工作区读写、加载竞态处理 | 构建真机走一遍：重启桌面端后上键可召回；两工作区互不串味 |
| M3 事务收尾 | P3 回滚（await onSend 快照回滚）、P6 命令分支入史、P7 召回不写草稿 | 手动：断网/错误路径发送后按 ↑ 不召回脏条目；发送 `/nexus xxx` 后 ↑ 可召回 |

## 验收

- [x] M1：`promptHistory.test.ts` 16/16 全绿；`pnpm exec tsc --noEmit` 通过；ChatInput 无 savedCurrentInputRef 残留
- [x] M2：`promptHistoryService.ts` 落地（cap.kv）；`cargo check` 未执行——本次零 Rust 改动，门控检查无对象
- [x] M3：发送失败不入史（commitPromptHistory 事务 + v2-kernel/useActiveSession 透传 `ok`）；
      `/nexus` 等命令发送可召回；浏览历史不再写草稿 Store
      （kernel 测试 case-4b 21/21 通过；语义变更：SendResult.ok 现如实反映 store.sendMessage 返回值）
- [ ] 真机验收：重启桌面端后上键可召回、两工作区互不串味（待运行桌面端后补勾）
- [x] 本文件状态更新并补真实验证结果
