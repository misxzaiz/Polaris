# web 模式内置浏览器可用性（根因确认 + 修复方案）

> 状态：spec（Proposed）｜涉及：行为/能力门控｜所有者：前端 BrowserPanel + 后端 commands/browser + services/ask_listener

## 1. 问题

用户报告「内置浏览器在 web 模式（浏览器访问 9827）下无法正常使用」。

验证（本机 `tauri:dev:web`，前端 9827 / 后端 9829）：
- 前端侧：点「内置浏览器」可进入面板，显示「暂无打开的浏览器标签」与快捷入口；**无 iframe 降级页**。
- MCP 侧：`browser_acquire` 能创建 tab，但 `context/inspect/click` 均异常（脚本执行超时 / `chrome-error://`）。

## 2. 根因链（已逐一读源码确认）

1. **后端无 web 模式 browser 能力**
   - `src-tauri/src/commands/browser.rs`：全部原生 WebView 逻辑 `#[cfg(feature = "tauri-app")]` 门控，`BrowserActionDispatcher`（3210 行起）持有 `AppHandle`，web 构建不存在。
   - `src-tauri/src/web/api/ipc.rs` HTTP 命令表（400-479 行）**无任何 browser 分支** → 落 `_ => NotFound("Command not supported via HTTP")`。
2. **AskListener 帧被 gate 拒**
   - `src-tauri/src/services/ask_listener.rs:294-296`：web 构建下 `"browser"` 帧直接返回 `ValidationError("browser 帧需要 tauri-app 功能")`。
   - 浏览器 MCP server（`services/browser_mcp_server.rs`）经 stdio → TCP 回连 ask_listener，因此 **web 模式下 MCP browser 不可用**（这是 MCP 侧 `chrome-error://` 与超时的直接原因）。
3. **SimpleAI 原生 browser 工具被 gate**
   - `src-tauri/src/ai/engine/simple_ai/tools/browser.rs` 与注册处（`tools/mod.rs:14-15,158-159`）均 `#[cfg(feature = "tauri-app")]`，web 构建下不提供该工具。
4. **前端降级存在但不完整**
   - `src/components/Browser/BrowserPanel.tsx`：
     - `status='native-unavailable'` 时 `navigateTo` 走 `setCurrentUrl` + return（305-307 行），iframe `src={currentUrl}`（1384-1389 行）**链路理论可用**；
     - 但 `isTauriRuntime()`（96-98 行）只查 `__TAURI_INTERNALS__ in window` —— **在内置浏览器动态 webview（label `browser-*`）里打开的前端会误判为 tauri 模式**（`transport/detector.ts` 已专门处理该场景，BrowserPanel 未对齐）；
     - 后退/前进/刷新（1154/1174/1183 行）`disabled={status !== 'ready'}`，降级模式下全部禁用；iframe 内部导航后 `currentUrl` 不会跟随（无 `onLoad` 同步）。
   - `src/stores/tabStore.ts openBrowserTab` 默认 url `https://www.bing.com`。

## 3. 目标与接口

统一对齐 `transport/detector.ts` 的判定：**只要不是主窗口 tauri 环境，就进入 iframe 降级**，并让降级模式可用、MCP/AI 在 web 模式下给出明确错误而非超时。

### 3.1 前端（BrowserPanel.tsx）
- 新增运行时判定：`isTauriRuntime()` 需排除内置浏览器动态 webview（复用 `src/services/transport/detector.ts` 的 `isEmbeddedBrowserWebview()` 逻辑或直接调用）。
- `native-unavailable` 模式下：
  - 后退/前进/刷新按钮按 iframe 可用性启用（`contentWindow.history` 实现 back/forward、`reload()` 刷新；`currentUrl` 从 `iframe.contentWindow.location` 同步）。
  - 地址栏提交继续走 `navigateTo`（现状已 `setCurrentUrl`，OK）。
  - iframe 加 `onLoad` 回填当前地址与标题。
- tabStore 快捷入口/默认页对 iframe 友好（`bing.com` 默认即可，无强制改动）。

### 3.2 后端（web 构建，`--no-default-features`）
- `web/api/ipc.rs` 增加 `browser_*` HTTP 分支，返回统一错误：`WebError::BadRequest("内置浏览器需要桌面 Tauri 运行时（tauri-app feature）")` —— 使前端 MCP/调用得到明确 4xx，而非逐请求超时。
- `ask_listener.rs` web 分支错误文案不变（已明确），MCP server 侧捕获并透传。

### 3.3 能力注册
- web 构建 SimpleAI 不注册 browser 工具（现状已 gate，保持）。

## 4. 验收

- [ ] `pnpm exec tsc --noEmit`、`pnpm lint` 通过。
- [ ] `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过。
- [ ] 浏览器访问 9827：点「内置浏览器」进入 iframe 降级页，可导航/后退/前进/刷新。
- [ ] web 模式下 MCP `browser_*` 调用返回明确错误（非超时）。
- [ ] 桌面 tauri 模式内置浏览器行为不变（回归）。
