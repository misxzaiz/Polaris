# snippet-desk 提示词工作台插件化 spec

> 日期：2026-11-16 · 状态：实施中
> 上位：`plans/ai-chat-plugin-extraction-spec.md`；流程复制 model-desk（spec→骨架→主仓瘦身→四门禁→真机→push）。
> 用户定案（2026-11-16）：「确定实施直到完成」。

## 0. 目标

把 Settings 的 PromptSnippetTab（484 行，快捷片段/提示词管理 + skill 路径配置与已发现 Skill 列表）迁出为独立插件 **snippet-desk**。@snippet 的输入侧链路（ChatInput/SnippetParamPanel）已随 chat-desk 出仓——本插件交付后，管理端（snippet-desk）与输入端（chat-desk）形成两插件协作。

## 1. 边界

**迁出**：`Settings/tabs/PromptSnippetTab.tsx`（484）、`stores/snippetStore.ts`（78）、`types/promptSnippet.ts`（71）。
**留宿主**：`skillStore.ts`（256，扫描依赖宿主文件系统与 pluginRegistry，经桥只读代理）、`types/skill.ts`、`services/tauri/snippetService.ts`（cap.prompt_snippet 封装，chat-desk 输入侧消费）。
**Icon 替换**：IconPlus/IconEdit/IconTrash（简单 SVG）→ lucide `Plus/SquarePen/Trash2`。

## 2. 数据面（零后端改动）

- 片段 CRUD：`cap.prompt_snippet`（snippetService 已封装，router_dispatch）✅
- skill 列表/路径保存：skillStore 经 deps Proxy 代理宿主实例（内部 invoke 命令已通）✅
- 插件白名单：无需新增（router_dispatch 已在；snippet 走总线）

## 3. 主仓瘦身

- SettingsPage：删 PromptSnippetTab import/渲染分支/ref；侧栏删 `prompt-snippet` 项与 `SettingsTabId` 成员；`topLevelKeysByTab` 无该 key（确认后清理）
- 删文件：`tabs/PromptSnippetTab.tsx`
- 保留：snippetStore（chat-desk 输入侧消费）、snippetService、types/promptSnippet

## 4. 门禁

插件仓 `npm run build` + `tsc --noEmit`；主仓 `tsc --noEmit`、`pnpm lint`（不新增 error）、`pnpm test:run`、`cargo check`、web-only 门禁；grep 断言主仓 0 命中 `PromptSnippetTab`；真机 9827：activityBar 出现 snippet-desk、片段 CRUD、skill 路径保存、chat-desk @snippet 输入链路不回归。

## 5. 回滚

禁用插件 → Settings 无该 tab（已删）；revert 主仓删码 commit 恢复。
