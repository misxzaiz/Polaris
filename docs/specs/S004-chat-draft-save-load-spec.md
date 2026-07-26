---
name: chat-draft-save-load
status: draft
version: 1.0
date: 2026-07-26
author: spec-developer
reviewers: []
related-adrs: []
related-plans: []
priority: p2
---

# ChatInput 草稿保存/加载/列出斜杠命令

## 1. Context（背景）

### 1.1 问题陈述

Polaris 用户在输入框中编辑的长文本（prompt / 需求 / 设计草稿）在发送前没有"存下来"的能力。一旦切换会话、关闭应用或清空输入框，编辑中的草稿就永久丢失。现有输入框草稿持久化（`updateInputDraft`）仅作用于"当前会话的未发送草稿"，无法跨会话、跨时间复用。

### 1.2 用户故事

> 作为 Polaris 用户，我想要在发送前把输入框中的内容保存为本地 Markdown 草稿文件，以便于以后从草稿恢复、积累可复用片段。

### 1.3 动机

- 与 `/agent`、`/dispatch`、`/nexus` 等本地斜杠命令保持一致的"纯命令操作"体验
- 不新增 UI 入口，降低认知负担
- 草稿文件是独立于应用的本地 Markdown，可用任何编辑器直接查看/编辑

## 2. Intent（意图）

### 2.1 功能需求

系统增加三个本地斜杠命令，均在 `ChatInput.handleSend` 中拦截并处理，不走模型、不走 CLI：

1. **`/save-draft [文件名或标签]`**：将当前输入框文本保存为 Markdown 草稿文件
2. **`/load-draft [文件名]`**：把草稿内容回填到输入框
3. **`/list-drafts`**：列出所有草稿，显示文件名和创建时间

文件名（标签）可选；不传时系统自动生成 `draft-YYYYMMDD-HHMMSS.md`。

### 2.2 验收标准（EARS）

| # | 模式 | 验收标准 |
|---|------|---------|
| AC-1 | Ubiquitous | 系统应当在 `~/.polaris/drafts/` 目录下保存草稿 Markdown 文件 |
| AC-2 | Event-driven | 当用户在输入框输入 `/save-draft 标签` 并按回车时，系统应当将输入框当前文本连同元数据写入 `~/.polaris/drafts/<标签>.md`，清空输入框，并显示保存成功 toast |
| AC-3 | Event-driven | 当用户输入 `/save-draft`（不带标签）时，系统应当自动生成 `draft-YYYYMMDD-HHMMSS.md` 文件名并保存 |
| AC-4 | Event-driven | 当用户输入 `/load-draft 文件名` 并按回车时，系统应当读取对应草稿文件，把其正文内容回填到输入框（保留输入框已有内容之外的其余文本位置），并显示恢复成功 toast |
| AC-5 | Event-driven | 当用户输入 `/list-drafts` 并按回车时，系统应当列出 `~/.polaris/drafts/` 下所有 `.md` 草稿，以"文件名（创建时间）"格式展示 |
| AC-6 | Unwanted behavior | 如果 `/save-draft` 时输入框为空，系统应当拒绝保存并提示用户 |
| AC-7 | Unwanted behavior | 如果 `/load-draft` 时文件名不存在或无法读取，系统应当提示"草稿未找到"并返回原样 |
| AC-8 | Unwanted behavior | 如果 `/save-draft` 时标签与已有文件同名，系统应当自动追加后缀（如 `-1`、`-2`）避免覆盖，并提示实际文件名 |
| AC-9 | State-driven | 当草稿目录 `~/.polaris/drafts/` 不存在时，系统应当自动创建该目录 |
| AC-10 | Ubiquitous | 三个命令的处理过程不得影响前端 UI 布局（无弹窗、无面板，仅 toast 反馈） |
| AC-11 | Optional features | `/list-drafts` 的结果可复用为输入框建议浮窗条目（用户按 ↑/↓ 选择后自动插入 `/load-draft 文件名`），此为可选增强，不通过也不影响主验收 |

### 2.3 非功能需求

- **性能**：草稿文件单文件通常 < 1MB；`/list-drafts` 在草稿数 ≤ 500 时应 < 200ms 完成
- **安全**：文件名须经过后端规范化（去除路径穿越 `../`、非法字符），仅允许 ASCII 字母/数字/下划线/连字符/空格；不传文件内容到任何远程服务
- **兼容性**：Web-only（`--no-default-features`）编译时，草稿相关 IPC 命令不可调用，前端应优雅降级为 toast 提示"草稿功能仅桌面端可用"
- **可观测性**：每次保存/加载/列出操作写入一条 `tracing::info` 日志（草稿名、操作类型）

## 3. Architecture（架构）

### 3.1 关键组件

```
ChatInput.handleSend               ← 命令拦截（/save-draft /load-draft /list-drafts）
        │
        ▼
src/services/draftService.ts       ← 前端服务层（参数组装、结果解析、错误转 toast）
        │
        ▼  invoke('save_draft' / 'load_draft' / 'list_drafts')
        │  (Tauri Desktop)
        │  / 降级提示 (Web-only)
        ▼
src-tauri/src/web/api/ipc.rs       ← IPC 路由新增三个命令
        │
        ▼
src-tauri/src/services/draft_service.rs  ← Rust 业务逻辑（路径构造、读/写/列文件）
```

### 3.2 数据模型

**草稿文件内容格式**（Markdown，YAML frontmatter 形式，供人工可读）：

```markdown
---
savedAt: "2026-07-26T14:30:00+08:00"
workspace: "MyWorkspace"
sessionId: "abc-123"
label: "用户传入的标签（可选）"
---

# 原始输入框文本（原样保留，不截断、不编码）

用户在输入框中键入的所有内容，逐字保存。
```

**命名约定**：
- 有标签：`<规范化标签>.md`
- 无标签：`draft-YYYYMMDD-HHMMSS.md`
- 冲突处理：`<基础名>-1.md`、`<基础名>-2.md` …

**`/list-drafts` 返回结构**：

```json
[
  { "fileName": "draft-20260726-143000.md", "createdAt": "2026-07-26T14:30:00+08:00", "sizeBytes": 412 }
]
```

### 3.3 API 契约

#### 前端 → IPC（`src/services/draftService.ts`）

```ts
// 保存
async function saveDraft({ label?: string, content: string, workspace: string, sessionId: string })
  => Promise<{ fileName: string, path: string }>

// 加载
async function loadDraft({ fileName: string })
  => Promise<{ content: string, meta: { savedAt: string, workspace?: string } }>

// 列出
async function listDrafts() => Promise<DraftEntry[]>

interface DraftEntry {
  fileName: string
  createdAt: string   // ISO 8601
  sizeBytes: number
}
```

#### IPC 命令签名（`ipc.rs` 注册点）

| 命令名 | 输入 | 输出 |
|--------|------|------|
| `save_draft` | `{ label?: string, content: string, workspace: string, sessionId: string }` | `{ fileName, path }` |
| `load_draft` | `{ fileName: string }` | `{ content, meta }` |
| `list_drafts` | `{}` | `DraftEntry[]` |

### 3.4 系统交互

- **数据根路径**：通过已有 `getDataRootInfo().root`（`~/.polaris`）拼接 `/drafts/` 子目录，**不硬编码 `~/.polaris`**，与 DataRoot 统一抽象保持一致
- **前端命令拦截**：与 `/agent`、`/dispatch` 同模式，在 `handleSend` 顶部按命令名分流，解析参数后调用 `draftService`，成功后 `setLocalText('')` + toast，return 阻止后续发送
- **`/load-draft` 文本插入**：回填到输入框末尾（追加）；若输入框非空，在光标位置插入
- **错误反馈**：所有操作通过 `useToastStore` 返回结果，标题为命令名，正文为操作结果或错误信息

## 4. Constraints（约束）

### 4.1 技术约束

- 草稿读写为文件系统本地操作，桌面端由 Rust 后端实现（`tokio` 异步 `std::fs`），Web-only 编译不可用
- 文件名在后端进行安全规范化：移除路径分隔符、只保留 `[a-zA-Z0-9 _-]`，去除首尾空格
- 草稿内容不做 Markdown 渲染处理，原样保存为文件正文
- 遵循 `web-only-tauri-command-gate` 约定：Rust 端新命令若依赖 `#[tauri::command]` 需加 `#[cfg(feature = "tauri-app")]` 门控

### 4.2 组织约束

- 纯命令操作，不新增设置页、不新增侧栏面板
- 与现有本地斜杠命令（`/agent`、`/dispatch`、`/nexus`）保持代码风格和错误处理模式一致

### 4.3 排除范围（Out-of-Scope）

- 草稿的版本管理 / 历史回退
- 草稿的搜索、全文检索
- 草稿的删除（`/delete-draft`，本次不实现）
- 草稿的跨设备同步 / 云端存储
- 输入框建议浮窗内自动展示草稿列表（AC-11 可选增强，本次默认不实现，除非用户要求）
- 草稿导入到会话（非本命令范围，用户自行 `@drafts/xxx.md` 引用）

## 5. Risks（风险）

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| Web-only 编译包含草稿命令导致编译失败 | 中 | 中 | Rust 端加 `#[cfg(feature = "tauri-app")]` 门控；前端 invoke 前判断是否为 Web 环境 |
| 文件名注入 / 路径穿越 | 低 | 高 | 后端对标签做强规范化，拒绝含 `..` `/` `\` 的标签 |
| 草稿目录创建权限不足 | 低 | 中 | `std::fs::create_dir_all` 失败时返回明确错误，前端转 toast |
| 草稿文件过大导致列表/加载慢 | 低 | 低 | `/list-drafts` 仅读取目录条目和元数据，不读正文；加载单文件设 5MB 软上限 |

## 6. Traceability（可追溯性）

- **关联 ADR**：无
- **关联 Plan**：`docs/plans/chat-draft-save-load-plan.md`（Step 3 派生）
- **关联测试**：`src/services/draftService.test.ts`、`src-tauri/src/services/draft_service.rs` 单元测试

## 7. Validation Plan（验证计划）

### 7.1 单元测试

- `draft_service.rs`：文件名规范化（合法名、含路径穿越、含非法字符、空标签）
- `draft_service.rs`：冲突重命名逻辑（同名 → `-1` → `-2`）
- `draft_service.rs`：`/load-draft` 解析 frontmatter 正文
- `draftService.ts`：Web-only 降级 mock

### 7.2 集成测试

- 桌面端：save → verify 文件存在且格式正确 → load → 内容一致
- 桌面端：save 空内容 → 拒绝
- 桌面端：load 不存在文件 → 错误提示
- 桌面端：`/list-drafts` 返回结构与草稿目录一致

### 7.3 用户体验验收

1. 输入 `/save-draft 我的需求`，回车 → toast 提示"草稿已保存：我的需求.md"，输入框清空
2. 清空输入框，输入 `/load-draft 我的需求`，回车 → 输入框出现原文内容
3. 输入 `/list-drafts`，回车 → toast 显示草稿列表
4. 输入 `/save-draft`（无标签），回车 → 自动生成时间戳文件名
5. 输入 `/save-draft 我的需求` 再次保存 → 提示实际文件名含后缀

## 8. Rollout（发布策略）

- 一次性发布，不涉及迁移
- 草稿目录首次使用时由 Rust 后端 `create_dir_all` 创建
- 无回滚需求（不改变任何已有数据结构）

## 9. References（参考）

- `src/components/Chat/ChatInput.tsx` — 命令拦截模式参考（`/agent`、`/dispatch`、`/nexus`）
- `src/services/cliSlashCommands.ts` — CLI 命令目录（本地命令与 CLI 命令分离）
- `src/services/dataRootService.ts` — DataRoot 路径获取
- `src/services/transport/index.ts` — 前端 invoke 调用
- `src-tauri/src/web/api/ipc.rs` — IPC 路由注册
- `src/services/conversationPackager/index.ts` — 前端本地写文件落盘参考
- ADR 0001 DataRoot 统一（memory: `data-root-unification.md`）
