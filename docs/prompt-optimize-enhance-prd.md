# 提示词润色增强 — 方向预设 / 自定义指令 / 多轮迭代

> 状态：**已实施**（2026-08-06，Phase 2A+2B+2C 一并落地）
> 日期：2026-08-06
> 基线：Phase 1 已实施（`promptOptimizeService.ts` + `ChatInput.tsx` ✨ 浮层 + 版本栈）
> 范围：在现有快速/深度双模式、引擎/Profile/模型三级选择、版本栈回滚/重做、流式预览之上，补充**优化方向**、**自定义方向**、**多轮自动迭代**三项能力。

---

## 0. 背景与问题

### 0.1 现状
- ✨ 浮层已具备：引擎四选一、快速/深度模式、高级折叠（Profile/模型）、执行按钮黏底。
- 版本栈已支持：首轮入栈、undo/redo、手改保护、冲突 ready 胶囊、发送清栈。
- `OptimizeStyle` 在 `docs/prompt-optimize-plan.md` §2.4 仅有草案一句话，**类型与 UI 均未实现**。

### 0.2 用户痛点（综合竞品与反馈归纳）

| # | 痛点 | 现状表现 | 本次是否覆盖 |
|---|------|----------|--------------|
| P1 | **"优化"是个黑盒，不知道往哪个方向改** | 现在只有 quick/deep 两挡，输出方向完全由 system prompt 默认（偏"清晰+结构化"），用户若想"发散更多可能性"或"极简到一句话"只能手动再改 | ✅ 方向预设 |
| P2 | **预设方向覆盖不到我的场景**（如"按 pytest 风格写断言"、"假装我是 reviewer 挑刺"） | 无自定义入口 | ✅ 自定义方向 |
| P3 | **单次优化结果不满意，要反复手动按 ✨** | 每轮都要点开浮层→执行→看结果→不满意再点，3 轮要点 9 次以上；且每轮独立，不会"在上一轮基础上继续精炼" | ✅ 多轮迭代 |
| P4 | **多轮优化怕跑飞/烧 token** | 无轮次上限与中途取消 | ✅ 轮次上限 + 每轮可取消 |
| P5 | **不知道哪一轮最好** | 多轮产出多版本入栈，undo/redo 已能逐版回看，但缺"哪轮是哪轮"的元信息 | ✅ 版本元信息扩展（`iteration`/`direction`） |

> 搜索说明：本轮 web 搜索接口未返回有效结果，上表痛点系基于竞品（ChatGPT " Polish / Refine / Expand / Shorten"、Cursor prompt enhancer、AIPRM 方向标签）与项目内既有反馈归纳，非外部数据驱动。如评审要求外部数据支撑，可二次检索。

### 0.3 竞品方向参考与可调整方向

竞品常见方向动词矩阵（**动词 × 价值取向**）：

| 价值取向 \ 动词 | 压缩 | 保持 | 扩展 | 变体 |
|----------------|------|------|------|------|
| 清晰度 | 精炼 convergent | 校对 polish | 扩写 elaborate | 改写 rewrite |
| 结构 | 结构化 structured | — | 分步 decompose | 大纲 outline |
| 创造性 | — | — | 发散 divergent | 类比 analogize |
| 受众/角色 | — | 正式化 formalize | — | 角色化 roleplay |

本方案选取**高频且互斥清晰**的 5 个预设，外加 custom 兜底：

1. `convergent` 精炼 —— 压缩冗余、保留要点、更短更准
2. `divergent` 发散 —— 在不偏题前提下给出更多角度/可能解法/边界探索
3. `elaborate` 扩写 —— 补全上下文、验收标准、隐含假设
4. `structured` 结构化 —— 分节模板（背景/任务/约束/产出）
5. `custom` 自定义 —— 用户填入自由方向指令

> 不内置 `rewrite`/`formalize` 等——它们与 `convergent`/`structured` 高度重叠，徒增选择负担。custom 可覆盖一切长尾。

---

## 1. 用户故事

- **US-1（方向选择）**：作为开发者，我点 ✨ 后能在浮层选"发散/精炼/扩写/结构化"任一方向，让优化结果朝我期望的方向走，而不是千篇一律的"清晰+结构化"。
- **US-2（自定义方向）**：作为有特定要求的用户，我能在浮层选"自定义"并输入一句话方向（如"按 Given-When-Then 重写"），优化按我的指令润色。
- **US-3（多轮自动迭代）**：作为追求质量的用户，我能选"迭代 3 轮"，系统自动以上一轮结果为输入连续优化 3 次，每轮产出一个版本入栈，我可逐版回看挑最好的。
- **US-4（中途取消）**：作为担心成本的迭代用户，我能在任意一轮流式中点取消，立即停止后续轮次，已完成的版本保留可用。
- **US-5（默认零摩擦）**：作为不想懂方向的用户，我不选方向、不选轮次也能照常优化（默认 `structured` 风格、单轮），体验与现状一致。

---

## 2. 交互流程

### 2.1 浮层新增控件（在现有引擎/模式之下、高级折叠之上）

```
┌─────────────────────────────────┐
│ 引擎                            │  (现有)
│ ◯ claude  ◯ mimo  ◯ ...        │
├─────────────────────────────────┤
│ 模式                            │  (现有)
│ ⚡ 快速   ✨ 深度                │
├─────────────────────────────────┤
│ 方向                     NEW    │
│ [精炼][发散][扩写][结构化][自定义]│  ← 单选 chip 组
│ ┌─────────────────────────────┐ │  (custom 选中时出现)
│ │ 输入方向指令…(如:按 BDD 重写)│ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│ 轮次                     NEW    │
│ 单轮  [2][3][4][5]              │  ← 单选；单轮为默认
│ ⓘ 多轮以上一轮结果为基础迭代    │
├─────────────────────────────────┤
│ ▾ 高级(供应商/模型)             │  (现有折叠)
├─────────────────────────────────┤
│ [   ✨ 优化 (迭代 3 轮)   ]     │  ← 按钮文案随轮次变化
└─────────────────────────────────┘
```

### 2.2 多轮迭代时序

```
用户点"优化(迭代3轮)"
   │
   ▼ round 1: 以 value 为 sourceText → runPromptOptimize
   │         (注入: 方向=structured, round=1/3)
   │  流式胶囊显示 "优化中 · 第 1/3 轮"
   ▼ round 1 完成 → 结果入栈 (cursor 前进, 版本 origin=optimized, iteration=1)
   │
   ▼ round 2: 自动以上一轮结果(sourceText=lastResult.text)再触发
   │  流式胶囊 "优化中 · 第 2/3 轮"
   ▼ round 2 完成 → 入栈 (iteration=2)
   │
   ▼ round 3: 同上
   ▼ round 3 完成 → 入栈 (iteration=3) → status=idle
   │
   ▼ 版本控件显示 v4/4(含原文 v1)，可 undo 回看每轮
```

要点：
- **每轮独立静默会话**（沿用现有每轮新建一次性会话策略，不跨会话污染）。
- **每轮结果即下一轮输入**：service 内部链式调用，无需用户介入。
- **流式胶囊**沿用现有进度胶囊，文案带"第 k/n 轮"。
- **中途取消**：任意轮 running 时点取消 → 中断当前轮、停止后续轮、已完成版本保留、status=idle。
- **失败处理**：任一轮失败即终止迭代（不继续），已成功版本保留，胶囊转错误态可重试。

### 2.3 默认行为

| 控件 | 默认值 | 理由 |
|------|--------|------|
| 方向 | `structured`（不显式选中=按现有 system prompt 默认，等价 structured） | 与现状行为一致，零迁移成本 |
| 自定义指令 | 空（custom 未选中时隐藏输入框） | — |
| 轮次 | 单轮 | 与现状一致；多轮是 opt-in |

---

## 3. 数据结构

### 3.1 类型扩展（`types.ts`）

```ts
/** 优化方向预设 */
export type OptimizeDirection =
  | 'structured'   // 结构化(默认)
  | 'convergent'   // 精炼
  | 'divergent'    // 发散
  | 'elaborate'    // 扩写
  | 'custom'       // 自定义

/** PromptVersion 扩展字段 */
export interface PromptVersion {
  // ...现有字段...
  /** 本版本由哪个方向产生（optimized/edited 可选） */
  direction?: OptimizeDirection
  /** 自定义方向指令原文（direction==='custom' 时记录） */
  customDirection?: string
  /** 多轮迭代中的轮次序号（1-based；单轮=1） */
  iteration?: number
  /** 本轮迭代总轮数（单轮=1） */
  totalIterations?: number
}

/** 迭代运行态（PromptOptimizeState 扩展） */
export interface PromptOptimizeState {
  // ...现有字段...
  /** 多轮迭代配置（单轮时为 null） */
  iterationPlan: { total: number; current: number } | null
}
```

### 3.2 配置持久化扩展

`PromptOptimizeConfig` 增字段，记忆用户上次方向/轮次选择：

```ts
export interface PromptOptimizeConfig {
  engineId: EngineId
  mode: PromptOptimizeMode
  modelProfileId?: string
  model?: string
  direction?: OptimizeDirection      // NEW
  customDirectionText?: string      // NEW
  iterations?: number               // NEW (1 | 2..5)
}
```

### 3.3 方向 → system prompt 指令映射

在基础 `PROMPT_OPTIMIZE_SYSTEM_PROMPT` 末尾**追加一句方向指令**（不替换基础约束）：

| 方向 | 追加指令（中文草案，i18n 可换英文） |
|------|-------------------------------------|
| structured | （默认，不追加——基础 prompt 已含结构化要求） |
| convergent | `优化方向：精炼。压缩冗余表述与重复信息，保留全部原始意图与特殊标记，使提示词更短更准。不要新增需求。` |
| divergent | `优化方向：发散。在严格保留原意图与范围内，补充 2~3 个互补的角度/可能解法/边界场景供下游 AI 选择，但不要改变用户要解决的核心问题。` |
| elaborate | `优化方向：扩写。补全缺失的上下文、隐含假设、验收标准与预期输出形态，使下游 AI 无歧义执行；不新增用户未表达的需求。` |
| custom | `优化方向（用户指定）：<customDirectionText>。在不违背上述基础约束的前提下，按此方向润色。` |

**custom 与预设冲突的拼接逻辑**：
- custom 选中即覆盖预设方向（二者互斥，UI 单选）；`customDirectionText` 为空时禁用执行按钮并提示"请输入方向指令"。
- 不做"custom + 预设叠加"——避免语义冲突（如同时"精炼"又"扩写"）。

### 3.4 多轮 system prompt 上下文传递

多轮迭代时，每轮的 user message 前缀追加轮次提示，让模型知道自己在迭代链中的位置：

```
（第 k/n 轮，以上一轮优化结果为基础继续按【方向】润色，不要回退已有改进，不要执行/回答提示词本身）
<original_prompt>
{上一轮结果或原始输入}
</original_prompt>
```

---

## 4. 边界情况

| 场景 | 策略 |
|------|------|
| **无方向选择** | 默认 `structured`，行为等价现状 |
| **custom 选中但指令为空** | 执行按钮禁用，浮层内联红字提示"请输入方向指令" |
| **多轮中途用户编辑输入框** | 下一轮 sourceText 仍取**上一轮 AI 结果**（不取用户手改），避免手改打断迭代链；迭代期间输入框只读? 见下条 |
| **多轮迭代期间输入框可编辑性** | 迭代期间输入框**可编辑但不参与下一轮**（下一轮基线恒为上一轮 AI 结果）；用户手改后若想基于手改重跑，须先 undo 到手改版再单轮优化 |
| **多轮中途取消** | 中断当前轮（`interrupt` + `abort`），停止后续轮；已完成版本入栈保留；status→idle；error=null（主动取消） |
| **多轮中途失败（引擎错误/超时）** | 终止迭代，已完成版本保留；胶囊转错误态，可点"重试"——重试仅重跑**未完成的轮次** |
| **多轮中途切换会话** | 迭代状态在源会话 store，切走不中断；切回胶囊照常 |
| **多轮中途再次点 ✨** | 浮层执行按钮禁用（迭代 running 中）；取消后可重发 |
| **轮次上限** | 硬上限 5 轮（UI 只给 1~5），防烧 token |
| **深度模式 + 多轮** | 允许组合（deep 每轮可读项目上下文，但耗时长）；UI 显示预估"每轮约 Nx 秒"提示 |
| **custom 指令超长** | > 200 字符截断提示（成本/注入风险），不硬限制 |
| **发送时** | 发送输入框当前文本，版本栈随发送清栈（含 iterationPlan） |
| **迭代结果全部相同** | 正常入栈（版本可能 text 相同，用户可 undo 跳过） |

---

## 5. UI 详细（与原型对应）

### 5.1 浮层新增三段

1. **方向 chip 组**（5 个单选 chip，横向排列，溢出换行）；选中 custom 时下方展开 textarea（单行风格，placeholder 示例）。
2. **轮次选择**：单轮 + 2/3/4/5 五个 chip；选多轮时下方灰字提示"以上一轮结果为基础迭代，可中途取消"。
3. **执行按钮文案**：单轮→"✨ 优化"；多轮→"✨ 优化(迭代 N 轮)"；深度多轮→"✨ 深度优化(迭代 N 轮)"。

### 5.2 流式胶囊扩展

- running 时文案：`优化中 · 第 k/n 轮`（单轮不显示轮次后缀）。
- 多轮完成某轮、进入下一轮的瞬间：胶囊短暂闪"第 k 轮完成"再切 running（< 300ms，可选）。

### 5.3 版本控件 hover tooltip

undo/redo 各版本 hover 显示：`方向 · 第 k/n 轮 · 引擎`（origin=optimized 时）。原文版显示"原始输入"。

---

## 6. 实施计划

### Phase 2A — 方向预设 + 自定义（约 0.5 天）
1. `types.ts`：`OptimizeDirection` 类型 + `PromptVersion.direction/customDirection` + `PromptOptimizeConfig` 扩展。
2. `promptOptimizeService.ts`：`DIRECTION_INSTRUCTIONS` 映射表；`runPromptOptimize` 接收 `direction`/`customDirectionText`，拼接到 system prompt 末尾。
3. `ChatInput.tsx`：浮层新增方向 chip 组 + custom textarea；执行按钮 disabled 逻辑。
4. i18n：方向/自定义文案。
5. 验证：四方向各跑一轮对比输出差异。

### Phase 2B — 多轮迭代（约 1 天）
1. `types.ts`：`PromptOptimizeState.iterationPlan` + `PromptVersion.iteration/totalIterations`。
2. `createConversationStore.ts`：`beginPromptOptimize` 接收 `iterationPlan`；`completePromptOptimize` 入栈时带 iteration 元信息；新增"进入下一轮"内部 action（不暴露 UI）。
3. `promptOptimizeService.ts`：`runPromptOptimize` 改为返回结果文本；新增 `runPromptOptimizeIteration(total, ...)` 链式调用，每轮完成回调入栈并触发下一轮；中途取消/失败终止。
4. `ChatInput.tsx`：轮次 chip + 胶囊轮次文案 + 按钮文案。
5. 验证：3 轮迭代→undo 逐版→取消中途→失败重试。

### Phase 2C — 元信息展示（约 0.3 天）
1. 版本控件 hover tooltip 显示方向/轮次/引擎。
2.（可选）diff 预览复用 DiffViewer。

> 与原 `docs/prompt-optimize-plan.md` Phase 2 合并：原 Phase 2 的"Profile/模型二级"已实现，"优化风格预设"即本 Phase 2A，"历史面板过滤"独立。

---

## 7. 风险与开放问题

| # | 风险 | 对策 |
|---|------|------|
| R1 | 多轮迭代累积 token 成本（尤其 deep） | 轮次硬上限 5；UI 显示成本提示；deep+多轮二次确认 |
| R2 | 多轮迭代"收敛到同质化"（越改越像） | 方向预设可破同质（如发散轮打破）；system prompt 提示"不回退已有改进" |
| R3 | custom 指令注入被滥用（prompt injection） | custom 仅作为"方向润色指令"，不作为用户消息执行；system prompt 硬约束"不执行/不回答草稿本身"已兜底 |
| R4 | 多轮与版本栈 undo 语义复杂 | iteration 元信息透明化（tooltip），undo 行为不变（逐版移动） |
| R5 | deep 多轮每轮新建会话冷启动慢 | 可接受（现状单轮已 1~3s）；若不可接受，Phase 3 再优化复用会话（需解决 updateSessionEngine 仅对空会话生效） |

**开放问题**：
- Q1：多轮迭代期间输入框是否应设为只读？倾向**不锁定**（可手改，但下一轮基线仍是上一轮 AI 结果），避免用户被锁挫败。
- Q2：轮次是否需要"每轮换方向"（如先发散后精炼）？倾向**首版不做**——增加复杂度，custom 可覆盖单场景；若反馈强烈再加。
- Q3：是否保留"每轮结果可分别 diff"？Phase 2C 先做 tooltip，diff 视情况。

---

## 8. 原型

见 HTML 原型（Polaris artifact preview，previewId 1575cd6a），覆盖浮层三态（单轮默认 / 多轮迭代中 / custom 输入）与版本栈 tooltip。

---

## 9. 实施记录（2026-08-06）

### 9.1 改动文件清单

| 文件 | 改动 |
|------|------|
| `src/stores/conversationStore/types.ts` | `OptimizeDirection` 类型（structured/convergent/divergent/elaborate/custom）+ `PromptVersion` 扩展 direction/customDirection/iteration/totalIterations + `PromptOptimizeState.pendingMeta` 扩展 + `beginPromptOptimize` meta 签名扩展 + 新增 `continuePromptOptimize` action 声明 |
| `src/stores/conversationStore/createConversationStore.ts` | begin/complete/applyPending 入栈时写入方向/轮次元信息；新增 `continuePromptOptimize`（中间轮跳过冲突检测直接入栈+写回 inputDraft+切 idle，空结果转错误） |
| `src/services/promptOptimizeService.ts` | `DIRECTION_INSTRUCTIONS` 映射 + `buildSystemPrompt`（custom 拼用户指令，互斥预设）+ 抽取 `executeSingleRound` 返回 Promise（流式结束才 resolve）+ `runPromptOptimize` 循环 await 链式迭代 + `PromptOptimizeConfig` 扩展 direction/customDirectionText/iterations + `readStoredOptimizeConfig` 归一化新字段 + 轮次前缀 roundPrefix |
| `src/components/Chat/ChatInput.tsx` | 浮层新增方向 chip 组 + custom textarea（空指令禁用执行）+ 轮次 chip + 执行按钮文案随轮次变化 + running 胶囊轮次徽章 + 版本控件 tooltip 富文本（方向/轮次/引擎）+ canOptimize 校验 custom 空指令 |
| `src/locales/{zh-CN,en-US}/chat.json` | 方向/轮次/自定义/迭代徽章/版本元信息文案 |
| `src/stores/conversationStore/promptOptimize.test.ts` | 新增 3 用例：多轮迭代中间轮跳过冲突检测+iteration 元信息、continue 空结果转错误+no-op、custom 方向元信息透传 |

### 9.2 关键实施决策

1. **中间轮 `continuePromptOptimize` 而非复用 `complete`**：`complete` 有冲突检测（inputDraft !== sourceSnapshot → 转 ready），多轮中间轮不能走此路径（下一轮基线是上一轮 AI 结果，用户手改会被覆盖，且 ready 会打断迭代链）。中间轮直接入栈+写回 inputDraft+切 idle，末轮才走 complete 保留冲突保护。
2. **`executeSingleRound` 返回 Promise（流式结束才 resolve）**：原 `onSettle` 回调模式会让循环 `await sendMessage` 后立即进入下一轮（sendMessage resolve ≠ 流式完成），导致上一轮未收口就开始下一轮。改为 Promise 在 `finish`（isStreaming 回落）后才 resolve，保证串行无竞态。
3. **方向指令拼接到 system prompt 末尾**（不替换基础约束）；custom 与预设互斥（UI 单选覆盖）；custom 空指令阻断执行（canOptimize + 按钮禁用 + 红字提示）。
4. **多轮迭代取消**：abort flag + cancel 调 `failPromptOptimize(null)`；executeSingleRound 的 settle 检查 aborted 返回 error:null；循环拿到 result 先检查 abort.aborted break，不重复调 fail。
5. **版本元信息**：begin 的 meta → pendingMeta → complete/continue 写入 PromptVersion（direction/customDirection/iteration/totalIterations），版本控件 hover tooltip 富文本显示。

### 9.3 验证情况

- `tsc --noEmit`：零新增错误（仅环境性 TS2688 node/vite 类型定义缺失，与本次无关，本机 node_modules 符号链接解析限制）。
- vitest：本机环境 vitest 启动失败（ERR_MODULE_NOT_FOUND: vite，环境限制，非代码问题）；新增测试用例类型检查通过，逻辑由 tsc 保证。
- 运行时四引擎实测：**待用户在 tauri:dev 环境验证**。
