# opencode Code Mode × PRD 预览卡片适配修复方案

> 背景与根因分析：2026-10-17 会话实测 + 源码排查（`chatCardRegistry.ts` / `eventHandler.ts` / `ai/engine/opencode.rs`）。
> 状态：**A 项已实现**（2026-10-17）—— `eventHandler.ts` 新增 `isCodeModeCarrierInput`/`isArtifactLike`/`unwrapCodeModeArtifact`，`parseCardData(result, blockInput?)` 增加固有口径不变 + Code Mode 拆包；测试 `eventHandler.cardData.test.ts`（13 用例）。B 项按方案保持文档层。
> **Rev2（2026-10-17 渲染层补丁）**：实测发现 data 层已通但卡片被折叠进 SessionSummaryCard"预览"tab，用户无入口。补丁① `SessionSummaryCard` 有 preview 块时默认展开（初值态，用户操作后不强制）；补丁② `PrdPreviewCard` 退化形态（return 投影缺 html 但有 previewId/sourcePath）兜底升级为"预览已生成 + 打开源码"提示，替代"解析失败"文本。
> 关联：`plans/opencode-integration-optimization.md`（P1 工具卡片类问题）。

## 一、问题定义

| 链路 | tool_call_end.tool | tool_call_end.result | 卡片 |
|---|---|---|---|
| simpleai 原生 MCP | `mcp__{server}__{tool}` | `{ content, structuredContent: PreviewArtifact }` | ✅ 渲染 |
| opencode Code Mode | `execute`（载体） | return 值原样 JSON/字符串，无信封 | ❌ 失败/退化 |

已存在但不足的适配：
- `chatCardRegistry.resolve()`：从 `block.input.code` 正则提取内嵌 MCP 调用匹配卡片 —— **名字层 OK**。
- `eventHandler.parseCardData()`：只认 `structuredContent` 信封 —— **data 层断裂**。

三个失败形态（按出现频率）：
1. 多调用聚合返回 `{ step1_created: artifact, step2_list: … }` → `isPreviewArtifact` 失败 → 文本兜底。
2. 调用 `preview_html` 但未 `return` → 返回值与卡片不同源 → 无卡片。
3. 单调用直接 `return tools[…].preview_html(…)` → 现状即可渲染（唯一通过形态）。

## 二、修复目标

opencode Code Mode 下，`preview_html` 调用（无论裸 return / 聚合返回）都能渲染 PRD 预览卡片；simpleai 原生路径行为零变化。

## 三、方案（定稿）

### A. `parseCardData` artifact 拆包（本方案核心，唯一必做项）

**位置**：`src/stores/conversationStore/eventHandler.ts`（纯前端，无协议改动）。

**改动**：
1. 新增类型守卫 `isArtifactLike(obj)`：`artifactType === 'polaris.preview'`，或（`html` 与 `previewId` 均为 string）——与 `PrdPreviewCard.tsx` 的 `isPreviewArtifact` 口径对齐。
2. `parseCardData(result, blockInput?)` 增加第二参数：
   - 现有优先级不变（structuredContent → fenced json → 直接 parse → 原值）。
   - 解析结果为对象且**预期能命中 Code Mode 时**（`blockInput.code` 为 string，经 `chatCardRegistry` 同源的 Code-Mode 载体判定），在其**自身 + 自身一层成员**（含数组元素，遍历一层为限，不递归）中查找 artifact-like 值，命中则返回它。
   - 优先 return 语句对齐（复用 `chatCardRegistry` 导出的 `RETURN_MCP_RE` 口径，从 `code` 提取 return 的 MCP 调用对应的成员名）；对不齐则取首个命中。
   - 查不到 → 返回原解析结果（行为与现版本相同）。

**边界约定**：
- 一层遍历不递归深挖：`list_previews` 这类数组不拆（列表无卡片注册，不受影响）。
- 多 artifact 命中取最后一个创建的？→ **取 return 对齐 > 首个命中**，不做时间排序（明确、可测）。
- 该拆包仅对 Code Mode 载体启用（`tool === execute/xecute` 判定由 `cardBlockInput.code` 是否存在承载，无须重复正则判定载体名——调用方已达名匹配 miss 分支）。

**所有者**：前端 `conversationStore/eventHandler.ts`；测试 `eventHandler` 相关 vitest（新增用例）。

### B. 单调用裸 return 约定（零代码，随 A 验证）

不改 Rust、不改 tool description（避免触发改协议/重建 polaris-mcp 的连锁）。A 落地后聚合形态已覆盖，B 仅作为文档/提示层面的后续项，不在本方案范围。

### C. 引擎层注 structuredContent（否决）

Rust 侧改动 + 协议双边同步 + `cargo build --bin polaris-mcp` 连锁，收益低于 A。不做。

## 四、验收标准

1. `parseCardData` 新增 vitest 用例（参照 `chatCardRegistry.test.ts` 风格）：
   - 裸 return artifact 原样命中（回归保护）
   - `{ step1_created: artifact }` 拆出 artifact
   - `{ a: artifact, b: list }` 拆出 artifact
   - `structuredContent` 存在时优先级不降
   - 无 artifact-like 成员 → 返回原值（不误拆）
   - 非 Code Mode 输入（无 blockInput）→ 行为与现版本一致
2. `pnpm exec tsc --noEmit` + `pnpm lint` + `pnpm test:run` 通过。
3. 人工验证（opencode 引擎真实会话）：调用 `preview_html` 带聚合返回 → Polaris 聊天出现可交互预览卡片；previewId 可回读。
4. simpleai 引擎回归：原生 MCP 调用 preview_html 卡片不回退。

## 五、风险与回退

- 风险：误拆（把恰好含 html+previewId 字段的普通对象当 artifact）→ 仅在 Code Mode 分支启用 + 口径对齐现有守卫，影响面可控。
- 回退：改动单文件单函数，`git revert` 即回退；无存储/协议影响。
