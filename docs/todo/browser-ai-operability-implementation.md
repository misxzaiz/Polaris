# 内置浏览器 AI 可操作性增强 — 完整实施蓝图（端到端）

> 定稿日期：2026-08-27
> 状态：**已确定**，可直接照着实施直到全部完成。
> 关联：`docs/todo/browser-ai-operability-todo.md`（TODO 清单）、`docs/todo/browser-ai-operability-plan.md`（计划与决策）。
> 目标：让 AI 通过内置浏览器（Tauri 2 + wry / WebView2）形成「感知 → 判断 → 执行 → 验证」闭环。
> 成功标准：① AI 能定位请求/登录失败根因（读请求+存储+console）；② AI 能判断提交成功与否；③ 本地开发页全量可用，跨域明确降级并告知。

---

# 第一部分：通用实现规约（所有阶段必须遵守）

## 规约 1：命令门控与注册
- 每个新增 `#[tauri::command]` 必须加 `#[cfg(feature = "tauri-app")]`。
- 必须注册到 `src-tauri/src/lib.rs` 的 `invoke_handler`（`commands::browser::*` 列表，约 842-868 行）。
- 前端 `src/services/tauri/browserService.ts` 增加对应 TS 封装函数（`invoke(...)`）。

## 规约 2：注入脚本统一管理
- 新脚本放入 `src-tauri/resources/browser-scripts/`。
- 在 `src-tauri/src/commands/browser_scripts.rs` 注册为 `pub const XXX_SCRIPT`（`include_str!`）。
- 脚本统一 `(() => { ... return JSON.stringify(...) })()` 包装，捕获异常返回默认结构。

## 规约 3：MCP 工具接入
- 在 `src-tauri/src/services/browser_mcp_server.rs`：① `handle_tools_list` 加工具声明（name/description/inputSchema）；② `tool_name_to_action` 加映射；③ 若走通用桥接则无需额外 dispatch。
- 工具统一 `browser_*` 前缀，按语义归类：感知（network/storage/console/context）、执行（click/fill/type）、验证（wait）。

## 规约 4：跨域与上下文边界（诚实声明）
- 存储/请求明细只在**当前页面 origin** 内可用；返回必带 `origin` 字段。
- 请求明细只给元数据，**不给 body / 完整状态码**；不在后端硬编码"transferSize=0=失败"语义，交由 AI 判断。
- 所有感知工具加**返回上限/采样**，防 AI 上下文膨胀。

---

# 第二部分：Phase 1（P0）— 感知层

## 1. 请求明细 `browser_network_requests`

**文件：**
- 新增 `src-tauri/resources/browser-scripts/network-requests.js`
- `browser_scripts.rs` 注册 `NETWORK_REQUESTS_SCRIPT`
- `browser.rs` 新增命令 + `lib.rs` 注册
- `browserService.ts` 新增 `browserNetworkRequests`
- `browser_mcp_server.rs` 工具 `browser_network_requests`

**脚本逻辑（network-requests.js）：**
```js
(() => {
  try {
    const entries = performance.getEntriesByType('resource').map(r => ({
      url: r.name, method: (r.initiatorType || 'other'),
      initiatorType: r.initiatorType || 'other',
      transferSize: r.transferSize || 0,
      duration: Math.round(r.duration),
      startTime: Math.round(r.startTime),
      // name→mimeType 可从 performance entries 推断（r.name 扩展名）
    }));
    // 采样：默认取最近 100 条
    const list = entries.slice(-100);
    return JSON.stringify({ origin: location.origin, count: entries.length, items: list });
  } catch {
    return JSON.stringify({ origin: location.origin, count: 0, items: [] });
  }
})()
```
- `method` 非 resource timing 能直接给出，用 `initiatorType` 区分 xhr/fetch/script/img；如需真 method 留待 Phase 3。

**命令签名：**
```rust
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_network_requests(app: AppHandle, label: String, limit: Option<usize>) -> Result<Value>
```
- `limit` 传入脚本控制采样条数（默认 100）。

**MCP schema：** `browser_network_requests`，入参 `{ label, limit? }`，返回 `{ origin, count, items:[{url,method,initiatorType,transferSize,duration,startTime}] }`。

**验收：**
- 对本地页调用，items 含该页加载的全部 resource（js/css/xhr/img）。
- 跨域资源也能列 URL（resource timing 对跨域可见 name/duration），但标注 origin 为当前域。
- limit 生效，不返回超过条数。

---

## 2. 存储读取 `browser_storage_get`

**文件：**
- 新增 `src-tauri/resources/browser-scripts/storage-read.js`
- `browser_scripts.rs` 注册 `STORAGE_READ_SCRIPT`
- `browser.rs` 新增命令 + `lib.rs` 注册
- `browserService.ts` 新增 `browserStorageGet`
- `browser_mcp_server.rs` 工具 `browser_storage_get`

**脚本逻辑（storage-read.js，入参 type/key）：**
```js
((params) => {
  try {
    const type = params.type || 'localStorage';
    const onlyKey = params.key || null;
    const out = { origin: location.origin, type, keys: {} };
    if (type === 'cookie') {
      const pairs = document.cookie.split(';').map(s => s.trim()).filter(Boolean);
      out.keys = Object.fromEntries(pairs.map(p => { const i = p.indexOf('='); return [p.slice(0,i), p.slice(i+1)]; }));
    } else {
      const store = type === 'sessionStorage' ? sessionStorage : localStorage;
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!onlyKey || k === onlyKey) out.keys[k] = store.getItem(k);
      }
    }
    return JSON.stringify(out);
  } catch {
    return JSON.stringify({ origin: location.origin, type: params.type || 'localStorage', keys: {}, error: 'unavailable' });
  }
})(typeof __ARGS__ !== 'undefined' ? __ARGS__ : {})
```
- `__ARGS__` 由命令侧在拼脚本时注入 JSON（参考现有 with_collector 拼参方式）。

**命令签名：**
```rust
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_storage_get(app: AppHandle, label: String, r#type: Option<String>, key: Option<String>) -> Result<Value>
```

**MCP schema：** `browser_storage_get`，入参 `{ label, type?: 'localStorage'|'sessionStorage'|'cookie', key? }`，返回 `{ origin, type, keys:{k:v} }`。

**验收：**
- 本地页读 localStorage/sessionStorage/cookie 全量与单 key。
- 返回必带 `origin`。
- 跨域页面读不到第三方域存储（SOP），返回当前域空集，MCP 描述注明。

---

## 3. 存储写入/清除 `browser_storage_set` / `browser_storage_clear`

**文件：**
- 新增 `src-tauri/resources/browser-scripts/storage-write.js`
- `browser_scripts.rs` 注册 `STORAGE_WRITE_SCRIPT`
- `browser.rs` 新增两个命令 + `lib.rs` 注册
- `browserService.ts` 新增 `browserStorageSet` / `browserStorageClear`
- `browser_mcp_server.rs` 工具 `browser_storage_set` / `browser_storage_clear`

**脚本逻辑（storage-write.js，入参 action/type/key/value/cookieOpts）：**
```js
((params) => {
  try {
    const { action, type = 'localStorage', key, value } = params;
    if (type === 'cookie') {
      const opts = params.cookieOpts || {};
      const path = opts.path || '/';
      const expires = opts.expires ? `; expires=${opts.expires}` : '';
      if (action === 'set') document.cookie = `${key}=${encodeURIComponent(value)}; path=${path}${expires}`;
      else if (action === 'clear') document.cookie = `${key}=; path=${path}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    } else {
      const store = type === 'sessionStorage' ? sessionStorage : localStorage;
      if (action === 'set') store.setItem(key, value);
      else if (action === 'clear') { if (key) store.removeItem(key); else store.clear(); }
    }
    return JSON.stringify({ origin: location.origin, ok: true, action, type, key: key || null });
  } catch {
    return JSON.stringify({ ok: false, action: params.action, error: 'unavailable' });
  }
})(typeof __ARGS__ !== 'undefined' ? __ARGS__ : {})
```

**命令签名：**
```rust
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_storage_set(app: AppHandle, label: String, r#type: Option<String>, key: String, value: String, cookie_opts: Option<Value>) -> Result<Value>
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_storage_clear(app: AppHandle, label: String, r#type: Option<String>, key: Option<String>) -> Result<Value>
```

**MCP schema：**
- `browser_storage_set`：`{ label, type?, key, value, cookieOpts?:{path?,expires?} }`；description 明确「仅调试用，谨慎修改 token/cookie」。
- `browser_storage_clear`：`{ label, type?, key? }`（key 省略则清空该类型）。

**验收：**
- set 后 get 能读回；clear 删除单 key / 清空。
- cookie set/clear 带 path/expires 生效。
- 写操作对当前域生效，跨域失败返回错误。

---

# 第三部分：Phase 2（P1）— 验证层

## 4. `browser_wait` 增条件 `dom_change` / `error_detected`

**文件：** `browser.rs`（约 1969 行 condition 分支，已有 `network_idle`/`navigation` 可参照）、`browser_mcp_server.rs`（wait 工具 schema 加条件枚举）。

**逻辑：**
- `dom_change`：记录进入 wait 时 `document.body` 的 outerHTML hash（或元素数），轮询至变化或 timeout——SPA 视图切换检测。
- `error_detected`：轮询 console 捕获数组 + `performance.getEntriesByType('resource')`，检测 4xx/5xx 状态、fetch 失败、`window.onerror` 触发；返回匹配错误摘要。

**MCP schema：** `browser_wait` 的 `condition` 枚举追加 `dom_change`、`error_detected`。

**验收：**
- SPA 点击后 `dom_change` 能等到视图更新完成。
- 提交触发 4xx 时 `error_detected` 返回错误信息。
- 超时返回 `ok:false` + message，不挂起。

---

## 5. Console 结构化 `browser_console_diagnostics`

**文件：** `console-capture.js`（增强汇总）、`browser.rs`、`browserService.ts`、`browser_mcp_server.rs`。

**逻辑：** 在现有 console-capture 收集基础上，返回：
```
{ origin, byLevel: { error: n, warn: n, info: n, log: n }, errors: [ {level, message, url, timestamp} ], networkErrors: [ {url, status?} ] }
```
- `networkErrors` 从 console 的 `NetworkError` / fetch 失败堆栈 + resource timing 失败项关联。
- 截断 errors 到最近 N 条（默认 20）。

**MCP schema：** `browser_console_diagnostics`，入参 `{ label }`，返回上述结构。

**验收：**
- 页面有 console.error 与 fetch 失败时，结构化返回并关联。
- byLevel 计数正确，errors 截断生效。

---

# 第四部分：Phase 3（P2）— 请求体/拦截（后置，独立）

## 6. CDP 客户端抓请求/响应体 + 存储（~5-8 人日）

**前置 PoC（决定是否 commit）：** 1-2 天验证：
- `browser_toggle_devtools` 已开 CDP 端口（WebView2 remote-debugging）。
- 能否连上并握手（WebView2 CDP 版本差异、`open_devtools` 弹窗体验）。
- `Network.enable` 后能否订阅到 `Network.requestWillBeSent` / `responseReceived`。

**若 PoC 通过，实现：**
- Rust 侧新增 CDP 客户端（websocket 连调试端口）：`Network.enable` 订阅请求/响应事件。
- 新增 MCP 工具：`browser_request_log`（含 body）、`browser_storage_full`（cookie 全量，经 CDP `Storage.*`）、可选 `browser_route`（拦截请求改头/假响应）。
- 事件流式推送给 AI（非阻塞轮询）。

**边界（必须明示）：** 跨域响应体仍受 CORS/隔离限制，只保证本地与同源页面全量可见。

**验收：**
- 本地页能抓到请求 URL/方法/状态码/请求头/响应体。
- `browser_storage_full` 读到 CDP 级 cookie（含 HttpOnly）。
- 拦截路由在本地/同源生效。

---

# 第五部分：加固项（实施中一并做）

| # | 加固项 | 说明 | 归属 |
|---|--------|------|------|
| G1 | 存储读取评估并入 diagnostics 通道 | 复用 `browser_get_diagnostics` 聚合通道减少注入次数；若耦合则独立（实施时定） | Phase 1 |
| G2 | 预置会话状态（导航前临时注入） | 写能力扩展：导航前注入 key-value 组，AI 预置调试 token | Phase 1 |
| G3 | console 错误→请求关联 | Phase 2 console 结构化同时输出「进行中请求列表」，AI 定位「4xx ↔ 报错」 | Phase 2 |

---

# 第六部分：实施顺序与验收门

## 推荐顺序（串行，每步验证后进入下一步）

| 步 | 内容 | 交付 | 验证门 |
|----|------|------|--------|
| S1 | 请求明细 `browser_network_requests` | 脚本+命令+MCP+TS | 本地页调用返回 items，limit 生效 |
| S2 | 存储读取 `browser_storage_get` | 同上 | 读写回显，origin 必返回 |
| S3 | 存储写入/清除 `browser_storage_set/clear` | 同上 | set→get 回读，clear 生效 |
| S4 | G1/G2 加固（并入诊断 + 预置注入） | 优化 | 无回归 |
| S5 | wait 增条件 `dom_change`/`error_detected` | 命令扩展 | SPA 与 4xx 场景通过 |
| S6 | Console 结构化 + G3 | 命令扩展 | 错误结构化+关联 |
| S7 | 端到端 AI 验证 | — | 见下「端到端验收」 |
| S8 | Phase 3 PoC | 可行性报告 | CDP 握手通过才继续 |
| S9 | Phase 3 CDP 实现（可选） | 请求体/拦截 | 见 Phase 3 验收 |

## 编译与测试门（每步必须）
- `cargo check --lib`（本机 `cargo test` 因 Tauri DLL 无法跑，用 check 验证编译，见内存 `rust-lib-test-env-limit`）。
- 前端 `tsc`（若本机 node_modules 损坏则靠 esbuild/语法检查，见内存 `browser-marquee-context-block-refactor`）。

## 端到端验收（S7）
让 AI 执行完整链路并记录结果：
1. 打开本地登录页（如 localhost 登录 demo）。
2. `browser_inspect` 找字段 → `browser_fill`/`type_text` 填表。
3. 提交 → `browser_wait(error_detected)` 判断成败。
4. 若失败：`browser_network_requests` 找失败请求 + `browser_console_diagnostics` 找报错 + `browser_storage_get` 看 token → 定位根因。

**通过标准：** AI 能仅凭上述工具输出，准确指出失败原因（接口 4xx / token 缺失 / JS 报错），且不依赖猜测。

---

# 第七部分：风险与警惕（实施中回看）

| # | 风险 | 应对 |
|---|------|------|
| W1 | CDP"看似很近"陷阱 | Phase 3 先 PoC 再 commit |
| W2 | AI 上下文膨胀 | 感知工具加返回上限（规约 4） |
| W3 | Web 模式不可用 | 所有命令加 cfg 门控（规约 1） |
| W4 | 写操作副作用 | set/clear schema 标注「仅调试用」 |
| W5 | 跨域能力承诺过度 | 所有工具返回 origin + MCP 描述注明 SOP 边界 |
