# /spec 命令：规格驱动开发模式集成

> 版本: v1.0
> 日期: 2026-07-26
> 关联: ADR 0007 · S001 攻坚工作流 · S002 /assault 协议

---

## 1. 设计目标

让用户在 Polaris 主对话中发起一个**有规格约束的开发任务**——AI 先读规格、按规格开发、以 AC 验收，全程对话内分步可见、可打断、可调整。

交互模式与 `/assault` 完全一致：前端拦截 `/` 命令 → 剥离前缀发送 → system prompt 约束模型行为。

---

## 2. 使用方式

```
/spec S004 实现文件上传功能
```

参数：
- `S00X`：规格编号，从 `docs/specs/SPEC-CATALOG.md` 中查询活跃规格
- 后续文本：对该规格的用户补充说明或方向约束

完整流程：

```
用户: /spec S004 实现文件上传功能
       ↓ ChatInput 拦截，剥离 /，发送 "spec S004 实现..."
       ↓ 模型识别 "spec" 开头，进入规格开发模式

📐 Step 1/4: 读规格 → 输出 Intent/AC 理解，请确认
🔨 Step 2/4: 生成实施计划，请确认
✅ Step 3/4: 编码实施（按 Task 顺序，每步验证）
🎯 Step 4/4: AC 验证矩阵（逐条确认）
```

---

## 3. 改动清单

| # | 文件 | 改动 | 行数 |
|---|------|------|------|
| 1 | `src/services/cliSlashCommands.ts` | 新增 `parseSpecSlashCommand` + 注册命令 | ~15 |
| 2 | `src/components/Chat/ChatInput.tsx` | 新增 `/spec` 拦截分支 | ~15 |
| 3 | `src/locales/zh-CN/systemPrompt.json` | 新增 `specDevelopmentProtocol` key | ~1 行（内容长，但 key 一个） |
| 4 | `src/locales/en-US/systemPrompt.json` | 同上英文版本 | ~1 行 |
| 5 | `src/services/workspaceReference.ts` | `buildWorkspacePrompt` 拼入协议 | ~2 行 |

---

## 4. 具体实现

### 4.1 `cliSlashCommands.ts`

**新增** `parseSpecSlashCommand`：

```ts
/**
 * 解析 /spec 命令，剥离 / 前缀后返回纯文本。
 * 若不以 /spec 开头则返回 null。
 */
export function parseSpecSlashCommand(text: string): string | null {
  if (!text.startsWith('/spec')) return null
  const rest = text.slice('/spec'.length)
  // /specs 等前缀误匹配：/spec 后必须有空白或结尾
  if (rest && !/^\s/.test(rest)) return null
  return text.slice(1)  // "spec S004 xxx"
}
```

**注册命令**：

```ts
export const CLI_SUGGESTED_COMMANDS: CliSlashCommandMeta[] = [
  { name: 'compact', argumentHint: '[instructions]', descKey: 'compact' },
  { name: 'context', descKey: 'context' },
  { name: 'usage', aliases: ['cost', 'stats'], descKey: 'usage' },
  { name: 'mcp', descKey: 'mcp' },
  { name: 'model', descKey: 'model' },
  { name: 'recap', descKey: 'recap' },
  { name: 'assault', argumentHint: '<profile> <problem>', descKey: 'assault' },
  { name: 'spec', argumentHint: '<S00X> <补充说明>', descKey: 'spec' },  // 新增
]
```

**新增测试** `cliSlashCommands.test.ts`（`describe('parseSpecSlashCommand')`，7 条用例，模式同 `parseAssaultSlashCommand`）。

### 4.2 `ChatInput.tsx`

在 `parseAssaultSlashCommand` 拦截分支之后、`/clear` 拦截之前，新增：

```tsx
// 规格驱动开发命令：/spec <S00X> <补充说明> → 剥离 / 后作为普通文本发送
const specText = parseSpecSlashCommand(trimmed)
if (specText) {
  cancelPersistDraft()
  setLocalText('')
  setLocalAttachments([])
  updateInputDraft({ text: '', attachments: [] })
  setHistoryIndex(-1)
  resetPromptOptimize()
  onSend(specText, currentWorkspace?.path, attachments.length > 0 ? attachments : undefined)
  return
}
```

### 4.3 `systemPrompt.json` 协议内容

**中文** `zh-CN/systemPrompt.json` 新增 key：

```json
{
  "specDevelopmentProtocol": "## 规格驱动开发协议\n\n当用户消息以 'spec' 开头时（格式：`spec <S编号> <补充说明>`），进入规格驱动开发模式：\n\n### 第 1 步：读规格\n- 读取 `docs/specs/SPEC-CATALOG.md` 确认编号对应状态\n- 读取对应规格文件 `docs/specs/S<编号>-*.md`\n- 用结构化格式输出：\n  ```\n  📐 Step 1/4: 读规格\n\n  规格：<编号> <名称>（状态：<状态>）\n\n  ### Intent 理解\n  - <系统应该做什么>\n\n  ### 关键验收标准\n  - AC-1: <文本>\n  - AC-2: <文本>\n  - ...\n\n  ### 约束与排除\n  - 约束: <非功能需求>\n  - 排除: <不做的事>\n\n  ### 确认\n  我理解需求为以上摘要。方向正确吗？有什么需要调整的？\n  ```\n\n### 第 2 步：生成实施计划\n- 根据规格生成任务分解（编号 T1、T2...）\n- 每个任务标注：涉及的规格章节、产出文件、验收方式\n- 输出结构化概要，等待用户确认后再进入实施\n\n### 第 3 步：编码实施\n- 按任务顺序实施，每完成一个任务后输出验证结果\n- 遇到与规格冲突的情况，立即停下汇报，不要自行决定\n- 不跳过任何已批准的验收标准\n\n### 第 4 步：验证矩阵\n- 对照 AC 逐条确认，输出验证矩阵表格：\n  ```\n  | AC# | 验收标准 | 实际结果 | 通过 |\n  |-----|----------|----------|------|\n  | 1   | ... | 已实现，见 xxx | ✅ |\n  | 2   | ... | 未覆盖 | ❌ |\n  ```\n- 如有不通过的 AC，标记风险和原因，不掩盖\n- 更新 SPEC-CATALOG.md 状态为 implemented（如果全部通过）\n\n### 关键约束\n- 规格编号无效时，列出活跃规格让用户选择\n- 不能把"代码写了"定义为完成——完成 = AC 全部通过\n- 不修改已 approved 的规格文件内容，只更新状态"  ...
}
```

**英文** `en-US/systemPrompt.json` 对应英文版本（关键术语保持一致：spec、intent、acceptance criteria、verify matrix）。

### 4.4 `workspaceReference.ts`

在 `buildWorkspacePrompt` 函数中，`workspaceToolGuidance` 之后追加：

```ts
lines.push(t('systemPrompt:specDevelopmentProtocol'))
```

---

## 5. 交互流程完整示例

```
用户: /spec S004 实现文件上传功能

📐 Step 1/4: 读规格

规格：S004 ChatInput 草稿保存/加载（状态：draft）

### Intent 理解
- 系统应当在 /save-draft 时将输入框内容保存为本地 Markdown
- 系统应当在 /load-draft 时将草稿内容回填到输入框
- 系统应当在 /list-drafts 时列出所有草稿

### 关键验收标准
- AC-1: 草稿保存到 ~/.polaris/drafts/
- AC-2: 无标签时自动生成时间戳文件名
- AC-3: 空输入框时拒绝保存
- AC-4: 同名文件自动追加后缀
- ...（共 11 条）

### 约束与排除
- 约束: Web-only 编译降级、文件名安全规范化、纯命令操作
- 排除: 版本管理、搜索、删除、跨设备同步

### 确认
我理解需求为以上摘要。方向正确吗？有什么需要调整的？

用户: 方向没问题，但 AC-4 追加后缀改成直接覆盖旧文件

🔨 Step 2/4: 生成实施计划

计划确认，开始实施。

✅ Step 3/4: 编码实施

T1: 创建 Rust draft_service.rs → cargo check 通过
T2: 前端 draftService.ts → tsc 通过
T3: ChatInput 拦截 /save-draft → 测试通过
...

🎯 Step 4/4: AC 验证矩阵

| AC# | 验收标准 | 实际结果 | 通过 |
|-----|----------|----------|------|
| 1 | 草稿保存到 ~/.polaris/drafts/ | 已实现，draft_service.rs:save_draft | ✅ |
| 2 | 无标签自动生成时间戳 | 已实现，generate_filename | ✅ |
| 3 | 空输入框拒绝保存 | 已实现，validate_content | ✅ |
| 4 | 同名文件追加后缀 | 已改为覆盖，用户确认 | ⚠️ |
...
```

---

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 协议太长挤占上下文 | 协议约 600 字，放在 workspace prompt 末尾；实际占用极小 |
| 模型忽略协议 | 协议在 system prompt 中，优先级高于普通消息；`/assault` 已验证模式有效 |
| 规格文件不存在 | Step 1 报错，列出 SPEC-CATALOG.md 中的活跃规格让用户选择 |
| 规格是 draft 状态 | 仍可按 draft 规格开发，但验证阶段标注"规格未正式批准" |

---

## 7. 与现有体系的兼容性

| 体系 | 兼容性 |
|------|--------|
| `/assault` 模式 | ✅ 完全一致（前端拦截 → system prompt 协议） |
| `/dispatch @spec-developer` | ✅ 互补（对话内 vs 后台派发，按场景选择） |
| ADR 0007 SDD 框架 | ✅ `/spec` 是 SDD 在对话中的落地入口 |
| Web-only 编译 | ✅ 改动均为前端 TS + JSON，无 Rust 改动 |
| 现有 CLI 命令系统 | ✅ 沿用 `parseXXXSlashCommand` + `handleSend` 分支模式 |

---

## 8. 验收标准

| AC# | 验收标准 | 验证方式 |
|-----|----------|----------|
| AC-1 | `/spec S004 xxx` 被正确拦截并发送 | 单元测试 + 手动 |
| AC-2 | `/spec` 拒绝 `/specs` 前缀误匹配 | 单元测试 |
| AC-3 | 模型进入规格开发模式，输出 Step 1/4 | 手动：输入命令观察输出 |
| AC-4 | Step 1 输出 Intent 理解 + AC 列表 + 确认问题 | 手动 |
| AC-5 | 用户确认后进入 Step 2（生成计划） | 手动 |
| AC-6 | Step 4 输出 AC 验证矩阵表格 | 手动 |
| AC-7 | 无效 S 编号时列出活跃规格 | 手动：输入不存在的编号 |
| AC-8 | 协议在 system prompt 中可读取 | 手动：设置 → 系统提示词 |
| AC-9 | TypeScript 编译零错误 | tsc |
| AC-10 | 现有 `/assault` 行为不受影响 | 现有测试全绿 |

---

## 9. 实施步骤

| 步骤 | 内容 | 工作量 |
|------|------|--------|
| 1 | `cliSlashCommands.ts` + 测试 | 0.3h |
| 2 | `ChatInput.tsx` 拦截分支 | 0.2h |
| 3 | `systemPrompt.json` 中英文协议 | 0.5h |
| 4 | `workspaceReference.ts` 拼接 | 0.1h |
| 5 | 端到端手动验证 | 0.5h |
| 6 | 整理 git commit | 0.2h |
| **合计** | | **~1.8h** |
