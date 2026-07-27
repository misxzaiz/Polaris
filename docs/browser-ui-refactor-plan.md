# 内置浏览器 UI 重构规划方案

> 方案版本: v1 · 2026-07-27
> 覆盖文件: `src/components/Browser/BrowserPanel.tsx` · `src/services/tauri/browserService.ts` · `src/components/Layout/CenterStage.tsx` · `src/locales/*/common.json`
> 实施人日预估: ~4.2 人日

---

## 目录

- [一、现状问题清单](#一现状问题清单附行号)
- [二、设计目标](#二设计目标)
- [三、组件设计方案](#三组件设计方案)
  - [3.1 顶部工具栏重新分组](#31-顶部工具栏重新分组)
  - [3.2 地址栏增强方案](#32-地址栏增强方案)
  - [3.3 底部状态栏瘦身方案](#33-底部状态栏瘦身方案)
  - [3.4 AI 操作面板可发现性改进](#34-ai-操作面板可发现性改进)
- [四、按钮视觉分层规范](#四按钮视觉分层规范)
- [五、状态机设计](#五状态机设计)
- [六、具体改动清单](#六具体改动清单)
  - [6.1 BrowserPanel.tsx 改动](#61-browserpaneltsx-改动)
  - [6.2 browserService.ts 改动](#62-browserservicets-改动)
  - [6.3 后端(Rust)改动](#63-后端rust改动)
- [七、国际化 key 新增清单](#七国际化-key-新增清单)
- [八、边界情况](#八边界情况)
  - [8.1 小屏适配](#81-小屏适配)
  - [8.2 多 Tab](#82-多-tab)
  - [8.3 错误恢复](#83-错误恢复)
  - [8.4 降级模式(native-unavailable)](#84-降级模式native-unavailable)
  - [8.5 网络/Favicon 加载失败](#85-网络favicon-加载失败)
- [九、实施建议](#九实施建议)

---

## 一、现状问题清单(附行号)

| 序号 | 问题描述 | 严重度 | 文件:行号 |
|------|---------|--------|----------|
| P1 | **11 个工具栏按钮无视觉分层** — 全部用同一样式(`toolbarButtonClass`, `flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary...`),后退/前进/刷新与复制/外链/DevTools 完全同质,无法建立操作优先级 | 🔴 高 | `BrowserPanel.tsx:L647-648` / `L688-828` |
| P2 | **后退/前进按钮永远启用** — `disabled={status !== 'ready'}`,只判断是否 ready,不反映真实历史可点击性,用户会误触导航 | 🔴 高 | `BrowserPanel.tsx:L693`, `L702` |
| P3 | **地址栏无 favicon、无 HTTPS 安全指示** — 用静态 `Globe2` 图标替代真实站点标识,用户对访问站点无视觉信任感 | 🔴 高 | `BrowserPanel.tsx:L719-740` |
| P4 | **地址栏无加载进度** — 加载状态仅在页面内浮一个左上角胶囊,地址栏本身无进度条反馈,Chrome/Edge 都在地址栏内展示进度环/条 | 🟡 中 | `BrowserPanel.tsx:L857-861` |
| P5 | **底部状态栏冗余文案** — `"AI 可读取并操作当前页"` 是永远显示的静态说明,无信息增量 | 🟡 中 | `BrowserPanel.tsx:L1084-1087` |
| P6 | **错误反馈不统一** — 导航类操作(back/forward/reload/devtools/clear)只调 `setError(String(e))`,无 toast;而 `copyUrl` 和 `handleContextToChat` 同时发了 `setError` + `toast.error`,用户看到双重报错 | 🟡 中 | `BrowserPanel.tsx:L692`, `L701`, `L710`, `L806`, `L1091` vs `L643`, `L669`, `L798` |
| P7 | **AI 操作面板折叠态触发缺陷** — 底部折叠按钮 `disabled={!latestOperation}`,无操作事件时呈灰色不可点,用户无法主动打开 AI 面板 | 🟡 中 | `BrowserPanel.tsx:L1035-1053` |
| P8 | **任务按钮小屏语义丢失** — "讲解/修改"在 `xl`(1280px)以下、"上下文/诊断/AI操作"在 `2xl`(1536px)以下只剩图标,无标签用户不知道图标含义 | 🟡 中 | `BrowserPanel.tsx:L752`, `L762`, `L774`, `L785`, `L799` |
| P9 | **底部状态栏左右重复显示** — `isLocalDev` 标记在 AI 面板内和底部状态栏两处出现;`highlightCount` 也在 AI 面板内和底部两处出现 | 🟢 低 | `L893-898`, `L1065-1070` / `L899-906`, `L1076-1082` |
| P10 | **地址栏"访问"按钮冗余** — 右侧 Search 按钮功能与回车提交完全重复,挤压输入空间 | 🟢 低 | `BrowserPanel.tsx:L733-739` |

---

## 二、设计目标

对标 Chrome / Edge 的体验基线:

| 维度 | 目标 |
|------|------|
| **视觉层级** | 一眼分辨"导航操作"和"AI 任务",用户认知成本 ≤ 2 级 |
| **地址栏** | 成为信息密度最高的区域: favicon + 安全指示 + URL + 进度 — 单一眼点获取页面身份与状态 |
| **状态反馈** | 每个操作有即时反馈(图标动效 / toast),错误有统一渠道 |
| **可发现性** | 所有功能在任意宽度下语义清晰,关键功能(AI 面板)永远可触发 |
| **状态机驱动** | UI 不是靠分散的 flag 拼凑,而是由明确状态机决定渲染 |

---

## 三、组件设计方案

### 3.1 顶部工具栏重新分组

当前: 导航(3) + 地址栏 + 任务(5) + 工具(3) 全部平铺在同一 `flex` 容器(`L688-828`),按钮之间无分隔。

**新分组布局(左→右):**

```
[← → ↻]  ── 导航组(图标按钮,可 disabled, 右侧 border-r 分隔线)
[🔒 favicon │ www.example.com │ loading]  ── 地址栏(增强 OMR,含进度条)
[讲解 修改]  ── AI 任务组(实心 primary 主按钮,文字+图标)
[⋮]  ── 溢出菜单(上下文/诊断/AI操作/DevTools/复制/外链/清理)
```

**分组职责:**

| 分组 | 包含按钮 | 样式 |
|------|---------|------|
| **导航组** | 后退、前进、刷新 | `browser-btn-icon`(图标按钮),加 `border-r border-border-subtle` 右侧分隔线 |
| **地址栏** | 安全指示 + favicon + URL输入框 + 加载进度条 | 容器 `flex-1`,高度 8,圆角边框,`focus-within` 高亮 |
| **AI 任务组** | 讲解、修改 | `browser-btn-primary`(实心主按钮),始终带文字标签 |
| **溢出菜单** | 上下文预览、诊断、AI 操作开关、DevTools、复制、外部打开、清理数据 | 触发按钮 `MoreHorizontal` 图标,弹出 Dropdown 列表面板 |

**溢出菜单 Dropdown 设计:**

```tsx
// 伪代码示意
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <button className={browserBtnIcon}>
      <MoreHorizontal size={16} />
    </button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end" className="w-48">
    <DropdownMenuLabel>{t('browser.overflowMenu')}</DropdownMenuLabel>
    <DropdownMenuSeparator />
    <DropdownMenuItem onClick={refreshContextPreview} disabled={contextLoading}>
      <ListTree size={14} /><span>{t('browser.contextPreview')}</span>
    </DropdownMenuItem>
    <DropdownMenuItem onClick={refreshDiagnostics} disabled={diagnosticsLoading || status !== 'ready'}>
      <Activity size={14} /><span>{t('browser.diagnostics')}</span>
    </DropdownMenuItem>
    <DropdownMenuItem onClick={toggleAiOperation} disabled={status !== 'ready'}>
      <MousePointer2 size={14} /><span>{t('browser.operationMode')}</span>
    </DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem onClick={toggleDevtools} disabled={status !== 'ready'}>
      <Bug size={14} /><span>{t('browser.devtools')}</span>
    </DropdownMenuItem>
    <DropdownMenuItem onClick={copyUrl}>
      <Copy size={14} /><span>{t('browser.copyUrl')}</span>
    </DropdownMenuItem>
    <DropdownMenuItem onClick={openExternal}>
      <ExternalLink size={14} /><span>{t('browser.openExternal')}</span>
    </DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem onClick={clearData} disabled={status !== 'ready'}>
      <Eraser size={14} /><span>{t('browser.clearDataShort')}</span>
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

### 3.2 地址栏增强方案

替换当前 `L719-740` 的地址栏,新增 `AddressBar` 子组件:

| 元素 | 方案 | 数据来源 |
|------|------|---------|
| **favicon** | 优先取 `https://{host}/favicon.ico`,失败回退到 `https://t2.gstatic.com/faviconV2?url={host}` (Google favicon 服务),再失败回退 `Globe2` | `currentUrl` 派生 host |
| **HTTPS 安全指示** | `https` → 实心绿锁(`ShieldCheck` lucide);`http`(非本地) → 黄三角 + `!`(不安全);`localhost` → 灰终端图标(`Terminal`,本地开发) | `currentUrl` 协议判断 |
| **URL 显示** | 聚焦时显示完整 URL;失焦时优先显示 `host + path` 精简形式;超长截断 | `address` / `currentUrl` |
| **加载进度** | 地址栏底部 2px 进度条: 加载时 `bg-primary` 从左向右填充 + 脉冲动画;完成时淡出 | `loading` 状态 |
| **提交按钮** | 移除独立 Search 按钮(L733-739),回车提交,改为在地址栏右侧显示加载 spinner 或小箭头指示 | 回车 `onSubmit` |

**安全指示组件:**

```tsx
function SecurityIndicator({ url }: { url: string }) {
  const protocol = url.startsWith('https') ? 'https' : url.startsWith('http') ? 'http' : 'unknown'
  if (protocol === 'https') {
    return <ShieldCheck size={14} className="text-success shrink-0" />
  }
  if (isLocalDevUrl(url)) {
    return <Terminal size={14} className="text-text-tertiary shrink-0" />
  }
  return <AlertCircle size={14} className="text-warning shrink-0" />
}
```

**Favicon 加载 hook:**

```typescript
// 新增: src/hooks/useFavicon.ts
const FAVICON_CACHE = new Map<string, string | null>()
const FAVICON_TIMEOUT = 5_000

function useFavicon(url: string): string | null {
  const [favicon, setFavicon] = useState<string | null>(null)

  useEffect(() => {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      setFavicon(null)
      return
    }

    // 缓存命中
    if (FAVICON_CACHE.has(host)) {
      setFavicon(FAVICON_CACHE.get(host) ?? null)
      return
    }

    // 尝试原生 favicon.ico
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), FAVICON_TIMEOUT)

    fetch(`https://${host}/favicon.ico`, { signal: abort.signal, mode: 'no-cors' })
      .then(() => {
        const url = `https://${host}/favicon.ico`
        FAVICON_CACHE.set(host, url)
        setFavicon(url)
      })
      .catch(() => {
        // 回退到 Google favicon 服务
        const fallback = `https://t2.gstatic.com/faviconV2?url=${host}`
        FAVICON_CACHE.set(host, fallback)
        setFavicon(fallback)
      })
      .finally(() => clearTimeout(timer))

    return () => { clearTimeout(timer); abort.abort() }
  }, [url])

  return favicon
}
```

**地址栏布局(伪代码):**

```tsx
// 地址栏布局
<div className="min-w-0 flex-1 relative">
  <form onSubmit={handleSubmit}>
    <div className="flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border-subtle bg-background-surface px-2 text-text-tertiary focus-within:border-primary/70 focus-within:text-text-secondary">
      <SecurityIndicator url={currentUrl} />
      {favicon && <img src={favicon} alt="" className="h-4 w-4 shrink-0 rounded" />}
      {!favicon && <Globe2 size={14} className="shrink-0 text-text-tertiary" />}
      <input
        value={address}
        onChange={...}
        onFocus={() => addressFocusedRef.current = true}
        onBlur={() => addressFocusedRef.current = false}
        className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
        placeholder={t('browser.addressPlaceholder')}
      />
      {loading ? (
        <Loader2 size={14} className="animate-spin shrink-0 text-primary" />
      ) : (
        <ArrowRight size={14} className="shrink-0 text-text-tertiary" />
      )}
    </div>
  </form>
  {/* 加载进度条 */}
  {loading && (
    <div className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden rounded-full bg-border-subtle">
      <div className="h-full w-full animate-progress bg-primary" />
    </div>
  )}
</div>
```

### 3.3 底部状态栏瘦身方案

当前底部状态栏(`L1055-1101`)包含过多冗余信息,瘦身方案:

| 保留 | 移除 | 新增 |
|------|------|------|
| 状态色点(ready/error/idle) | `"AI 可读取并操作当前页"` 静态文案(`L1084-1087`) | 实时加载进度文本(`"正在加载…"`) |
| host 文本(`L1063`) | 重复的 `isLocalDev` 标签(`L1065-1070`) | — |
| 标题/URL(`L1064`) | 重复的 `highlightCount`(`L1076-1082`) | — |
| `清理` 按钮(`L1088-1099`) | — | — |

**瘦身后状态栏布局:**

```tsx
<div className="flex h-7 shrink-0 items-center justify-between border-t border-border-subtle bg-background-elevated px-3 text-[11px] text-text-tertiary">
  <div className="flex min-w-0 items-center gap-2">
    <span className={clsx(
      'h-1.5 w-1.5 shrink-0 rounded-full',
      status === 'ready' ? 'bg-success' : status === 'error' ? 'bg-danger' : 'bg-warning'
    )} />
    <span className="shrink-0 truncate font-medium text-text-secondary">{hostText}</span>
    <span className="hidden min-w-0 truncate md:inline">{pageTitle || currentUrl}</span>
  </div>
  <div className="flex shrink-0 items-center gap-1">
    {loading && (
      <span className="inline-flex items-center gap-1 text-text-tertiary">
        <Loader2 size={11} className="animate-spin" />
        {t('status.loading')}
      </span>
    )}
    <button
      type="button"
      onClick={() => browserClearData(webviewLabel).catch((e) => toast.error(String(e)))}
      disabled={status !== 'ready'}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary disabled:opacity-45"
      title={t('browser.clearData')}
    >
      <Eraser size={12} />
      <span className="hidden sm:inline">{t('browser.clearDataShort')}</span>
    </button>
  </div>
</div>
```

### 3.4 AI 操作面板可发现性改进

**折叠按钮(`L1035-1053`):**

| 当前 | 改为 |
|------|------|
| `disabled={!latestOperation}` — 无操作时灰色不可点击,用户无法主动打开 | 始终启用,无操作时显示 `"AI 操作日志 — 点击打开"`,图标用 `text-text-tertiary` 表示无数据 |
| 无操作时 `Sparkles` 图标用 `text-text-tertiary` | 保持 `text-text-tertiary`(无操作状态),有操作时 `text-primary` |

**AI 面板内部(`L885-1031`):**

| 当前 | 改为 |
|------|------|
| 重复的 `isLocalDev` badge(`L893-898`) | 移除,仅在底部状态栏保留 |
| 重复的 `highlightCount` badge(`L899-906`) | 移除,仅在底部状态栏保留 |

**无操作事件空状态:** 在操作日志区域(`L1003-1027`)显示更友好的空状态:

```tsx
{operationEvents.length === 0 ? (
  <div className="flex flex-col items-center gap-1 py-3 text-xs text-text-tertiary">
    <Sparkles size={16} className="opacity-50" />
    <span>{t('browser.aiPanelEmpty')}</span>
    <span className="text-[11px]">{t('browser.aiPanelOpenHint')}</span>
  </div>
) : (
  // ...现有操作事件列表
)}
```

---

## 四、按钮视觉分层规范

引入三级视觉等级,在工具栏中通过类名常量区分:

| 等级 | 类名常量 | 样式定义 | 用途 | 代表按钮 |
|------|---------|---------|------|---------|
| **Primary 主按钮** | `browserBtnPrimary` | `inline-flex h-9 shrink-0 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed` | 核心 AI 任务,必须带文字标签 | 讲解、修改 |
| **Secondary 次按钮** | `browserBtnSecondary` | `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border-subtle bg-background-surface px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary disabled:opacity-45 disabled:cursor-not-allowed` | 辅助操作,可有文字标签 | 溢出菜单中的各项 |
| **Icon 图标按钮** | `browserBtnIcon` | `flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed` | 导航/高频工具,仅图标 | ← → ↻、⋮、复制、外链、DevTools |

**关键改动:**

1. 讲解/修改从 `taskButtonClass`(描边,`L649-650`)升级为 `browserBtnPrimary`(实心),与 `BrowserLauncherPanel` 中 launcher 主按钮(`L1172`)同级,建立"AI 是核心能力"的视觉锚点
2. 溢出菜单触发按钮使用 `browserBtnIcon` + `MoreHorizontal` 图标
3. 所有按钮统一 `disabled` 视觉: opacity 30(`browserBtnIcon`) / 45(`browserBtnSecondary`) / 50(`browserBtnPrimary`),全部加 `cursor-not-allowed`,hover 时不触发背景变化

**类名常量定义位置:** 组件内 `L647-650` 位置,替换现有 `toolbarButtonClass` 和 `taskButtonClass`:

```typescript
const browserBtnPrimary = [
  'inline-flex h-9 shrink-0 items-center gap-2 rounded-md',
  'bg-primary px-3 text-sm font-medium text-white',
  'transition-colors hover:bg-primary-hover',
  'disabled:opacity-50 disabled:cursor-not-allowed',
].join(' ')

const browserBtnSecondary = [
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md',
  'border border-border-subtle bg-background-surface px-2.5',
  'text-xs font-medium text-text-secondary',
  'transition-colors hover:bg-background-hover hover:text-text-primary',
  'disabled:opacity-45 disabled:cursor-not-allowed',
].join(' ')

const browserBtnIcon = [
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
  'text-text-secondary transition-colors',
  'hover:bg-background-hover hover:text-text-primary',
  'disabled:opacity-30 disabled:cursor-not-allowed',
].join(' ')
```

---

## 五、状态机设计

当前状态分散在 `status`(`L238`)、`loading`(`L237`)、`error`(`L239`)三个独立 state 中。建议收敛为单一状态机,用 `useReducer` 或 `useBrowserState` 自定义 hook 管理:

```
State
├── idle              — 初始/未就绪
│   UI: 加载骨架 + 左上胶囊 "加载中…"
│   工具栏: 全部 disabled
│
├── loading           — 导航中 / 刷新中 / 创建中
│   UI: 地址栏底部进度条(2px, 脉冲) + 左上胶囊隐藏(冗余,移除)
│   工具栏: 导航 disabled;刷新按钮 spinner;地址栏不可编辑(可选)
│   面板: 无额外浮层
│
├── ready             — 页面加载完成,原生 WebView 就绪
│   UI: 正常渲染,地址栏显示 favicon + 锁标
│   工具栏: 全部启用(后退/前进由 `backEnabled`/`forwardEnabled` 单独控制)
│
├── error             — 导航失败 / 页面错误(非启动失败)
│   UI: 顶部 error banner(现有 `L831-843`) + toast 提示
│   工具栏: 地址栏可编辑(允许重试);刷新/外链启用;其余保持
│   恢复: 用户改地址或点刷新 → 切回 loading
│
└── native-unavailable — 非 Tauri 环境 / 启动失败(降级)
    UI: iframe 降级 + 顶部提示 "内置浏览器不可用,使用降级模式"
    工具栏: 导航 disabled;讲解/修改/上下文仍启用(用空 context);诊断 disabled
    面板: iframe 正常展示
```

**状态转换图:**

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    v                                     │
  idle ──create──→ loading ──success──→ ready ──nav/reload/history──→ loading
                    │                    │                    │
                    │ fail               │ error              │ fail
                    v                    v                    v
                  error ←───────────── error ←────────────── error
                    │                    │
                    │ retry/navigate      │ clear banner
                    v                    │
                  loading ←──────────────┘
                    │
                    │ (非 Tauri 环境)
                    v
              native-unavailable
```

**与现有代码映射:**

| 现有代码 | 状态机映射 |
|---------|-----------|
| `L337-425` `createNativeWebview` | `idle → loading`(setLoading true) → `ready`(setStatus 'ready') 或 → `error`(catch) |
| `L492-515` `navigateTo` | 任意 state → `loading`(setLoading true) → `ready`(无异常) 或 → `error`(catch) |
| `L831-843` error banner 关闭 | `error → ready`(清 error) |
| `L300-306` `!isTauriRuntime()` | `idle → native-unavailable` |

**状态收敛方案:**

```typescript
// 使用 useReducer 收敛状态
type BrowserState = 'idle' | 'loading' | 'ready' | 'error' | 'native-unavailable'

interface BrowserStatus {
  phase: BrowserState
  loading: boolean  // 正在导航(用于 UI 进度条)
  error: string | null
  backEnabled: boolean
  forwardEnabled: boolean
}

type BrowserAction =
  | { type: 'INIT' }
  | { type: 'START_LOADING' }
  | { type: 'LOAD_SUCCESS' }
  | { type: 'LOAD_ERROR'; error: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SET_NATIVE_UNAVAILABLE' }
  | { type: 'SET_HISTORY_STATE'; backEnabled: boolean; forwardEnabled: boolean }

function browserReducer(state: BrowserStatus, action: BrowserAction): BrowserStatus {
  switch (action.type) {
    case 'INIT':
      return { phase: 'idle', loading: false, error: null, backEnabled: false, forwardEnabled: false }
    case 'START_LOADING':
      return { ...state, phase: 'loading', loading: true, error: null }
    case 'LOAD_SUCCESS':
      return { ...state, phase: 'ready', loading: false, error: null }
    case 'LOAD_ERROR':
      return { ...state, phase: 'error', loading: false, error: action.error }
    case 'CLEAR_ERROR':
      return { ...state, phase: 'ready', error: null }
    case 'SET_NATIVE_UNAVAILABLE':
      return { ...state, phase: 'native-unavailable', loading: false }
    case 'SET_HISTORY_STATE':
      return { ...state, backEnabled: action.backEnabled, forwardEnabled: action.forwardEnabled }
    default:
      return state
  }
}
```

**新增 `useBrowserState` hook 的好处:**

- 消除 `setLoading` / `setError` / `setStatus` 三处分散调用可能导致的竞态(如 `L404-425` finally 块中 `setLoading(false)` 和 `setStatus('error')` 的时序问题)
- `backEnabled`/`forwardEnabled` 作为状态的一部分,与 `browser_get_history_state` 后端命令联动
- 渲染时只需 `switch (status.phase)`,而非 `if (status === 'ready' && loading) { ... }` 的复合条件

---

## 六、具体改动清单

### 6.1 BrowserPanel.tsx 改动

| 编号 | 行号 | 改动内容 | 复杂度 |
|------|------|---------|--------|
| C01 | `L237-239` | 新增 `useReducer` 状态机(`BrowserState`),替换分散的 `status`/`loading`/`error` 三个 state;新增 `backEnabled`/`forwardEnabled` 状态字段 | L |
| C02 | `L647-650` | 新增三个类名常量 `browserBtnPrimary` / `browserBtnSecondary` / `browserBtnIcon`,替换现有 `toolbarButtonClass` 和 `taskButtonClass`;新增 `MoreHorizontal` 图标导入 | S |
| C03 | `L688-828` | 重构工具栏结构: 导航组加 `border-r` 分隔线;讲解/修改改用 `browserBtnPrimary` 样式;移除地址栏内 Search 提交按钮;新增 `MoreHorizontal` 溢出菜单(`DropdownMenu`),收纳所有低频操作 | L |
| C04 | `L719-740` | 替换地址栏为增强 `AddressBar` 子组件: 集成 `SecurityIndicator`(绿锁/黄警告/灰终端)、`useFavicon` hook(host 级缓存)、地址栏底部 2px 进度条(loading 驱动);移除独立 Search 按钮 | L |
| C05 | `L692`, `L701` | 后退/前进 `disabled` 改为 `!backEnabled` / `!forwardEnabled`(替代仅 `status !== 'ready'`);catch 中用 `toast.error` 替代 `setError` | S |
| C06 | `L692`, `L701`, `L710`, `L806`, `L1091` | 统一错误处理: 所有导航/工具类操作(`browserHistory`/`browserReload`/`browserToggleDevtools`/`browserClearData`)的 `.catch` 改为 `toast.error(message)`,移除 `setError(String(e))`;保留 error banner 仅用于启动失败 | S |
| C07 | `L1035-1053` | 移除折叠按钮 `disabled={!latestOperation}`;无操作时文案改为 `"AI 操作日志 — 点击打开"`,图标颜色保持 `text-text-tertiary`(非 disabled 样式) | S |
| C08 | `L1055-1101` | 底部状态栏瘦身: 移除 `L1072-1087`(操作模式 + AI 说明重复区)和 `L1065-1070`(重复 localDev 标签);保留色点 + host + 标题 + 清理按钮;`loading` 时右侧显示 `"加载中…"` + `Loader2` | S |
| C09 | 新增 `src/hooks/useFavicon.ts` | 新增 `useFavicon` hook: 从 `currentUrl` 派生 host,5s 超时 fetch `favicon.ico`,失败回退 Google favicon API,再失败返回 null(用 Globe2);`Map<string, string|null>` 按 host 缓存 | M |
| C10 | 新增组件 | 新增 `SecurityIndicator` 组件: 输入 url,输出 `ShieldCheck`(绿)/`AlertCircle`(黄)/`Terminal`(灰)图标;`isLocalDevUrl` 辅助函数复用 | S |
| C11 | 新增组件 | 新增 `BrowserOverflowMenu` 组件: Dropdown 包含[上下文预览/诊断/AI操作/DevTools/复制地址/外部打开/清理数据],每项显示 icon + label,操作后自动关闭 | M |
| C12 | `L885-1031` | AI 面板内移除重复的 `isLocalDev` badge(`L893-898`)和 `highlightCount` badge(`L899-906`),只保留在底部状态栏一处;空操作日志区显示友好空状态提示 | S |

### 6.2 browserService.ts 改动

| 编号 | 行号 | 改动内容 | 复杂度 |
|------|------|---------|--------|
| C13 | `L223` 后新增 | 新增函数 `browserGetHistoryState(label: string): Promise<{ canGoBack: boolean; canGoForward: boolean }>` — 查询 WebView 历史状态 | L(需 Rust 后端实现) |

**函数签名:**

```typescript
export interface BrowserHistoryState {
  canGoBack: boolean
  canGoForward: boolean
}

export async function browserGetHistoryState(label: string): Promise<BrowserHistoryState> {
  return invoke<BrowserHistoryState>('browser_get_history_state', { label })
}
```

### 6.3 后端(Rust)改动

| 编号 | 位置 | 改动内容 | 复杂度 |
|------|------|---------|--------|
| C14 | Rust browser command 模块 | 新增 `browser_get_history_state` Tauri command,调用 WebView 的 `can_go_back()`/`can_go_forward()` 方法,返回 `{ canGoBack: boolean, canGoForward: boolean }` | L |

**Rust 命令伪代码:**

```rust
#[tauri::command]
async fn browser_get_history_state(
    state: tauri::State<'_, BrowserManager>,
    label: String,
) -> Result<BrowserHistoryState, String> {
    let session = state.sessions.get(&label)
        .ok_or_else(|| format!("Session not found: {}", label))?;

    let webview = session.webview
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    Ok(BrowserHistoryState {
        can_go_back: webview.can_go_back(),
        can_go_forward: webview.can_go_forward(),
    })
}

#[derive(Serialize)]
struct BrowserHistoryState {
    can_go_back: bool,
    can_go_forward: bool,
}
```

**导航时更新历史状态:**

```typescript
// 在 navigateTo 成功后,或 session-updated 事件中,同步查询历史状态
const syncHistoryState = useCallback(async () => {
  if (status === 'ready') {
    try {
      const { canGoBack, canGoForward } = await browserGetHistoryState(webviewLabel)
      dispatch({ type: 'SET_HISTORY_STATE', backEnabled: canGoBack, forwardEnabled: canGoForward })
    } catch {
      // 静默失败,退化为 always enabled
    }
  }
}, [status, webviewLabel])
```

---

## 七、国际化 key 新增清单

### 7.1 需要新增的 key

```json
// src/locales/zh-CN/common.json — browser 块新增
{
  "browser": {
    "addressFocusHint": "按 Enter 访问,或继续输入",
    "notSecure": "连接不安全",
    "secure": "连接已加密",
    "loadingPage": "正在加载…",
    "aiPanelEmpty": "暂无 AI 浏览器操作",
    "aiPanelOpenHint": "点击打开操作日志",
    "overflowMenu": "更多工具",
    "copyUrlSuccess": "地址已复制",
    "navigationFailed": "导航失败: {{url}}",
    "historyBackDisabled": "无可后退页面",
    "historyForwardDisabled": "无可前进页面"
  }
}
```

```json
// src/locales/en-US/common.json — browser 块新增
{
  "browser": {
    "addressFocusHint": "Press Enter to go, or keep typing",
    "notSecure": "Connection is not secure",
    "secure": "Connection is encrypted",
    "loadingPage": "Loading…",
    "aiPanelEmpty": "No AI browser operations yet",
    "aiPanelOpenHint": "Click to open operation log",
    "overflowMenu": "More tools",
    "copyUrlSuccess": "URL copied",
    "navigationFailed": "Navigation failed: {{url}}",
    "historyBackDisabled": "No back history",
    "historyForwardDisabled": "No forward history"
  }
}
```

### 7.2 可复用现有 key

| 用途 | 现有 key | 文件位置 |
|------|---------|---------|
| 刷新 | `buttons.refresh` | `zh-CN:L14`, `en-US:L14` |
| 复制成功 | `buttons.copied` | `zh-CN:L8`, `en-US:L8` |
| 重试 | `buttons.retry` | `zh-CN:L10`, `en-US:L10` |
| 关闭 | `buttons.close` | `zh-CN:L9`, `en-US:L9` |
| 加载中 | `status.loading` | `zh-CN:L25`, `en-US:L25` |

### 7.3 可删除的冗余 key

以下 key 在瘦身后不再使用,建议清理:

| key | 原因 |
|-----|------|
| `browser.aiReady` | 底部状态栏移除静态文案 |
| `browser.hasSelection` | —(保留,其他场景仍可能用) |
| `browser.screenshotReady` | 溢出菜单项保留 |
| `browser.textOnlyDiagnostics` | 溢出菜单项保留 |

---

## 八、边界情况

### 8.1 小屏适配

| 宽度断点 | 行为 |
|---------|------|
| `< 640px`(手机) | 导航组保留(3 个图标按钮);AI 任务组(讲解/修改)折叠进溢出菜单,仅显示图标;地址栏保持完整;底部状态栏 host 截断到 12 字符 + 省略号;清理按钮仅显示图标 |
| `640-1279px`(平板) | 讲解/修改保留文字标签(简化为单字"讲"/"改");其余工具进溢出菜单 |
| `≥ 1280px`(桌面) | 完整布局: 讲解/修改显示完整文字标签,溢出菜单全部展开 |

**当前响应式策略辨析:**

当前代码用 `hidden xl:inline`(`L752`) / `hidden 2xl:inline`(`L774`, `L785`, `L799`) 控制文字显隐,导致在 `1024-1279px` 区间讲解/修改有图标但无文字,P8 问题即源于此。

**改为用溢出菜单替代响应式显隐** — 在任意宽度下,溢出菜单中的每一项始终显示 icon + label(继承 DropdownMenu 行为),这意味着:

- 窄屏: 讲解/修改从主工具栏移到溢出菜单,但菜单项内 icon + label 完整显示
- 宽屏: 讲解/修改在主工具栏以 `browserBtnPrimary` 显示,溢出菜单隐藏重复项

### 8.2 多 Tab

- 每个 `BrowserPanel` 实例的 favicon 缓存是**共享的**(host 级 `Map<string, string|null>`),避免同站点多 tab 重复 fetch
- `backEnabled`/`forwardEnabled` 是**实例级状态**(通过 `useReducer` 管理),不受其他 tab 影响
- history 查询通过 `webviewLabel`(`makeBrowserWebviewLabel(tabId)` 生成,`L221`)精确路由到对应 WebView 实例
- 溢出菜单 Dropdown 的 `open`/`close` 状态是实例级,不影响其他 tab

### 8.3 错误恢复

- `error` 状态下地址栏可编辑,用户改地址后 `onSubmit` 触发 `navigateTo`,状态机自动切 `loading → ready/error`
- 错误 banner 带关闭按钮(现有 `L831-843`),关闭后状态回 `ready`(不清除页面内容,不阻断操作)
- 启动失败(`browserCreate` 异常)走 `completeAcquire` 上报(L404-420) + 进入 `error` 显示空状态页(L864-882),提供重试按钮(L874-878)
- `browserGetHistoryState` 调用失败时静默降级,`backEnabled`/`forwardEnabled` 均设为 `true`(退化为"永远启用"行为,不阻塞用户)

### 8.4 降级模式(native-unavailable)

- iframe 渲染(现有 `L849-855`),工具栏保持
- 导航按钮 disabled(iframe 不可控制)
- 讲解/修改/上下文预览仍启用(用空 context 对象,现有 `L553-562`),用户可把 URL 手动贴给 AI
- 诊断按钮 disabled(无 WebView diagnostics)
- 地址栏显示降级提示: `SecurityIndicator` 显示 `AlertCircle`(黄) + 悬停提示 "浏览器引擎不可用,部分功能受限"
- favicon 在 iframe 模式下用 iframe 内容获取(若同源)或回退 `Globe2`

### 8.5 网络/Favicon 加载失败

- `useFavicon` hook 设置 5 秒超时,失败静默回退,不触发全局 error
- Google favicon API 同样有超时兜底
- 最终回退 `Globe2` 图标,用户感知不到降级
- 超时通过 `AbortController` 取消 fetch,避免内存泄漏

---

## 九、实施建议

### 建议分阶段交付

| Phase | 内容 | 涉及改动 | 预估耗时 | 验收标准 |
|-------|------|---------|---------|---------|
| **P0 — 状态机 + 错误统一** | 状态机收敛(C01);错误统一(C06);历史状态(C13+C14) | `BrowserPanel.tsx` + `browserService.ts` + Rust | 0.5 人日 | 状态转换正确,error 统一走 toast,back/forward 反映真实状态 |
| **P1 — 视觉分层 + 分组** | 按钮分层(C02);工具栏重构(C03);溢出菜单(C11);底部瘦身(C08) | `BrowserPanel.tsx` + 新组件 | 1 人日 | 三分级视觉差异明显,讲解/修改为实心主按钮,溢出菜单收纳正确 |
| **P2 — 地址栏增强** | 地址栏替换(C04);favicon hook(C09);安全指示(C10);进度条(C04) | `BrowserPanel.tsx` + `useFavicon.ts` | 2 人日 | favicon 正常显示,HTTPS 绿锁/HTTP 警告/localhost 灰终端,进度条流畅 |
| **P3 — 可发现性 + 小屏** | AI 面板折叠修复(C07);AI 面板内冗余清理(C12);小屏适配(8.1) | `BrowserPanel.tsx` | 0.5 人日 | 折叠按钮永远可点,AI 面板无重复元素,<640px 全部功能可触达 |
| **i18n** | 补齐所有新增 key | `zh-CN/common.json` + `en-US/common.json` | 0.2 人日 | 新增 key 全部覆盖,无遗漏 |

**合计约 4.2 人日。**

### 建议优先级

```
P0 ────────────→ P1 ────────────→ P2 ────────────→ P3 ──→ i18n
(状态正确)      (视觉层次到位)   (地址栏体验)     (缺陷修复)  (收尾)
```

建议 P0 + P1 先交付(状态正确 + 视觉层次到位),这两个阶段不涉及后端改动,纯前端即可完成。P2 的 history 状态和 favicon 可以并行做后端(P0 的 C13/C14 与 P2 的 C09/C10 无依赖关系)。