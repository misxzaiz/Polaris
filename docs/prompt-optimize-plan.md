# 输入框提示词优化 — 方案分析

> 需求：在聊天输入框中支持对用户输入的提示词进行 AI 优化；可选择 AI 引擎及模型；支持回滚到原始输入、还原后重新优化（可换引擎/模型多轮迭代）。
>
> 状态：**Phase 1 已实施**（2026-07-18，实施记录见文末第 6 节）；Phase 2/3 未实施
> 日期：2026-07-18

---

## 1. 现状调研结论

### 1.1 可直接复用的先例

| 能力 | 现有实现 | 位置 | 对本需求的价值 |
|------|----------|------|----------------|
| "选引擎 → AI 生成 → 结果回流输入框" 完整闭环 | Git 提交信息生成 | `src/components/GitPanel/CommitInput.tsx` + `src/services/commitMessageChat.ts` | 交互模式与服务骨架可整体套用 |
| 专用隐藏用途会话 | `kind: 'commit-message'` 会话（按 workspace 复用单会话） | `commitMessageChat.ts:53-108` | 优化调用走同一通道，扩展 `kind: 'prompt-optimize'` |
| 一次性系统提示注入 | `SendMessageOptions.oneTimeSystemPrompt`（appendSystemPrompt 通道，不进消息流、不持久化） | `src/stores/conversationStore/types.ts:83-100` | 注入"提示词优化器"人格，全引擎生效 |
| 流式结果订阅回流 | `useCommitMessageSuggestion`（useSyncExternalStore 订阅目标会话最新助手消息，流式实时跟随） | `commitMessageChat.ts:166-212` | 优化过程实时预览 + 完成取全文 |
| 引擎选择浮层（轻量） | Sparkles 按钮 + 引擎浮层 + localStorage 记忆上次选择 | `CommitInput.tsx:26-44, 274-300` | 优化按钮浮层直接参考 |
| 引擎/模型/Profile 选择器（完整） | `SessionConfigSelector`（PRESET_MODELS + modelProfileStore + isProfileForEngine 按引擎过滤 + getEngineSelectors 能力矩阵） | `src/components/Chat/SessionConfigSelector.tsx` | 模型/Profile 二级选择的取数逻辑复用 |
| 外部文本一键填入输入框 | promptSuggestion 气泡（输入框上方胶囊，点击填入并聚焦） | `ChatInput.tsx:992-1010` | "优化结果就绪"胶囊的交互样板 |
| 输入框上方可编辑卡片 | `PendingBriefingCard`（压缩交接简报） | `ChatInput.tsx:951` | 备选展示位 |
| 会话级草稿状态 | `inputDraft`（store 内 per-session，300ms 防抖持久化，切会话恢复） | `ChatInput.tsx:120-159` | 回滚栈同层放置，天然按会话隔离 |

### 1.2 关键约束与教训

1. **headless 一次性调用已被项目否定**。`commitMessageChat.ts` 文件头明确记录：旧 headless 路径存在"超时 / 跑偏 / 静默兜底"问题，提交信息生成因此改走成熟会话基建（sessionStoreManager + sendMessage）。本方案沿用此结论，主通道走会话基建。
2. **无现成单次补全命令**。Rust 侧无通用 "system + user → text" 命令（Agnes 仅 image/video/config；SimpleAI 的 compact 内嵌于 chat loop 不可独立调用）。直连 API 快速通道需要新增后端面积，列为 Phase 3 可选项。
3. **`runtimeOverride` 不含 model/profile**（仅 agent/effort/permissionMode，`types.ts:95-99`）。模型/Profile 是会话级 metadata（`updateSessionModel` / `updateSessionModelProfile`），优化会话在创建后设置即可，不需要改 SendMessageOptions。
4. **`kind` 字段目前是字面量 union `'commit-message'`**（`types.ts:359, 387`），需扩展；`kind` 会话目前**不会**从会话列表中过滤（commit-message 是故意可见的），隐藏优化会话需要新增过滤点。
5. **LRU 会话驱逐**：`sessionStoreManager` MAX_IDLE_STORES=5 会驱逐空闲 store。优化会话在流式中不会被驱逐（驱逐仅针对 idle），但跨多轮之间可能被回收 —— 复用逻辑需容忍"找不到旧会话则新建"。
6. **引擎能力差异**：mimo 不支持 profile、simple-ai 模型完全由 Profile 驱动、claude/mimo 有官方模型档位（`SessionConfigSelector.tsx:131-161`）。模型选择 UI 必须复用 `getEngineSelectors` + `isProfileForEngine` 的过滤链，避免向引擎传入其不支持的配置。

---

## 2. 总体方案

### 2.1 交互流程

```
输入框有草稿
   │
   ▼ 点击工具栏 ✨ 按钮（附件按钮旁）
弹出优化浮层：引擎（4 选 1）→ [API 型引擎] Profile/模型（可选）→ 优化风格（可选）
   │  （记住上次选择，回车/点击「优化」触发）
   ▼
状态：optimizing —— 按钮转 Loader；输入框上方出现进度胶囊（流式预览优化中文本，可取消）
   │
   ▼ 完成
冲突检测：
   ├─ 输入框文本 == 触发时快照 → 直接替换输入框文本，压入版本栈
   └─ 用户中途改过文本      → 不替换，胶囊变为「优化结果就绪，点击应用」
   │
   ▼ 替换后
工具栏出现版本控件： ↶ 回滚 · v2/2 · ↷ 重做 · ✨ 重新优化
   ├─ ↶ 回滚：cursor--，输入框恢复上一版本（最底层是原始输入 v1）
   ├─ ↷ 重做：cursor++，恢复后一版本
   └─ ✨ 重新优化：以当前输入框文本为源再次触发（可换引擎/模型），结果作为新版本入栈
用户手动编辑文本 → 版本控件保留；再次优化时当前文本作为新版本压栈（分支截断，同编辑器 undo 语义）
发送消息 / 清空输入 → 版本栈重置
```

要点：
- **优化会话完全静默**：不 `switchSession`、不展开面板（与 commit-message 的可见策略相反）。
- **原文永不丢失**：版本栈 v1 恒为触发第一次优化时的原始输入，任何时刻可一键回到。
- **多轮迭代**：每次优化产出一个新版本；"还原重新优化" = 回滚到任意版本后再触发优化。

### 2.2 调用通道决策

| | 方案 A：会话通道（推荐，Phase 1） | 方案 B：Rust 直连（Phase 3 可选） |
|---|---|---|
| 实现 | 新建 `kind: 'prompt-optimize'` 隐藏会话，`sendMessage(原文, workspacePath, undefined, { oneTimeSystemPrompt: 优化器人格 })` | 新增 `prompt_optimize` command：reqwest + ModelProfile（anthropic-messages / openai 双协议） |
| 引擎覆盖 | 全部四引擎统一支持（复用各引擎鉴权/CLI） | 仅 API 型 Profile 用户；claude-code OAuth CLI 无法直连 |
| 延迟 | CLI 引擎冷启动 1~3s + 生成时间 | 亚秒级往返 |
| 风险 | agent 可能跑偏调用工具（用强约束 prompt + permissionMode 缓解，commit-message 已验证约束有效） | 重蹈 headless 超时/静默兜底覆辙，需完整超时/重试/错误面 |
| 后端改动 | 零 | 新 command + ipc + 双协议适配 |

**决策：Phase 1 只做方案 A。**理由：零后端改动、全引擎覆盖、有已验证先例；提示词优化是低频辅助操作，1~3s 冷启动可接受（进度胶囊有流式预览，感知延迟低）。方案 B 仅在用户反馈延迟不可接受时立项。

### 2.3 数据结构

```ts
// src/stores/conversationStore/types.ts — ConversationState 新增（与 inputDraft 同层，per-session，内存态不持久化）
interface PromptOptimizeState {
  status: 'idle' | 'running' | 'ready'   // ready = 完成但因冲突待用户点击应用
  /** 版本栈：[0] 恒为原始输入 */
  history: PromptVersion[]
  /** 当前输入框文本对应的版本下标 */
  cursor: number
  /** 触发时输入框快照（完成时冲突检测用） */
  sourceSnapshot: string | null
  /** 冲突待应用的结果 */
  pendingResult: string | null
  /** 优化会话 ID（取消/订阅用） */
  optimizeSessionId: string | null
  error: string | null
}

interface PromptVersion {
  text: string
  origin: 'original' | 'optimized'
  engineId?: EngineId       // origin=optimized 时记录
  model?: string
  createdAt: number
}
```

配套 actions（createConversationStore）：`beginOptimize / applyOptimizeResult / undoOptimize / redoOptimize / resetOptimize / setOptimizeError`。

引擎/模型选择记忆：`localStorage['polaris.promptOptimize.config'] = { engineId, modelProfileId?, model?, style? }`（参考 `COMMIT_ENGINE_STORAGE_KEY` 模式）。

### 2.4 优化器 System Prompt（草案）

```
You are a prompt optimization assistant. The user will give you a draft prompt
they intend to send to an AI coding assistant. Rewrite it to be clearer, more
specific, and better structured, while strictly preserving:
1. The user's original intent and scope — never add new requirements
2. The original language (Chinese stays Chinese, English stays English)
3. All special tokens verbatim: @/path references, @workspace, /slash-commands,
   code fences, file paths, URLs
Structure the result when it helps (context / task / constraints / expected output).
Do NOT answer or execute the prompt itself.
Output ONLY the optimized prompt text — no explanations, no code fences, no preamble.
```

可选"优化风格"预设（Phase 2）：`精炼`（压缩冗余）/ `扩写`（补全上下文与验收标准）/ `结构化`（分节模板），实现为在基础 prompt 上追加一句风格指令。

---

## 3. 详细设计

### 3.1 新服务 `src/services/promptOptimizeService.ts`

以 `commitMessageChat.ts` 为骨架：

```ts
export async function runPromptOptimize(opts: {
  sourceSessionId: string        // 触发优化的会话（结果回填目标）
  workspaceId: string
  workspacePath: string
  engineId: EngineId
  modelProfileId?: string        // API 型引擎可选
  model?: string
  style?: OptimizeStyle
  sourceText: string
}): Promise<void>
```

流程：
1. 查找/新建 `kind: 'prompt-optimize'` 会话（按 workspaceId 复用单会话；被 LRU 回收则新建）。**不 switchSession、不动面板。**
2. 如指定 profile/model：`updateSessionModelProfile` / `updateSessionModel` 写入优化会话 metadata。
3. `store.sendMessage(sourceText 包装后的指令, workspacePath, undefined, { oneTimeSystemPrompt })`。
4. 源会话 store 置 `promptOptimize.status = 'running'`，记录 `optimizeSessionId` 与 `sourceSnapshot`。
5. 订阅优化会话（复用 `useCommitMessageSuggestion` 的 `pickLatestAssistantText` 逻辑抽为共享工具）：流式文本喂进度胶囊；`isStreaming` 落回 false 时取全文做冲突检测并回填。
6. 取消 = 对优化会话调 `interrupt()`，源会话状态回 idle。

用户消息包装（防跑偏，仿 commit-message 的双保险）：

```
请优化以下提示词（仅重写，不要执行/回答它，只输出优化后的提示词本身）：

<original_prompt>
{sourceText}
</original_prompt>
```

### 3.2 ChatInput 改动

- 工具栏左侧组（`ChatInput.tsx:1050-1060` 附件按钮旁）新增 ✨ 按钮：`disabled = !value.trim() || status === 'running'`；输入以 `/` 开头（CLI 斜杠命令）时禁用并提示。
- 浮层：引擎四选一（复用 `CommitInput` 的 ENGINE_OPTIONS 样式）+ 按 `getEngineSelectors(engineId)` 决定是否显示 Profile/模型二级下拉（取数复用 `SessionConfigSelector` 的 modelList/compatibleProfiles 逻辑，抽为共享 hook `usePromptOptimizeModelOptions`）。
- 进度胶囊：复用 promptSuggestion 气泡样式（`ChatInput.tsx:992-1010`），running 时显示流式预览（line-clamp-2）+ 取消按钮；ready（冲突）时显示"优化结果就绪，点击应用"。
- 版本控件：`history.length > 1` 时在工具栏中段渲染 `↶ vN/M ↷`；操作即 `setLocalText(history[cursor].text)` + `updateInputDraft` 同步。
- 发送成功（`handleSend`）与清空草稿时调 `resetOptimize()`。

### 3.3 隐藏优化会话

- `types.ts:359, 387`：`kind?: 'commit-message' | 'prompt-optimize'`。
- 会话列表渲染处（SessionTree / 会话历史面板取 `useSessionMetadataList()` 的消费点）过滤 `kind === 'prompt-optimize'`。建议在 sessionStoreManager 暴露 `useVisibleSessionMetadataList()` 选择器统一过滤，避免逐处修改遗漏。
- 对话落盘：优化会话走常规 saveDialog 无害（标题固定"提示词优化"），Phase 2 可在历史面板同样过滤该 kind。

### 3.4 边界情况

| 场景 | 策略 |
|------|------|
| 优化中用户继续编辑输入框 | 允许；完成时快照不一致 → 不覆盖，转 `ready` 胶囊待点击应用（点击应用同样压栈，当前手改文本先入栈保留） |
| 优化中切换会话 | 状态在源会话 store 内，切走不受影响；切回后胶囊/结果照常呈现 |
| 优化中再次点击 ✨ | 禁用（单飞行中任务）；取消后可重发 |
| 空输入 / 纯附件 | 按钮禁用 |
| 输入是斜杠命令 | 按钮禁用（避免破坏命令语义） |
| 超长输入（> 8k 字符） | 弹确认提示（成本/截断风险），不硬限制 |
| 引擎无可用配置（如 simple-ai 无 Profile） | 浮层内该引擎置灰 + 提示去设置页配置 |
| 优化失败/超时 | 胶囊转错误态（沿用 store error 文案），原文无损，可重试 |
| @/path、@workspace、附件 | 文本中的引用标记由 system prompt 约束原样保留；附件不参与优化、不受影响 |
| 发送时 | 发送的是输入框当前文本（即用户最终确认的版本），版本栈随发送清空 |

---

## 4. 实施计划

### Phase 1 — MVP（预计 1~1.5 天）
1. `types.ts`：`PromptOptimizeState` + kind union 扩展 + actions 定义
2. `createConversationStore.ts`：状态与 actions 实现（含版本栈 push/undo/redo/截断）
3. `promptOptimizeService.ts`：会话通道 + 订阅回填 + 冲突检测（抽共享 `pickLatestAssistantText`）
4. `ChatInput.tsx`：✨ 按钮 + 引擎浮层（暂不含模型二级）+ 进度胶囊 + `↶/↷` 版本控件
5. 会话列表过滤 `prompt-optimize`
6. i18n：`zh-CN/chat.json` + `en-US/chat.json`
7. 验证：四引擎各跑一轮优化→回滚→重新优化→发送

### Phase 2 — 完整体验（预计 1 天）
- Profile/模型二级选择（共享 hook 抽取）
- 优化风格预设（精炼/扩写/结构化）
- 历史面板过滤优化会话；版本控件 hover 预览版本 diff
- 优化会话复用清理策略（会话数上限/定期清理）

### Phase 3 — 可选增强（按需立项）
- Rust 直连快速通道（API 型 Profile 走 `prompt_optimize` command，其余回落会话通道）
- 优化前后 diff 视图（复用 DiffViewer）
- 快捷键（如 `Ctrl+Shift+O`，接入 shortcuts registry）

## 5. 风险清单

1. **CLI 引擎冷启动延迟（1~3s）**：流式胶囊缓解感知；不可接受则上 Phase 3 直连。
2. **模型跑偏执行原提示词**：system prompt + `<original_prompt>` 包装双保险；commit-message 同款约束已线上验证。
3. **隐藏会话堆积**：按 workspace 复用单会话 + LRU 自然回收；Phase 2 加清理。
4. **会话列表过滤遗漏**：统一走 `useVisibleSessionMetadataList()` 选择器收敛过滤点。
5. **回滚栈与草稿持久化的一致性**：版本栈仅内存态，应用重启后仅剩草稿文本（可接受，明确不做持久化）。

---

## 6. Phase 1 实施记录（2026-07-18）

### 6.1 与原方案的偏差（实施时的更优解）

| 原方案 | 实际实施 | 原因 |
|--------|----------|------|
| 新增 `useVisibleSessionMetadataList()` 过滤隐藏会话 | 直接用现成 `silentMode: true` | 调研发现 `SessionMetadata.silentMode` 早已存在（dispatch/scheduler 在用），QuickSwitchPanel / SourceOverview 均已过滤，零新增过滤点 |
| 优化会话按 workspace 复用单会话 | **每轮新建一次性静默会话** | `updateSessionEngine` 仅对空会话生效——复用会话无法换引擎；且多轮优化上下文互相污染、白耗 token |
| 完成后清理优化会话 | **不主动删除，交由 LRU 驱逐回收** | `deleteSession` 后若有迟到事件，eventRouter 会自动重建**可见**空会话（`sessionStoreManager.ts` 事件路由自动建会话逻辑）；静默会话本就不可见，LRU（MAX_IDLE_STORES=5）很快回收 |
| 版本控件操作直接 setLocalText | **store 层直接写 `inputDraft`** | ChatInput 已有 `useEffect([inputDraft])` 同步 effect，store 写草稿即自动回填本地文本，主界面/AIPopover 两处 ChatInput 行为天然一致 |

### 6.2 版本栈语义的实施细化

- undo 时若有未入栈手改：手改文本自动入栈（origin='edited'）再回退，redo 可回到手改文本（不丢内容）。
- redo 时若当前文本被手改：no-op（redo 会覆盖手改，宁可不动）；UI 侧同条件禁用按钮。
- 所有版本操作（含触发优化）前 UI 先 `cancelPersistDraft() + updateInputDraft(当前文本)` 消除 300ms 防抖差，保证冲突检测/手改判定基线准确。
- 完成时冲突检测：`inputDraft.text !== sourceSnapshot` → 转 `ready` 状态胶囊（点击应用，应用时当前手改文本先入栈保留）。
- 发送消息 / `/dispatch` 派发 / 语音 clear → `resetPromptOptimize()` 清栈；发送时若优化中先 `cancelPromptOptimize()`。
- **不要求关联工作区**（首版误加硬约束后修正）：`useActiveSessionWorkspace()` 读的是会话 store 的 workspaceId，free 会话/未绑定会话恒为 null，即使全局选了工作区也会被误禁。修正为与发送消息一致的解析链：会话关联工作区 → 全局当前工作区 → 无（创建 free 类型优化会话，workDir 由 sendMessage 解析链兜底）。

### 6.3 改动文件清单

| 文件 | 改动 |
|------|------|
| `src/stores/conversationStore/types.ts` | `PromptVersion` / `PromptOptimizeState` 类型 + `ConversationState.promptOptimize` + 7 个 actions 声明 + kind union 扩展 `'prompt-optimize'` |
| `src/stores/conversationStore/createConversationStore.ts` | 初始状态 + begin/complete/applyPending/fail/undo/redo/reset 七个 action 实现 |
| `src/stores/conversationStore/useActiveSession.ts` | `useActiveSessionPromptOptimize()` hook + actions 暴露（undo/redo/applyPending/reset/clearError） |
| `src/services/promptOptimizeService.ts` | 新建：一次性静默会话 + oneTimeSystemPrompt + 订阅 isStreaming 回落收口 + 180s 超时兜底 + `usePromptOptimizePreview` 流式预览 hook + 引擎记忆 localStorage |
| `src/services/assistantTextUtils.ts` | 新建：`extractAssistantText` / `pickLatestAssistantText`（自 commitMessageChat 抽出共享） |
| `src/services/commitMessageChat.ts` | 改用共享 assistantTextUtils（纯搬移） |
| `src/components/Chat/ChatInput.tsx` | ✨(Wand2) 按钮 + 引擎浮层 + 三态胶囊（优化中/就绪/失败）+ ↶ vN/M ↷ 版本控件 + 发送/清空清理 |
| `src/locales/{zh-CN,en-US}/chat.json` | `promptOptimize.*` 23 条文案 |
| `src/stores/conversationStore/promptOptimize.test.ts` | 新建：版本栈状态机 7 用例（首轮入栈/undo-redo/冲突 ready/分支截断/手改保护/失败保留栈/空结果） |

### 6.4 验证情况

- `tsc --noEmit`：零新增错误（ModelProviderTab/PromptSnippetTab 的既有错误与本次无关，已用 stash 基线确认）。
- eslint：改动文件零新增问题。
- vitest：conversationStore + dispatch 既有 68 用例全过；新增 promptOptimize 7 用例全过。
- `vite build`：生产构建成功，无 manualChunks TDZ 问题。
- 运行时四引擎实测（优化→回滚→重新优化→发送）：**待用户在 tauri:dev 环境验证**（本机无法运行 Tauri 原生环境）。
