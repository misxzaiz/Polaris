# spec：AI 对话内容块渲染注册表化（宿主默认 + 插件覆盖）

> 状态：规划完成，待实施
> 分支：`feat/chat-block-renderer-registry`
> 关联：`plans/ui-template-runtime-v1.md`（cap.ui.render 帧渲染）、`plans/plugin-cap-inject-render-v1.md`（可交互渲染契约）
> 关键历史：2026-11-08 块委托试验回退（react shim 导出受限 → blob 模块加载失败）；2026-11-12 react shim 已补全导出（`useSyncExternalStore` 等），根因解除。

## 1. 问题

`src/components/Chat/chatBlocks/index.tsx` 的 `renderContentBlock()` 是对话内容块分发中枢，当前对 10 种块类型做**宿主硬编码 switch**：

| block.type | 渲染器 | 宿主是否可被插件覆盖 |
|---|---|---|
| `text` | `TextBlockRenderer` | 否（文本语义，不建议开放） |
| `thinking` | `ThinkingBlockRenderer` | 否（建议保留宿主） |
| `tool_call` | `ToolCallBlockRenderer` | 否 |
| `question` | `AskQuestionCard` | 否（曾试验插件化后回退） |
| `form` | `FormCard` | 否（曾试验插件化后回退） |
| `plan_mode` | `PlanModeBlockRenderer` | 否 |
| `agent_run` | `AgentRunBlockRenderer` | 否 |
| `task_board` | `TaskBoardRenderer` | 否 |
| `permission_request` | `PermissionRequestRenderer` | 否 |
| `plugin_card` | `PluginCardHost` | ✅ 已是注册表分发 |

仅 `plugin_card` 走 `chatCardRegistry`。用户诉求：**宿主只提供默认渲染，插件可覆盖提供实际渲染**。

## 2. 目标

- `renderContentBlock()` 改为**注册表优先 + 宿主默认兜底**。
- 插件可通过既有 `contributes.chatCards` 声明，注册按 **block.type**（非仅 MCP 工具名）匹配的渲染器，覆盖宿主默认。
- 宿主默认渲染器注册为 low-priority（先注册，可被插件 override）。
- 历史会话回放不破坏：插件卸载后，宿主默认常驻兜底。

## 3. 非目标

- 不改 `blockGrouping` 折叠逻辑（仅决定块进组，渲染面独立）。
- 不迁移 `AssaultResultCard` / `WorkflowCard`（SDK 内部特殊格式，默认留宿主）。
- 不改后端 cap 契约（纯前端渲染面改造，`plugin_card` 交互应答路径不变）。
- 不处理 opencode Code Mode（用户已裁：后续 opencode 移除改插件，不做兼容）。

## 4. 设计

### 4.1 key 设计（核心）

新增 `blockToCardKey(block)`：统一从 `ContentBlock` 推导注册表 key。

- **`plugin_card`**：沿用现有 `block.cardKey ?? block.toolName`（不改，已有逻辑）。
- **其余块类型**：精确 key = `block:{type}`，如 `block:question`、`block:form`、`block:plan_mode`、`block:agent_run`、`block:task_board`、`block:permission_request`、`block:tool_call`。
  - `block:tool_call` 细分为按工具名：`tool:{name}`（如 `tool:Read`、`tool:Bash`、`tool:Grep`），供插件按具体工具名覆盖。
  - `block:tool_call` 兜底 key = `block:tool_call`（未按名命中时宿主默认）。

**匹配顺序**（`resolveBlockCard`）：
```
plugin_card → 现有 cardKey/toolName 路径
tool_call   → tool:{name} 精确 → block:tool_call 兜底
其他类型    → block:{type}
均未命中    → undefined（宿主默认）
```

### 4.2 `chatCardRegistry` 扩展

`PluginChatCardContribution` 增加可选字段（向后兼容）：

```ts
export interface PluginChatCardContribution {
  // 现有字段...
  /**
   * 按内容块类型匹配的 key 前缀（扩展，二选一与 mcpServerId/tools 并存）。
   * 允许值：'block' | 'tool'。不填 = 原 MCP 工具路径。
   * block:'question' → key = 'block:question'
   * tool:'Read'     → key = 'tool:Read'
   */
  matchBy?: 'block' | 'tool'
  /** matchBy='block' 时：目标块类型（question/form/plan_mode/agent_run/task_board/permission_request/tool_call） */
  blockTypes?: string[]
  /** matchBy='tool' 时：目标工具名列表（tool_call 的 block.name） */
  toolNames?: string[]
}
```

注册时若 `matchBy` 存在，`register()` 用 `matchBy` 构建 key（`block:${t}` / `tool:${t}`），不再走 `mcp__{server}__{tool}` 组装。

新增方法：
```ts
/** 按块推导 key 并匹配（不含 plugin_card——由 PluginCardHost 走既有路径） */
matchBlock(block: ContentBlock): CardEntry | undefined
```

### 4.3 `renderContentBlock` 改造

```
renderContentBlock(block, isStreaming):
  override = chatCardRegistry.matchBlock(block)   // plugin_card 之外
  if override:
    return <ContentBlockErrorBoundary><PluginCardHost block={block} /></...>
  // 未命中 → 现有宿主默认（switch 原逻辑不变）
```

- `plugin_card` 保持走 `PluginCardHost`（其内部已做注册表分发）。
- 所有分支仍包 `ContentBlockErrorBoundary`（现有 `wrapWithErrorBoundary` 保留）。

### 4.4 内置默认注册（builtinPlugins.ts）

宿主默认渲染器经 `registerBuiltinExact` 注册为 low-priority，**先于插件注册**（builtinPlugins 在应用启动时注册，插件后注册自动 override——注册表已有 override 语义）。

```ts
// builtinPlugins.ts
chatCardRegistry.registerBuiltinExact('block:question', {...}, () => import(.../AskQuestionCard))
chatCardRegistry.registerBuiltinExact('block:form', {...}, () => import(.../FormCard))
// ... 其余块类型
```

但注意：**内置默认注册后，matchBlock 命中内置 entry 会走 PluginCardHost 而非原生渲染**——这改变了渲染路径。需权衡：
- 方案 A：内置默认**不注册**进 registry，`matchBlock` 只查插件注册的 key；宿主默认由 switch 原生渲染。插件注册同名 key 时 override，未命中走 switch。
- 方案 B：内置默认全部注册，`matchBlock` 命中即走 PluginCardHost（统一路径，但绕一层懒加载）。

**采用方案 A**（更稳、改动最小、不改变现有 10 种块的渲染路径）：`matchBlock` 只匹配「插件显式注册」的 key；宿主默认恒由 switch 原生渲染。`plugin_card` 例外（其宿主默认就是 PluginCardHost 的兜底）。

### 4.5 交互应答契约

`question` / `form` / `permission_request` 块有应答回调（ask 管线、form_submit）。插件覆盖渲染器若做交互，必须能触达宿主应答通道。`PluginCardHost` 已透传 `respond`（interaction 模式）。**块覆盖渲染器复用同一 `PluginChatCardProps` 契约**（`data/status/mode/respond`），插件交互块照 `plugin_card` 模式实现即可。

## 5. 改动清单（已实施）

| 文件 | 改动 | 状态 |
|---|---|---|
| `src/plugin-system/types.ts` | `PluginChatCardContribution` + `matchBy`/`blockTypes`/`toolNames`；`mcpServerId`/`tools` 可选化 | ✅ |
| `src/plugin-system/chatCardRegistry.ts` | `CardEntry` 导出 + `matchBy`；`register()` 用 `buildContributionKeys`；`matchBlock()`/`blockToCardKey()` 新增 | ✅ |
| `src/plugin-system/registry.ts` | `registerChatCards`：`matchBy` 卡片绕过 mcpServerId 归属校验 | ✅ |
| `src/components/Chat/chatBlocks/index.tsx` | `resolveBlockOverride()` + `renderContentBlock` 开头查覆盖，命中走 `BlockCardOverrideHost` | ✅ |
| `src/components/Chat/chatBlocks/BlockCardOverrideHost.tsx` | 新增：块 → `PluginChatCardProps` 适配 + 懒加载 + 内部 ErrorBoundary 兜底 | ✅ |
| `src/components/Chat/tool-calls/blockGrouping.tsx` | 折叠组内 tool_call 改走 `renderContentBlock` 统一分发（否则组内块绕过覆盖检查） | ✅ |
| `src/plugin-system/chatCardRegistry.test.ts` | 新增 `matchBlock`/`blockToCardKey`/`resolveBlockCard` 测试（8 个用例） | ✅ |
| `src/plugin-system/schema.ts` | **无需改**（已核实无 `chatCards` 运行时校验，仅 TS 类型） | — |
| `src/plugin-system/registry.test.ts` | **未改**（改动在 `chatCardRegistry.test.ts`） | — |

## 5.1 实现说明

- **方案 A 确认**（`renderContentBlock` 中 `matchBlock` 仅查插件显式注册的 key；宿主默认恒由 switch 原生渲染）。`plugin_card` 例外，走 `PluginCardHost` 既有路径，不参与 `matchBlock`。
- `matchBlock` 返回 `undefined` 时，`renderContentBlock` 走原 switch（10 种块宿主默认渲染不变）——**历史回放与插件卸载后渲染零回归**。
- `BlockCardOverrideHost`：`blockToCardProps` 把任意 `ContentBlock` 适配为 `PluginChatCardProps`；**不提供 `respond`**（交互语义留宿主，防断链）；插件崩溃由内部 `OverrideErrorBoundary` 兜住，显示错误卡片不抖动回退宿主默认。

## 6. 验证（已执行）

- ✅ `pnpm exec tsc --noEmit`：零 error（改动文件 + 全量）
- ✅ `pnpm exec eslint`：0 error、2 warning（`registry.ts:33,38` `any` 为既有代码，非本次引入）
- ✅ `pnpm exec vitest run src/plugin-system/`：74 passed（含新增 5 用例）
- ✅ `pnpm exec vitest run src/components/Chat/chatBlocks/ src/components/Chat/tool-calls/`：79 passed
- ⏳ 手动：`pnpm tauri:dev:web` 默认块渲染不变 + 插件注册 `block:question` 覆盖生效（待真实 app 验证）

## 7. 风险

1. **历史会话回放**：插件卸载后旧块仍由宿主 switch 兜底渲染（方案 A 保证）。
2. **交互断链**：插件覆盖 `question/form` 若不做应答，AI 等待超时——契约写入文档。
3. **key 冲突**：`block:*` / `tool:*` 前缀与现有 `mcp__*` 不冲突（前缀互异）。
4. **schema 校验**：若 schema.ts 有 `chatCards` 字段校验，需同步否则插件加载被拒。
