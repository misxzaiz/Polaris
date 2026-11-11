# Web IPC `router_dispatch` 命令臂误删修复（回归记录）

> 状态：已修复｜类型：缺陷修复（接口可用性）｜所有者：`src-tauri/src/web/api/ipc.rs`｜日期：2026-11-12

## 1. 现象

Web/HTTP 模式（`pnpm tauri:dev:web`，前端 9827 / 后端 9829）下，前端调用
`invoke('router_dispatch', { req: { target, payload } })` 返回 404：
`Command not supported via HTTP: router_dispatch`。桌面 Tauri 模式正常。

## 2. 根因（静态证据）

- 提交 `a755f3fb`（2026-11-11「Scheduler 域整体出仓至插件仓 ai-scheduler」）在
  `web/api/ipc.rs` 删除 78 条 `scheduler_*` 命令臂时，把紧邻的
  `// ── Contract Router` 注释块与
  `"router_dispatch" => dispatch_router_dispatch(&state, &args).await,`
  一并删除（`git show a755f3fb -- src-tauri/src/web/api/ipc.rs` 可复核）。
  该臂原由 `d2bc9f24`（契约第三步 P2）引入。
- `dispatch_router_dispatch` 函数体仍保留在 `ipc.rs` 约 2303 行，是全文件 132 个
  `dispatch_*` 函数中**唯一**「有定义、无调用点」者——即误删的直接指纹。
- 前端 `httpTransport.ts::commandToPath` 通用映射 `router_dispatch` →
  `/api/router-dispatch` → `handle_ipc_bridge` 命令表未命中 → 落
  `_ => WebError::NotFound("Command not supported via HTTP: ...")`。
- 桌面端 `lib.rs:1242` 的 `invoke_handler` 仍注册
  `commands::router::router_dispatch`，不经过 `ipc.rs`，故只有 Web 模式受影响。

## 3. 影响面

Web 模式下所有经 `router_dispatch` 的同步能力全线不可用：
`cap.config`（设置读写）、`cap.data_root`（数据根）、`cap.pluginDiscovery` /
`cap.pluginServiceManager`（插件管理）、`cap.kv`（偏好 / 插件工具用量观测）、
`cap.help`（能力目录）、`cap.ai.chat` 同步动作与 form 提交、
`cap.app.update` / `cap.app.autolaunch` 等。

不受影响：`router_dispatch_stream`（流式会话）、`router_list_caps`、
`git_*`（`dispatch_git_via_bus` 独立转发）、`/api/settings`（`settings.rs` 直接
构造 Envelope 调 `cap.config`）、桌面 Tauri 模式。

## 4. 修复

`ipc.rs` 的 `handle_ipc_bridge` 命令表恢复 `router_dispatch` 臂，位置与
`router_dispatch_stream` / `router_list_caps` 相邻；补中文注释写明根因、
「基础设施臂非业务域附属」归属与防复发约定。不改函数实现、不改前端 transport、
不改桌面注册。

## 5. 验收

- [x] `cargo check`（`src-tauri/`）通过（exit 0，3m21s；存量 dead_code 告警与本次改动无关）
- [x] `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过（exit 0，30.9s）
- [x] 增量 `cargo check` 复核：`dispatch_router_dispatch` 不再有 unused 告警
- [ ] `pnpm tauri:dev:web` 运行时复核：设置页 / 插件管理 / 能力目录等
      `router_dispatch` 调用不再 404（修复时 9829 端口无 dev 后端在跑，未做运行时复核）
- [ ] 桌面 `pnpm tauri:dev` 行为不变（未改动桌面路径）

## 6. 防复发约定

1. `ipc.rs` 命令表三条 RouterBus 基础设施臂 `router_dispatch` /
   `router_dispatch_stream` / `router_list_caps` 必须成对存在。批量删除业务域命令时
   按命令名逐条删除，**禁止按注释块整段删除**。
2. 域出仓 / 大批量删臂的 PR 验收增加静态核对：
   - `grep -n '"router_dispatch"' src-tauri/src/web/api/ipc.rs` 有输出；
   - 检查 `ipc.rs` 中无「有定义、无调用点」的 `dispatch_*` 函数（本次即以此法定位于 1 分钟内）。
3. 已知缺口（未在本修复处理）：桌面注册在 `lib.rs`、Web 命令表在 `ipc.rs`，两处无
   编译期一致性校验。后续可加一条 CI 静态门禁比对两份清单，防止同类断链。
