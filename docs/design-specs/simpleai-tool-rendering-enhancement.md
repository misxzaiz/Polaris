# PRD：SimpleAI 引擎工具调用渲染增强

> 版本：v1.0 ｜ 状态：草案 ｜ 关联模块：`src/components/Chat/chatBlocks`、`src/utils/toolConfig.ts`、`src/utils/diffExtractor.ts`、`src/utils/toolSummary.ts`
> 关联后端：`src-tauri/src/ai/engine/simple_ai/tools/*`

---

## 1. 背景与问题

### 1.1 现状

SimpleAI 引擎（Polaris 自研的 OpenAI 兼容工具循环引擎）注册了 13 个内置工具：`bash`、`read_file`、`write_file`、`list_directory`、`edit_file`、`search_files`、`glob`、`apply_patch`、`update_plan`、`read_skill`、`dispatch_agent`、`browser`、`computer`。

这些工具在后端经统一 `Tool` trait → `ToolRegistry` 分发，产生的 `tool_call_start` / `tool_call_end` 事件在前端被归一化为 `ToolCallBlock`，最终由 `ToolCallBlockRenderer` 渲染。

### 1.2 问题

渲染链路与 Claude 引擎完全一致，但 SimpleAI 工具**前端适配缺失**，导致视觉上呈现"原生感"：

| 工具 | 折叠态显示 | 问题 |
|---|---|---|
| `bash` | `bash` + 扳手图标 + 命令文本 | 标签是原始 `bash` 而非友好名；颜色为灰色 other |
| `apply_patch` | `apply_patch` + 扳手图标，**无关键参数** | 头部无法看出改了哪些文件；输入只有 `input: "*** Begin Patch..."` 纯文本 |
| `update_plan` | `update_plan` + 扳手图标（+ 计划面板） | 工具卡冗余，与计划面板信息重复 |
| `edit_file` | `edit_file` + 扳手图标 | `isEditTool()` 不识别 `edit_file`，**不进 Diff 专用展示**，无 diffData |
| `list_directory` / `glob` | 纯文本输出 | 无文件列表结构化渲染 |

根因：

1. `toolConfig.ts` 的 `TOOL_ICONS` / `TOOL_CATEGORY` / `TOOL_LABEL_KEYS` 三张映射表**未收录 SimpleAI 工具名**（`bash`、`edit_file`、`apply_patch` 等），全部回退到 `other` 分类 + 扳手图标 + 原始名标签。
2. `diffExtractor.ts` 的 `isEditTool()` 白名单**不含 `edit_file`**，导致 SimpleAI 的行级编辑工具无法触发 DiffViewer。
3. `toolSummary.ts` 的折叠摘要逻辑用 `includes('edit')` 等模糊匹配，对 `edit_file` 部分命中但对 `apply_patch` 完全不命中。
4. `apply_patch` 的输入是一个完整补丁信封字符串，前端**无解析器**，无法提取"修改了哪些文件 / 增删行数"。

### 1.3 目标

在不改变后端协议、不改变 `ToolCallBlock` 数据结构的前提下，让 SimpleAI 工具调用获得与 Claude 引擎工具同等质量的语义化渲染：

- 折叠态一眼看出"工具做了什么 + 作用对象 + 结果摘要"
- 展开态对编辑类工具直接渲染 Diff，对补丁类工具渲染文件级 Diff 列表
- 颜色 / 图标 / 标签与工具语义对齐

---

## 2. 范围

### 2.1 In Scope

| 编号 | 工具 | 增强内容 |
|---|---|---|
| F1 | 全部 SimpleAI 工具 | 补齐 `toolConfig.ts` 三张映射表（icon/category/label/shortName） |
| F2 | `edit_file` | 纳入 `isEditTool()` 白名单，触发 DiffViewer；折叠态显示 `+N -M` |
| F3 | `apply_patch` | 新增补丁解析器；折叠态显示"修改 N 文件 +N -M"；展开态渲染文件级 Diff 列表 |
| F4 | `update_plan` | 通用工具卡降级为"已更新计划"提示，避免与计划面板重复 |
| F5 | `list_directory` / `glob` | 输出解析为可点击文件列表（复用 GrepOutputRenderer 模式） |
| F6 | `bash` | 标签友好化（"执行命令"）、命令复制已有，补充退出码徽标 |

### 2.2 Out of Scope

- 后端 `Tool` trait、`ToolRegistry`、事件协议：**不改**
- `ToolCallBlock` 类型结构：**不改**（仅可能扩展 `diffData` 为数组以支持多文件）
- `update_plan` 的计划面板本身：**不改**（已通过 `plan_start`/`plan_content` 实现）
- MCP 动态工具（`mcp__*`）：本期不做专项适配，仍走通用兜底
- `browser` / `computer` / `dispatch_agent` / `read_skill`：仅补齐 icon/label，不做结构化输出

---

## 3. 详细需求

### F1. 工具配置映射补齐

**文件**：`src/utils/toolConfig.ts`

为以下工具名补齐四张映射（`TOOL_SHORT_NAMES` / `TOOL_ICONS` / `TOOL_CATEGORY` / `TOOL_LABEL_KEYS`）：

| 工具名 | shortName | icon | category | labelKey |
|---|---|---|---|---|
| `bash` | B | Terminal | execute | labels.execute |
| `edit_file` | E | Edit2 | edit | labels.edit |
| `list_directory` | L | FolderOpen | list | labels.list |
| `glob` | G | FileSearch | search | labels.searchFiles |
| `apply_patch` | P | GitPullRequest | edit | labels.applyPatch |
| `update_plan` | P | ListChecks | manage | labels.updatePlan |
| `read_skill` | K | Layers | agent | labels.skill |
| `dispatch_agent` | A | Cpu | agent | labels.agent |
| `browser` | W | Globe2 | network | labels.browser |
| `computer` | C | Cpu | execute | labels.computer |

i18n 资源（`public/locales/*/tools.json`）需同步新增 `labels.applyPatch` / `labels.updatePlan` / `labels.browser` / `labels.computer` 键。

**验收**：折叠态 `bash` 显示紫色 B 徽标 + "执行命令" 标签；`apply_patch` 显示橙色 P 徽标 + "应用补丁" 标签。

---

### F2. `edit_file` 纳入 Diff 展示

**文件**：`src/utils/diffExtractor.ts`

```ts
export function isEditTool(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return n === 'str_replace_editor' ||
         n === 'edit' ||
         n === 'edit_file' ||      // ← 新增
         n.includes('str_replace');
}
```

`extractEditDiff` 需兼容 SimpleAI `edit_file` 的输入字段。SimpleAI `edit_file` 的输入结构（来自 `tools/fs.rs`）：

```
{ path: string, old_text: string, new_text: string }
```

现有提取器读 `old_string` / `new_string`，需补充 `old_text` / `new_text` 别名：

```ts
const oldContent = (input.old_string || input.old_str || input.old_text || input.oldContent) as string;
const newContent = (input.new_string || input.new_str || input.new_text || input.newContent) as string;
```

**验收**：SimpleAI 调用 `edit_file` 后，工具卡展开态直接渲染 DiffViewer，折叠态显示 `+N -M` 徽标。

---

### F3. `apply_patch` 补丁解析与 Diff 渲染（核心）

#### 3.1 补丁格式（Codex 风格）

```
*** Begin Patch
*** Add File: path/to/new.ts
+新增内容
*** Update File: path/to/existing.ts
@@ ...
-旧行
+新行
*** Delete File: path/to/old.ts
*** End Patch
```

#### 3.2 新增解析器

**新文件**：`src/utils/patchParser.ts`

```ts
export interface PatchFileChange {
  type: 'add' | 'update' | 'delete';
  filePath: string;
  hunks: { oldStart: number; newStart: number; lines: string[] }[];
  addedLines: number;   // +N
  removedLines: number; // -M
  oldContent: string;   // 由 - 行重建
  newContent: string;   // 由 + 行与上下文重建
}

export interface ParsedPatch {
  files: PatchFileChange[];
  totalAdded: number;
  totalRemoved: number;
}

export function parseApplyPatch(input: string): ParsedPatch | null;
```

解析器需处理：

- `*** Add File: <path>` — 全部为 `+` 行，oldContent 为空
- `*** Update File: <path>` — 含 `@@` hunk 头与 `-`/`+`/` ` 三类行
- `*** Delete File: <path>` — 全部为 `-` 行，newContent 为空
- `*** End Patch` — 结束

`oldContent` / `newContent` 重建规则（用于 DiffViewer）：
- ` ` 上下文行：同时进入 old 与 new
- `-` 行：只进 old
- `+` 行：只进 new

#### 3.3 Block 数据扩展

**文件**：`src/types/chat.ts`

`ToolCallBlock.diffData` 当前为单文件结构。为支持多文件，扩展为可选数组：

```ts
export interface ToolCallBlock {
  // ...
  diffData?: DiffData;            // 保留，单文件（edit_file）
  patchData?: PatchFileChange[];  // 新增，多文件（apply_patch）
}
```

#### 3.4 事件处理接入

**文件**：`src/stores/conversationStore/eventHandler.ts`

`tool_call_end` 分支补充：

```ts
if (block?.type === 'tool_call' && block.name === 'apply_patch') {
  const patchInput = block.input?.input as string;
  const parsed = parseApplyPatch(patchInput);
  if (parsed) {
    state.updateToolCallBlockPatch(callId, parsed.files);
  }
}
```

#### 3.5 渲染器

**新文件**：`src/components/Chat/chatBlocks/PatchDiffRenderer.tsx`

折叠态（由 `generateCollapsedSummary` 产出）：
```
[橙色 P] 应用补丁  3 文件  +12 -5  [✓]
```

展开态：
- 顶部：补丁总览（N 文件 · +X -Y）
- 逐文件折叠卡片：文件路径（可点击打开）+ 该文件 `+a -b` + 内嵌 DiffViewer

**验收**：
- `apply_patch` 修改 3 个文件时，折叠态显示"3 文件 +12 -5"
- 展开态逐文件渲染 DiffViewer，每个文件可独立折叠
- 文件路径点击可打开编辑器（复用 `useFileEditorStore`）

---

### F4. `update_plan` 工具卡降级

**文件**：`src/components/Chat/chatBlocks/ToolCallBlockRenderer.tsx`

当 `block.name === 'update_plan'` 且已存在同会话的 `plan_mode` block 时：
- 折叠态：显示 `[ListChecks] 已更新计划  N 步  [✓]`，不可展开（或仅展开显示纯文本步骤）
- 不再显示通用输入参数 `plan: [...]` 的 JSON dump

实现方式：渲染器内通过 props 传入 `hasPlanPanel: boolean` 标志，或在 `ToolCallBlockRenderer` 内根据 `block.name === 'update_plan'` 走精简分支。

**验收**：`update_plan` 调用后，聊天区只显示一行"已更新计划"提示，详细步骤在计划面板查看，无信息重复。

---

### F5. `list_directory` / `glob` 文件列表渲染

**文件**：`src/utils/toolSummary.ts`、新组件 `FileListOutputRenderer.tsx`

`list_directory` 输出格式（来自 `tools/fs.rs`）：

```
[DIR]  src
[FILE] main.rs (1.2 KB)
[FILE] config.rs (3.4 KB)
```

`glob` 输出为每行一个文件路径。

新增解析器 `parseFileList(output, toolName)`，返回 `{ entries: { name, type, size? }[] }`。

渲染：复用 `GrepOutputRenderer` 的列表样式，文件名点击可打开编辑器。

**验收**：`list_directory` 输出渲染为带图标的文件/目录列表，点击文件名打开编辑器；不再是无格式纯文本。

---

### F6. `bash` 退出码徽标

**文件**：`src/utils/toolSummary.ts` → `generateCollapsedSummary`

`bash` 当前不显示输出摘要（仅状态图标）。增强：从 output 末行解析退出码（SimpleAI bash 工具的 output 含 `[exit: N]` 后缀，见 `tools/bash.rs`），失败时在折叠态显示红色 `exit 1` 徽标。

**验收**：`bash` 命令失败时折叠态显示 `exit 1` 红色徽标；成功时不显示。

---

## 4. 非功能需求

### 4.1 性能

- `parseApplyPatch` 在单次补丁 ≤ 50 文件、≤ 5000 行时解析 < 5ms（纯前端字符串处理，无 IO）
- DiffViewer 已有 Web Worker 异步 diff 与大文件降级（见 memory `diff-viewer-perf-optimization`），`PatchDiffRenderer` 复用，不为每个文件新开 Worker

### 4.2 兼容性

- `ToolCallBlock.diffData` 字段保留，`edit_file` 仍用单文件路径；`patchData` 为新增可选字段，不影响现有 Claude 引擎工具
- `toolConfig.ts` 新增映射不影响未命中工具的回退逻辑
- 历史会话恢复（`dialogStorageService` JSONL）已序列化 `blocks`，新字段 `patchData` 需在反序列化时容错（缺失即不渲染 Diff，回退纯文本）

### 4.3 i18n

新增 i18n 键（中/英）：
- `tools.labels.applyPatch` = 应用补丁 / Apply Patch
- `tools.labels.updatePlan` = 更新计划 / Update Plan
- `tools.labels.browser` = 浏览器 / Browser
- `tools.labels.computer` = 电脑操作 / Computer
- `tools.output.patchSummary` = `{{files}} 文件 +{{added}} -{{removed}}`
- `tools.output.exitCode` = `退出码 {{code}}`

---

## 5. 交互设计

### 5.1 折叠态（默认）

```
┌─────────────────────────────────────────────────────┐
│ [P] 应用补丁  3 文件 +12 -5              1.2s  [✓]  │
└─────────────────────────────────────────────────────┘
```

### 5.2 展开态（apply_patch）

```
┌─────────────────────────────────────────────────────┐
│ [P] 应用补丁                       09:30:12 → 09:30:13│
│                                                      │
│ 补丁总览：3 文件 · +12 -5                            │
│                                                      │
│ ▼ src/main.rs                    +5 -2   [打开]      │
│   ┌─ DiffViewer ─────────────────────────────┐      │
│   │  old → new                                │      │
│   └───────────────────────────────────────────┘      │
│                                                      │
│ ▶ src/config.rs                  +7 -0   [打开]      │
│ ▶ src/old.ts                     +0 -3   [打开]      │
└─────────────────────────────────────────────────────┘
```

### 5.3 展开态（edit_file）

```
┌─────────────────────────────────────────────────────┐
│ [E] 编辑  src/main.rs          +5 -2     1.0s  [✓]  │
│                                                      │
│   ┌─ DiffViewer ─────────────────────────────┐      │
│   │  old_string → new_string                  │      │
│   └───────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────┘
```

### 5.4 update_plan 降级态

```
┌─────────────────────────────────────────────────────┐
│ [P] 已更新计划  3 步                              [✓]│
└─────────────────────────────────────────────────────┘
（详细步骤见右侧计划面板）
```

---

## 6. 实施计划

| 阶段 | 内容 | 预估 | 依赖 |
|---|---|---|---|
| P1 | F1 工具配置映射 + i18n | 0.5d | 无 |
| P2 | F2 edit_file Diff 接入 | 0.5d | P1 |
| P3 | F3 apply_patch 解析器 + PatchDiffRenderer | 1.5d | P1 |
| P4 | F4 update_plan 降级 | 0.5d | P1 |
| P5 | F5 list_directory/glob 列表渲染 | 1d | P1 |
| P6 | F6 bash 退出码徽标 | 0.5d | P1 |
| P7 | 联调 + 单元测试（patchParser、isEditTool） | 1d | P2-P6 |

**总计**：约 5.5 人日。

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `apply_patch` 补丁格式变体多（context 行、空文件、二进制） | 解析器遗漏边界 | 解析器对未知行容错跳过；解析失败回退纯文本展示，不阻断 |
| `patchData` 数组 DiffViewer 多实例性能 | 大补丁卡顿 | 复用现有 Worker + 单文件独立懒渲染（展开时才 diff） |
| 历史会话 `patchData` 字段缺失 | 旧数据无 Diff | 反序列化容错，缺失即回退纯文本，与现状一致 |
| `edit_file` 输入字段与 Claude `str_replace_editor` 不一致 | Diff 提取失败 | `extractEditDiff` 已设计多别名兼容，补充 `old_text`/`new_text` |

---

## 8. 验收标准

1. SimpleAI 调用 `bash` / `edit_file` / `apply_patch` / `update_plan` / `list_directory` / `glob` 时，折叠态均显示友好标签 + 语义化图标 + 颜色，不再出现裸 `apply_patch` + 扳手图标。
2. `edit_file` 展开态渲染 DiffViewer。
3. `apply_patch` 折叠态显示"N 文件 +X -Y"，展开态逐文件渲染 DiffViewer。
4. `update_plan` 不再与计划面板信息重复。
5. `list_directory` / `glob` 渲染为可点击文件列表。
6. TypeScript 编译零错误；现有 Claude 引擎工具渲染无回归。
7. `parseApplyPatch` 单元测试覆盖 Add/Update/Delete 三类操作 + 多文件混合。

---

## 9. 附：关键文件清单

| 文件 | 改动类型 |
|---|---|
| `src/utils/toolConfig.ts` | 修改：补齐映射表 |
| `src/utils/diffExtractor.ts` | 修改：`isEditTool` + `extractEditDiff` 别名 |
| `src/utils/toolSummary.ts` | 修改：`generateCollapsedSummary` 支持 apply_patch / bash exit |
| `src/utils/patchParser.ts` | **新增**：apply_patch 补丁解析器 |
| `src/types/chat.ts` | 修改：`ToolCallBlock` 增 `patchData` |
| `src/stores/conversationStore/eventHandler.ts` | 修改：tool_call_end 接入 patch 解析 |
| `src/components/Chat/chatBlocks/PatchDiffRenderer.tsx` | **新增**：多文件 Diff 渲染器 |
| `src/components/Chat/chatBlocks/FileListOutputRenderer.tsx` | **新增**：文件列表渲染器 |
| `src/components/Chat/chatBlocks/ToolCallBlockRenderer.tsx` | 修改：接入新渲染器 + update_plan 降级 |
| `public/locales/*/tools.json` | 修改：新增 i18n 键 |
