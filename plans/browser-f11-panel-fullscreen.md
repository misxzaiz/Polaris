# 内置浏览器 F11 面板全屏 — 实现方案

> 状态：已与用户对齐（PRD 原型 v2）
> 日期：2026-10-20
> 关联原型：`browser-f11-fullscreen` v2

## 目标

内置浏览器按 **F11** 进入「面板内全屏」：网页内容铺满浏览器面板「上(工具栏)+中(网页)+下(状态栏)」合并范围，
浏览器自身工具栏与底部状态栏让位隐藏，**边界止于浏览器面板**，外部内容（菜单栏/活动栏/左侧栏/右侧 AI 栏/TabBar）完全不动、不隐藏、不被覆盖。Esc / F11 退出。

## 需求来源与断言（来自 PRD v2 复盘）

- 全屏作用域 = 浏览器面板自身（`BrowserPanel` root）。
- 被覆盖 = 浏览器内部工具栏（URL 输入框等）+ 底部状态栏（AI 操作日志）。
- 外部内容一律不动（这是与「整窗全屏」的最大区别，实现无需动 App 布局/系统窗口）。
- 触发：F11 键 / 工具栏全屏按钮 / Esc 退出 / 全屏时悬浮退出条。
- 还原：退出后工具栏与状态栏按原状还原。

## 架构现状（约束）

- `BrowserPanel` 结构（`src/components/Browser/BrowserPanel.tsx`）：
  - 顶部 `toolbarWidthRef`（滚动工具栏，含地址栏）+ 中部 `containerRef`（原生 webview/iframe 挂载区，`flex-1`）+ 底部 `footer`（常驻状态栏）。
  - 原生模式：webview 位置/尺寸由 `getContainerBounds()`（`containerRef` 的 rect）量测 → `syncBounds()` → `browserSetBounds` 同步到后端原生层。`containerRef` 尺寸随布局变化会自动经 ResizeObserver 触发重新同步。
  - 遮挡检测 `isBrowserOccludedByAppOverlay`：全屏后工具栏/状态栏收缩到 0 高（不再遮挡），webview bounds 自动随 `containerRef` 新 rect 更新 → 实现为纯 DOM 布局变化即可驱动原生 webview 全屏。
- **F11 捕获难点（关键决策）**：
  - 原生 WebView2 中，F11 键盘事件**直达页面**（不冒泡到宿主 DOM 的 `window`），且 WebView2 收到 F11 默认触发"浏览器式全屏"。因此**必须**在 webview 页面内注入 keydown 监听并 `preventDefault`，再把事件转发到宿主前端。
  - iframe 降级模式：iframe 内键盘事件**冒泡到宿主 window**（同 DOM 树），可直接走宿主 `window.addEventListener('keydown')`。
  - 宿主级 `window.addEventListener('keydown')` 用 capture 捕获 iframe 的 F11（焦点在 iframe 内时 event target 是 iframe 文档，仍会到达宿主 window）。
- 事件回传通道：现有 `browser_eval_with_app`（内部函数，未注册公开命令）+ `browser_scripts.rs` 注入脚本 + `listen('browser://operation')` 事件通道已存在。为 F11 新建轻量「页面→宿主」通道：页面脚本捕获 F11 → `postMessage` 或直接调用 `window.__TAURI_INTERNALS__`（不可靠）→ 采用 **注入脚本监听 keydown → 把 key 写入 `window` 全局标记 + 宿主短轮询** 不可行（延迟）；采用「注入脚本在 keydown 时调用 `window.ipc.postMessage`/`emit` 不可靠」。
  - **收敛方案**：新增一个**公开 tauri command**（如 `browser_set_fullscreen`）— 等价"注入一段脚本到 webview 安装 F11 keydown 监听"，脚本捕获 F11 后**直接改 webview 尺寸**（后端同步 API，最可靠，不依赖事件通道）。但"改 webview 尺寸"后端无法单独得知该不该进入/退出 → 需要前端状态参与。
  - **最终方案（简单可靠）**：
    1. 前端在 F11（按钮/iframe/页面转发）时翻转**本地面板 state** `fullscreen`，用一个**受控的本地 + 上下文**信号。
    2. 原生模式 F11 转发：新建 Rust command `browser_notify_f11(label)` —— 内部对目标 webview `eval` 一段脚本，在页面内安装一次性 keydown 监听并 `preventDefault`；一旦 F11 触发即通过 `app.emit('browser://f11', {label})` 广播给前端。前端 `listen('browser://f11')` 翻转 state。
    - 之所以「安装一次性监听再移除」：键盘事件发生时页面就是当前活跃 webview，无需常驻监听；每次需捕获时注入，捕获到 F11 后即可移除（或常驻，代价小；为稳妥常驻并在必要时多次注入幂等去重）。
  - 简化（v1 不做常驻注入）：**在 `browser_create`/挂载时就通过 `initialization_script` 注入 F11 捕获脚本**（现有注入体系已有 3 个 initialization_script，再加 1 个），脚本每次 F11 `preventDefault` 并 `emit` 事件 → 前端统一翻转。无需新 command，复用 `browser://operation` 或新增 `browser://fullscreen-toggle` 事件。

## 决策：注入脚本 + 前端状态 + 布局

1. **后端**（`commands/browser_scripts.rs` + 新脚本文件）
   - 新脚本 `fullscreen-toggle.js`（`browser-scripts/`）：页面级 `keydown` 捕获 F11，`preventDefault()`，不冒泡；通过 `window.__TAURI__.event.emit('browser://fullscreen-toggle', { label })` 通知宿主（若在非 tauri 页面内嵌环境，emit 不可用时降级为 `console/无操作`——反正 iframe 模式走宿主捕获）。
   - `browser_scripts.rs` 导出 `FULLSCREEN_TOGGLE_SCRIPT`。
   - `browser.rs` `WebviewBuilder::new(...)` 增加 `.initialization_script(FULLSCREEN_TOGGLE_SCRIPT)`（挂在现有 3 个之后）。
2. **前端事件监听**（`BrowserPanel.tsx`）
   - 挂载时 `listen('browser://fullscreen-toggle')` → 仅当 `payload.label === webviewLabel` 且 `status==='ready'` 时 `toggleFullscreen()`。
   - 同时宿主级 `window.addEventListener('keydown', ...)`（capture）处理 iframe 降级模式的 F11（`status==='native-unavailable'`）。
3. **面板状态与布局**
   - `BrowserPanel` 本地 `useState<boolean> fullscreen`（不复用 viewStore：作用域仅限浏览器面板自身，且多浏览器 tab 各自独立全屏互不干扰 —— 与原型一致，也避免全局 store 引入复杂联动）。
   - root div 加 `fullscreen` class（`data-fs`）：工具栏与 footer 变为 `height:0/opacity:0/overflow:hidden`（用现有 theme token 与 CSS，不硬编码颜色；用 tailwind 或内联 style class）。
   - 全屏时网页区（`containerRef`）flex 自动撑满剩余 → 原生 webview bounds 经 ResizeObserver 自动更新为面板全范围，且工具栏/footer 隐藏后不再遮挡，遮挡检测不再 hide webview。
   - 工具栏加「全屏」按钮（`Maximize2`/`Minimize2` 图标，lucide 已可用）。
   - 全屏时网页区顶部叠加悬浮退出条（`data-native-webview-overlay` 以避遮挡检测隐藏 webview）——含「退出全屏」按钮 + 提示。
4. **还原**
   - 退出：class 移除 → 工具栏/footer 恢复，bounds 自动同步，无任何外部布局影响。切换 tab / 关闭 tab 时组件卸载，state 随组件生命周期自然清理。

## 验收

1. 原生 webview 模式按 F11 → 浏览器面板内网页铺满（工具栏+状态栏隐藏），外部内容原样。
2. Esc / 再按 F11 / 全屏悬浮条「退出」/ 工具栏按钮（全屏前）→ 各入口均能退出并还原。
3. iframe 降级模式同上（F11 走宿主捕获）。
4. 多浏览器 tab：各 tab 全屏状态独立，互不干扰；切换 tab 全屏不串。
5. `pnpm exec tsc --noEmit` + `pnpm lint`通过；后端 `cargo check` 通过（未动公共协议枚举，仅新增脚本/注入/前端，Rust 无新类型）。

## 不做（边界）

- 不动 App 布局 / viewStore / 系统窗口（非整窗全屏）。
- 不做 `browser_set_bounds` 全屏特判：全屏是 DOM 布局变化 → bounds 自动同步，无需后端特判。
- 不在 webview 页面内做「点击网页退出」等侵入式行为。

## 风险

- WebView2 在注入脚本 `preventDefault` 前是否已触发自身全屏：脚本在 commit 节点（页面顶层 keydown 先于 WebView2 快捷键处理）捕获应可拦截；若不生效，需降级为「���端 command + 事件」方式调用 `eval` 安装捕获（预留，见「最终方案」）。实现后须真机验证。
- iframe 模式 F11 默认可能让浏览器（外框）进入全屏：宿主 `preventDefault` 可拦截。