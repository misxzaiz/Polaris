# spec：opencode Code Mode 下 MCP 聊天卡片（PRD 预览等）适配

## 背景 / 问题

Polaris 内置 MCP（如 `polaris-prd-preview`、`polaris-agnes`）的 result 模式聊天卡片，
靠 `chatCardRegistry` 按 **完整工具名 `mcp__{server}__{tool}`** 匹配
（`src/plugin-system/chatCardRegistry.ts`，消费方 `eventHandler.ts` tool_call_end）。

两引擎行为差异：

| 引擎 | MCP 调用形态 | tool_call_end 的 tool 名 |
|---|---|---|
| Claude Code 等 | MCP 工具即原生工具 | `mcp__polaris-prd-preview__preview_html` → **命中卡片** |
| opencode（Code Mode） | 模型在一个 `execute` 工具里写 JS：`tools["polaris-prd-preview"].preview_html(...)` | `execute` → **匹配失败，无卡片** |

opencode 后端映射（`src-tauri/src/ai/engine/opencode.rs` `emit_tool_events`）对 tool_use
原样透传，`part.tool == "execute"`，`state.output` 是整段脚本返回值。于是 opencode 会话里
PRD 预览只在过程卡显示裸 JSON 输出，artifact_preview 卡不渲染。

目标数据链路本身无恙：opencode 的 execute 返回值已被解开为 artifact 对象（顶层
`artifactType/previewId/html/...`），`parseCardData` 的对象兜底分支可直接喂给
`PrdPreviewCard`（其 `isPreviewArtifact` 正是按顶层字段校验）。缺口只在**工具名匹配**一环。

## 目标

opencode 引擎会话调用注册了 result 卡片的 MCP 工具时，正常渲染插件卡片；
非 opencode 引擎的现有匹配路径零改动。

## 所有者与写路径

- 匹配逻辑单权威：`chatCardRegistry` 新增 `resolve(toolName, blockInput)`：
  1. 先按 `toolName` 直接 `match`（现状不变）；
  2. miss 且 `toolName` 形如 opencode Code Mode 载体（`execute`/`xecute`）时，
     从 `blockInput.code` 提取内嵌调用 `tools["<server>"].<tool>(`，按
     `mcp__{server}__{tool}` 查注册表；
  3. 唯一命中 → 命中之；多命中 → 优先匹配 `return ...tools[...]` 语句所指调用
     （execute 返回值 = 该工具结果，与卡片 data 来源一致）；再退化为首个命中。
- `eventHandler.ts` tool_call_end：`chatCardRegistry.match(event.tool)` 改为
  `chatCardRegistry.resolve(event.tool, blockInput)`，blockInput 取自现有
  toolBlockMap 里的 `ToolCallBlock.input`（tool_call_start 已存 `event.args`，
  opencode 引擎 Start 事件携带完整 `part.state.input`，含 `code`）。
- 卡片数据侧零改动（`parseCardData` 已兼容两种形态）。

## 非目标

- 不改后端 `emit_tool_events`（保持 tool 名忠实反映 opencode 真实工具，过程卡语义不变）。
- 不覆盖一条 execute 里多件东西的完美归属（如 `Promise.allSettled` 混合多个 MCP 调用）：
  按 return 语句启发式取最佳匹配，解析不出时不渲染卡片、不报错（best-effort）。

## 验收

1. `chatCardRegistry.resolve("mcp__polaris-prd-preview__preview_html", anything)`
   行为与旧 `match` 一致（直接命中）。
2. `resolve("execute", { code: 'return await tools["polaris-prd-preview"].preview_html(...)' })`
   → 命中 preview 卡片。
3. `resolve("execute", { code: "const x = 1" })` → undefined；`resolve("bash", ...)` → undefined。
4. manifest 中多卡（read_preview、agnes、dispatch）同理命中；未注册 server 的调用不误命中。
5. `pnpm exec tsc --noEmit` + 新增 vitest 通过 + `pnpm lint` 无新增告警。
