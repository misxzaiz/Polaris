# 浏览器自动化交互增强规划方案

> 版本: 1.0  
> 日期: 2026-07-27  
> 范围: 新增 browser_wait/browser_scroll/browser_press_key/browser_type_text + 现有操作增强 + 截图跨平台

---

## 目录

1. [前置分析:当前架构与调用链路](#1-前置分析当前架构与调用链路)
2. [现有交互能力清单](#2-现有交互能力清单)
3. [新增操作设计](#3-新增操作设计)
4. [现有操作增强](#4-现有操作增强)
5. [截图跨平台方案](#5-截图跨平台方案)
6. [MCP 桥接影响](#6-mcp-桥接影响)
7. [前端 API 同步](#7-前端-api-同步)
8. [测试用例](#8-测试用例)
9. [实施优先级](#9-实施优先级)

---

## 1. 前置分析:当前架构与调用链路

### 1.1 三路分派架构

Polaris 内置浏览器的自动化操作通过三条独立路径汇聚到同一个 Rust 实现层:

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Tauri命令    │     │  SimpleAI 工具    │     │  MCP 服务器          │
│  (前端调用)    │     │  (AI 引擎内部)     │     │  (Claude/Codex 调用) │
│  browserService│     │  BrowserTool     │     │  polaris-browser-mcp │
│  .ts→invoke() │     │  execute()       │     │  tools/call          │
└──────┬───────┘     └────────┬─────────┘     └──────────┬──────────┘
       │                      │                           │
       │               ┌──────┴──────────────┐            │
       │               │  ask_listener.rs     │◄───────────┘
       │               │  dispatch_browser_   │  TCP bridge
       │               │  frame()             │  (port+token)
       │               └──────┬──────────────┘
       │                      │
       ▼                      ▼
┌──────────────────────────────────────────────┐
│  commands/browser.rs                          │
│  ┌──────────────────────────────────────┐     │
│  │  _with_app() 函数 (核心实现)          │     │
│  │  browser_click_with_app              │     │
│  │  browser_fill_with_app               │     │
│  │  browser_eval_with_app               │     │
│  │  ...                                 │     │
│  └──────────────┬───────────────────────┘     │
│                 │                              │
│                 ▼                              │
│  ┌──────────────────────────────────────┐     │
│  │  Tauri Webview eval                 │     │
│  │  webview.eval_with_callback(script) │     │
│  │  → 注入 JS 脚本执行                  │     │
│  └──────────────────────────────────────┘     │
│                                               │
│  ┌──────────────────────────────────────┐     │
│  │  JS 脚本常量 (嵌入在 .rs 中)          │     │
│  │  CLICK_ELEMENT_SCRIPT_BODY          │     │
│  │  FILL_ELEMENT_SCRIPT_BODY           │     │
│  │  PAGE_CONTEXT_SCRIPT                │     │
│  └──────────────────────────────────────┘     │
└──────────────────────────────────────────────┘
```

### 1.2 三条路径的差异

| 维度 | Tauri 命令 | SimpleAI 工具 | ask_listener (MCP) |
|------|-----------|--------------|-------------------|
| 入口 | `#[tauri::command]` → `invoke()` | `BrowserTool::execute()` → `run()` | `dispatch_browser_frame()` |
| label 解析 | 直接传参 | `resolve_browser_label_for_agent_with_app()` | 同 SimpleAI |
| agent_key | 无 | `ctx.session_id` | `frame.sessionId` |
| 返回值 | 泛型 T | `ToolOutcome` | `Result<Value>` |
| 调用方 | 前端 TS | SimpleAI 引擎 | MCP TCP 桥接 |

### 1.3 核心基础设施

**`browser_eval_with_app()`** (browser.rs:833-859):
- 所有 JS 注入操作均通过此函数执行
- 超时范围: 100ms ~ 10,000ms (默认 2,500ms)
- 使用 `eval_with_callback` 异步获取结果
- 返回原始 JSON 字符串,由 `parse_eval_json()` 解析

**JS 脚本注入模式**:
- 所有交互脚本共用 `polaris_interactive_collector_script!()` 宏
- 宏展开为 `collectPolarisInteractiveElements()` 函数
- 该函数遍历 DOM、Shadow DOM、iframe (同源),收集可交互元素
- 跨域 iframe 被 `try { doc } catch {}` 静默跳过

---

## 2. 现有交互能力清单

### 2.1 `browser_navigate` / `browser_reload` / `browser_history`

- **实现**: 直接调用 Tauri Webview 的 `navigate()` / `eval("history.back()")` / `eval("history.forward()")`
- **边界情况**: `navigate` 对 file:// URL 做 AI 导航限制
- **失败场景**: WebView 已关闭 → `get_webview()` 返回 `AppError`

### 2.2 `browser_click` (CLICK_ELEMENT_SCRIPT_BODY)

**当前实现** (browser.rs:1945-1995):
```
1. 遍历交互元素 → 按 index 或 text 匹配
2. scrollIntoView(block: 'center')
3. 对 <a> 设置 target='_self'
4. focus()
5. 合成事件: pointerdown → mousedown → pointerup → mouseup → click
```

**缺失的事件**:
- ❌ **mousemove**: 完全缺失。antd Dropdown、hover 驱动的菜单、mouseenter 监听器无法触发
- ❌ **pointermove**: 同样缺失
- ✅ pointerdown/mousedown → pointerup/mouseup → click 顺序正确

**其他问题**:
- `dispatchMouse` 使用 `view.MouseEvent` 构造函数,部分框架可能检测 `event.sourceCapabilities` 来判断是否为合成事件
- 未检查元素是否在视口外(仅 `scrollIntoView` 不能保证)

### 2.3 `browser_fill` (FILL_ELEMENT_SCRIPT_BODY)

**当前实现** (browser.rs:1997-2049):
```
1. 遍历交互元素 → 按 index 或 text 匹配
2. scrollIntoView
3. focus()
4. 对 <select>: 用 value 精确匹配或 textContent 模糊匹配
5. 对 input/textarea: setNativeValue() + 派发 input/change 事件
6. 对 contentEditable: 直接设置 textContent
```

**问题**:
- **select 选项匹配**: `option.value === fillValue` (精确) 或 `clean(option.textContent).includes(fillValue)` (模糊)
  - 模糊匹配太宽松: 如 fillValue="选项1" 可能匹配到 "选项10" 的 textContent
  - 没有对 `<select multiple>` 的特殊处理(只能选一个)
- **fill 对 React 受控组件**: `setNativeValue` + `Event('input')` 在 React 17+ 中可能被忽略,因为 React 18 使用 `input` 事件监听器而非 `setNativeValue` 的 setter 拦截
- **无 type_text 逐字输入**: 一次性设置 value 无法触发 keydown/keypress/keyup 事件

### 2.4 `browser_inspect` / `browser_diagnostics` / `browser_context`

- **inspect**: 返回 `Vec<BrowserInteractiveElement>`,含 index/kind/text/value/placeholder/href/disabled/fillable
- **diagnostics**: 合并 context + elements + visual + consoleMessages + screenshot
- **context**: 提取文本、标题、链接、meta 描述

### 2.5 交互元素收集器 (collectPolarisInteractiveElements)

**覆盖的交互模式**:
- 原生交互元素: `a[href]`, `button`, `input`, `textarea`, `select`, `summary`, `label[for]`
- ARIA 角色: 20+ 种角色
- 属性: onclick, jsaction, aria-expanded, data-action, data-click, data-command 等
- 框架属性: `ng-click`, `x-on:click`, `@click`, `wire:click`, `hx-get` 等
- Shadow DOM (深度 ≤3)
- 同源 iframe (深度 ≤3)

**限制**:
- 跨域 iframe: `try { node.contentDocument } catch {}` 静默跳过,不标注
- 最大元素数: 220, 扫描上限: 5000
- 不包含 SVG 内部交互元素

---

## 3. 新增操作设计

### 3.1 `browser_wait`

#### 需求
AI/Agent 需要等待页面加载完成、特定文本出现、元素出现或网络空闲。当前只有 `navigate` 后的隐含等待,缺乏显式等待能力。

#### 设计

**Action 枚举值**: `"wait"`

**支持的等待条件** (通过 `condition` 参数指定):

| condition | 描述 | 典型超时 |
|-----------|------|---------|
| `"url_change"` | 等待 URL 发生变化(相对于调用时的 URL) | 15s |
| `"text_appear"` | 等待指定文本出现在页面中(配合 `text` 参数) | 15s |
| `"element_appear"` | 等待指定 index/text 的元素出现在可交互列表中 | 15s |
| `"network_idle"` | 等待网络请求停止(连续 500ms 无请求) | 30s |
| `"navigation"` | 等待页面完全加载(DOMContentLoaded + 网络空闲) | 30s |
| `"timeout"` | 固定等待指定毫秒数(配合 `ms` 参数) | 自定义 |

**Rust 函数签名**:

```rust
#[cfg(feature = "tauri-app")]
pub async fn browser_wait_with_app(
    app: &AppHandle,
    label: &str,
    condition: &str,
    text: Option<&str>,
    index: Option<usize>,
    ms: Option<u64>,
    timeout_ms: Option<u64>,
) -> Result<BrowserInteractionResult>
```

**`#[tauri::command]`**:

```rust
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_wait(
    app: AppHandle,
    label: String,
    condition: String,
    text: Option<String>,
    index: Option<usize>,
    ms: Option<u64>,
    timeout_ms: Option<u64>,
) -> Result<BrowserInteractionResult>
```

**JS 注入脚本** (`WAIT_SCRIPT_BODY`):

```javascript
// 传入: condition, waitText, waitIndex, waitMs, timeoutMs
const startTime = Date.now();
const deadline = startTime + timeoutMs;

const poll = async (resolve) => {
  if (Date.now() >= deadline) {
    resolve(JSON.stringify({ ok: false, action: 'wait', index: null, text: condition, url: String(location.href), message: '等待超时' }));
    return;
  }

  let satisfied = false;
  let detail = '';

  switch (condition) {
    case 'url_change': {
      const currentUrl = String(location.href);
      satisfied = currentUrl !== initialUrl;
      detail = currentUrl;
      break;
    }
    case 'text_appear': {
      if (!waitText) { satisfied = true; break; }
      const body = document.body?.innerText || '';
      satisfied = body.toLowerCase().includes(waitText.toLowerCase());
      detail = satisfied ? `找到文本: ${waitText}` : '';
      break;
    }
    case 'element_appear': {
      const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 240 });
      const query = (waitText || '').toLowerCase();
      if (Number.isInteger(waitIndex) && waitIndex >= 0) {
        satisfied = waitIndex < entries.length;
        detail = satisfied ? `元素 index ${waitIndex} 已出现` : '';
      } else if (query) {
        const found = entries.findIndex(e => e.searchText.includes(query));
        satisfied = found >= 0;
        detail = satisfied ? `元素 "${waitText}" 已出现(index=${found})` : '';
      }
      break;
    }
    case 'network_idle': {
      // 检查是否有 pending 网络请求
      const resources = performance.getEntriesByType('resource');
      const pending = resources.filter(r => !r.responseEnd);
      satisfied = pending.length === 0 && document.readyState === 'complete';
      detail = satisfied ? '网络空闲' : `${pending.length} 个请求进行中`;
      break;
    }
    case 'navigation': {
      satisfied = document.readyState === 'complete';
      if (satisfied) {
        // 额外等待网络空闲
        await new Promise(r => setTimeout(r, 500));
        satisfied = true;
      }
      detail = satisfied ? '页面已加载完成' : `readyState: ${document.readyState}`;
      break;
    }
    case 'timeout': {
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
      satisfied = true;
      detail = `等待 ${waitMs}ms`;
      break;
    }
    default: {
      resolve(JSON.stringify({ ok: false, action: 'wait', index: null, text: condition, url: String(location.href), message: `未知等待条件: ${condition}` }));
      return;
    }
  }

  if (satisfied) {
    resolve(JSON.stringify({ ok: true, action: 'wait', index: null, text: condition, url: String(location.href), message: `等待完成: ${detail}` }));
  } else {
    setTimeout(() => poll(resolve), 200);
  }
};

const initialUrl = String(location.href);
new Promise(poll).then(result => { /* return via eval callback */ });
```

**注意**: 由于 `eval_with_callback` 不支持异步脚本,需要改用 `setTimeout` 轮询模式。具体实现方式有两种:

**方案 A (推荐)**: 在 Rust 侧实现轮询,JS 脚本只做一次检查,由 Rust 循环调用 `browser_eval_with_app` 直到条件满足或超时。

```rust
pub async fn browser_wait_with_app(
    app: &AppHandle,
    label: &str,
    condition: &str,
    text: Option<&str>,
    index: Option<usize>,
    ms: Option<u64>,
    timeout_ms: Option<u64>,
) -> Result<BrowserInteractionResult> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    let poll_interval = Duration::from_millis(200);

    loop {
        let script = build_wait_check_script(condition, text, index, ms);
        let raw = browser_eval_with_app(app, label, &script, Some(3500)).await?;
        let value = parse_eval_json(&raw)?;
        let result: BrowserInteractionResult = serde_json::from_value(value)?;
        if result.ok {
            return Ok(result);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(result); // 返回最后一次的超时结果
        }
        tokio::time::sleep(poll_interval).await;
        // 检查 deadline
        if tokio::time::Instant::now() >= deadline {
            return Ok(BrowserInteractionResult {
                ok: false,
                action: "wait".to_string(),
                index: None,
                text: condition.to_string(),
                url: String::new(),
                message: format!("等待条件 '{condition}' 超时 ({}ms)", timeout_ms),
            });
        }
    }
}
```

**错误处理**:
- 未知 condition → 返回 `AppError::ValidationError`
- 超时 → 返回 `ok: false` 的 `BrowserInteractionResult`,message 包含超时信息
- WebView 断开 → `get_webview()` 的 `AppError`

**超时策略**:
- `text_appear` / `element_appear`: 默认 15s,最大 60s
- `network_idle` / `navigation`: 默认 30s,最大 120s
- `url_change`: 默认 15s,最大 30s

### 3.2 `browser_scroll`

#### 需求
AI 需要滚动页面到指定位置、元素或按指定偏移量滚动。当前只能在 click/fill 前隐式 `scrollIntoView`,无法独立控制滚动。

#### 设计

**Action 枚举值**: `"scroll"`

**滚动模式** (通过 `direction` 参数):

| mode | 描述 | 必填参数 |
|------|------|---------|
| `"to_element"` | 滚动到指定 index/text 的元素 | `index` 或 `text` |
| `"by"` | 按指定偏移量滚动 | `x` (px), `y` (px) |
| `"to"` | 滚动到指定位置 | `x` (px), `y` (px) |
| `"top"` | 滚动到页面顶部 | 无 |
| `"bottom"` | 滚动到页面底部 | 无 |
| `"up"` | 向上滚动一屏 | `amount` (可选,默认视口高度) |
| `"down"` | 向下滚动一屏 | `amount` (可选,默认视口高度) |
| `"left"` | 向左滚动(水平) | `amount` (可选) |
| `"right"` | 向右滚动(水平) | `amount` (可选) |

**Rust 函数签名**:

```rust
#[cfg(feature = "tauri-app")]
pub async fn browser_scroll_with_app(
    app: &AppHandle,
    label: &str,
    mode: &str,
    index: Option<usize>,
    text: Option<&str>,
    x: Option<f64>,
    y: Option<f64>,
    amount: Option<f64>,
) -> Result<BrowserInteractionResult>
```

**`#[tauri::command]`**:

```rust
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_scroll(
    app: AppHandle,
    label: String,
    mode: String,
    index: Option<usize>,
    text: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    amount: Option<f64>,
) -> Result<BrowserInteractionResult>
```

**JS 注入脚本** (`SCROLL_SCRIPT_BODY`):

```javascript
const scrollMode = '{{mode}}';
const scrollIndex = {{index}};
const scrollText = '{{text}}';
const scrollX = {{x}};
const scrollY = {{y}};
const scrollAmount = {{amount}};

const behavior = 'smooth';

try {
  switch (scrollMode) {
    case 'to_element':
    case 'to': {
      let target = null;
      if (Number.isInteger(scrollIndex) && scrollIndex >= 0) {
        const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 240 });
        target = entries[scrollIndex]?.element || null;
      }
      if (!target && scrollText) {
        const query = scrollText.toLowerCase();
        const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 240 });
        const idx = entries.findIndex(e => e.searchText.includes(query));
        if (idx >= 0) target = entries[idx].element;
      }
      if (target) {
        target.scrollIntoView({ behavior, block: 'center', inline: 'center' });
        target.focus({ preventScroll: true });
        return JSON.stringify({ ok: true, action: 'scroll', index: scrollIndex, text: scrollText || '', url: String(location.href), message: '已滚动到目标元素' });
      }
      if (scrollMode === 'to') {
        window.scrollTo({ left: scrollX || 0, top: scrollY || 0, behavior });
        return JSON.stringify({ ok: true, action: 'scroll', index: null, text: scrollMode, url: String(location.href), message: `已滚动到 (${scrollX || 0}, ${scrollY || 0})` });
      }
      return JSON.stringify({ ok: false, action: 'scroll', index: scrollIndex, text: scrollText || '', url: String(location.href), message: '未找到目标元素' });
    }
    case 'by':
      window.scrollBy({ left: scrollX || 0, top: scrollY || 0, behavior });
      return JSON.stringify({ ok: true, action: 'scroll', index: null, text: scrollMode, url: String(location.href), message: `已滚动偏移 (${scrollX || 0}, ${scrollY || 0})` });
    case 'top':
      window.scrollTo({ top: 0, behavior });
      return JSON.stringify({ ok: true, action: 'scroll', index: null, text: 'top', url: String(location.href), message: '已滚动到顶部' });
    case 'bottom':
      window.scrollTo({ top: document.body.scrollHeight, behavior });
      return JSON.stringify({ ok: true, action: 'scroll', index: null, text: 'bottom', url: String(location.href), message: '已滚动到底部' });
    case 'up': {
      const amt = scrollAmount || window.innerHeight;
      window.scrollBy({ top: -amt, behavior });
      return JSON.stringify({ ok: true, action: 'scroll', index: null, text: 'up', url: String(location.href), message: `已向上滚动 ${amt}px` });
    }
    case 'down': {
      const amt = scrollAmount || window.innerHeight;
      window.scrollBy({ top: amt, behavior });
      return JSON.stringify({ ok: true, action: 'scroll', index: null, text: 'down', url: String(location.href), message: `已向下滚动 ${amt}px` });
    }
    case 'left':
      window.scrollBy({ left: -(scrollAmount || window.innerWidth), behavior });
      return JSON.stringify({ ok: true, action: 'scroll', index: null, text: 'left', url: String(location.href), message: '已向左滚动' });
    case 'right':
      window.scrollBy({ left: scrollAmount || window.innerWidth, behavior });
      return JSON.stringify({ ok: true, action: 'scroll', index: null, text: 'right', url: String(location.href), message: '已向右滚动' });
    default:
      return JSON.stringify({ ok: false, action: 'scroll', index: null, text: scrollMode, url: String(location.href), message: `未知滚动模式: ${scrollMode}` });
  }
} catch (e) {
  return JSON.stringify({ ok: false, action: 'scroll', index: null, text: scrollMode, url: String(location.href), message: `滚动失败: ${e.message}` });
}
```

### 3.3 `browser_press_key`

#### 需求
AI 需要发送键盘快捷键(如 `Ctrl+S`, `Escape`, `Enter`, `Tab`),用于表单提交、对话框关闭、快捷键操作等。

#### 设计

**Action 枚举值**: `"press_key"`

**Rust 函数签名**:

```rust
#[cfg(feature = "tauri-app")]
pub async fn browser_press_key_with_app(
    app: &AppHandle,
    label: &str,
    keys: &str,         // 如 "Enter", "Control+S", "Escape", "Tab", "Control+Shift+R"
    index: Option<usize>, // 可选:先聚焦到指定元素再按键
    text: Option<&str>,
) -> Result<BrowserInteractionResult>
```

**`#[tauri::command]`**:

```rust
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_press_key(
    app: AppHandle,
    label: String,
    keys: String,
    index: Option<usize>,
    text: Option<String>,
) -> Result<BrowserInteractionResult>
```

**JS 注入脚本** (`PRESS_KEY_SCRIPT_BODY`):

```javascript
const requestedKeys = '{{keys}}';
const requestedIndex = {{index}};
const requestedText = '{{text}}';

try {
  // 如果指定了元素,先聚焦
  if (Number.isInteger(requestedIndex) && requestedIndex >= 0) {
    const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 240 });
    const entry = entries[requestedIndex];
    if (entry) {
      entry.element.scrollIntoView({ block: 'center', inline: 'center' });
      entry.element.focus({ preventScroll: true });
    }
  } else if (requestedText) {
    const query = requestedText.toLowerCase();
    const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 240 });
    const idx = entries.findIndex(e => e.searchText.includes(query));
    if (idx >= 0) {
      entries[idx].element.scrollIntoView({ block: 'center', inline: 'center' });
      entries[idx].element.focus({ preventScroll: true });
    }
  }

  // 解析组合键
  const parts = requestedKeys.split('+').map(p => p.trim());
  const modifiers = {
    ctrlKey: parts.some(p => /^control$/i.test(p) || /^ctrl$/i.test(p)),
    shiftKey: parts.some(p => /^shift$/i.test(p)),
    altKey: parts.some(p => /^alt$/i.test(p) || /^option$/i.test(p)),
    metaKey: parts.some(p => /^meta$/i.test(p) || /^command$/i.test(p) || /^cmd$/i.test(p) || /^win$/i.test(p)),
  };
  const key = parts.find(p => !/^(control|ctrl|shift|alt|option|meta|command|cmd|win)$/i.test(p)) || '';

  const keyMap = {
    'enter': 'Enter', 'escape': 'Escape', 'esc': 'Escape', 'tab': 'Tab',
    'backspace': 'Backspace', 'delete': 'Delete', 'del': 'Delete',
    'space': ' ', ' ': ' ',
    'arrowup': 'ArrowUp', 'arrowdown': 'ArrowDown', 'arrowleft': 'ArrowLeft', 'arrowright': 'ArrowRight',
    'up': 'ArrowUp', 'down': 'ArrowDown', 'left': 'ArrowLeft', 'right': 'ArrowRight',
    'home': 'Home', 'end': 'End', 'pageup': 'PageUp', 'pagedown': 'PageDown',
    'insert': 'Insert',
    'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4', 'f5': 'F5', 'f6': 'F6',
    'f7': 'F7', 'f8': 'F8', 'f9': 'F9', 'f10': 'F10', 'f11': 'F11', 'f12': 'F12',
  };
  const resolvedKey = keyMap[key.toLowerCase()] || key;

  const activeEl = document.activeElement || document.body;
  const view = ownerWindowOf(activeEl);

  // 构造并派发 keydown
  const eventOpts = {
    bubbles: true,
    cancelable: true,
    view,
    key: resolvedKey,
    code: resolvedKey,
    ...modifiers,
    repeat: false,
    composed: true,
  };

  // keydown
  const keydownEvent = new KeyboardEvent('keydown', eventOpts);
  const keydownCancelled = !activeEl.dispatchEvent(keydownEvent);

  // keypress (非修饰键)
  let keypressCancelled = false;
  if (resolvedKey.length === 1 && !modifiers.ctrlKey && !modifiers.altKey && !modifiers.metaKey) {
    const keypressEvent = new KeyboardEvent('keypress', { ...eventOpts, charCode: resolvedKey.charCodeAt(0) });
    keypressCancelled = !activeEl.dispatchEvent(keypressEvent);
  }

  // 如果是文本输入,注入字符
  if (!keydownCancelled && resolvedKey.length === 1) {
    const target = activeEl;
    if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      const start = target.selectionStart || target.value?.length || 0;
      const end = target.selectionEnd || start;
      const newValue = (target.value || '').slice(0, start) + resolvedKey + (target.value || '').slice(end);
      // 需要 setNativeValue 来触发 React 响应
      const prototype = target instanceof view.HTMLTextAreaElement
        ? view.HTMLTextAreaElement.prototype
        : view.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor?.set) descriptor.set.call(target, newValue);
      else target.value = newValue;
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: resolvedKey }));
    }
  }

  // keyup
  const keyupEvent = new KeyboardEvent('keyup', eventOpts);
  activeEl.dispatchEvent(keyupEvent);

  return JSON.stringify({ ok: true, action: 'press_key', index: requestedIndex, text: requestedKeys, url: String(location.href), message: `已发送按键: ${requestedKeys}` });
} catch (e) {
  return JSON.stringify({ ok: false, action: 'press_key', index: requestedIndex, text: requestedKeys, url: String(location.href), message: `按键失败: ${e.message}` });
}
```

**按键映射表** (在 Rust 侧实现,用于验证):

```rust
const VALID_KEYS: &[&str] = &[
    "Enter", "Escape", "Tab", "Backspace", "Delete", "Space",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Home", "End", "PageUp", "PageDown", "Insert",
    "F1", "F2", "F3", "F4", "F5", "F6",
    "F7", "F8", "F9", "F10", "F11", "F12",
    "Control", "Shift", "Alt", "Meta",
];

fn validate_keys(keys: &str) -> Result<()> {
    // 允许组合键: Control+S, Control+Shift+R, Alt+F4 等
    // 至少一个非修饰键
    // 不允许单独修饰键 (Control 单独发无意义)
}
```

### 3.4 `browser_type_text`

#### 需求
AI 需要在聚焦的输入框上逐字输入文本,触发完整的 keydown/keypress/input/keyup 事件链,以支持富文本编辑器、受控组件、自动完成等场景。与 `fill` 的区别: `fill` 一次设置 value,`type_text` 逐字模拟用户输入。

#### 设计

**Action 枚举值**: `"type_text"`

**Rust 函数签名**:

```rust
#[cfg(feature = "tauri-app")]
pub async fn browser_type_text_with_app(
    app: &AppHandle,
    label: &str,
    text: &str,
    index: Option<usize>,
    element_text: Option<&str>,
    delay_ms: Option<u64>,
) -> Result<BrowserInteractionResult>
```

**`#[tauri::command]`**:

```rust
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_type_text(
    app: AppHandle,
    label: String,
    text: String,
    index: Option<usize>,
    element_text: Option<String>,
    delay_ms: Option<u64>,
) -> Result<BrowserInteractionResult>
```

**JS 注入脚本** (`TYPE_TEXT_SCRIPT_BODY`):

```javascript
const typeValue = '{{text}}';
const requestedIndex = {{index}};
const requestedText = '{{elementText}}';
const typeDelay = {{delayMs}};

try {
  // 查找目标元素
  let target = document.activeElement;
  if (Number.isInteger(requestedIndex) && requestedIndex >= 0) {
    const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 240 });
    const entry = entries[requestedIndex];
    if (entry) target = entry.element;
  } else if (requestedText) {
    const query = requestedText.toLowerCase();
    const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 240 });
    const idx = entries.findIndex(e => e.searchText.includes(query));
    if (idx >= 0) target = entries[idx].element;
  }

  if (!target || !(target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
    // 如果没找到目标,尝试 fallback 到当前 activeElement
    if (!document.activeElement || (!document.activeElement.isContentEditable && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA')) {
      return JSON.stringify({ ok: false, action: 'type_text', index: requestedIndex, text: typeValue, url: String(location.href), message: '没有可输入的聚焦元素' });
    }
    target = document.activeElement;
  }

  target.scrollIntoView({ block: 'center', inline: 'center' });
  target.focus({ preventScroll: true });
  target.select();

  const view = ownerWindowOf(target);

  // 逐个字符输入
  for (const char of typeValue) {
    const key = char;

    // keydown
    const keydownEvent = new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, view, key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
      repeat: false, composed: true,
    });
    const cancelled = !target.dispatchEvent(keydownEvent);

    // keypress
    if (key.length === 1) {
      target.dispatchEvent(new KeyboardEvent('keypress', {
        bubbles: true, cancelable: true, view, key, charCode: key.charCodeAt(0),
        ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
      }));
    }

    // 修改值
    if (!cancelled && key.length === 1) {
      if (target.isContentEditable) {
        const sel = view.getSelection();
        if (sel && sel.rangeCount) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(key));
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          target.textContent = (target.textContent || '') + key;
        }
      } else {
        const start = target.selectionStart ?? target.value?.length ?? 0;
        const end = target.selectionEnd ?? start;
        const newValue = (target.value || '').slice(0, start) + key + (target.value || '').slice(end);
        const prototype = target instanceof view.HTMLTextAreaElement
          ? view.HTMLTextAreaElement.prototype
          : view.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor?.set) descriptor.set.call(target, newValue);
        else target.value = newValue;
        target.setSelectionRange(start + 1, start + 1);
      }
    }

    // input event
    target.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: key,
    }));

    // keyup
    target.dispatchEvent(new KeyboardEvent('keyup', {
      bubbles: true, cancelable: true, view, key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
      composed: true,
    }));

    // 字符间延迟
    if (typeDelay > 0) {
      await new Promise(r => setTimeout(r, typeDelay));
    }
  }

  // 最终 change 事件
  target.dispatchEvent(new Event('change', { bubbles: true }));

  return JSON.stringify({ ok: true, action: 'type_text', index: requestedIndex, text: typeValue, url: String(location.href), message: `已逐字输入 ${typeValue.length} 个字符` });
} catch (e) {
  return JSON.stringify({ ok: false, action: 'type_text', index: requestedIndex, text: typeValue, url: String(location.href), message: `输入失败: ${e.message}` });
}
```

**关于延迟**: 由于 `eval_with_callback` 是同步求值,`typeDelay` 的实现需要另作处理:

- **方案 A (推荐)**: 延迟在 Rust 侧实现,JS 脚本只生成事件序列,Rust 在每个字符间插入 `tokio::time::sleep`
- **方案 B**: 如果 `type_text` 场景不需要延迟,直接使用 `Promise.resolve().then()` 链,但 `eval_with_callback` 不支持异步返回

推荐方案 A——将脚本拆分为"单字符输入"函数,Rust 循环调用:

```rust
pub async fn browser_type_text_with_app(
    app: &AppHandle,
    label: &str,
    text: &str,
    index: Option<usize>,
    element_text: Option<&str>,
    delay_ms: Option<u64>,
) -> Result<BrowserInteractionResult> {
    let delay = delay_ms.unwrap_or(10).min(200);
    // 第一步:聚焦目标元素
    let focus_script = build_focus_script(index, element_text);
    browser_eval_with_app(app, label, &focus_script, Some(3500)).await?;

    // 逐字符输入
    for ch in text.chars() {
        let char_script = build_type_char_script(ch);
        browser_eval_with_app(app, label, &char_script, Some(2000)).await?;
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
    }

    // 触发 change
    browser_eval_with_app(app, label, CHANGE_EVENT_SCRIPT, Some(2000)).await?;

    Ok(BrowserInteractionResult {
        ok: true,
        action: "type_text".to_string(),
        index,
        text: text.to_string(),
        url: String::new(),
        message: format!("已逐字输入 {} 个字符", text.len()),
    })
}
```

---

## 4. 现有操作增强

### 4.1 Click 增加 mousemove 事件链

#### 问题
当前 click 事件链: `pointerdown → mousedown → pointerup → mouseup → click`  
缺少 `mousemove` 和 `pointermove`,导致:
- `mouseenter` 事件不会触发(antd Dropdown、hover 菜单等)
- 依赖 `mouseover` 的 UI 状态更新失败
- 部分前端框架检测鼠标位置变化来优化交互

#### 修改方案

在 `CLICK_ELEMENT_SCRIPT_BODY` 的 `dispatchPointer`/`dispatchMouse` 之前增加 `mousemove`:

```javascript
// 在 dispatchPointer('pointerdown') 之前插入:
// 先移动到目标元素的附近(模拟真实鼠标移动轨迹)
const moveSteps = 3;
for (let step = 1; step <= moveSteps; step++) {
  const t = step / moveSteps;
  const prevX = clientX - (1 - t) * 30; // 从左侧 30px 移入
  const prevY = clientY;
  try {
    target.dispatchEvent(new view.PointerEvent('pointermove', {
      bubbles: true, cancelable: true, pointerType: 'mouse',
      clientX: prevX, clientY: prevY, button: 0, buttons: 0, view,
    }));
    target.dispatchEvent(new view.MouseEvent('mousemove', {
      bubbles: true, cancelable: true, view,
      clientX: prevX, clientY: prevY, button: 0, buttons: 0,
    }));
  } catch {}
}

// 鼠标进入目标
try {
  target.dispatchEvent(new view.PointerEvent('pointermove', {
    bubbles: true, cancelable: true, pointerType: 'mouse',
    clientX, clientY, button: 0, buttons: 0, view,
  }));
  target.dispatchEvent(new view.MouseEvent('mousemove', {
    bubbles: true, cancelable: true, view,
    clientX, clientY, button: 0, buttons: 0,
  }));
  target.dispatchEvent(new view.MouseEvent('mouseover', {
    bubbles: true, cancelable: true, view,
    clientX, clientY, button: 0, buttons: 0,
  }));
  target.dispatchEvent(new view.MouseEvent('mouseenter', {
    bubbles: false, cancelable: true, view,
    clientX, clientY, button: 0, buttons: 0,
  }));
} catch {}

// 然后继续原有的 pointerdown → mousedown → pointerup → mouseup → click
dispatchPointer('pointerdown');
dispatchMouse('mousedown');
dispatchPointer('pointerup');
dispatchMouse('mouseup');
// ...
```

#### 完整事件链 (修改后)

```
pointermove(×3) → mousemove(×3) → pointermove(目标) → mousemove(目标) → mouseover → mouseenter → pointerdown → mousedown → pointerup → mouseup → click
```

### 4.2 Fill 对 select 的精确选项匹配

#### 问题
当前模糊匹配 `clean(option.textContent).includes(fillValue)` 过于宽松,如 `"选项1"` 会匹配 `"选项10"`。

#### 修改方案

将 `FILL_ELEMENT_SCRIPT_BODY` 中的 select 处理改为精确匹配优先、降级模糊:

```javascript
// 替换原有逻辑:
// const option = Array.from(target.options).find((item) => item.value === fillValue || clean(item.textContent).includes(fillValue));

// 新逻辑:
const option = (() => {
  const options = Array.from(target.options);
  // 1. 精确 value 匹配
  let match = options.find(o => o.value === fillValue);
  if (match) return match;
  // 2. 精确 textContent 匹配
  match = options.find(o => clean(o.textContent) === fillValue);
  if (match) return match;
  // 3. 精确 textContent 前缀匹配 (按长度降序,避免短前缀误匹配)
  const textMatches = options
    .map(o => ({ option: o, text: clean(o.textContent) }))
    .filter(({ text }) => text.startsWith(fillValue) || text.includes(` ${fillValue}`) || text.includes(fillValue));
  // 取最长匹配文本的选项 (最精确)
  textMatches.sort((a, b) => b.text.length - a.text.length);
  if (textMatches.length > 0) return textMatches[0].option;
  // 4. includes 模糊匹配 (最后降级)
  match = options.find(o => clean(o.textContent).includes(fillValue));
  return match || null;
})();
```

#### 对 `<select multiple>` 的支持

```javascript
if (tagOf(target) === 'select' && target.multiple) {
  // 清除所有选中
  Array.from(target.options).forEach(o => o.selected = false);
  // 选择匹配的选项
  const selectedOptions = fillValue.split(',').map(v => v.trim()).filter(Boolean);
  for (const val of selectedOptions) {
    const opt = findOption(target, val);
    if (opt) opt.selected = true;
  }
  setNativeValue(target, Array.from(target.selectedOptions).map(o => o.value).join(','));
} else if (tagOf(target) === 'select') {
  const opt = findOption(target, fillValue);
  setNativeValue(target, opt ? opt.value : fillValue);
}
```

### 4.3 跨域 iframe 标注方案

#### 问题
当前 `collectRoots()` 中 `try { node.contentDocument } catch {}` 静默跳过跨域 iframe,AI 无法感知到这些被隔离的区域。

#### 修改方案

在 `collectPolarisInteractiveElements` 中增加对跨域 iframe 的标注:

```javascript
// 在遍历 iframe 时:
if (tagOf(node) === 'iframe') {
  let crossOrigin = false;
  try {
    const doc = node.contentDocument;
    if (doc) {
      const frameRect = node.getBoundingClientRect();
      visit(doc, { x: offset.x + frameRect.left, y: offset.y + frameRect.top }, depth + 1, frames.concat(node));
    }
  } catch (e) {
    // 跨域 iframe,无法访问 contentDocument
    crossOrigin = true;
  }
  if (crossOrigin) {
    // 添加一个占位条目,告知 AI 此处有隔离内容
    const frameRect = node.getBoundingClientRect();
    if (frameRect.width > 0 && frameRect.height > 0) {
      candidates.push({
        element: node,
        rect: { ...frameRect, left: frameRect.left + offset.x, top: frameRect.top + offset.y },
        label: `[跨域隔离] ${node.src || node.getAttribute('srcdoc') || 'iframe'}`,
        searchText: `[cross-origin iframe] ${node.src || ''}`.toLowerCase(),
        kind: 'cross-origin-iframe',
        value: '',
        placeholder: '',
        href: node.src || '',
        disabled: false,
        fillable: false,
        frames: [],
        score: 0,
        order: order++,
        crossOrigin: true,
      });
    }
  }
}
```

对应的 `BrowserInteractiveElement` 结构体需要新增 `crossOrigin` 字段:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInteractiveElement {
    pub index: usize,
    // ... 现有字段 ...
    #[serde(default)]
    pub cross_origin: bool,
}
```

---

## 5. 截图跨平台方案

### 5.1 当前实现

```rust
// Windows (browser.rs:1028-1071)
#[cfg(all(feature = "tauri-app", windows))]
fn capture_browser_screenshot(...) -> Result<Option<BrowserScreenshot>> {
    // 使用 computer_control::ComputerController 截图
    // 需要: 窗口位置 + 缩放因子 + 浏览器 bounds
}

// 非 Windows (browser.rs:1073-1080)
#[cfg(all(feature = "tauri-app", not(windows)))]
fn capture_browser_screenshot(...) -> Result<Option<BrowserScreenshot>> {
    Ok(None) // 直接返回 None
}
```

### 5.2 方案选择

#### 方案 A: 基于 WebView 的 HTML2Canvas (推荐)

利用 Tauri WebView 的 `eval` 能力,在页面中注入 HTML2Canvas 或类似库来截图:

```rust
#[cfg(all(feature = "tauri-app", not(windows)))]
fn capture_browser_screenshot(
    app: &AppHandle,
    label: &str,
    scale: f32,
) -> Result<Option<BrowserScreenshot>> {
    let script = r#"
        (() => {
            try {
                const canvas = document.createElement('canvas');
                const scale = 2; // 2x 清晰度
                canvas.width = window.innerWidth * scale;
                canvas.height = window.innerHeight * scale;
                const ctx = canvas.getContext('2d');
                ctx.scale(scale, scale);
                ctx.drawWindow(window, 0, 0, window.innerWidth, window.innerHeight, 'rgb(255,255,255)');
                const dataUrl = canvas.toDataURL('image/png');
                canvas.remove();
                return JSON.stringify({ ok: true, data: dataUrl });
            } catch(e) {
                return JSON.stringify({ ok: false, error: e.message });
            }
        })()
    "#;
    // 注意: drawWindow 是 Firefox 专用 API。
    // 跨浏览器方案需要注入 html2canvas 脚本
    // ...
}
```

**问题**: `drawWindow` 是 Firefox 专用 API,在 Tauri 的 WebView (WebKit) 上不可用。

#### 方案 B: WebKit 原生截图 API (推荐)

Tauri 的 WebView 在 macOS 上使用 WKWebView,支持 `takeSnapshot`:

```rust
#[cfg(all(feature = "tauri-app", not(windows)))]
fn capture_browser_screenshot(
    app: &AppHandle,
    label: &str,
    scale: f32,
) -> Result<Option<BrowserScreenshot>> {
    let webview = get_webview(app, label)?;
    // 使用 tauri-webview 的截图 API
    // macOS: WKWebView.takeSnapshot(configuration:)
    // Linux: WebKitWebView 的 snapshot 功能
    let snapshot = webview.screenshot(true, 1.0)?; // 假设有此 API
    // ...
}
```

**需要确认**: Tauri 的 `Webview` 在 2.x 版本中是否有 `screenshot` 方法。如果原生 API 不可用:

#### 方案 C: 跨平台通用方案 — 全窗口截图 + 裁剪

```rust
#[cfg(all(feature = "tauri-app", not(windows)))]
fn capture_browser_screenshot(
    app: &AppHandle,
    label: &str,
    scale: f32,
) -> Result<Option<BrowserScreenshot>> {
    let Some(bounds) = browser_bounds(label)? else {
        return Err(AppError::ValidationError("缺少浏览器位置".to_string()));
    };

    let config = crate::services::computer_control::ComputerConfig::from_env();
    let controller = crate::services::computer_control::ComputerController::new(config)?;

    // 获取主窗口位置
    let window = app.get_window("main")
        .ok_or_else(|| AppError::ValidationError("主窗口不存在".to_string()))?;
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let position = window.outer_position()
        .map_err(|e| AppError::ProcessError(format!("读取窗口位置失败: {e}")))?;

    let x = ((position.x as f64) + bounds.x * scale_factor).round().max(0.0) as u32;
    let y = ((position.y as f64) + bounds.y * scale_factor).round().max(0.0) as u32;
    let width = (bounds.width * scale_factor).round().max(1.0) as u32;
    let height = (bounds.height * scale_factor).round().max(1.0) as u32;

    let shot = controller.screenshot(Some(0), Some((x, y, width, height)), Some(scale))?;
    Ok(Some(BrowserScreenshot {
        mime_type: "image/png".to_string(),
        data: shot.png_base64,
        width: shot.width,
        height: shot.height,
        scale,
    }))
}
```

**关键**: `computer_control` 的后端实现当前仅支持 Windows (xcap/enigo)。macOS 和 Linux 需要额外的后端实现。

#### 推荐方案

**短期 (P1)**: 移除 `#[cfg(not(windows))]` 门控,让 `computer_control` 在所有平台上尝试截图。如果截图后端在当前平台不可用,返回 `Ok(None)` 和 `screenshot_error` 消息,而不是直接编译为 `Ok(None)`。

```rust
#[cfg(feature = "tauri-app")]
fn capture_browser_screenshot(
    app: &AppHandle,
    label: &str,
    scale: f32,
) -> Result<Option<BrowserScreenshot>> {
    let Some(bounds) = browser_bounds(label)? else {
        return Err(AppError::ValidationError("缺少浏览器位置".to_string()));
    };
    // ... 统一逻辑,computer_control 内部处理平台差异 ...
    match try_capture(app, bounds, scale) {
        Ok(shot) => Ok(Some(shot)),
        Err(e) => {
            tracing::warn!("截图失败(平台可能不支持): {}", e);
            Ok(None) // 不阻止 diagnostics,只返回 screenshot_error
        }
    }
}
```

**长期 (P2)**: 为 `computer_control` 增加 macOS (CGDisplayStream/screencapture) 和 Linux (X11/screencapture) 后端。

---

## 6. MCP 桥接影响

### 6.1 当前 MCP 桥接流程

`browser_mcp_server.rs` 中的 `handle_tools_call()`:
1. `tool_name_to_action(name)` → action 字符串
2. `browser_frame(config, action, &args)` → 构建 JSON frame
3. `request_browser_via_tcp(config.port, &frame)` → TCP 发送到 ask_listener
4. ask_listener 解析 frame → `dispatch_browser_frame(frame)` → 调用 `browser_*_with_app()`

### 6.2 新增操作需要同步的变更

**browser_mcp_server.rs**:

```rust
fn tool_name_to_action(name: &str) -> Result<&'static str> {
    match name {
        "browser_list" => Ok("list"),
        // ... 现有映射 ...
        "browser_wait" => Ok("wait"),
        "browser_scroll" => Ok("scroll"),
        "browser_press_key" => Ok("press_key"),
        "browser_type_text" => Ok("type_text"),
        other => Err(...)
    }
}
```

**MCP tool schemas** (新增):

```javascript
// browser_wait
{
    "name": "browser_wait",
    "description": "Wait for a condition in the built-in browser (text appearance, element, network idle, etc.)",
    "inputSchema": {
        "type": "object",
        "required": ["condition"],
        "properties": {
            "label": label_property,
            "condition": {
                "type": "string",
                "enum": ["url_change", "text_appear", "element_appear", "network_idle", "navigation", "timeout"],
                "description": "Wait condition type"
            },
            "text": { "type": "string", "description": "Text to wait for (text_appear/element_appear)" },
            "index": { "type": "integer", "description": "Element index to wait for (element_appear)" },
            "ms": { "type": "integer", "description": "Fixed delay in ms (timeout mode)" },
            "timeoutMs": { "type": "integer", "description": "Maximum wait time in ms (default: 15000)" }
        }
    }
}

// browser_scroll
{
    "name": "browser_scroll",
    "description": "Scroll the built-in browser page to a position, element, or direction",
    "inputSchema": {
        "type": "object",
        "required": ["mode"],
        "properties": {
            "label": label_property,
            "mode": {
                "type": "string",
                "enum": ["to_element", "by", "to", "top", "bottom", "up", "down", "left", "right"]
            },
            "index": index_property,
            "text": text_property,
            "x": { "type": "number", "description": "X scroll offset or position (px)" },
            "y": { "type": "number", "description": "Y scroll offset or position (px)" },
            "amount": { "type": "number", "description": "Scroll amount (px), defaults to viewport height" }
        }
    }
}

// browser_press_key
{
    "name": "browser_press_key",
    "description": "Send keyboard shortcut to the built-in browser. Supports combinations like 'Control+S', 'Escape', 'Tab'",
    "inputSchema": {
        "type": "object",
        "required": ["keys"],
        "properties": {
            "label": label_property,
            "keys": {
                "type": "string",
                "description": "Key combination: 'Enter', 'Escape', 'Tab', 'Control+S', 'Control+Shift+R', 'Alt+F4', 'ArrowDown', 'F5'"
            },
            "index": index_property,
            "text": text_property
        }
    }
}

// browser_type_text
{
    "name": "browser_type_text",
    "description": "Type text character by character into the focused element. Unlike browser_fill which sets value directly, this simulates real keyboard input with keydown/keypress/input/keyup events.",
    "inputSchema": {
        "type": "object",
        "required": ["text"],
        "properties": {
            "label": label_property,
            "text": { "type": "string", "description": "Text to type character by character" },
            "index": index_property,
            "elementText": text_property,
            "delayMs": { "type": "integer", "description": "Delay between keystrokes (ms), default 10" }
        }
    }
}
```

### 6.3 前端 `browserService.ts` 新增函数

```typescript
export interface BrowserWaitOptions {
  condition: 'url_change' | 'text_appear' | 'element_appear' | 'network_idle' | 'navigation' | 'timeout'
  text?: string | null
  index?: number | null
  ms?: number | null
  timeoutMs?: number | null
}

export async function browserWait(
  label: string,
  options: BrowserWaitOptions
): Promise<BrowserInteractionResult> {
  return invoke<BrowserInteractionResult>('browser_wait', {
    label,
    condition: options.condition,
    text: options.text,
    index: options.index,
    ms: options.ms,
    timeoutMs: options.timeoutMs,
  })
}

export async function browserScroll(
  label: string,
  mode: 'to_element' | 'by' | 'to' | 'top' | 'bottom' | 'up' | 'down' | 'left' | 'right',
  options?: {
    index?: number
    text?: string
    x?: number
    y?: number
    amount?: number
  }
): Promise<BrowserInteractionResult> {
  return invoke<BrowserInteractionResult>('browser_scroll', {
    label,
    mode,
    ...options,
  })
}

export async function browserPressKey(
  label: string,
  keys: string,
  options?: { index?: number; text?: string }
): Promise<BrowserInteractionResult> {
  return invoke<BrowserInteractionResult>('browser_press_key', {
    label,
    keys,
    ...options,
  })
}

export async function browserTypeText(
  label: string,
  text: string,
  options?: { index?: number; elementText?: string; delayMs?: number }
): Promise<BrowserInteractionResult> {
  return invoke<BrowserInteractionResult>('browser_type_text', {
    label,
    text,
    ...options,
  })
}
```

---

## 7. 前端 API 同步

### 7.1 `browserService.ts` 新增接口

新增接口如 6.3 节所示。现有的 `BrowserInteractionResult` 接口可复用:

```typescript
export interface BrowserInteractionResult {
  ok: boolean
  action: string
  index: number | null
  text: string
  url: string
  message: string
}
```

同时需要新增 `crossOrigin` 字段到 `BrowserInteractiveElement`:

```typescript
export interface BrowserInteractiveElement {
  index: number
  kind: string
  text: string
  value: string
  placeholder: string
  href: string
  disabled: boolean
  fillable: boolean
  crossOrigin?: boolean  // 新增
}
```

### 7.2 Tauri 命令注册

所有新命令都需要在 `browser.rs` 末尾添加 `#[tauri::command]` 函数,并在主命令注册表中注册:

```rust
// 在 browser.rs 末尾添加
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_wait(
    app: AppHandle,
    label: String,
    condition: String,
    // ...
) -> Result<BrowserInteractionResult> {
    browser_wait_with_app(&app, &label, &condition, ...).await
}
```

命令注册位置 (在 `main.rs` 或 `lib.rs` 中):

```rust
.invoke_handler(tauri::generate_handler![
    browser_register,
    browser_create,
    browser_navigate,
    // ...
    browser_wait,        // 新增
    browser_scroll,      // 新增
    browser_press_key,   // 新增
    browser_type_text,   // 新增
])
```

### 7.3 SimpleAI tool spec 更新

在 `simple_ai/tools/browser.rs` 的 `spec()` 方法中,action enum 增加:

```rust
"action": {
    "type": "string",
    "enum": [
        "list", "acquire", "navigate", "context", "diagnostics",
        "inspect", "click", "fill", "reload", "back", "forward",
        "wait", "scroll", "press_key", "type_text"  // 新增
    ]
},
```

同时在 `run()` 的 match 块中增加对应的 arm:

```rust
"wait" => { ... }
"scroll" => { ... }
"press_key" => { ... }
"type_text" => { ... }
```

### 7.4 ask_listener 帧分派更新

在 `dispatch_browser_frame()` 的 match 块中增加:

```rust
"wait" => {
    let result = browser_wait_with_app(&app, &label, ...).await?;
    serde_json::to_value(result).map_err(Into::into)
}
"scroll" => { ... }
"press_key" => { ... }
"type_text" => { ... }
```

---

## 8. 测试用例

### 8.1 Rust 单元测试

```rust
#[cfg(test)]
mod browser_automation_tests {
    use super::*;

    // --- 脚本编译测试 ---
    #[test]
    fn wait_script_contains_all_conditions() {
        // 验证 wait 脚本覆盖所有条件分支
    }

    #[test]
    fn scroll_script_contains_all_modes() {
        // 验证 scroll 脚本覆盖所有模式
    }

    #[test]
    fn press_key_script_handles_modifier_combinations() {
        // 验证 press_key 能正确解析组合键
    }

    #[test]
    fn type_text_script_contains_event_sequence() {
        // 验证 type_text 包含 keydown/keypress/input/keyup 序列
    }

    // --- 按键验证 ---
    #[test]
    fn validate_keys_accepts_valid_combinations() {
        assert!(validate_keys("Enter").is_ok());
        assert!(validate_keys("Control+S").is_ok());
        assert!(validate_keys("Control+Shift+R").is_ok());
        assert!(validate_keys("Alt+F4").is_ok());
    }

    #[test]
    fn validate_keys_rejects_invalid_combinations() {
        assert!(validate_keys("").is_err());
        assert!(validate_keys("InvalidKey+123").is_err());
    }

    // --- wait 参数验证 ---
    #[test]
    fn wait_condition_rejects_unknown() {
        // verify_normalize_condition
    }
}
```

### 8.2 集成测试

| 测试场景 | 操作序列 | 预期结果 |
|---------|---------|---------|
| SPA 导航等待 | navigate → wait(url_change) → context | 页面 URL 已更新 |
| 文本出现等待 | navigate → wait(text_appear, "登录") | 页面包含"登录"文本 |
| 元素出现等待 | navigate → wait(element_appear, index=3) | 元素 index 3 可交互 |
| 滚动到元素 | scroll(to_element, text="提交") | 元素在视口中 |
| 键盘快捷键 | press_key("Escape") | 弹窗关闭 |
| 逐字输入 | type_text("hello", index=0) | 输入框显示 "hello" |
| 跨域 iframe 标注 | inspect | 跨域 iframe 有 `crossOrigin: true` |
| 增强 click | click(index=0) | 触发 mouseenter/mouseover |

### 8.3 前端测试 (Vitest)

```typescript
describe('browserService new APIs', () => {
  it('browserWait builds correct invoke payload', async () => {
    // 验证 invoke 参数
  })
  it('browserScroll builds correct invoke payload', async () => {
    // 验证各种 mode 参数
  })
  it('browserPressKey builds correct invoke payload', async () => {
    // 验证 keys 参数
  })
  it('browserTypeText builds correct invoke payload', async () => {
    // 验证 text 参数
  })
})
```

---

## 9. 实施优先级

### P0 (核心缺失,影响 AI 自动化成功率)

| 操作 | 优先级理由 | 预估工作量 |
|------|-----------|-----------|
| `browser_wait` (text_appear/element_appear) | SPA 页面加载后无法等待元素,AI 自动化几乎不可用 | 1.5 人日 |
| Click 增加 mousemove 事件链 | antd Dropdown 等主流 UI 库无法操作 | 0.5 人日 |
| `browser_type_text` | 受控组件/富文本编辑器无法精确输入 | 1.5 人日 |

### P1 (重要增强,提升交互成功率)

| 操作 | 优先级理由 | 预估工作量 |
|------|-----------|-----------|
| `browser_scroll` | 长页面/无限滚动页面无法浏览 | 1 人日 |
| `browser_press_key` | 无法发送 Escape/Tab/Enter 等关键键 | 1 人日 |
| Fill select 精确匹配 | 下拉选择错误率降低 | 0.5 人日 |
| 截图跨平台 (移除 `#[cfg(not(windows))]` 门控) | macOS/Linux 用户无截图能力 | 0.5 人日 |
| MCP 桥接同步 (4 个新操作) | 确保 MCP 客户端可用 | 0.5 人日 |

### P2 (完善性/质量)

| 操作 | 优先级理由 | 预估工作量 |
|------|-----------|-----------|
| `browser_wait` (network_idle/navigation) | 更精确的等待条件 | 1 人日 |
| 跨域 iframe 标注 | 提示 AI 有隔离区域,减少猜测 | 0.5 人日 |
| `computer_control` macOS/Linux 截图后端 | 完整跨平台截图支持 | 2 人日 |
| SimpleAI tool spec 更新 | AI 模型可感知新操作 | 0.5 人日 |
| 前端 browserService.ts 同步 | 前端可调用新操作 | 0.5 人日 |
| 测试用例 | 自动化回归保障 | 1 人日 |

### 实施顺序建议

```
Phase 1 (P0, ~3.5 人日):
  └─ Click mousemove 事件链 (+0.5d)
  └─ browser_wait (text_appear/element_appear) (+1.5d)
  └─ browser_type_text (+1.5d)

Phase 2 (P1, ~3.5 人日):
  └─ browser_scroll (+1d)
  └─ browser_press_key (+1d)
  └─ Fill select 精确匹配 (+0.5d)
  └─ 截图跨平台门控移除 (+0.5d)
  └─ MCP 桥接同步 (+0.5d)

Phase 3 (P2, ~5 人日):
  └─ browser_wait network_idle/navigation (+1d)
  └─ 跨域 iframe 标注 (+0.5d)
  └─ computer_control macOS/Linux 后端 (+2d)
  └─ SimpleAI tool spec + 前端 + 测试 (+1.5d)
```

---

## 附录: 关键代码位置索引

| 位置 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 核心命令 | `src-tauri/src/commands/browser.rs` | 1-2354 | 浏览器控制全部逻辑 |
| JS 脚本: click | 同上 | 1945-1995 | CLICK_ELEMENT_SCRIPT_BODY |
| JS 脚本: fill | 同上 | 1997-2049 | FILL_ELEMENT_SCRIPT_BODY |
| JS 脚本: context | 同上 | 1405-1442 | PAGE_CONTEXT_SCRIPT |
| JS 脚本: collector | 同上 | 1444- | polaris_interactive_collector_script! |
| JS 脚本: diagnostics | 同上 | 1926- | DIAGNOSTICS_SCRIPT_BODY |
| eval 执行器 | 同上 | 833-859 | browser_eval_with_app |
| 截图(Windows) | 同上 | 1028-1071 | capture_browser_screenshot |
| 截图(fallback) | 同上 | 1073-1080 | 非 Windows 空实现 |
| tauri::command 注册 | 同上 | 1227-1402 | 所有命令入口 |
| 前端服务 | `src/services/tauri/browserService.ts` | 1-241 | TS 封装 |
| SimpleAI 工具 | `src-tauri/src/ai/engine/simple_ai/tools/browser.rs` | 1-311 | BrowserTool |
| MCP 服务器 | `src-tauri/src/services/browser_mcp_server.rs` | 1- | 工具名称→action 映射 |
| ask_listener 分派 | `src-tauri/src/services/ask_listener.rs` | 1317- | dispatch_browser_frame |