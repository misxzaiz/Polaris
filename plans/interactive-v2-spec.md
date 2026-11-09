# interactive-v2 — PRD 预览域去 PRD 化与宿主瘦身

> 状态：实施中（worktree `feat/interactive-v2`，2026-11-09）
> 定案（用户）：① prd 去除 = 把 prd 改名为 interactive；② `interactive-component`
> 不兼容历史对话，直接规划新版本；③ 应用目标是**简化宿主项目**。
> 上游：`plugins/docs/interactive-component-implementation-plan.md`、
> `plugins/docs/prd-preview-extraction-playbook.md`。

## 目标

- 宿主删除 PRD/artifact 预览专属实现与三座宿主桥（`polaris-host/artifact|form|cap`），净减代码。
- 插件仓 `interactive-component` 发 **v2.0.0**：自包含、交互面板（`panel` +
  `supportsFullscreen`）、iframe 补 `autoplay`/`pointer-lock`/全屏/主题/版本。
- 闪造为可选增强（AI 编排，零硬依赖）：两插件各自可单独安装使用。

## 非目标

- 不兼容历史对话：旧 `cardKey` match 不到时由 `PluginCardHost` 的
  `PluginCardFallback` 兜底，接受降级。
- 不做新旧 server 双注册、别名映射、弃用过渡、商城公告。
- 不引入硬依赖字段；不 import 闪造 `forge-core.js`；不写回闪造花园。

## 改名映射

| 现名 | 新名 / 动作 |
|---|---|
| `polaris-prd-preview`（MCP server id） | `polaris-interactive` |
| `polaris.prd-preview` / `prd-preview` | `polaris.interactive` / `interactive` |
| `PrdPreviewAdapter` | 删 |
| `'prd-preview': '预览'` | `'interactive': '交互'` |
| 注释/文档「PRD 预览」 | 「交互面板」或随代码删 |
| `artifactType: 'polaris.preview'` | `polaris.interactive`（插件侧） |
| `.polaris/previews` | `.polaris/interactive`（插件侧，新版本可改） |
| `preview_html` / `read_preview` / `list_previews` / `render_component` | 保留（不含 prd） |

## 批次（契约先行）

1. **宿主净删**：A 档（三座桥 + 注册模块 + 薄适配器 + core 守卫 + 改名 +
   修 `mcp.test.ts` 3 红）；B 档（`htmlCardRender` / `artifact_preview` 渲染整套）。
2. **插件 v2 重写**：自包含、panel、全屏/声音/版本、新命名、闪造来源档位。
3. **联调与发布**：v2.0.0 + `index.json` / `update.json` / zip。

## 宿主可删清单

- A：`builtinPlugins.ts` 薄适配器、`hostBridge.ts(.test)`、
  `artifactHostRegistration.ts`、`capHostRegistration.ts`、
  `formHostRegistration.ts`、`htmlCardCapBridge.ts(.test)`、
  `pluginModuleLoader.ts` / `reactImportRewrite.ts` 的桥重写分支、
  `plugin_service.rs` core 守卫。
- B：`ArtifactPreviewRenderer.tsx(.test)`、`artifactVersions.tsx(.test)`、
  `htmlCardDetect.ts(.test)`、`chatBlocks/index.tsx` 的 `artifact_preview` case、
  `types/chat.ts` 的 `ArtifactPreviewBlock`、`eventHandler.ts` 的
  `extractHtmlCardBlocks` / inlineToBody 分支、`sessionConfig*` 的
  `htmlCardRender`、`messageCompactor.ts` 注释及其余引用点。
- 保留：`parseCardData` / `unwrapCodeModeArtifact`（服务 `plugin_card` 与
  opencode Code Mode，属通用能力）、`chatCardRegistry` / `PluginCardHost`（通用插件机制）。

## 验收

- 主仓：`pnpm typecheck` + `pnpm lint` + 定向 vitest + `cargo check` +
  `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`。
- 插件：`pnpm typecheck` / `pnpm test` / esbuild 产物无冲突标记。
- 真机双端：全屏 / 音效 / 静音 / Esc、闪造在 / 不在两态、商城安装与热更。
