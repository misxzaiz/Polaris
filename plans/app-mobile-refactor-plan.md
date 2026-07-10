# App 端移动化重构方案

## 目标

让 Polaris app 端从“桌面 UI 压缩到手机屏幕”重构为可独立使用的移动伴生端，优先支持：连接桌面/服务端、续接会话、查看并回应待处理交互、管理任务与工作区状态。

## 当前结论

当前项目没有独立 app/mobile 工程，app 端主要依赖同一套 React + Tauri 前端：

- `src/main.tsx` 直接挂载桌面 `App`。
- `src/App.tsx` 以桌面多面板为中心，仅通过 `isCompact` 做小屏抽屉适配。
- `src/services/transport/detector.ts` 将 Android/iOS 判定为 HTTP 模式。
- `src/services/transport/index.ts` 试图在移动 Tauri 中调用 `get_server_config`。
- `src/services/transport/auth.ts` 试图调用 `set_server_config`。
- Rust 端目前只有 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`，未提供移动配置命令和移动专属启动链路。

因此不可用不是单点 UI bug，而是启动链路、传输层、能力边界和移动 UI 架构同时缺失。

## 复审与验证记录

本方案已复审关键假设，并做了可执行验证：

- 搜索 `src-tauri/src` 后仅发现 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`，未发现 `get_server_config` / `set_server_config` 实现，确认移动配置命令缺失。
- 搜索 `src` 后确认 `get_server_config` 只在 `src/services/transport/index.ts` 调用，`set_server_config` 只在 `src/services/transport/auth.ts` 调用，前端调用与后端实现不闭环。
- 读取 `src/main.tsx` 确认当前入口无移动分流，始终渲染桌面 `App`。
- `pnpm exec vitest run src/services/transport/httpTransport.test.ts` 通过：现有 HTTP transport 基础路由逻辑未坏，问题集中在移动配置加载、动态 baseUrl 和能力边界。
- `pnpm exec tsc --noEmit` 失败：当前仓库已有 TypeScript 错误，其中 `src/services/transport/index.ts` 的 `log.warn('Failed to load mobile server config', Error)` 参数类型错误与移动链路直接相关；其余错误分布在 Chat、Diff、Agnes 插件。
- `cd src-tauri && cargo check --lib` 通过，仅有 SimpleAI 相关未使用告警，说明 Rust lib 基础编译可用，新增 Phase 0 命令具备落地前提。

## 主要问题

### 1. 移动端启动链路断裂

移动端前端会进入 HTTP transport，但 `getServerUrl()` 在 `tauri.localhost` 下返回空字符串；随后 `createHttpTransport(getServerUrl())` 捕获空 baseUrl。即使异步加载配置后调用 `manualReconnect()`，transport 闭包仍持有旧 baseUrl，无法真正切换到正确服务地址。

### 2. Rust 端缺少移动配置命令

前端调用了两个命令但后端没有实现：

- `get_server_config`
- `set_server_config`

这会导致移动端无法持久化和读取服务端地址/token。

### 3. HTTP 能力矩阵不完整

`httpTransport` 会把大量 Tauri command 走 `/api/*` bridge，但 `src-tauri/src/web/api/ipc.rs` 只实现了部分命令。移动端复用桌面主界面时，会触发文件、Git、LSP、插件、终端、窗口等大量不适合移动端或未桥接的命令，表现为 404/500/静默失败。

### 4. UI 架构不适配移动

`App.tsx` 的主结构仍是：

```text
TopMenuBar + ActivityBar + LeftPanel + CenterStage + RightPanel
```

小屏模式只是把左面板变成抽屉，并强制显示右侧聊天面板。它没有移动端需要的底部导航、卡片化首页、连接配置页、任务状态聚合、会话优先层级。

### 5. 产品目标与现状不一致

`PRODUCT.md` 明确要求移动端是“mobile companion surface”，强调续接、查看状态、管理任务和上下文，而不是完整桌面 IDE 的压缩版本。

## 重构原则

1. **移动端先可用，再完整**：先保证打开、连接、续接会话，再逐步迁移复杂功能。
2. **明确能力边界**：移动端不默认承诺所有桌面命令；只暴露已验证的 mobile API。
3. **独立移动入口**：不要继续在桌面 `App` 上堆 `isCompact` 条件。
4. **服务端优先**：移动端应主要连接桌面/Web 服务，不直接依赖本机 CLI、文件系统、LSP、终端能力。
5. **状态透明**：连接状态、活跃 workspace、engine、会话运行状态必须始终可见。

## 目标架构

```text
src/main.tsx
├─ DesktopApp / App        # 桌面 Tauri + Web 桌面模式
└─ MobileApp               # Android/iOS 或窄屏移动模式

MobileApp
├─ MobileConnectionGate    # 服务地址/token 配置与健康检查
├─ MobileShell             # 顶部状态 + 底部导航
├─ MobileSessions          # 最近会话/续接/待处理问题
├─ MobileChat              # 单会话聊天与流式状态
├─ MobileTasks             # Todo/Scheduler 聚合
├─ MobileWorkspaces        # 工作区状态与切换
└─ MobileSettings          # 连接、主题、模型/Profile 只读或轻量配置

Transport
├─ tauriTransport          # 桌面 IPC
├─ httpTransport           # Web/移动远程 API
└─ mobileConfigBridge      # 移动本地服务地址/token 持久化
```

## 实施进展（2026-07-10 复核）

### Phase 0：启动链路止血 —— 基本完成，存在一处 UX 竞态

已落地：

- `src-tauri/src/commands/mobile_config.rs`：`MobileServerConfig { serverUrl, token }` + `get_server_config` / `set_server_config`，落盘到 `data_root().config_dir()/mobile-server-config.json`，带 `#[cfg(feature="tauri-app")]` 门控。
- `src-tauri/src/commands/mod.rs` 与 `src-tauri/src/lib.rs` 已导出并注册两个命令。
- `src/services/transport/index.ts`：新增 `rebuildHttpTransport()`，支持运行时替换 HTTP baseUrl；`loadMobileServerConfig()` 启动时异步从 Rust 后端读配置 → 写 localStorage → 重建 transport → `manualReconnect()`。
- `src/services/transport/auth.ts`：`storeServerUrl` / `storeTokenMd5` 同步回写移动后端 `set_server_config`。
- `index.test.ts` 覆盖「重建 transport」时序。

验证：`tsc --noEmit` 零错误；`cargo check --lib` 通过；`vitest run src/mobile src/services/transport/index.test.ts` 5/5 通过。

**待修竞态（Phase 0 收尾）**：`MobileConnectionGate` 在 mount 时 `checkConnection()` 依赖 `getServerUrl()`，而 transport 的 `loadMobileServerConfig()` 是异步的。当后端已保存有效配置但 localStorage 尚为空时，Gate 会立即 `setShowSettings(true)` 停在配置页；`loadMobileServerConfig` 完成后只重建了 transport，不会触发 Gate 重新检查。

修复（2026-07-10 已实施）：Gate mount 时若 `getServerUrl()` 为空，先 `invoke('get_server_config')` 读取后端配置；读到非空则填入 localStorage 后再 `checkConnection()`，否则才展示配置页。

### Phase 1：移动 App 壳 —— 完成

- `src/mobile/platform.ts` + `platform.test.ts`：`shouldRenderMobileApp()` 判定移动 Tauri（userAgent + `__TAURI_INTERNALS__`）。
- `src/main.tsx`：根分流 `shouldRenderMobileApp() ? MobileApp : App`，移动端不再挂载桌面 `ActivityBar/LeftPanel/CenterStage/RightPanel`。
- `src/mobile/MobileApp.tsx`、`MobileShell.tsx`：顶部状态条（workspace/engine/连接状态）+ 底部 4 tab（会话/任务/工作区/设置）+ safe-area 适配。
- `MobileConnectionGate.tsx`：服务地址/token 配置页 + 健康检查。

### Phase 2：Mobile API 能力矩阵 —— 传输层已闭合

`httpTransport.COMMAND_ROUTE_MAP` 已覆盖移动端调用的全部首批命令：

| 能力 | 前端调用 | HTTP 路由 |
|---|---|---|
| 配置 | `invoke('get_config')` | GET `/api/settings` |
| 健康 | `invoke('health_check')` | GET `/api/health` |
| 会话列表 | `invoke('list_sessions')` | GET `/api/sessions` |
| 会话历史 | `invoke('get_session_history')` | GET `/api/chat/history/{id}` |
| 会话交互 | `invoke('continue_chat')` / `start_chat` | POST `/api/chat/send` |
| 中断 | `invoke('interrupt_chat')` | POST `/api/chat/interrupt` |
| 待处理问题 | `answer_question` / `approve_plan` / `reject_plan` | POST `/api/chat/*` |
| Todo | `list_todos` / `complete_todo` 等 | IPC bridge `/api/list-todos` 等 |
| Scheduler | `scheduler_list_tasks` / `scheduler_run_task` | IPC bridge |

IPC bridge（`ipc.rs` catch-all）对 Todo/Scheduler 命令有显式分发；对未支持命令返回 NotFound 而非静默失败。

### Phase 3：核心移动体验 —— 骨架完成，深度待补

- `MobileSessions.tsx`：最近会话列表（claude-code + codex 聚合）+ 聊天页（消息气泡、续接发送、WS 事件流、待处理交互卡片）。
- `MobileTasks.tsx`：Todo + Scheduler 聚合，支持完成 todo / 运行 scheduler task。
- `MobileWorkspaces.tsx`：当前工作区（含 `validate_workspace_path` 校验）、全部工作区列表、最近访问时间。

**Phase 3 已修复（2026-07-10 第一轮）**：
- 聊天页 WS 事件订阅：`MobileChatSession` 挂载 `listen('chat-event')`，处理 `assistant_message`（增量/首次追加）、`result`（刷新全量历史）、`error`/`session_end`（清理发送状态）。`unlistenRef` 清理。
- 发送后 `continue_chat` 不再在 finally 中清 sending，改由 WS 事件驱动（`result`/`session_end`/`error` 清 sending），避免助手回复还未到达就重置状态。

**Phase 3 已修复（2026-07-10 第二轮）**：
- 待处理交互卡片：WS 事件处理 `question` / `question_answered` / `plan_approval_request` / `plan_approval_result` / `plan_end` / `permission_request`，渲染 Question Card（多选/单选/跳过）、Plan Approval Card（批准/拒绝）、Permission Card（允许/拒绝）。通过 `invoke('answer_question'/'approve_plan'/'reject_plan')` 提交回复。
- 工作区页：`MobileWorkspaces` 组件接入 `validate_workspace_path`，显示当前工作区状态（可用/不可用）、全部工作区列表（高亮当前）与最近访问时间。替换 MobileShell 中的 placeholder。

### Phase 4：打包与真机验证 —— 已完成（2026-07-10）

**构建流程**：

1. `pnpm build` → `dist/`
2. `cp -r dist/ polaris-mobile/dist/`（polaris-mobile 的 `frontendDist: "../dist"` 指向）
3. 手动编译 `cargo build --target aarch64-linux-android --release` 得到 `libpolaris_mobile_lib.so`
4. 复制 .so 到 `jniLibs/arm64-v8a/`
5. 复制前端资源到 `android/app/src/main/assets/`
6. `./gradlew assembleRelease -x :app:rustBuild*` 打包

**APK 产物**：

| 文件 | 路径 | 大小 |
|---|---|---|
| `polaris-mobile.apk` | `polaris-mobile/polaris-mobile.apk` | 15.1 MB |
| `polaris-mobile.apk` | 根目录 (项目根) | 15.1 MB |

**APK 内容**：955 文件，包含全部前端资产（JS/CSS/HTML）、native .so（6.97MB）、AndroidManifest、资源文件。

**Android 配置**：`applicationId=com.polaris.mobile`，`minSdkVersion=24`，`arm64-v8a`。

**已知限制**：
- 目前仅 arm64 架构（`--target aarch64`），无 armv7/x86_64 兼容
- 构建因 Windows 符号链接限制需手动复制 .so，不可用 `tauri android build` 直接完成
- 前端构建包含大量桌面端代码（mermaid/cytoscape/codemirror/katex 等），适合在后续优化中做移动端 tree-shaking

## 分阶段方案

### Phase 0：启动链路止血

目标：app 端至少能打开、配置服务地址、完成健康检查。

改动：

- Rust 新增移动配置模型：`MobileServerConfig { server_url, token }`。
- Rust 新增 Tauri commands：`get_server_config`、`set_server_config`。
- 将配置保存到 app config dir，例如 `mobile-server-config.json`。
- 前端 transport 支持运行时替换 HTTP baseUrl，而不是创建后固定闭包。
- 移动端无 serverUrl 时进入连接配置页，不初始化桌面主应用。
- `storeTokenMd5()` 同步保存到移动后端，避免只保存 URL 不保存 token。

验收：

- Android/iOS WebView 首次打开显示连接配置页。
- 输入服务地址后能调用 `/api/health`。
- 重启 app 后能恢复服务地址。
- 空地址不会触发 `fetch('/api/...')` 或 WebSocket 空地址重连风暴。

### Phase 1：移动 App 壳

目标：建立移动专用 UI 骨架，不再复用桌面主布局。

改动：

- 新增 `src/mobile/MobileApp.tsx`。
- 新增 `src/mobile/MobileShell.tsx`。
- `main.tsx` 根据平台选择 `MobileApp` 或 `App`。
- 底部导航先保留 4 个入口：会话、任务、工作区、设置。
- 顶部状态条显示 server、workspace、engine、连接状态。
- 移动端不挂载桌面 `ActivityBar`、`LeftPanel`、`CenterStage`、`RightPanel`。

验收：

- 手机尺寸下没有桌面面板挤压。
- 底部导航可切换四个页面。
- 连接失败/鉴权失败有明确恢复入口。

### Phase 2：Mobile API 能力矩阵

目标：只接入移动端真实可用且有价值的接口。

首批支持：

| 能力 | 接口 |
|---|---|
| 配置/健康 | `get_config`, `health_check` |
| 会话列表 | `list_sessions`, `get_session_history` |
| 会话交互 | `start_chat`, `continue_chat`, `interrupt_chat` |
| 待处理问题 | `answer_question`, `approve_plan`, `reject_plan` |
| 工作区 | `get_config` 中 workspace/workDir + `validate_workspace_path` 只读展示 |
| Todo | `list_todos`, `create_todo`, `update_todo`, `complete_todo` |
| Scheduler | `scheduler_list_tasks`, `scheduler_run_task`，日志后置 |

明确不做或后置：

- 本机文件编辑。
- LSP 跳转/索引。
- Git 复杂操作。
- 终端交互。
- 插件安装/卸载。
- 桌面窗口管理。

验收：

- 所有移动端页面只调用能力矩阵内 API。
- 未支持功能显示“需在桌面端操作”，不触发未知 command。
- HTTP bridge 对首批 API 有测试覆盖。

### Phase 3：核心移动体验

目标：移动端真正能续接和干预工程会话。

页面设计：

1. **会话页**
   - 最近会话列表。
   - 运行中/等待输入/已完成状态。
   - 点击进入移动聊天页。

2. **聊天页**
   - 消息流只保留移动友好渲染。
   - 工具调用折叠卡片。
   - pending question/plan 原位操作。
   - 输入框支持文本、停止、继续。

3. **任务页**
   - Todo + Scheduler 合并成“待办/自动化”。
   - 支持完成 todo、手动运行 scheduler task。
   - 日志只做摘要，详细日志后置。

4. **工作区页**
   - 当前工作区、关联工作区、最近会话。
   - 只读项目状态，复杂切换后置。

验收：

- 从会话列表进入聊天页可恢复历史。
- 运行中会话断线重连后状态正确。
- pending question/plan 可在手机上处理。
- Todo/Scheduler 基本操作可用。

### Phase 4：打包与真机验证

目标：形成可持续发布的 app 端验证流程。

改动：

- 补 Android/iOS Tauri 配置与权限说明。
- 增加 app smoke test 清单。
- 增加移动端 API contract test。
- 增加窄屏视觉回归或 Playwright viewport smoke。
- 文档化“桌面端开启 Web 服务 → 手机端连接”的流程。

验收：

- Android 真机可安装、启动、连接、恢复配置。
- iOS 如暂不实施，需明确构建阻塞项。
- 每次发布前有固定 smoke 流程。

## 建议实施顺序

1. 先做 Phase 0，修复启动链路。
2. 再做 Phase 1，把移动端从桌面布局中拆出来。
3. Phase 2 与 Phase 3 交替推进：每接一个 API，就在移动页面中闭环一个可用场景。
4. 最后补 Phase 4，避免 app 端再次变成不可验证状态。

## 第一批具体任务

1. 新增 `src-tauri/src/commands/mobile_config.rs`。
2. 在 `src-tauri/src/commands/mod.rs` 导出移动配置命令。
3. 在 `src-tauri/src/lib.rs` 注册 `get_server_config`、`set_server_config`。
4. 重构 `src/services/transport/index.ts`，让 HTTP transport 可重建 baseUrl。
5. 新增 `src/mobile/MobileConnectionGate.tsx`。
6. 新增 `src/mobile/MobileApp.tsx` 和 `src/mobile/MobileShell.tsx`。
7. 修改 `src/main.tsx` 做移动入口分流。
8. 建立移动端首屏 smoke：无配置、错误配置、正确配置三种状态。

## 风险与边界

- 如果继续复用桌面 `App`，移动端会持续被桌面功能拖垮，修复成本会无限扩散。
- 如果 HTTP bridge 继续按未知 command 兜底，移动端会出现大量运行时失败，必须收敛到显式能力矩阵。
- 移动端不能默认具备本机 CLI/文件系统能力；所有本地工程操作都应通过已连接的桌面/Web 服务执行。
- Token 当前是 MD5 存储与 Bearer 传输，后续需要单独评估认证模型，但不应阻塞 Phase 0 可用性。
