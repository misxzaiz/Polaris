# 插件商城手机端修复规划（marketplace-mobile-fix-plan）

> 状态：**规划中，未实施**
> 日期：2026-10-19
> 范围：仅规划。实施需另开会话/按本方案分步落地。

---

## 1. 问题与根因

手机 App（Android APK）打开插件商城面板报两条错误：

| 现象 | 报错 | 根因 |
|---|---|---|
| 商城 tab | `加载失败：Failed to fetch` | 面板硬编码 `fetch('https://raw.githubusercontent.com/misxzaiz/Polaris-plugin/main/index.json')`，国内/移动网络访问 GitHub raw 常失败（网络层） |
| 已装 tab | `读取失败：Command router_dispatch not found` | 面板硬编码 `window.__TAURI_INTERNALS__.invoke('router_dispatch', …)`，而手机 APK 的 Rust 壳**未注册任何 Tauri 命令**（架构层，必现） |

### 根因证据链

1. **手机 APK 是独立空壳工程**（非根目录 `src-tauri/`）：
   - 构建入口：`.github/workflows/release-apk.yml` → `polaris-mobile/`，`npx tauri android build`。
   - `polaris-mobile/src-tauri/src/lib.rs` / `main.rs`：仅 `tauri::Builder::default().run(...)`，**无 `.invoke_handler()`**。
   - `polaris-mobile/src-tauri/Cargo.toml`：只依赖 `tauri`，不链接主后端。
   - 前端 `dist` 整体打包进 APK（workflow `cp -r dist polaris-mobile/dist`），前端是完整的，但后端命令一个都没有。
2. **`Command router_dispatch not found` 是 Tauri v2 对未注册命令的标准报错**（`@tauri-apps/api` 亦如此）。桌面端命令注册在 `src-tauri/src/lib.rs:1161`（`commands::router::router_dispatch`），且整段挂在 `#[cfg(feature = "tauri-app")]`。
3. **手机前端主 App 本身走 HTTP 传输**：`src/services/transport/detector.ts:50` 对 Android/iOS UA 强制 `'http'`；移动端 Tauri 内嵌前端通过本地 HTTP 服务与远程桌面端（局域网 Web 服务）通信，桌面端 `src-tauri/src/web/api/ipc.rs:323` 有 `router_dispatch` 的 HTTP 兜底。
4. **面板却绕开 HTTP、直连 IPC**：`plugins/marketplace/src/Panel.tsx:82-88` 硬编码 `window.__TAURI_INTERNALS__.invoke`。IPC 通路在手机壳上不存在 → 必现 `Command router_dispatch not found`。

## 2. 关键约束（规划必须遵守的事实）

### 2.1 面板运行在「主前端 JS 运行时」内
- 插件面板经 `src/plugin-system/registry.ts:99-113` 的 `pluginPanelRegistry.register(...)` + `createPanelLoader(...)` 动态 import，由 `src/components/Plugins/PluginPanelHost.tsx` 渲染。
- **不是 iframe，不是独立 WebView** —— 商城面板与主前端同 JS 运行时。
- 含义：面板代码**可以 import 主前端模块**（`transport`、`detector`、`auth` 等），但要谨慎处理「插件 bundle 独立性」约束（见 §4.1）。

### 2.2 HTTP `router_dispatch` 存在，但权限默认 Deny（关键坑）
- 桌面 Web 服务已实现 `router_dispatch` 的 HTTP 桥（`src-tauri/src/web/api/ipc.rs:323,2798`），手机端经 HTTP 本可调用。
- 但 `cap.pluginDiscovery` 属于**管理面能力**，`src-tauri/src/services/router/policy_permission.rs:170-191` 内置安全基线：
  - `("cap.plugin", true)` + `SourceClass::Remote` → **Deny**（wildcard 覆盖 `cap.pluginDiscovery`、`cap.pluginServiceManager`、`cap.plugin_foo`）。
  - 测试 `policy_permission.rs:384-392` 明确断言 `cap.pluginDiscovery` 对 Remote = Deny。
- 结论：**仅把面板改成走 HTTP `router_dispatch` 仍会被权限拒绝**。要让手机端（Remote 源）用上插件管理面，必须同时改权限模型（§4.3）——这是规划必须含的联动。

### 2.3 移动端没有本地后端，能力只能指向「桌面端」
- 手机 App 是瘦客户端：本身不跑插件发现/安装/卸载逻辑（`polaris-mobile` 壳无任何 Rust 业务）。
- `cap.pluginDiscovery` 的 `discover`/`install_remote`/`uninstall_local`/`check_update`/`apply_update` 实际作用对象是**桌面端数据根下的插件目录**（`install_remote` 还会下载 zip 到桌面端）。
- 即：**手机端商城管理的是「所连桌面端」的插件**，不是手机本机。这是产品语义，需在规划中明确，避免误以为手机能独立管理自己的插件。

## 3. 目标

让手机 App（以及纯 Web 浏览器）的插件商城面板：

1. **商城 tab**：索引拉取可成功（多 CDN 兜底），网络失败时给出可操作提示。
2. **已装 tab**：不再裸抛 `Command router_dispatch not found`；在可连上桌面端服务时，能列出/卸载/更新**桌面端**的插件（经 HTTP 桥）。
3. 桌面 Tauri 端行为**完全不变**（保持现 IPC 直连路径）。

## 4. 方案

### 4.1 面板调用层改为「环境感知」的 invoke（核心）

改造点：`plugins/marketplace/src/Panel.tsx` 的 `tauriInvoke` / `dispatchPluginDiscovery`。

- 运行环境判定（复用主前端思路，面板内自实现轻量版，避免依赖主前端内部模块）：
  - **桌面 Tauri**（`window.__TAURI_INTERNALS__` 存在 且 UA 非移动 且 不是 `browser-*` 内嵌 webview）→ 现 IPC 路径（不变）。
  - **移动端 Tauri / 纯 Web** → HTTP 路径：
    - 目标地址 = 已配置的桌面 Web 服务地址（复用主前端的 `getServerUrl()` / localStorage 的 serverUrl，面板内读同一存储 key）；
    - `POST {baseUrl}/api/router-dispatch`（与 `httpTransport.ts` 的 `commandToPath` 规则一致：`router_dispatch` → `/api/router-dispatch`），`req` 结构同现 IPC 调用；
    - 需要携带 Bearer token（`getTokenMd5()` 同一存储 key）。
  - **无法判定 / 未连接** → 显示明确引导（"请先在设置中连接桌面服务"），不再裸抛命令错误。

- 关键设计问题（实施时决策）：
  1. 面板是独立 bundle（`dist/panel.js`），**不要** import `@/services/transport` 等主前端内部模块（bundle 独立性 / 打包路径问题）——在面板内做最小化 HTTP 实现（~30 行，fetch + token），只复用 localStorage 的 `serverUrl`/`tokenMd5` 存储 key。
  2. 存储 key 与主前端 `src/services/transport/auth.ts` 对齐，避免双份配置。

### 4.2 商城索引多 CDN 兜底

改造点：`Panel.tsx` 的 `loadIndex`（当前 `DEFAULT_INDEX` 单一源）。

- 候选源（按序尝试，全部失败才报错）：
  1. `https://raw.githubusercontent.com/misxzaiz/Polaris-plugin/main/index.json`（现源）
  2. `https://cdn.jsdelivr.net/gh/misxzaiz/Polaris-plugin@main/index.json`（jsdelivr 镜像，仓库已有同域下载 URL 先例）
  3. 可选 ghproxy 前缀镜像（`https://ghproxy.com/https://raw.githubusercontent.com/...` 等，可用性需实施时验证）
- 每源设超时（如 8s），失败自动切下一源；UI 可显示"正在切换镜像源"轻提示。
- 错误文案细化：区分「网络不可达」与「HTTP 状态错误」。

### 4.3 权限模型：`cap.pluginDiscovery` 对 Remote 的开放策略（联动必改）

要让手机端（Remote 源）经 HTTP 桥调用插件管理面，必须调整 `policy_permission.rs` 内置基线：

- 现状：`("cap.plugin", true)` + Remote → Deny。
- 方向（实施时二选一，需权衡安全）：
  - **A. 放行 `cap.pluginDiscovery`，保留 `cap.pluginServiceManager` 等其余 deny**：`cap.pluginDiscovery` 只读面（discover）风险低，但 `install_remote`/`uninstall_local`/`apply_update` 是**写操作**且作用于桌面端文件系统，Remote 放开需谨慎。
  - **B. 保持整体 Deny，改为「已连接桌面端会话 = 可信」的源模型**：Remote 会话按 token 认证，若桌面端显式授权移动端管理插件（如设置项），则来源可标记为可信 Remote。改动更大，涉及源分类。
  - **C. 手机端只读（discover）+ 写操作二次确认**：capability 内按 action 区分（`discover` 允许 Remote，写操作继续 deny 或要求 config 精确 allow）。
- 至少需要：config 可覆盖（现有 `user_config_can_relax_builtin` 测试证明精确 allow 可覆盖内置 deny）——即**用户可在设置里显式 allow `cap.pluginDiscovery` remote**，作为最小可行路径；是否默认放行另议。
- **验收**：`policy_permission.rs` 单测更新（新增 Remote × pluginDiscovery 的期望裁决）。

### 4.4 错误信息与降级 UX

- `Command router_dispatch not found` / `Failed to fetch` 不再直接展示为面板错误：
  - 检测到 IPC 不可用 → 进入 HTTP 模式或显示"未连接桌面服务"引导。
  - HTTP 401/403 → "认证失败，请重新连接"。
  - 网络失败 → 显示重试 + 镜像切换。
- 面板可显示当前模式（"桌面直连 / 远程桌面服务 / 未连接"），帮助定位。

## 5. 涉及文件清单

| 文件 | 改动 |
|---|---|
| `Polaris-plugin/plugins/marketplace/src/Panel.tsx` | §4.1 invoke 分层 + §4.2 多 CDN + §4.4 错误提示（核心） |
| `Polaris-plugin/plugins/marketplace/dist/panel.js` | 重新构建（仓库 `pack-and-push.bat` / 构建脚本） |
| `Polaris-plugin/plugins/marketplace/marketplace.zip` | 重新打包（若安装走 zip） |
| `src-tauri/src/services/router/policy_permission.rs` | §4.3 权限（Remote × cap.pluginDiscovery 裁决） |
| `src-tauri/src/services/router/policy_permission.rs` 测试 | §4.3 验收单测 |
| （可选）`src/services/pluginDiscoveryService.ts` | 若主前端也要远程复用（当前主前端移动端不走该路径，可不改） |

## 6. 验证清单

- [ ] 桌面 Tauri：商城两个 tab 行为与现在一致（回归）。
- [ ] 纯 Web（浏览器访问 polaris-web）：商城 tab 走 HTTP + 多 CDN；已装 tab 在未连接时显示引导。
- [ ] 手机 APK：不再出现 `Command router_dispatch not found`。
- [ ] 手机 APK 连接桌面服务后：已装列表来自桌面端（若 §4.3 放行）。
- [ ] 后端：`cargo check` + `cargo test --lib` 不可用，改用 `cargo check`（AGENTS.md §9）+ 权限单测（若可单独跑 `cargo test --lib policy` 受 DLL 限制，则说明）。

## 7. 风险与未决问题

1. **权限开放的安全边界**：`install_remote`（下载 zip 到桌面端）+ `apply_update` + `uninstall_local` 从 Remote 源可达，等于**任意已认证移动端可改桌面端插件**。建议：默认不放行写操作，或加 config 显式 allow + UI 二次确认（§4.3-C）。
2. **面板 bundle 独立性**：`dist/panel.js` 是否允许 import 主前端模块，取决于打包方式（`createPanelLoader` 的具体实现）。若不能，则面板内自实现 HTTP 层（§4.1 决策点 1）。
3. **serverUrl/tokenMd5 的存储 key 是否与主前端一致**：需读 `src/services/transport/auth.ts` 确认 key 名，实施时核对。
4. **jsdelivr/ghproxy 对 index.json 的可用性**：实施时实测。
5. **手机端「管理的是桌面端插件」这一语义**是否可接受，需产品确认（§2.3）。

## 8. 验收标准（Done 定义）

- 手机 APK 打开商城面板：
  - 商城 tab 能加载到索引（任一镜像可用），或明确提示网络不可达并提供重试。
  - 已装 tab 不再出现 `Command router_dispatch not found`；已连接桌面服务时能列出桌面端插件（权限放行后），未连接时显示引导。
- 桌面 Tauri 端两个 tab 行为零回归。
- `policy_permission.rs` 的权限裁决有单测覆盖（含新 Remote × pluginDiscovery 期望值）。
- `cargo check` 通过；面板重新构建产物（`dist/panel.js`、`marketplace.zip`）已更新。
