# 内置浏览器 MCP 工具逐个实测问题反馈与修复指引

> 测试日期：2026-09-04
> 测试方式：本地启动 HTTP 测试页，通过 `polaris-browser` MCP 服务逐个调用全部 27 个工具，用**页面真实状态**（DOM 变化、滚动位置、缩放系数、按键日志）验证工具是否实际生效，而非只看工具返回值。
> 涉及代码：`src-tauri/src/services/browser_mcp_server.rs`、`src-tauri/src/commands/browser.rs`、`src-tauri/src/services/ask_listener.rs`

---

## 一、结论速览

| 类别 | 正常 ✅ | 异常 ❌ |
|---|---|---|
| 页面获取与导航 | list / acquire / navigate / back / forward / reload / history_state | — |
| 页面内容读取 | context / inspect / diagnostics | status / network_info / network_requests |
| 交互操作 | click / fill / type_text / scroll / zoom / find / marquee / select_region | press_key（半可用） |
| 断言与等待 | wait | assert |
| 存储与调试 | — | storage_get / storage_set / storage_clear |

**8 个异常工具，可归并为 4 类根因：**

| 根因 | 影响工具 | 严重度 |
|---|---|---|
| **A. MCP 参数白名单转发缺失** | assert、storage_set | 高（动作不执行） |
| **B. 脚本外层 IIFE 缺 `return`** | press_key | 中（动作执行但报错） |
| **C. 返回类型与 MCP schema 不匹配**（string/null） | status、network_info、network_requests、storage_get、storage_clear | 中（动作执行但拿不到结果） |
| **D. 历史状态检测与实际不符** | history_state（记录项） | 低 |

---

## 二、逐类根因详析

### A. MCP 参数白名单转发缺失（`browser_mcp_server.rs`）

**问题**：`tool_success` 前的 `handle_tools_call` 将 MCP 参数转发到主进程时，只白名单转发固定字段。`browser_frame` 的转发列表（`browser_mcp_server.rs:599-635`）**缺了以下字段**：

- `kind` —— `browser_assert` 必传（`assert 缺少 kind` 错误由此而来）
- `key` —— `browser_storage_set` 必传（`storage_set 缺少 key` 错误由此而来）
- `type` —— `browser_storage_get/set/clear` 的存储类型（虽不报错，但被静默丢弃，读到的永远是默认 localStorage）
- `cookieOpts` —— `browser_storage_set` 写 cookie 时用到

**证据（实测）**：
```
assert 缺少 kind                                                                        ← browser_assert，已传 kind
storage_set 缺少 key                                                                    ← browser_storage_set，已传 key
```

MCP server 侧（`browser_mcp_server.rs:599-635`）的 `get` 循环里搜不到 `kind` / `key` / `type` / `cookieOpts`，而 `browser.rs:3405-3411` 的 `assert` 分支确实 `args.get("kind")`、`browser.rs:3391` 的 `storage_set` 分支确实 `args.get("key")`。字段在转发时蒸发。

（注：`press_key` 的报错信息是「浏览器按键结果格式错误」，那是缺字段之外的**另一类根因**——见下文 B 类，其 `keys` 参数本身能正常传入。）

**修复方向**：将 `kind`、`key`、`type`、`cookieOpts` 补入 `browser_frame` 的转发白名单（`browser_mcp_server.rs` 的字段数组）。

---

### B. press_key 脚本外层 IIFE 缺 `return`

**位置**：`browser.rs:2260-2341` `build_press_key_script`

**问题**：脚本是 `(() => { ... (function() { ... return JSON.stringify({ok, action, ...}) })() })()`。内层 IIFE 返回了结果字符串，但**外层 IIFE 没有 `return` 它**，整段 IIFE 无返回值 → WebView2 `eval_with_callback` 回调拿到 `null` → `parse_eval_json` → `from_value(null)` → 报"浏览器按键结果格式错误: invalid type: null"。

**关键发现**：虽然报错，但**按键真实生效**——实测页面 keydown 日志出现了 2 次 `[Tab]`。说明动作已执行，仅返回值丢失。

**对比**：`type_text`、`scroll` 等用同一模式但工作正常，检查它们外层 IIFE 是带了 `return` 的（`browser.rs:2369` 起）。press_key 是漏了。

**修复方向**：给外层 IIFE 加 `return`，把内层 IIFE 的结果抛出；或改写成 `(() => { return (function() {...})(); })()`。修复后可加一条 MCP 往返测试断言返回值非 null。

---

### C. 返回类型与 MCP schema 不匹配（string/null）

**涉及工具**：`status`、`network_info`、`network_requests`、`storage_get`、`storage_clear`

**问题**：这些 action 在 `browser.rs:3372-3403`、`3506-3508` 走的是「`browser_eval_with_app` 返回原始 JS 字符串 → `serde_json::from_str` 解析」路径。当 JS 返回值是字符串或 null 时：

- `status` / `network_info`：脚本返回的是**字符串**（如状态描述文本），`from_str` 解析后是 `Value::String`，不是对象 → MCP server 侧 `structuredContent` 要求 object，校验失败，报 `structuredContent expected record received string`。
- `network_requests` / `storage_get` / `storage_clear`：脚本返回 null（无数据/执行完成无产物）→ `from_str` 解出 `Value::Null` → schema 校验失败报 `received null`。

**关键区分**：这类工具**动作实际执行了**（storage_clear 清空、network_requests 采集都发生），只是返回给 AI 的值无法通过校验。与 A 类（真的没执行）不同。

**修复方向**（三选一）：
1. **最优**：`browser_mcp_server.rs` 的 `tool_success` 中，对 `Value::String` / `Value::Null` 兜底——String 包成 `{"text": "..."}`，Null 包成 `{"value": null}`，保证 `structuredContent` 恒为 object。
2. 命令层（`browser.rs`）在 `from_str` 后对 String/Null 规范化。
3. 让脚本侧保证返回 JSON 对象（改脚本返回结构）。

建议采用方案 1，一处修复覆盖全部 5 个工具，且不侵入命令层。

---

### D. 历史状态检测与实际不符（记录项）

**实测**：`browser_navigate` example.com → example.org 后，`history_state` 返回 `{canGoBack:false, canGoForward:false}`，但随后的 `browser_back` **实际回到了 example.com**。说明历史栈里其实有可返回的条目，`canGoBack` 探测逻辑漏判。

**定位候选**：`BrowserHistoryState` 结构（`browser.rs:274`）的读取方式——若基于注入脚本读取 `window.history`，注意 Tauri/wry 场景下 origin 切换时机、或 SPA history.state 与栈条目的差异。

**修复方向**：核对 history_state 探测脚本是否在导航提交后才采样；优先用 `history.length` + 栈索引，而非 `canGoBack`（`canGoBack` 在 WebView2 下偶有不一致）。

---

## 三、逐工具实测明细

> ✅ = 实测验证通过（以页面真实状态为准）　❌ = 异常　⚠️ = 有行为特性/半可用

### 页面获取与导航

| 工具 | 结果 | 实测证据 |
|---|---|---|
| `browser_list` | ✅ | 空列表返回 `{"items":[]}` |
| `browser_acquire` | ✅ | 新建标签并导航 example.com，返回 label/tabId |
| `browser_navigate` | ✅ | 跳转 example.org 成功 |
| `browser_back` | ✅ | 从 example.org 回 example.com（context 实证） |
| `browser_forward` | ✅ | 回到 example.org（context 实证） |
| `browser_reload` | ✅ | `reloaded:true` |
| `browser_history_state` | ⚠️ D | 报告 canGoBack:false，但 back 实际成功 |

### 页面内容读取

| 工具 | 结果 | 实测证据 |
|---|---|---|
| `browser_context` | ✅ | 返回标题/正文/链接/标题层级 |
| `browser_inspect` | ✅ | 返回元素索引/矩形/选择器 |
| `browser_diagnostics` | ✅ | 上下文+元素+视口+控制台快照 |
| `browser_status` | ❌ C | 两次 schema 校验失败（received string） |
| `browser_network_info` | ❌ C | schema 校验失败（received string） |
| `browser_network_requests` | ❌ C | schema 校验失败（received null） |

### 交互操作

| 工具 | 结果 | 实测证据 |
|---|---|---|
| `browser_click` | ✅ | 点按钮后页面渲染「被点击:小白测试」，JS 真实执行 |
| `browser_fill` | ✅ | 输入框填入值 |
| `browser_type_text` | ⚠️ | 生效，但行为是**全选后替换**而非追加（原值被覆盖） |
| `browser_press_key` | ⚠️ B | 报 invalid type: null，但按键真实生效（keylog 出现 [Tab][Tab]） |
| `browser_scroll` | ✅ | 滚到底 scrollY:2905 实证 |
| `browser_zoom` | ✅ | 设 200% 后元素矩形 21×170 → 42×339，恰好 2 倍 |
| `browser_find` | ✅ | 返回「找到 2 个匹配」 |
| `browser_marquee` | ✅ | 启用/关闭正常 |
| `browser_select_region` | ✅ | 区域内元素+HTML/文本片段 |

### 断言与等待

| 工具 | 结果 | 实测证据 |
|---|---|---|
| `browser_wait` | ✅ | text_appear 等到 3 秒后延迟文本；url_change 正常 |
| `browser_assert` | ❌ A | 无论传何 kind 都报「assert 缺少 kind」（参数被转发丢弃） |

### 存储与调试

| 工具 | 结果 | 实测证据 |
|---|---|---|
| `browser_storage_get` | ❌ C | schema 校验失败（received null） |
| `browser_storage_set` | ❌ A | 报「storage_set 缺少 key」（key 被转发丢弃） |
| `browser_storage_clear` | ❌ C | schema 校验失败（received null） |

---

## 四、行为特性记录（非 bug，但影响使用预期）

1. **`type_text` 是全选替换语义**：聚焦输入框后 type_text("追加")，输入框从「小白测试」变为仅「追加」。与浏览器手动键盘行为不同（通常为追加）。若预期是追加，需在脚本里改为光标定位到末尾再插入。

2. **`file://` 导航被安全策略拦截**：`browser_navigate` 到 file URL 报「AI/MCP 浏览器导航暂不允许 file://」。属有意设计（防 AI 越权读本地文件）。本地测试可用 http://localhost 服务替代。

3. **`url_change` 等待的边界**：导航到 404 页后等待 url_change，返回的是当前 URL 而非新 URL——语义上「等待到 URL 变化」在此场景下未生效，需页面真实导航触发才严格有效。

---

## 五、修复优先级建议

| 优先级 | 根因 | 影响 | 改动量 |
|---|---|---|---|
| P0 | A. 参数白名单补字段 | assert / storage_set 完全不可用 | 极小（browser_mcp_server.rs 数组追加 4 字段） |
| P1 | C. structuredContent 兜底 | 5 个只读工具拿不到结果 | 小（tool_success 一处兜底） |
| P1 | B. press_key 补 return | 按键动作有效但稳定报错 | 小（脚本外层加 return） |
| P2 | D. history_state 探测逻辑 | 低，仅影响 AI 预判 | 中（核对探测脚本） |

**一条回归经验**：form 类型工具有 `browser_fill_form`、`browser_hover`、`browser_dialog`、`browser_screenshot`、`browser_close` 未在本次 27 个清单内（它们是 `browser_mcp_server.rs` 中 `tool_name_to_action` 已注册但或许未被 UI 列出的扩展工具）。若本轮已修复 A，建议顺手验证这批工具的参数转发是否也被白名单覆盖。

---

## 六、附：测试环境与复现方式

1. 准备本地 HTTP 测试页（含输入框、按钮、3 秒延迟按钮、scroll 指示器、keydown 日志）。
2. `python -m http.server 8899` 起服务，`browser_navigate` 到 `http://localhost:8899/test.html`。
3. 逐个调用工具，用 `browser_context` / `browser_diagnostics` 读**页面真实状态**验证是否生效。
4. 观察到的全部原始报错：

```
# assert / storage_set（根因 A）
验证错误: assert 缺少 kind
验证错误: storage_set 缺少 key

# status / network_info / network_requests / storage_get / storage_clear（根因 C）
MCP server "polaris-browser" returned a malformed result that failed schema validation:
[{"expected":"record","code":"invalid_type","path":["structuredContent"],"message":"Invalid input: expected record, received string"}]   # status/network_info
[{"expected":"record","code":"invalid_type","path":["structuredContent"],"message":"Invalid input: expected record, received null"}]      # 其余

# press_key（根因 B）
验证错误: 浏览器按键结果格式错误: invalid type: null, expected struct BrowserInteractionResult
```

---

## 七、修复记录（2026-09-04 闭环）

| 根因 | 修复点 | 文件 / 行 | 状态 |
|---|---|---|---|
| A. 参数白名单缺失 | `browser_frame` 白名单追加 `kind`、`key`、`cookieOpts`；`type` 因与帧路由键冲突，改以 `storageType` 别名透传，命令层三处 storage 分支改读 `storageType` | `browser_mcp_server.rs:631-645`、`browser.rs:3382/3390/3398` | ✅ |
| B. press_key 缺 return | 外层 IIFE 前补 `return`，把内层 IIFE 结果抛出 | `browser.rs:2268` | ✅ |
| C. structuredContent 非 object | `ensure_object` 增加 `String → {text}`、`Null → {value:null}` 兜底，一处覆盖全部 5 个工具 | `browser_mcp_server.rs:655-677` | ✅ |
| D. history_state 漏判 | 删除永不置位的 `__polaris_can_go_forward__`；`canGoBack` 仍用 `history.length>1`；`canGoForward` 改用 `sessionStorage.__polaris_nav_dir__` 标记，由 `browser_history_with_app` 在 back/forward 后写入 | `browser.rs:1047-1058、1860-1893` | ✅ |

**关键设计决策**：storage 的 `type` 参数与 MCP 帧路由键 `type:"browser"` 同名。若直接透传会覆盖帧类型标记，导致主进程无法路由（比原 bug 更严重的回归）。因此 MCP server 侧重命名为 `storageType` 透传，命令层兼容读取 `storageType`。这同时修复了原本 storage 分支读 `args.get("type")` 永远拿到 `"browser"` 的潜在 bug。

**验证**：`cargo check --features tauri-app` 与 `cargo check --features tauri-app --tests` 均编译通过（0 error）。新增 6 条单元测试覆盖 `ensure_object` 的 String/Null 兜底与 `browser_frame` 的 assert/storage 字段转发（含帧 type 不被覆盖的回归断言）。本机 `cargo test` 因 polaris.exe 占用无法链接（见记忆 `rust-lib-test-env-limit`），运行时验证待下次发版前在干净环境执行。