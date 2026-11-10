# spec：IM 集成（钉钉/飞书/QQ bot）插件化改造（B2-2）

> 状态：**方案已定，待实施** · 2026-11-10
> 上游：`plans/core-slimdown-plugin-extraction-plan.md` §4.2 B2-2、`AGENTS.md` §五功能路由原则。
> 用户定案（2026-11-10）：确定改造为插件的方案；实施另需批准。本文只定方案，不改代码。

## 1. 目标与边界

- 目标：IM 集成域整体出主仓，落 `Polaris-plugin/plugins/im-bridge`（新插件，名称待定）；主仓不再携带适配器、命令、面板与状态字段。
- 不做：不改协议行为、不新增平台、不动会话/AI 运行时、不重命名既有 `cap.*`。
- 插件形态：`contributes.services` 常驻进程（webhook/长连接）+ stdio MCP；依赖宿主公共通道 `cap.config`（配置）、`cap.http`（出网）、`cap.kv`（实例/会话状态）、`cap.ai.chat`（IM 消息转 AI 会话，可选）。

## 2. 四问判定（core-slimdown §3）

| 问 | 结论 |
|---|---|
| Q1 宿主性 | 否——不属会话/总线/插件系统/数据根/引擎运行时 |
| Q2 边界性 | 是——自带面板 + 适配器 + 自有状态（实例注册表），与 Chat 无深度交织 |
| Q3 通道性 | 部分不满足：现走 `commands/integration.rs` 直调（内部接口），须先 cap 化 |
| Q4 收益 | 高——~8.4k 行、近 3 月仅 1 次改动（最冷门域）、独立进程形态天然契合 |

## 3. 现状清单（2026-11-10 实测）

后端 ~7.5k：
- `src-tauri/src/integrations/` 7,095（17 文件）：`manager.rs` 1882、`qqbot/adapter.rs` 1164、`feishu/adapter.rs` 1087 + `feishu/frame.rs` 359、`dingtalk/adapter.rs` 802、`commands.rs` 579、`types.rs` 346、`instance_registry.rs` 326、common/* 323、`traits.rs` 76、`mod.rs` 17
- `commands/integration.rs` 369；`lib.rs` 14 / 64-71 / 112 / 600,624 / 1180-1195 / 1510,1517；`state.rs` 的 `AppState.integration_manager`
- `web/api/ipc.rs` Web 桥：:199-204、:401-403（`init_integration` no-op、`send_integration_message` 报「requires local runtime」）、:1314-1358 四个 dispatch 函数

前端 ~1.2k：
- `components/Integration/IntegrationPanel.tsx` 771、`services/tauri/integrationService.ts` 168（22 个 invoke 封装 + `integration:message` 监听）、`types/integration.ts`、`builtinPlugins.ts` 的 `integration.panel` view、`App.tsx` 的 `integrationContent`
- 联动待复核：`components/ExecutionConsole/{ActiveExecutionList,ExecutionConsolePanel,SourceOverview}.tsx`、`hooks/useAppInit.ts`（实施前确认是类型引用还是真依赖）
- 配置/数据：`models/config.rs` IM 段、`src-tauri/dingtalk-bridge.js`、i18n integration 节

## 4. 分层路径（L1/L2/L3）

**L0 先 cap 化**：按 Q3，不直接拆。把 22 个命令收敛为 `cap.config`/`cap.http`/`cap.kv` 组合（倾向不新增 `cap.im`），前端 `integrationService.ts` 改走 `router_dispatch`。若确需新增 cap，同步 `AGENTS.md` §三清单 + `plans/two-bus-architecture.md`。

**L1 前端外移**：面板 → `dist/panel.js`（`pluginModuleLoader` 从 installPath 加载）；`integrationService` 改插件内 cap 客户端；`builtinPlugins.ts` 摘 `integration.panel`、`App.tsx` 摘 `integrationContent`、ToolSwitcher/i18n 注册点同步摘。前置地基：hostInvoke 插件级白名单（§6-1）、manifest 校验补齐（§6-2）。

**L2 后端外移**：`integrations/` 全目录 + `commands/integration.rs` + `lib.rs`/`state.rs`/`ipc.rs` 桥接一并删；Node 常驻服务在插件仓重写三平台适配器（REST/webhook/长连接，无 Windows 原生依赖），`autoStart:true` + `healthCheck`；MCP stdio 暴露 `im_send`/`im_status`/`im_instances` 等（沿用现有命令语义，工具名可收敛）。删命令注册表后必跑 web-only 门控（AGENTS.md §3.4 双方向陷阱）。

**L3 数据外移**：实例注册表/会话状态 → `cap.kv` 或 `<DataRoot>/plugins/<id>/`；IM 凭证从 `models/config.rs` 移到插件 `configSchema`，不再是宿主 config 字段。

## 5. 宿主交界清单

| 交界 | 处置 |
|---|---|
| Web 模式 | 插件服务管理当前被 Remote deny（core-slimdown §6-3）→ 先放行已鉴权 Remote 查状态/触发 autostart；否则本批停在 L1/L2 |
| `integration:message` 事件 | 宿主停止 emit，插件自监听；需要转 AI 时走 `cap.ai.chat` |
| `AppState.integration_manager` | 删；`ipc.rs` 4 个 dispatch 函数与 match 分支同删 |
| 桌面/移动/Web | 常驻进程仅桌面；Web 与移动端在插件描述显式声明不可用能力 |

## 6. 主仓删除清单

`integrations/`(17) + `commands/integration.rs` + `lib.rs` 上述 5 处 + `state.rs` 字段 + `ipc.rs` integration 分支/4 函数 + `components/Integration/` + `services/tauri/integrationService.ts` + `types/integration.ts` + `builtinPlugins.ts` view + `App.tsx` import/lazy/content + `hooks/useAppInit.ts` 初始化 + `models/config.rs` IM 段 + i18n 节 + ToolSwitcher 分组项。

## 7. 验收

- 主仓 `pnpm typecheck` + `pnpm lint` + `pnpm test:run` + `cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 全绿。
- 净删 ≈ 8.4k（±20%），无孤儿组件/死 manifest/死 i18n key。
- 插件仓 `node scripts/validate.js`；安装→启用→面板→三平台连通→AI 调工具→禁用后工具消失；`update.json` 热更新验证一次。
- 桌面 + Web 双端回归；三处同步（主仓 / 插件仓 / `AGENTS.md` §五 cap 清单）。

## 8. 风险与决策点

| # | 问题 | 推荐 |
|---|---|---|
| D1 | 是否新增 `cap.im` | 不新增，复用 `cap.config`/`cap.http`/`cap.kv`/`cap.ai.chat`；通道不足再单独立 spec |
| D2 | Node 重写 vs 携原生二进制 | 纯 Node；`dingtalk-bridge.js` 若仍引用则一并迁入插件 |
| D3 | 已配置实例迁移 | 插件首次启动从宿主 config 一次性导入，之后不留兼容垫层 |
| D4 | Web 降级 | 先做 §6-3 放行再实施 |

## 9. 实施纪律

每项动手前读目标文件与测试；提交序列 ①cap 化 ②主仓摘壳 ③插件仓实现 ④主仓删码 ⑤文档同步，不混批；不改协议字段仅搬移；一次一个主题（AGENTS.md §二.5 / §七）。
