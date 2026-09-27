# 内置浏览器最小化恢复后刷新问题 — 攻坚分析

> 日期：2026-09-27
> 状态：路径 A 修复已实施（方案 1a），待验证；路径 G 待实施

## 问题现象

应用最小化后重新打开，内置浏览器打开的网页会重新刷新（丢失浏览状态：滚动位置、表单输入、SPA 路由等）。

## 架构背景

内置浏览器**不是** HTML `<iframe>`，而是通过 Tauri 创建的 **OS 级原生 WebView2 子窗口**（`host_window.add_child`）。它与 React 组件树解耦——React 只负责通过 IPC 同步 bounds（位置/大小）和生命周期（创建/销毁）。

- 创建：`BrowserPanel.tsx` mount effect → `browserCreate()` → Rust `browser_create_with_app()` → `WebviewBuilder::new(label, WebviewUrl::External(url))` + `host_window.add_child(builder, ...)`
- 销毁：`BrowserPanel.tsx` cleanup → `browserClose()` → Rust `browser_close()` → `webview.hide()` + 销毁
- bounds 同步：`syncBounds()` → `browserSetBounds()` → Rust `apply_webview_bounds()` → `webview.set_position/set_size/hide/show`

## 排查的 8 条路径

### 路径 A：isCompact 翻转 → CenterStage 卸载 → BrowserPanel 销毁

**完整链路**：

1. 最小化时 Windows 发 `WM_SIZE`，WebView2 的 `window.innerWidth` 变成小但非零的值（如 160px 的任务栏预览宽度，或最小化动画过程中的中间帧宽度）
2. `useWindowSize` 的 `handleResize` 被触发，`document.hidden` 仍为 `false`（Windows 最小化不触发 visibilitychange），`width` 非零（通过了 `width <= 0` 兜底）
3. `width < 500`（compactThreshold）→ `isCompact = true`
4. `App.tsx:252` `hasCenterStage = !isCompact && hasOpenTabs` → 变 `false`
5. `App.tsx:366` `{!isCompact && hasCenterStage && ... <CenterStage>}` → CenterStage 从 DOM 移除
6. `BrowserPanel` 卸载 → cleanup 执行 `browserClose(webviewLabel)`（`BrowserPanel.tsx:682`）→ Rust 侧销毁 WebView
7. 恢复窗口 → `isCompact` 翻回 `false` → CenterStage 重新渲染 → BrowserPanel 重新挂载 → `createNativeWebview()` → `browserCreate()` → Rust 侧 `app.get_webview(&label)` 返回 `None`（已被销毁）→ 创建全新 WebView，从 `initialUrl` 重新加载

**嫌疑判定：高**

**证据**：
- `App.tsx:198-208` 有被注释掉的 effect，注释写着「最小化后恢复面板消失的根因嫌疑」——开发者已经怀疑过这条路径
- `useWindowSize.ts:59-73` 有临时诊断日志 `[DiagResize]`，记录 `wouldFlipCompact` 字段——说明开发者已知最小化时会出现小宽度
- 已尝试的修复（`document.hidden` 守卫）无效，因为 Windows 最小化不触发 `document.hidden = true`

**未验证的环节**：最小化时 `window.innerWidth` 是否真的变成 < 500 的非零值。需要 `[DiagResize]` 日志确认。

---

### 路径 B：BrowserPanel mount effect 依赖变化导致重跑

**排查结果：排除**

mount effect 依赖数组（`BrowserPanel.tsx:685-695`）：
- `getContainerBounds`：`useCallback(..., [])` → 稳定 ✓
- `acquireCreated`：prop → 最小化时不变 ✓
- `acquireRequestId`：prop → 不变 ✓
- `markBrowserNavigationHandled`：zustand action → 引用稳定 ✓
- `normalizedInitialUrl`：`useRef` 缓存 → 稳定 ✓
- `scheduleSyncBounds`：`useCallback` 链最终依赖 `[]` → 稳定 ✓
- `tabId`：prop → 不变 ✓
- `updateBrowserTab`：zustand action → 稳定 ✓
- `webviewLabel`：`useMemo(() => makeBrowserWebviewLabel(tabId), [tabId])` → 稳定 ✓

所有依赖在最小化/恢复期间都稳定，mount effect 不会重跑。

---

### 路径 C：useBrowserVisibilityGuard 误杀激活 tab

**排查结果：排除**

`useBrowserVisibilityGuard.ts` 的 effect 依赖 `[tabs, activeTabId]`。最小化期间 `tabs` 和 `activeTabId` 都不会变化（没有代码在最小化时修改它们）。effect 不会重跑，不会误杀激活 tab。

且其逻辑是 `tab.id !== activeTabId`（line 42），只处理非激活 tab，不影响当前激活的浏览器 tab。

---

### 路径 D：CenterStage 给 BrowserPanel 传了 key 导致重挂载

**排查结果：排除**

CenterStage 中唯一的 `key=`（`CenterStage.tsx:279`）是 `key={tab.id}`，用于 TabBar 的列表项。BrowserPanel 渲染处（`CenterStage.tsx:602`）没有 `key` prop。最小化时 `tab.id` 不变，不会触发重挂载。

---

### 路径 E：viewStore compactMode 持久化导致恢复时 isCompact 异常

**排查结果：排除**

`viewStore` 持久化了 `compactMode`（`viewStore.ts:367-369`），但 `App.tsx:181` 的 `isCompact` 来自 `useWindowManager` 的返回值，而 `useWindowManager` 内部从 `useWindowSize` 的 `useState` 获取——**不是从 viewStore 读取**。viewStore 的 `compactMode` 只是一个被动同步的存储，不是渲染时的真相源。

最小化/恢复不会触发 persist 的重新 hydrate（store 实例一直在内存中），只有应用重启才会。

---

### 路径 F：主 WebView2 在最小化/恢复时重载导致 tabStore 失效

**排查结果：可能性低**

如果主 WebView2 重载，React 重新挂载，tabStore 从 localStorage 恢复，而 `tabStore.ts:542` `partialize: () => ({ tabs: [], activeTabId: null })`——恢复后 tabs 为空，所有 tab 消失。用户看到的是"tab 没了"而不是"浏览器内容刷新"。与用户描述不符。

主窗口在 dev 模式下有 `--disable-features=CalculateNativeWinOcclusion`（`lib.rs:690`），release 模式没有。但主窗口重载的表现是整个应用闪白重启，与"仅浏览器刷新"不符。

---

### 路径 G：WebView2 渲染器被 Windows 挂起后自动重建

**嫌疑判定：中高**

Windows 10/11 的窗口最小化机制会让 Chromium 渲染器进入低功耗挂起状态。恢复时如果渲染器超时未响应，WebView2 可能自动重建渲染进程并重新加载页面。

**关键证据**：
- 主窗口的 WebView2 在 dev 模式下设置了 `--disable-features=CalculateNativeWinOcclusion`（`lib.rs:690-692`）来缓解这类问题
- 内置浏览器的子 WebView（`browser.rs:1602` 的 `WebviewBuilder`）**完全没有设置 `additional_browser_args`**，完全暴露在这套机制下
- `WebviewBuilder` 确实支持 `additional_browser_args`（Tauri 2.11.5 `src/webview/mod.rs:956`）

**与路径 A 的关系**：两者可能同时存在、叠加触发。即使解决了路径 A，路径 G 仍可能独立导致刷新。

---

### 路径 H：onResized/onFocused 等事件回调触发状态更新

**排查结果：排除**

前端没有监听 Tauri 的 `onResized`/`onFocused` 窗口事件来修改 tab 或 compactMode 状态。`windowService.ts:142` 的 `onResized` 仅用于全屏状态检测（`onFullscreenChange`），且只在 `ArtifactPreviewRenderer` 中使用，与 BrowserPanel 无关。

Rust 侧 `on_window_event`（`lib.rs:799-812`）只处理 `CloseRequested`，没有处理 `Minimized`/`Focused`/`Resized`。

## 结论：两条嫌疑路径

| 路径 | 嫌疑度 | 根因 | 与 `document.hidden` 修复的关系 |
|------|--------|------|------|
| A | 高 | 最小化时 `window.innerWidth` 变小 → `isCompact` 翻转 → CenterStage 卸载 → BrowserPanel 销毁 WebView | 修复无效（`document.hidden` 在 Windows 最小化时不翻转为 true） |
| G | 中高 | 子 WebView 未设置 `--disable-features=CalculateNativeWinOcclusion`，渲染器被 Windows 挂起后重建 | 与 `document.hidden` 无关 |

## 验证方案

在 DevTools Console 中操作：

1. 打开内置浏览器，导航到某个页面
2. 在 Console 中输入：
   ```js
   // 拦截 console.log，过滤 BrowserPanel 生命周期日志
   const origLog = console.log;
   console.log = function(...args) {
     const s = args.map(a => typeof a === 'string' ? a : '').join(' ');
     if (s.includes('[BrowserPanel]')) {
       origLog('[CAPTURED]', new Date().toISOString(), ...args);
     }
     origLog.apply(this, args);
   };
   ```
3. 最小化应用，等 3 秒，再恢复
4. 查看 Console 日志：
   - 如果出现 `[BrowserPanel] BrowserPanel UNMOUNT` + `MOUNT` → **路径 A 确认**（组件卸载重建）
   - 如果没有 UNMOUNT 但页面仍刷新 → **路径 G 确认**（WebView2 底层行为）
   - 如果两者都有 → 路径 A + G 同时存在

## 修复方案（待验证后实施）

### 方案 1：修复路径 A（isCompact 翻转）

**思路**：最小化时阻止 `isCompact` 翻转。

**方案 1a — 用 Tauri `onResized` + `isMinimized` 替代 `document.hidden`**：

在 `useWindowSize` 中，通过 Tauri 的窗口 API 监听 `onResized`，在回调中检查 `win.isMinimized()`。如果窗口正在最小化，标记一个 ref，`handleResize` 中检查该 ref 跳过更新。

```ts
// useWindowSize.ts 新增
useEffect(() => {
  if (!isTauri()) return;
  let unlisten: (() => void) | null = null;
  getGetCurrentWindow().then(getWin => {
    if (!getWin) return;
    const win = getWin();
    win.onResized(async () => {
      minimizedRef.current = await win.isMinimized();
    });
  });
  return () => { unlisten?.(); };
}, []);
```

改动量：中。需要引入 Tauri window API，处理异步。

**方案 1b — 对 `isCompact` 翻转做防抖**：

在 `useWindowSize` 中，对 `isCompact` 从 `false` → `true` 的翻转做延迟确认（如 300ms），过滤掉最小化/恢复期间的瞬态小宽度。

```ts
// isCompact 只在连续 300ms 满足 width < threshold 时才翻转
```

改动量：小。纯前端，不依赖 Tauri API。但引入 300ms 延迟。

**方案 1c — 在 `App.tsx` 渲染层守卫**：

让 CenterStage 的渲染不因瞬态 `isCompact` 翻转而卸载，例如对 `hasCenterStage` 做防抖或用 CSS `display:none` 替代条件渲染。

改动量：中。可能影响其他场景的 compact 模式切换。

### 方案 2：修复路径 G（WebView2 渲染器挂起）

**思路**：给内置浏览器子 WebView 也加上 `--disable-features=CalculateNativeWinOcclusion`。

在 `browser.rs:1602` 的 `WebviewBuilder::new(...)` 链上追加：

```rust
let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(normalized.clone()))
    .additional_browser_args("--disable-features=CalculateNativeWinOcclusion")
    .devtools(true)
    ...
```

改动量：极小（一行）。与主窗口 dev 模式的做法一致。

**注意**：`--disable-features=CalculateNativeWinOcclusion` 会禁用 Chromium 的窗口遮挡计算，轻微增加 CPU 开销（窗口被其他窗口遮挡时仍渲染）。对于内置浏览器这种需要保持状态的场景，代价可接受。

### 推荐实施顺序

1. **先做方案 2**（一行改动，覆盖路径 G）
2. **再做方案 1b**（防抖，覆盖路径 A，改动最小）
3. 验证后清理 `useWindowSize.ts` 的 `[DiagResize]` 诊断日志和 `App.tsx` 的注释代码
