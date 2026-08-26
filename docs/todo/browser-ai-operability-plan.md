# 内置浏览器 AI 可操作性增强 — 实施计划

> 分析日期：2026-08-27
> 关联：`docs/todo/browser-ai-operability-todo.md`（TODO 清单）
> 目标：让 AI 通过内置浏览器（Tauri 2 + wry / WebView2）操作网页时，形成「感知 → 判断 → 执行 → 验证」闭环。
> 成功标准：① AI 能定位请求失败与登录失败根因（读请求+存储+console）；② AI 能判断提交成功与否；③ 本地开发页全量可用，跨域明确降级并告知。

---

## 一、路径选型（已确定）

**A、B 分层，先 A 后 B，二者独立轨道。**

| 维度 | 路径 A（纯 JS 注入） | 路径 B（CDP 复用 devtools 通道） |
|---|---|---|
| 实现 | 复用 `webview.eval_with_callback` | 复用 `browser_toggle_devtools` 已开的 CDP 端口，实现 CDP 客户端 |
| 覆盖 | 请求元数据、同源存储、DOM | + 请求/响应体、完整状态码、拦截篡改 |
| 工作量 | 小 | 大（独立工程） |
| 跨域 | SOP 受限 | 响应体仍受 CORS 限制 |

**关键判断**：CDP 通道已存在（`browser_toggle_devtools` 已 `open_devtools`），B 路径增量仅是「实现 CDP 客户端」，非开通通道。但仍为独立大工程，后置。

---

## 二、分阶段实施路线

### Phase 1（P0）— 感知层：看请求 + 看存储（~2-3 人日）
| # | 能力 | MCP 工具 | 关键设计 |
|---|------|----------|----------|
| 1 | 请求明细 | `browser_network_requests` | `performance.getEntriesByType('resource')` → `[{url, method, initiatorType, transferSize, duration, startTime}]`；`transferSize=0` 判失败 |
| 2 | 存储读取 | `browser_storage_get` | 遍历 localStorage/sessionStorage + `document.cookie`；按当前页面 origin 隔离并标注来源域 |
| 3 | 存储写入/清除 | `browser_storage_set/clear` | `localStorage.setItem` / 设 cookie（expires/path）；schema 标注「仅调试用」 |

**文件锚点：**
- 脚本：`src-tauri/resources/browser-scripts/`（新增 `network-requests.js`、`storage-read.js`、`storage-write.js`）
- 注册：`src-tauri/src/commands/browser_scripts.rs`
- 命令：`src-tauri/src/commands/browser.rs`（复用 `browser_eval_with_app`）
- MCP：`src-tauri/src/services/browser_mcp_server.rs`（工具声明 + `tool_name_to_action`）

### Phase 2（P1）— 验证层（~1.5-2 人日）
| # | 能力 | 位置 |
|---|------|------|
| 4 | `browser_wait` 增 `dom_change` / `error_detected` 条件 | `browser.rs:1969` 附近 condition 分支（扩展点已存在） |
| 5 | Console 结构化 `browser_console_diagnostics` | `console-capture.js` 增强（按 level 汇总 + NetworkError 标注） |

### Phase 3（P2）— 请求体/拦截（~5-8 人日，后置）
CDP 客户端订阅 `Network.*` / `Storage.*`。边界：跨域响应体仍受 CORS 限制。

---

## 三、依赖链

- Phase 1：三项互相独立，可并行。
- Phase 2：`error_detected` 可依赖 Phase 1 请求状态；其余独立。
- Phase 3：完全独立。

---

## 四、风险与规避

| 风险 | 影响 | 规避 |
|------|------|------|
| 跨域存储读不到（SOP） | 第三方页存储能力缺失 | Phase 1 返回「当前域」并明示，不承诺跨域 |
| 请求体拿不到（performance 限制） | 无法满足完整"看接口响应" | 明确 Phase 1 只给元数据，body 划入 Phase 3 |
| MCP 工具膨胀 | AI 工具选择混乱 | 按感知/执行/验证归类，单一职责 |
| 写操作副作用 | 误改 token/cookie | 写工具 schema 加约束 + 前端可设开关 |

---

## 五、验证策略

1. AI 端到端：打开本地登录页 → 填表 → 提交 → 读请求+存储+console 判断成败。
2. 脚本单元：注入脚本在固定页面断言返回结构。
3. MCP 冒烟：直接调 `browser_storage_get` / `browser_network_requests` 看输出。

---

## 六、实施决策（已确定）

### 决策 1：命令门控
所有新增 `#[tauri::command]` 必须加 `#[cfg(feature = "tauri-app")]`，并注册到 `src-tauri/src/lib.rs` 的 `invoke_handler`（约 842-868 行 `commands::browser::*` 列表）。否则 Web 打包（`--no-default-features`）会报 unresolved crate tauri（见内存 `web-only-tauri-command-gate`）。

### 决策 2：技术边界诚实声明
- Phase 1 请求明细**只给元数据**（url/method/initiatorType/transferSize/duration），**不给 body/完整状态码**——由 AI 基于上下文判断，后端不在 transferSize=0 上硬编码"失败"语义（缓存命中/跨域也会是 0）。
- 存储按**当前页面 origin 隔离并必返回 `origin` 字段**，避免 AI 跨域混淆 token。

### 决策 3：MCP 工具命名与归类
统一 `browser_*` 前缀，在 `tool_name_to_action` 按语义归类：感知（network/storage/console/context）、执行（click/fill/type）、验证（wait）。

### 决策 4：防上下文膨胀
`browser_network_requests` / `browser_storage_get` 加**返回上限/采样**（如网络请求默认取最近 N 条、可过滤 `status==ok`），防止 AI 一次拉取 500 条请求爆上下文。

---

## 七、加固项（实施时一并做，均小改动）

| # | 加固项 | 说明 |
|---|--------|------|
| G1 | 存储读取评估并入 diagnostics 通道 | 复用 `browser_get_diagnostics` 已聚合的注入通道，减少脚本注入次数；若增加耦合则独立 |
| G2 | 预置会话状态（临时注入） | 写能力顺势支持「导航前注入一组 key-value」，让 AI 预置调试 token 后再操作 |
| G3 | console 错误→请求关联 | Phase 2 console 结构化同时输出「出错时进行中的请求列表」，AI 可定位「某 4xx ↔ 某报错」 |

---

## 八、边界警惕

| # | 警惕点 | 应对 |
|---|--------|------|
| W1 | CDP 的"看似很近"陷阱 | Phase 3 开工前先 1-2 天 PoC 验证 CDP 握手（WebView2 版本差异、事件订阅时序、`open_devtools` 弹窗体验），再决定是否 commit 到路线 |
| W2 | AI 长流程上下文失焦 | 见决策 4（返回上限）+ 工具归类 |
| W3 | Web 模式（非 Tauri）不可用 | 见决策 1（cfg 门控），前端 `isTauriRuntime()` 分支已存在（BrowserPanel.tsx:615） |
