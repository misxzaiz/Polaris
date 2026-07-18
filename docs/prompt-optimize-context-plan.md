# 提示词优化 — 上下文感知 + 快速/深度双模式 + 引擎/模型/Profile 三级选择(路径2)

> 需求延伸:在现有"选引擎优化草稿 + 版本栈"基础上,增加三项能力——
> (1) 优化时读取当前对话上下文与项目信息,使结果更贴合真实场景;
> (2) 支持"快速优化 / 深度优化"两种模式;
> (3) 像压缩交接那样可选择引擎 + 供应商 Profile + 具体模型。
>
> 方案:**路径2(Agent-Driven Context)**——深度模式赋予优化会话只读工具权限,
> 让模型按草稿意图自主读取对话存档 / 项目文件,而非前端预采集拼 prompt(路径1)。
> 模型选择管线直接复用 CompactHandoffModal 的成熟实现。
>
> 状态:**设计稿,待实施**(基于 `prompt-optimize-plan.md` Phase 1 已落地的版本栈体系)
> 日期:2026-07-18

---

## 0. 与现有实现的衔接

现状(已实施,见 `prompt-optimize-plan.md`):

```
输入框草稿 → runPromptOptimize({ sourceSessionId, workspaceId?, workspacePath?, engineId, sourceText })
  → 一次性静默会话(kind='prompt-optimize', silentMode)
  → sendMessage(包装指令, workspacePath, undefined, { oneTimeSystemPrompt: PROMPT_OPTIMIZE_SYSTEM_PROMPT })
  → 订阅 isStreaming 下降沿 → pickLatestAssistantText → completePromptOptimize → 版本栈
```

本设计**不改动版本栈 / 冲突检测 / 回填链路**,只在"送给引擎的内容"、"优化会话的工具权限"、"模型选择"三处做扩展。

### 关键可行性结论(已核实代码)

| 结论 | 依据 |
|------|------|
| 工具调用**不影响** `isStreaming`,现有下降沿完成检测在多轮工具往返下不误判 | `isStreaming` 仅在 `session_start`(true)/`session_end`/`error`(false)切换,`tool_call_start`/`tool_call_end` 不改动它(`eventHandler.ts:74-195`) |
| `sendMessage` 支持工具放权与权限覆盖 | `chatOptions` 透传 `allowedTools` + `runtimeOverride.permissionMode`(`createConversationStore.ts:1456-1474`) |
| "静默会话 + bypassPermissions + agent 读文件产出文本"链路已实战验证 | `contextCompactHandoff.ts`(压缩交接)完整跑通同构链路 |
| 静默会话必须 bypassPermissions,否则权限弹窗永久挂起 | 压缩交接教训(`contextCompactHandoff.ts:128-133`) |
| `createSession` 已支持 `modelProfileId`/`model` 透传,无需改后端 | 压缩交接同款用法(`contextCompactHandoff.ts:111-119`);`sendMessage` 解析链自动取 metadata 的 model/profile(`createConversationStore.ts:1430-1432`) |
| 引擎/Profile/模型三级联动过滤已有完整可复现实现 | `CompactHandoffModal.tsx:176-223`,`isProfileForEngine()`,`resolveEffectiveProfileId()` |

---

## 1. 模式分界(本质)

**两模式的差异 = 是否放开工具让 agent 自读上下文。**

| | 快速优化(quick) | 深度优化(deep) |
|---|---|---|
| 定位 | 措辞打磨、结构清晰化 | 结合当下对话 + 项目场景的贴合式改写 |
| 上下文 | **零**(维持现状) | 对话历史 + 项目文件,由模型按需自读 |
| 工具权限 | 禁用(`Do NOT use any tools`) | 只读白名单 `Read / Grep / Glob` |
| 权限模式 | 默认 | `bypassPermissions`(静默会话强制) |
| System Prompt | `PROMPT_OPTIMIZE_SYSTEM_PROMPT`(现有) | `PROMPT_OPTIMIZE_DEEP_SYSTEM_PROMPT`(新增) |
| 工作区 | 不强制 | 需绑定(无则降级,见 §5) |
| 超时 | 180s(现状) | 300~360s(工具往返留余量) |
| 延迟 / 成本 | 低 | 显著更高(仅深度承担) |
| 模型建议 | 可用默认/更快模型 | 可选更强模型(模型选择 UI 提供) |

### 可调决策点(默认取值,实施前可改)

1. **快速模式上下文**:默认**完全零上下文**(=现状)。若希望快速也带极廉价的项目名/分支,分界改为"上下文深浅"而非"有无"——见 §6 混合思路。
2. **深度工具白名单**:默认**只读** `Read / Grep / Glob`,**排除 `Bash / Write / Edit`**。排除 Bash 避免 `find`/`git` 全盘扫描导致延迟失控与跑偏;git 信息改用路径1 廉价预拼(§6)。
3. **对话上下文范围**:默认**轻量近 N=6 轮摘要**内联(不落盘);超长对话按需切换 `packToFile` 落盘 + `@引用` 自读方案(§4.2)。

---

## 2. 数据结构改动

```ts
// types.ts
export type PromptOptimizeMode = 'quick' | 'deep'

// RunPromptOptimizeOptions 增字段
interface RunPromptOptimizeOptions {
  // ...现有字段
  mode: PromptOptimizeMode
  modelProfileId?: string
  model?: string
}

// PromptVersion 增字段(版本栈标注来源,回滚时可辨识)
interface PromptVersion {
  // ...现有字段
  mode?: PromptOptimizeMode
  // model 字段已存在,无需改
}

// localStorage 从分散键合并为单一配置对象
interface PromptOptimizeStoredConfig {
  engineId: EngineId
  mode: PromptOptimizeMode
  modelProfileId?: string    // '' 代表官方 API
  model?: string
}
// key: 'polaris.promptOptimize.config'
```

---

## 3. 服务层分流(promptOptimizeService.ts)

### 3.1 System Prompt 分流

```ts
// 现有(快速)——保持不动
export const PROMPT_OPTIMIZE_SYSTEM_PROMPT = `...Do NOT use any tools...`

// 新增(深度)
export const PROMPT_OPTIMIZE_DEEP_SYSTEM_PROMPT = `You are a prompt optimization assistant with read-only access to the user's current project and conversation.

The user gives you a draft prompt they intend to send to an AI coding assistant. Your job is to rewrite it to be clearer, more specific, and better grounded in the ACTUAL project context.

You MAY use Read / Grep / Glob to inspect:
- The project's convention files (CLAUDE.md, AGENTS.md, README) to match its terminology and constraints
- Files, symbols, or paths the draft explicitly references, to make vague mentions concrete
- The recent conversation context provided, to align the prompt with what the user is currently doing

Strict rules:
1. Preserve the user's original intent and scope — NEVER add requirements the user did not state, even if the project context suggests them. Context is for making the wording precise, NOT for inventing new tasks.
2. Preserve the original language (Chinese stays Chinese, English stays English).
3. Preserve all special tokens verbatim: @/path references, @workspace, /slash-commands, code fences, file paths, URLs.
4. Do NOT modify any files. Do NOT execute or answer the draft prompt itself. Only reading is allowed.
5. After reading, output ONLY the optimized prompt text — no explanation of what you read, no tool-call summary, no preamble, no code fences.`
```

要点:深度版明确"context 仅供措辞精准,绝不新增需求"(最大语义风险的硬约束)+ "只读不写不执行" + "只输出优化文本"。

### 3.2 sendMessage 调用分流

```ts
const sendOptions: SendMessageOptions = isDeep
  ? {
      oneTimeSystemPrompt: PROMPT_OPTIMIZE_DEEP_SYSTEM_PROMPT,
      allowedTools: ['Read', 'Grep', 'Glob'],
      runtimeOverride: { permissionMode: 'bypassPermissions' },
    }
  : {
      oneTimeSystemPrompt: PROMPT_OPTIMIZE_SYSTEM_PROMPT,
    }

await optStore.getState().sendMessage(userMessage, workspacePath, undefined, sendOptions)
```

### 3.3 createSession 带 model/profile(新增改动)

```ts
// 当前:只传 engineId
// 改为:
const optSessionId = manager.createSession({
  type: workspaceId ? 'project' : 'free',
  workspaceId,
  engineId,
  modelProfileId: options.modelProfileId || undefined,
  model: options.model || undefined,
  title: i18n.t('chat:promptOptimize.sessionTitle', '提示词优化'),
  silentMode: true,
  kind: 'prompt-optimize',
})

// beginPromptOptimize 的 pendingMeta 也带上 model
srcStore.getState().beginPromptOptimize(sourceText, {
  engineId,
  model: options.model,
  optimizeSessionId: optSessionId,
})
```

`createSession` 写入 metadata 后,后续 `sendMessage` 的模型解析链(`createConversationStore.ts:1430-1432`)自动读取 metadata 的 `modelProfileId`/`model`,**无需额外改动 sendMessage 逻辑**。

### 3.4 超时分模式

```ts
const QUICK_TIMEOUT_MS = 180_000
const DEEP_TIMEOUT_MS = 330_000
const timeoutMs = isDeep ? DEEP_TIMEOUT_MS : QUICK_TIMEOUT_MS
```

### 3.5 完成检测 — 复用现状,无需改

深度模式多轮工具往返期间 `isStreaming` 恒为 true(已核实),`sawStreaming` 天然置位,`session_end` 下降沿收口。现有 `settle` / `pickLatestAssistantText` 逻辑直接复用。模型若"只调工具不输出文本" → `pickLatestAssistantText` 取空 → 现有逻辑已按失败收口。

---

## 4. 对话上下文接入

### 4.1 轻量方案(默认,推荐起步)

不落盘,直接把源会话近 N=6 轮消息摘要作为 `<recent_context>` 拼进深度模式的 userMessage:

```
请结合项目上下文优化以下提示词(仅重写,不新增需求,只输出优化后的提示词本身)。
你可以用 Read/Grep 阅读项目约定文件与草稿提到的文件。

<recent_context>
{近 N 轮 user/assistant 摘要,每条截断到 ~200 字}
</recent_context>

<original_prompt>
{sourceText}
</original_prompt>
```

近 N 轮取数:`srcStore.getPersistableMessages()`(已在内存,零 IO),取末 N 轮,每条截断。**只读不改 `sourceText`**(冲突检测基线不变)。

### 4.2 完整方案(超长对话按需)

复用压缩交接的 `packToFile`(`conversationPackager`)把源会话完整原文落盘到 `.polaris-handoff/`,指令给 `@存档相对路径`,让模型自读。适合对话极长、近 N 轮不足以覆盖意图的场景。代价:一次落盘 IO + 模型一轮读文件往返。

**建议**:Phase 1 先做 4.1;Phase 2 做文字数阈值自动切换 4.2。

---

## 5. 无工作区 / free 会话降级

深度模式依赖 workDir 读项目。free / 未绑定工作区会话选深度时:

| 策略 | 说明 | 取舍 |
|------|------|------|
| **A. 降级为"仅对话上下文"**(推荐) | 不绑工作区、不放文件工具,只注入 `<recent_context>`,走深度 prompt 的语义约束 | 保留部分深度价值,不静默失败 |
| B. 提示绑定工作区 | 浮层深度选项置灰 + 提示"深度优化需绑定项目" | 明确但打断 |
| C. 静默回退快速 | 用户选深度但实际跑快速 | 体验割裂,不推荐 |

工作区解析链沿用现有(会话关联 → 全局当前 → 无),在 `ChatInput.handleOptimizeWithEngine` 已有 `currentWorkspace ?? workspaces.find(...)` 逻辑。

---

## 6. 更优思路:路径2 为主 + 路径1 廉价兜底(混合)

路径2 的延迟硬伤来自"每类上下文都要模型一轮工具往返"。优化:**廉价且必读的信息前端直接预拼,昂贵且动态的让模型自读**。

- **前端预拼(路径1 廉价部分,毫秒级)**:工作区名 + git 分支 + 改动文件清单。复用 `gitContextService.getGitStatus()` / `formatGitDiffSummary()`,一次调用拿到,作为 `<project_state>` 附上,省掉模型一轮工具往返。
- **模型自读(路径2 动态部分)**:草稿提到的具体文件、`CLAUDE.md` 细节、需要 grep 的代码。

是否纳入取决于 Phase 1 实测延迟。若可接受纯路径2,可不做混合以保持前端零采集。

---

## 7. 引擎 / Profile / 模型三级选择

### 7.1 先例:CompactHandoffModal 的成熟实现(直接复用)

`CompactHandoffModal.tsx:167-245` 已跑通完整的"引擎 + Profile + 模型"三级选择:

```
引擎四选一(EnginePicker)                 ← 切引擎时清空已选 Profile/模型
  ↓
Profile 下拉(Dropdown)                   ← isProfileForEngine 按引擎过滤
  ↓
模型下拉(Dropdown)                       ← profile.modelOptions ?? [profile.model]
```

三段取数逻辑:

```ts
// 默认值:源会话当前线路(零额外挑选)
const sourceDefaults = useMemo(() => {
  const meta = sessionStoreManager.getState().sessionMetadata.get(sessionId)
  const sessionConfig = getSessionConfig()
  const activeProfileId = useModelProfileStore.getState().activeProfileId ?? undefined
  const profileId = resolveEffectiveProfileId(
    meta?.modelProfileId,
    sessionConfig.modelProfileId,
    activeProfileId,
  ) ?? ''
  const model = meta?.model || sessionConfig.model || ''
  return { profileId, model }
}, [sessionId])
```

`resolveEffectiveProfileId` 和 `isProfileForEngine` 都在 compact 里用着了,可以直接搬到优化侧。

### 7.2 改动点

| 层 | 文件 | 改动 |
|----|------|------|
| 类型 | `types.ts` | `RunPromptOptimizeOptions` 增 `modelProfileId?` / `model?`(见 §2) |
| 服务 | `promptOptimizeService.ts` | `createSession` 增传 `modelProfileId`/`model`(见 §3.3);`readStoredConfig`/`storeConfig` 从单 engine 升级为 `{ engineId, modelProfileId, model, mode }` |
| UI | `ChatInput.tsx` | 优化浮层从引擎单选升级为三级选择(见 §7.3);默认值解析同 §7.1 `sourceDefaults` |
| i18n | `chat.json` | 复用现有 `sessionConfig.officialApi` 等文案;少量新增 |

### 7.3 浮层信息架构

当前优化浮层是一行引擎选择 + 一个触发按钮,加 Profile/模型/模式后需要重组。

**建议布局**(紧凑型,不改为 modal 打断):

```
┌──────────────────────────────────┐
│  引擎   ○Claude  ○Codex          │  ← EnginePicker(四选一)
│          ○Simple ○Mimo           │
│                                  │
│  模式   ○快速优化  ○深度优化     │  ← mode toggle
│                                  │
│  ▾ 高级选项                       │  ← 默认折叠,展开显下面两行
│  供应商 ┌─────────────────┐      │
│         │ 官方 API    ▾   │      │  ← Dropdown(Profile)
│         └─────────────────┘      │
│  模型   ┌─────────────────┐      │
│         │ claude-sonnet  ▾ │      │  ← Dropdown(模型)
│         └─────────────────┘      │
│                                  │
│  ↶  1/3  ↷        [优化]  ✕     │  ← 版本控件 + 触发按钮
└──────────────────────────────────┘
```

### 7.4 模型选择与双模式的协同

- 深度模式用户**可能想换强模型**,快速模式用户想用默认/快模型——两模式可各自记忆独立的模型偏好(在 `PromptOptimizeStoredConfig` 里按 mode 分 store 或无妨,能省 UX 复杂度就先统一记忆)。
- **视图标注增补**:`PromptVersion.mode` + `PromptVersion.model` 写入后,版本栈里显示 `v3 · 深度 · claude-sonnet` 等标识,多轮换模式/模型迭代时有辨识度。

### 7.5 边界情况

| 场景 | 处理 |
|------|------|
| 源会话模型不在当前引擎 Profile 列表中 | 同 CompactHandoffModal 兜底:始终把当前 model 加入选项(`CompactHandoffModal.tsx:220-221`) |
| simple-ai 无可用 Profile | Profile 下拉空 → 显示"—" + 提示"请先在设置页配置 simple-ai 供应商"(compact 未处理此情况,优化侧可补) |
| mimo 无 Profile | `isProfileForEngine` 过滤后无 Profile → Profile 下拉自动默认官方 API |
| 切换引擎时已选模型不兼容 | 清空 Profile 和模型,回退到"官方 API" + 新引擎默认模型 |

---

## 8. 实施计划(合并为四阶段)

### Phase 0 — 前置验证(0.5 天,决定路线)

手工实验:建绑定工作区 + `bypassPermissions` + `Read/Grep` 白名单的会话,发"读 CLAUDE.md 后优化这段提示词"指令。验证:
- 模型是否稳定**只输出优化文本**(不夹带工具解说)?
- 是否会**跑偏执行**提示词?
- 约束强度是否够,是否需收窄白名单?

**失败(模型无法稳定只输出优化文本)→ 回退路径1;成功 → Phase 1。**

### Phase 1 — 基础设施:模型透传 + 双模式骨架(1.5 天)

**并行推进**(两项无依赖冲突):

1. **模型透传**(0.5 天,可独立先行):
   - `types.ts`: `RunPromptOptimizeOptions` 增 `modelProfileId`/`model`/`mode`;`PromptVersion` 增 `mode`。
   - `promptOptimizeService.ts`: `createSession` 增传 modelProfileId/model(§3.3);配置记忆从单一 engine 升级为完整对象(§2 localStorage)。
   - 服务层先跑通:即使 UI 未升级,每次优化默认沿用源会话当前模型,比现状"引擎默认模型"更贴合。

2. **双模式骨架**(1 天):
   - `promptOptimizeService.ts`: §3 全部分流(system prompt / sendOptions / 会话创建 / 超时)。
   - `ChatInput.tsx`: 优化浮层加"快速/深度"toggle;深度无工作区按 §5-A 降级。
   - i18n: 模式标签 + 深度提示文案。

**节点**:深度模式真实项目跑通 + 模型默认沿用正确;版本栈标注生效。

### Phase 2 — 浮层 UI 升级 + 精调(1.5 天)

1. **浮层三级选择 UI**(1 天):
   - 搬 CompactHandoffModal 的 `EnginePicker` / `Dropdown` / Profile·模型联动取数进优化浮层。
   - 默认值走 `sourceDefaults` 同款解析链(§7.1)。
   - 信息架构按 §7.3 布局:"引擎 + 模式"常显,"供应商 + 模型"折叠。

2. **Prompt 精调 + 边界加固**(0.5 天):
   - 深度版 System Prompt 精调(§3.1)。
   - 对话上下文轻量接入(§4.1);`sanitizeBriefing` 同款后处理兜底。
   - simple-ai 无 Profile 提示(§7.5)。
   - 四引擎各跑一轮深度优化:确认不跑偏、不夹带、输出干净。

**节点**:四引擎深度优化稳定;模型切换联动正确。

### Phase 3 — 护栏与体验(0.5~1 天)

1. 隐私提示:深度模式首次使用一次性告知"将读取项目文件与对话并发送给所选引擎"。
2. 进度胶囊:深度工具调用期间显示"正在阅读项目上下文…"。
3. 成本可见:浮层深度选项标注"较慢·读取项目上下文"。
4. (可选)§6 混合兜底 + §4.2 长对话落盘切换。

---

## 9. 风险清单(含模型选择部分)

| 风险 | 缓解 |
|------|------|
| **跑偏执行提示词**(最高) | Phase 0 先验;只读白名单(排除 Write/Edit/Bash);强约束 prompt + `sanitizeBriefing` 后处理双保险 |
| **误把上下文当新需求** | prompt 硬分区,`<context>` 仅供贴合,明确"绝不新增需求" |
| **延迟不可控**(读一堆文件) | `DEEP_TIMEOUT_MS` 兜底;白名单排除 Bash 防全盘扫;§6 廉价信息预拼省往返 |
| **隐私面质变**(发项目文件+对话) | 一次性告知;敏感项目可关深度模式 |
| **成本翻倍** | 仅深度承担,快速零成本;近 N 轮截断 + 只读按需 |
| **静默会话权限挂起** | 深度强制 `bypassPermissions`(硬约束) |
| **模型只调工具不输出** | `pickLatestAssistantText` 取空 → 现有失败收口逻辑已覆盖 |
| **浮层信息过载**(四项选择拥挤) | §7.3 折叠方案:"引擎+模式"常显,Profile/模型收入"高级选项"折叠 |
| **模型选择不兼容**(切引擎时已选模型无效) | 同 CompactHandoffModal 清空+回退官方 API;simple-ai 无 Profile 时提示配置 |
| **版本栈辨识度不足**(多轮换模型/模式后分不清) | `PromptVersion.mode` + `model` 写入,回滚时显示 `v2 · 深度 · claude-sonnet` |

---

## 10. 依赖前提(已核实成立)

1. ✅ `sendMessage` 支持 `allowedTools` + `runtimeOverride.permissionMode`(`createConversationStore.ts:1456-1474`)
2. ✅ 工具调用不影响 `isStreaming`,完成检测不误判(`eventHandler.ts:74-195`)
3. ✅ "静默会话 + bypass + agent 读文件产出文本"链路已验证(`contextCompactHandoff.ts`)
4. ✅ `createSession` 支持 `modelProfileId`/`model` 透传,`sendMessage` 解析链自动读取(`createConversationStore.ts:1430-1432`)
5. ✅ `resolveEffectiveProfileId` / `isProfileForEngine` / `CompactHandoffModal` 三级选择 UI 可直接复用
6. ⏳ Phase 0 需验证:模型在只读工具下能否稳定只输出优化文本、不跑偏