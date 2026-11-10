# spec：Translate 插件化改造（B2-4）

> 状态：**方案已定，待实施** · 2026-11-10
> 上游：`plans/core-slimdown-plugin-extraction-plan.md` §4.2 B2-4、`AGENTS.md` §五功能路由原则。
> 用户定案（2026-11-10）：确定改造为插件的方案；实施另需批准。本文只定方案，不改代码。

## 1. 目标与边界

- 目标：翻译域整体出主仓，落 `Polaris-plugin/plugins/translate`（新建）。主仓不再携带百度翻译命令、面板、划词菜单、配置字段与 store。
- 不做：不改翻译语义/错误码；不动会话主链路；不新增 `cap.*`。
- 插件形态：`contributes.views` 面板 + stdio MCP（可选，给 AI 一个 translate 工具）；出网走 `cap.http`（或插件服务内原生 fetch），配置走插件 `configSchema`。

## 2. 四问判定（core-slimdown §3）

| 问 | 结论 |
|---|---|
| Q1 宿主性 | 否 |
| Q2 边界性 | 是（自带面板 + 命令 + store + 配置段） |
| Q3 通道性 | **最不满足**：`SelectionContextMenu` 是 `App.tsx` 根层全局划词菜单，直连 4 个 store 与宿主 `baiduTranslate` 命令，属内部接口；须先按 §4 L0 改造 |
| Q4 收益 | 中：~1.1k 行、近 3 月 4 次改动（冷门）；单独发版收益一般，可与 B2-3 同批顺手做 |

## 3. 现状清单（2026-11-10 实测）

后端：`src-tauri/src/commands/translate.rs` 107（`baidu_translate`，百度 REST + MD5 签名，appId/secret 由前端传入）、`lib.rs:62` import / `:1178` 注册、`commands/mod.rs:13` `pub mod translate`。

前端：
- `components/Translate/` 705：`SelectionContextMenu.tsx` 493（根层全局划词菜单，依赖 `useTranslateStore`/`useConfigStore`/`useViewStore`/`useWorkspaceStore` + `baiduTranslate`）、`TranslatePanel.tsx` 210、`index.ts` 2
- `services/tauri/windowService.ts:96` `baiduTranslate()`、`stores/translateStore.ts`、`types/config.ts:338` `baiduTranslate?: BaiduTranslateConfig`
- 宿主接线：`App.tsx:33`（SelectionContextMenu 全局）/`:49`（lazy）/`:317`（`translateContent`）、`builtinPlugins.ts:52-59` 的 `translate.panel` view、`components/Layout/toolSwitcherData.tsx:23`、`ToolSwitcher.tsx:52`、`ToolSwitcher.test.tsx`、`Common/Icons/EngineIcons.tsx:89`、i18n translate 节

后端配置：`models/config.rs:88` `BaiduTranslateConfig`、`:1453` 字段、`:1670` 默认值、`services/config_store.rs:1006` 默认值。

## 4. 分层路径

**L0 先解全局划词耦合**（本域最大改造点，不可跳过）：`SelectionContextMenu` 目前由 `App.tsx` 无条件挂载且直连宿主 store。两条路径二选一：
- （推荐）宿主提供**通用划词菜单 slot**（`contributes.contextMenu` 或等价贡献点），插件注册自己的菜单项；宿主不再 import 任何 `Translate/*`。
- 或保留宿主薄「划词事件 → `cap.ui.render` 帧」通道，插件订阅帧自行渲染菜单。

无论哪条，`App.tsx` 都不得再硬编码 `SelectionContextMenu`。前置地基：hostInvoke 白名单（§6-1）、manifest 校验补齐（§6-2）；新增贡献点须同步前端 `schema.ts` 与 Rust `models/plugin.rs` 校验。

**L1 前端外移**：`TranslatePanel` + `translateStore` → `dist/panel.js`；`services/tauri/windowService.ts` 的 `baiduTranslate` 封装删除，改插件内 `cap.http` 调用；`builtinPlugins.ts` 摘 `translate.panel`、`App.tsx` 摘三处、ToolSwitcher 分组与 i18n 同步摘。

**L2 后端外移**：`commands/translate.rs` + `lib.rs:62,1178` + `commands/mod.rs:13` 删除；百度 API 调用在插件 Node 服务/MCP 内实现（纯 REST，`md5` 用 `node:crypto`，零原生依赖）。删命令后跑 `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`（AGENTS.md §3.4）。

**L3 数据外移**：`BaiduTranslateConfig` 从 `models/config.rs` / `config_store.rs` 移到插件 `configSchema`；翻译历史（若持久化）→ `cap.kv` 或 `<DataRoot>/plugins/<id>/`。**一次性迁移**：插件首次启动从宿主 config 读旧 `baiduTranslate` 导入，之后不留兼容垫层。

## 5. 宿主交界清单

| 交界 | 处置 |
|---|---|
| 全局划词菜单 | 见 §4 L0；**本域唯一硬骨头**，先出贡献点 spec 再动 |
| `onSendToChat` | `TranslatePanel` 把译文送回会话 → 插件面板用宿主 `sendToChat` / `cap.ui.chat`，不改 Chat 架构 |
| `useViewStore.setLeftPanelType('translate')` | 改插件面板自有路由，或 `pluginPanelRegistry` 激活；不在宿主 store 留 translate 分支 |
| Web 模式 | 百度 API 为公网 REST，Web 可等价；`cap.http` 权限需在 Web 端放行 |

## 6. 主仓删除清单

`commands/translate.rs` + `lib.rs:62,1178` + `commands/mod.rs:13` + `components/Translate/`(3) + `services/tauri/windowService.ts:96` + `stores/translateStore.ts` + `types/config.ts:338` + `models/config.rs` 3 处 + `config_store.rs:1006` + `App.tsx:33,49,317` + `builtinPlugins.ts:52-59` + `toolSwitcherData.tsx:23` + `ToolSwitcher.tsx:52` + `ToolSwitcher.test.tsx` 的 translate 用例 + `EngineIcons.tsx:89`（若仅翻译用）+ i18n translate 节。

## 7. 验收

- 主仓 `pnpm typecheck` + `pnpm lint` + `pnpm test:run` + `cargo check` + web-only 门控全绿。
- 净删 ≈ 1.1k（±20%）；`App.tsx` 无 `Translate` 字样；ToolSwitcher 无 translate 分组残留。
- 插件仓 `node scripts/validate.js`；安装→启用→面板翻译→划词菜单→译文送回会话→禁用后菜单与工具同时消失；`update.json` 热更新验证一次。
- 双端回归；三处同步（主仓 / 插件仓 / `schema.ts` + `models/plugin.rs` 若新增贡献点）。

## 8. 风险与决策点

| # | 问题 | 推荐 |
|---|---|---|
| D1 | 全局划词菜单归属 | 新增通用 `contributes.contextMenu` slot（宿主只管事件，插件管 UI）；属新增贡献点，需独立 spec + 前后端校验同步 |
| D2 | 是否保留 `SelectionContextMenu` 在宿主 | 不保留；若 D1 暂不落地，本批**停在 L1**（只外移 `TranslatePanel`），划词菜单留主仓并显式标注为待迁 |
| D3 | 百度凭证位置 | 移到插件 `configSchema`，宿主 config 不再出现密钥字段（顺带收敛 config 面） |
| D4 | 与 B2-3 同批 | 可同批，但 D1 贡献点是独立主题，单独 commit |

## 9. 实施纪律

先补 §4 L0 的贡献点 spec（新增贡献点属协议改动，AGENTS.md §4.1 要求双向同步且保守）；提交序列 ①贡献点 ②主仓摘壳 ③插件仓实现 ④主仓删码 ⑤文档同步，不混批；不改协议字段仅搬移；一次一个主题。
