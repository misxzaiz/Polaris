# 内置浏览器 AI 可操作性增强 — TODO

> 分析日期：2026-08-27
> 背景：内置浏览器（Tauri 2 + wry / WebView2）已具备圈选、DOM 交互、MCP 浏览器工具等能力。本待办聚焦「让 AI 更好感知与操作网页」，重点补齐三块信息缺口：**请求明细、浏览器存储、结构化页面信息**。
> 目标消费者是 AI（通过 polaris-browser-mcp + 通用 eval 命令），前端面板仅作辅助可视化。

---

## 现状速览（分析结论）

| 能力 | 现状 | 说明 |
|------|------|------|
| 圈选（Marquee） | ✅ 完整 | `browser_set_marquee` + `browser_select_region` → 上下文块，注入脚本实现 |
| DOM 交互 | ✅ 完整 | click / fill / type / press_key / scroll / find / zoom，20+ MCP 工具 |
| 请求明细 | ⚠️ 仅聚合 | `browser_get_network_info` 只返回耗时/资源数/总大小/失败数，靠 `performance.getEntriesByType('resource')` |
| 浏览器存储 | ❌ 无 | 无 localStorage / cookie / sessionStorage 的查看与编辑命令 |
| 拦截/篡改请求 | ❌ 无 | Tauri 2 的 wry 层未暴露 WebView2 `WebResourceRequested`，需 B 路径 |
| 跨域存储 | ❌ 受限 | 注入脚本受 SOP 限制，只能读同源 |

**技术边界（诚实标注）：**
- 注入脚本（`webview.eval_with_callback`）可及：请求 URL/时序/大小、同源 localStorage/sessionStorage/cookie、DOM 内容。
- 注入脚本**不可及**：请求/响应**体**、完整状态码（resource timing 无 body）；需 B 路径（CDP 复用 `browser_toggle_devtools` 或 WebView2 custom protocol），是独立大工程。

---

## TODO 1：请求明细 `browser_network_requests`（P0）

**目的：** AI 判断「哪个请求失败」「提交到底成没成」，当前只能靠 `network_info` 聚合值猜。

**MCP 工具：** `browser_network_requests`
**返回：** `[{ url, method, initiatorType, transferSize, duration, startTime, mimeType }]`

**文件：**
- `src-tauri/resources/browser-scripts/network-info.js`（扩展或新增 `network-requests.js`，遍历 `performance.getEntriesByType('resource')`，取 url/method/initiatorType/transferSize/duration/startTime/name→mimeType）
- `src-tauri/src/commands/browser_scripts.rs`（注册新脚本常量）
- `src-tauri/src/commands/browser.rs`（新增 `browser_network_requests` 命令 + 复用 `browser_eval_with_app`）
- `src-tauri/src/services/browser_mcp_server.rs`（新增工具声明 + `tool_name_to_action` 映射）

**依赖：** 无

**边界：** 拿不到请求/响应体与部分状态码（performance API 限制）。如需 body 转 TODO 6（B 路径）。

---

## TODO 2：存储读取 `browser_storage_get`（P0）

**目的：** AI 判断登录态、token 存储位置、配置/调试开关，对本地开发页（localhost）尤其高频。

**MCP 工具：** `browser_storage_get`
**入参：** `type: 'localStorage' | 'sessionStorage' | 'cookie'`、可选 `key`
**返回：** 同源下指定存储类型的 key-value 全量或单 key；cookie 解析 `document.cookie`

**文件：**
- `src-tauri/resources/browser-scripts/storage-read.js`（读取 localStorage/sessionStorage 全部键值；cookie 按 `;` 拆分）
- `src-tauri/src/commands/browser_scripts.rs`
- `src-tauri/src/commands/browser.rs`
- `src-tauri/src/services/browser_mcp_server.rs`

**依赖：** 无

**边界：** 只能读**同源**页面存储（SOP）。跨域页面需 B 路径。

---

## TODO 3：存储写入/清除 `browser_storage_set` / `browser_storage_clear`（P0）

**目的：** AI 修改配置、清理 token 或调试数据，形成「读→判断→改」闭环。

**MCP 工具：**
- `browser_storage_set`：入参 `type`、`key`、`value`（cookie 支持 `expires`/`path` 选项）
- `browser_storage_clear`：入参 `type`、可选 `key`（不传则清空该类型）

**文件：** 同 TODO 2，新增 `storage-write.js` 脚本。

**依赖：** TODO 2（共享脚本目录与命令骨架）

**风险：** 写操作有副作用，MCP schema 描述中应提示「仅限调试/本页会话数据，谨慎修改 cookie/token」。

---

## TODO 4：Console 结构化 `browser_console_diagnostics`（P1）

**目的：** 现有 console-capture 只做原始收集，AI 需要「页面坏没坏、坏在哪」的结构化摘要。

**增强：** 按 level 汇总 + 错误堆栈 + 自动标注 `NetworkError`（fetch 失败）与 4xx/5xx 关联。

**文件：**
- `src-tauri/resources/browser-scripts/console-capture.js`（增强汇总逻辑）
- `browser_scripts.rs` / `browser.rs` / `browser_mcp_server.rs`

**依赖：** 无

---

## TODO 5：操作副作用判定 + SPA 变化感知（P1）

**目的：** 补上「执行→验证」闭环，AI 提交后能确知结果。

**增强 `browser_wait`：**
- 新增条件 `dom_change`：SPA 点击后 URL 不变但视图变，检测 DOM 更新/加载完成。
- 新增条件 `error_detected`：检测是否出现 4xx/5xx、原生 dialog（`window.alert` 类）、loading 后停留。

**文件：**
- `src-tauri/resources/browser-scripts/*`（wait 相关脚本）
- `src-tauri/src/commands/browser.rs`（`browser_wait` 的 condition 分支，约 1969 行附近已有 `network_idle/navigation` 分支可扩展）
- `src-tauri/src/services/browser_mcp_server.rs`（wait 工具的 schema）

**依赖：** 部分依赖 TODO 1（error 关联需请求状态）

---

## TODO 6：请求/响应体 + 完整状态码（B 路径，P2，大工程）

**目的：** 真正的「查看接口调用」——URL/方法/状态码/请求头/响应体，以及请求拦截篡改。

**可选实现：**
- 复用现有 `browser_toggle_devtools`（已开 CDP 端口），实现 CDP 客户端订阅 `Network.*` / `Storage.*` 事件。
- 或 wry custom protocol / 包一层 native webview2-com 调 `WebResourceRequested`。

**边界（必须明确）：** 即使实现，跨域页面响应体仍受 CORS/隔离限制，只能保证本地与同源页面全量可见。

**依赖：** 无（独立大工程，建议后置，不与 P0 抢投入）

---

## 优先级建议

| TODO | 优先级 | 工作量 | 路径 | 说明 |
|------|--------|--------|------|------|
| 1. 请求明细 | 🔴 高 | 小 | A（纯 JS） | AI 定位请求失败的关键，改动最小 |
| 2. 存储读取 | 🔴 高 | 小 | A | 登录态/配置高频场景，本地页全通 |
| 3. 存储写入/清除 | 🔴 高 | 小 | A | 与 TODO 2 配套，形成读写闭环 |
| 4. Console 结构化 | 🟡 中 | 小 | A | 提升故障定位，改动小 |
| 5. wait 增强 | 🟡 中 | 中 | A | 依赖 TODO 1 部分，补齐验证闭环 |
| 6. 请求体/拦截 | 🔵 低 | 大 | B（CDP） | 独立大工程，建议后置 |

**推荐落地顺序：** TODO 1 → 2 → 3（P0 三个一起，覆盖 AI 操作与本地调试 80% 场景）→ 4 → 5 → 6。
