# 001 · Polaris 插件源码直连模式（dev-link）spec

> 来源：需求库 needs/001（analyzed，夜班已勘察）。状态：specd，待拍板。
> 所有者：宿主端（src-tauri plugin_service / plugin_discovery_capability）+ 前端设置页。

> **实施记录（2026-10-31）**：已实施（ZCode 会话）。与 spec 的两处形状偏差：
> ① state.json 条目字段定为 `devLink: { sourcePath }`（单对象，替代 devLink:true + devSourcePath 两键，信息等价）；
> ② `check_update` 短路返回复用 `PluginUpdateCheckResult` 并新增 `skipped: "dev-link"` 字段（而非自定义 ok/skipped 形状），前端更新条据此显示「源码直连无需检查」。
> 落点：`plugin_service.rs`（dev_link_plugin / read_dev_link / uninstall_dev_link_plugin / create_dir_junction + 三卸载分支 + 两更新短路 + 发现盖戳）、`plugin_discovery_capability.rs`（dev_link action + describe；apply_update 在停服务前短路）、前端 schema/types/service/PluginTab（DEV 徽标 + Dev link 按钮 + 移除（保留源码）文案）。
> 验证：cargo check + web-only gate + tsc + vitest（44+71）全绿；junction 五项 OS 语义（无管理员建链/透传/删链保源/真目录拒删/reparse 判定）与 Rust std is_symlink 均已离线实证；Rust 单测已写但因本机 DLL 限制（STATUS_ENTRYPOINT_NOT_FOUND，AGENTS §九）只能编译验证。**真机 e2e 冒烟未做**（注册→改 server.js→新会话生效），为唯一遗留。

## 目标

开发者把插件源码目录注册为 dev 插件后，MCP/服务/面板直接从源码目录加载：改 `mcp/server.js` 下个会话即生效，全程零 pack、零重装。**不复制文件，不建热更机制**。

## 选型（定案，依据见 needs/001 分析结论）

**junction/符号链接指向源码目录**。决定性先例：`%APPDATA%/Polaris-dev/plugins/mimo-tts` 已是真实符号链接且被宿主正常发现加载——`scan_plugin_root`（plugin_service.rs:1138）跟随链接、`install_path` 即链接路径，发现/加载/面板零改动。Windows 目录 junction（`mklink /J`）普通用户可建，无需开发者模式。

## 接口

### cap.pluginDiscovery 新增 action `dev_link`

```
payload: { sourcePath: string }         // 必须含合法 plugin.json 的源码目录
返回：  { ok, pluginId, installPath }    // installPath = install_root/<pluginId>（junction）
```

行为：
1. 读 `<sourcePath>/plugin.json`，取 `id`（与现有插件重名 → 拒绝，提示先卸载）。
2. 在 install_root 创建 junction `<id> → sourcePath`（已存在同 id 目录 → 拒绝）。
3. state.json 该插件条目写入 `devLink: true` + `devSourcePath`（发现时回读，作为 dev 标记的唯一权威）。

### 宿主行为改动（三处短路/分支）

| 位置 | 现行为 | dev 插件行为 |
|---|---|---|
| `check_plugin_update` / `apply_update`（plugin_service.rs:461） | 下载 zip → 替换 install_path（canonicalize 会解析到源码目录） | **短路**：返回 `{ ok, skipped: "dev-link" }`，永不触碰源码 |
| `uninstall_local_plugin`（plugin_service.rs:608） | `canonicalize_allowed_plugin_dir` + `allowed_roots` 校验后删目录（对 junction 解析到外部源码必被拒） | **分支**：`fs::remove_dir` 只删 junction 本身（Windows 语义：不跟进目标），保留 `devSourcePath` 备注返回给前端提示「源码目录未动」 |
| 面板/MCP/服务加载 | 无感知 | 无改动（install_path 即链接，占位符 `{{pluginDir}}` 展开为链接路径） |

### 前端

- 设置→插件：新增「添加开发插件（选择目录）」入口 → 调 `dev_link`；列表中 dev 插件带 `DEV` 徽标（依据 state.json devLink）。
- dev 插件详情：显示源码路径 + 「移除（保留源码）」按钮文案区分。

## 边界（明确不做）

- 不改远程安装主流程（zip + updateUrl + CDN）；不做签名校验降级；dev 模式仅本机、显式添加、可枚举可撤销。
- 面板热更（改 dist/panel.js 即时生效）不做（MCP/服务本就每次新进程；面板热更属后续阶段）。
- 不支持把 dev 源码目录作为 update.json 发布源。

## 验收（可执行冒烟）

1. `cargo check`；`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`（命令层 gate）。
2. `pnpm exec tsc --noEmit`（前端改动）。
3. 真机冒烟：dev_link 注册 `Polaris-plugin/plugins/needs` → 插件列表出现且带 DEV 徽标 → 改其 `mcp/server.js` 某工具返回文案 → 新开 AI 会话调用该工具看到新文案，全程无 pack/重装。
4. 删除保护：对 dev 插件执行移除 → junction 消失、源码目录完好（`ls` 验证）；`check_plugin_update` 对 dev 插件返回 skipped。

## 风险

- **junction 误删源码**：最高风险点。所有删除路径必须走 `remove_dir`（不递归目标），且 dev 分支禁止复用 `delete_dir_all` 类实现。代码评审硬门。
- state.json devLink 字段与 discovery 缓存的同步：以 state.json 为唯一权威，discovered 元数据每次现读。
