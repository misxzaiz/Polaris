import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Activity,
  ArrowLeft,
  ArrowRight,
  BoxSelect,
  Bookmark,
  ChevronDown,
  ChevronUp,
  Code2,
  Globe2,
  ListTree,
  Loader2,
  Lock,
  Minus,
  MousePointer2,
  PanelBottom,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Unlock,
  X,
} from 'lucide-react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { clsx } from 'clsx'
import { useTranslation } from 'react-i18next'
import {
  browserAcquireComplete,
  browserBookmarkAdd,
  browserBookmarkDelete,
  browserBookmarksList,
  browserClearData,
  browserClose,
  browserCreate,
  browserFind,
  browserFindNext,
  browserGetDiagnostics,
  browserGetHistoryState,
  browserGetMarqueeResult,
  browserGetNetworkInfo,
  browserGetPageContext,
  browserHistory,
  browserNavigate,
  browserReload,
  browserSelectRegion,
  browserSetAiOverlay,
  browserSetBounds,
  browserSetMarquee,
  browserShowOverflowMenu,
  browserToggleDevtools,
  browserZoom,
  formatMarqueeContext,
  makeBrowserWebviewLabel,
  normalizeBrowserUrl,
  type BrowserBookmark,
  type BrowserBounds,
  type BrowserDiagnostics,
  type BrowserInteractionResult,
  type BrowserPageContext,
  type BrowserRegion,
  type BrowserRegionContext,
  type BrowserSessionInfo,
} from '@/services/tauri/browserService'
import { useToastStore } from '@/stores/toastStore'
import { useTabStore } from '@/stores/tabStore'
import { useViewStore } from '@/stores/viewStore'
import { useActiveSessionActions } from '@/stores/conversationStore/useActiveSession'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useOverlayStore } from '@/stores/overlayStore'


interface BrowserPanelProps {
  tabId: string
  initialUrl?: string
  navigationRequestUrl?: string
  navigationRequestId?: number
  acquireRequestId?: string
  acquireCreated?: boolean
}

const QUICK_STARTS = [
  { key: 'search', url: 'https://www.bing.com', label: 'Bing' },
  { key: 'local5173', url: 'localhost:5173', label: 'localhost:5173' },
  { key: 'local3000', url: 'localhost:3000', label: 'localhost:3000' },
  { key: 'mdn', url: 'https://developer.mozilla.org', label: 'MDN' },
  { key: 'tauri', url: 'https://tauri.app', label: 'Tauri' },
]

const MAX_OPERATION_EVENTS = 8
const MIN_OCCLUDING_Z_INDEX = 10
const HIDDEN_BROWSER_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
const OCCLUDING_ELEMENT_SELECTOR = [
  '[data-native-webview-overlay]',
  '[data-theme-panel]',
  '[data-workspace-dropdown]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  '.fixed',
  '.absolute',
].join(',')

const log = (msg: string, data?: unknown) => {
  console.log(`[BrowserPanel] ${msg}`, data !== undefined ? data : '')
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function parseZIndex(value: string): number {
  if (!value || value === 'auto') return 0
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function boundsEqual(a: BrowserBounds | null, b: BrowserBounds): boolean {
  return (
    a !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  )
}

function rectIntersectsBrowserBounds(rect: DOMRect, bounds: BrowserBounds): boolean {
  return (
    rect.right > bounds.x &&
    rect.left < bounds.x + bounds.width &&
    rect.bottom > bounds.y &&
    rect.top < bounds.y + bounds.height
  )
}

function isElementRendered(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element)
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    Number(style.opacity || '1') <= 0.01
  ) {
    return false
  }

  const rect = element.getBoundingClientRect()
  return rect.width >= 1 && rect.height >= 1
}

function isBrowserOccludedByAppOverlay(
  browserBounds: BrowserBounds,
  browserRoot: HTMLElement | null
): boolean {
  if (browserBounds.width < 1 || browserBounds.height < 1) {
    log('isBrowserOccludedByAppOverlay: bounds too small', browserBounds)
    return true
  }

  const candidates = document.body.querySelectorAll<HTMLElement>(OCCLUDING_ELEMENT_SELECTOR)
  for (const element of candidates) {
    if (browserRoot?.contains(element)) continue
    if (!isElementRendered(element)) continue

    const style = window.getComputedStyle(element)

    // pointer-events: none 的元素是视觉浮层，不遮挡 Native WebView
    if (style.pointerEvents === 'none') continue

    const isExplicitOverlay = element.hasAttribute('data-native-webview-overlay')
    const isModal = element.getAttribute('aria-modal') === 'true' || element.getAttribute('role') === 'dialog'
    const canOverlayNativeWebview =
      isExplicitOverlay ||
      isModal ||
      (['fixed', 'absolute', 'sticky'].includes(style.position) &&
        parseZIndex(style.zIndex) >= MIN_OCCLUDING_Z_INDEX)

    if (!canOverlayNativeWebview) continue

    if (rectIntersectsBrowserBounds(element.getBoundingClientRect(), browserBounds)) {
      log('isBrowserOccludedByAppOverlay: occluding element found', {
        tag: element.tagName,
        id: element.id,
        className: element.className,
        position: style.position,
        zIndex: style.zIndex,
        rect: element.getBoundingClientRect(),
        browserBounds,
      })
      return true
    }
  }

  return false
}

function isLocalDevUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

export function BrowserPanel({
  tabId,
  initialUrl = 'https://www.bing.com',
  navigationRequestUrl,
  navigationRequestId,
  acquireRequestId,
  acquireCreated,
}: BrowserPanelProps) {
  const { t } = useTranslation('common')
  const rootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const toolbarWidthRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const mountedRef = useRef(false)
  const readyRef = useRef(false)
  const addressFocusedRef = useRef(false)
  const addressInputRef = useRef<HTMLInputElement>(null)
  const lastAppliedBoundsRef = useRef<BrowserBounds | null>(null)
  const initialUrlRef = useRef<string | null>(null)
  const webviewLabel = useMemo(() => makeBrowserWebviewLabel(tabId), [tabId])
  const normalizedInitialUrl = initialUrlRef.current ?? normalizeBrowserUrl(initialUrl)
  if (initialUrlRef.current === null) {
    initialUrlRef.current = normalizedInitialUrl
  }
  const initialNavigationRequestId =
    navigationRequestUrl && normalizeBrowserUrl(navigationRequestUrl) === normalizedInitialUrl
      ? navigationRequestId
      : undefined
  const initialNavigationRequestRef = useRef<number | undefined>(initialNavigationRequestId)
  const lastNavigationRequestRef = useRef<number | undefined>(initialNavigationRequestRef.current)
  // RAF 防抖 + 时间窗口 throttle：避免动画期间 occlusion 检测频繁触发 hide/show
  const lastSyncTimeRef = useRef(0)
  const SYNC_THROTTLE_MS = 100

  const [address, setAddress] = useState(normalizedInitialUrl)
  const [currentUrl, setCurrentUrl] = useState(normalizedInitialUrl)
  const [pageTitle, setPageTitle] = useState('Browser')
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const loadingRef = useRef(false)
  const [loadProgress, setLoadProgress] = useState(0)
  const [status, setStatus] = useState<'idle' | 'ready' | 'native-unavailable' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  // 统一的错误显示：设置错误状态（内联显示）+ 可选 toast
  function showError(message: string, toastToo = false) {
    setError(message)
    if (toastToo) toast.error(message)
  }
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiPanelTab, setAiPanelTab] = useState<'context' | 'marquee' | 'log'>('context')
  const [aiOperationMode, setAiOperationMode] = useState(false)
  const [highlightCount, setHighlightCount] = useState<number | null>(null)
  const [contextPreview, setContextPreview] = useState<BrowserPageContext | null>(null)
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnostics | null>(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [operationEvents, setOperationEvents] = useState<BrowserOperationEvent[]>([])
  const [boundAgentKey, setBoundAgentKey] = useState<string | null>(null)
  const [marqueeMode, setMarqueeMode] = useState(false)
  const [marqueeRegions, setMarqueeRegions] = useState<BrowserRegion[]>([])
  const [marqueeNote, setMarqueeNote] = useState('')
  const [marqueeSending, setMarqueeSending] = useState(false)
  const [marqueePolling, setMarqueePolling] = useState(false)
  const [toolbarWidth, setToolbarWidth] = useState(0)
  const [findQuery, setFindQuery] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  const findInputRef = useRef<HTMLInputElement>(null)
  const unlistenOverflowRef = useRef<UnlistenFn | null>(null)
  const [findResult, setFindResult] = useState<BrowserInteractionResult | null>(null)
  const [zoomLevel, setZoomLevel] = useState(1.0)
  const [networkInfo, setNetworkInfo] = useState<{ loadTime: number; resourceCount: number; totalSizeKB: number } | null>(null)
  const [loadingTimeout, setLoadingTimeout] = useState(false)
  const loadingTimeoutRef = useRef<number | null>(null)
  const LOADING_TIMEOUT_MS = 30_000
  // 前端导航历史跟踪（用于长按后退按钮显示历史快照菜单）
  const historyStackRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const [historyDropdownOpen, setHistoryDropdownOpen] = useState(false)
  const [historyDropdownDirection, setHistoryDropdownDirection] = useState<'back' | 'forward'>('back')

  // 书签状态
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([])
  const [isBookmarked, setIsBookmarked] = useState(false)
  const [bookmarkDropdownOpen, setBookmarkDropdownOpen] = useState(false)
  const bookmarkListRef = useRef<HTMLDivElement>(null)

  // 加载书签
  useEffect(() => {
    let cancelled = false
    browserBookmarksList()
      .then((items) => {
        if (!cancelled) {
          setBookmarks(items)
          if (currentUrl) setIsBookmarked(items.some((b) => b.url === currentUrl))
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // URL 变化时更新收藏态
  useEffect(() => {
    if (currentUrl) setIsBookmarked(bookmarks.some((b) => b.url === currentUrl))
    else setIsBookmarked(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUrl, bookmarks])

  // 点击外部关闭书签下拉
  useEffect(() => {
    if (!bookmarkDropdownOpen) return
    const onClick = (event: MouseEvent) => {
      if (bookmarkListRef.current && !bookmarkListRef.current.contains(event.target as Node)) {
        setBookmarkDropdownOpen(false)
      }
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [bookmarkDropdownOpen])

  const toggleBookmark = useCallback(async () => {
    if (!currentUrl || status !== 'ready') return
    try {
      if (isBookmarked) {
        const existing = bookmarks.find((b) => b.url === currentUrl)
        if (existing) {
          await browserBookmarkDelete(existing.id)
          setBookmarks((prev) => prev.filter((b) => b.id !== existing.id))
          setIsBookmarked(false)
        }
      } else {
        const added = await browserBookmarkAdd(pageTitle === 'Browser' ? '' : pageTitle, currentUrl)
        setBookmarks((prev) => [added, ...prev.filter((b) => b.id !== added.id)])
        setIsBookmarked(true)
      }
    } catch (error) {
      setError(String(error))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUrl, isBookmarked, bookmarks, pageTitle, status])

  const openBookmarkDropdown = useCallback(() => {
    setBookmarkDropdownOpen((prev) => !prev)
  }, [])


  // 点击外部关闭历史下拉
  useEffect(() => {
    if (!historyDropdownOpen) return
    const onClick = () => setHistoryDropdownOpen(false)
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [historyDropdownOpen])

  // 路由变化时记录历史
  useEffect(() => {
    const url = currentUrl
    if (!url) return
    const stack = historyStackRef.current
    const idx = historyIndexRef.current
    // 若当前 URL 与栈当前位置相同，说明是同一个条目（如 reload），跳过
    if (stack[idx] === url) return
    // 删除当前位置之后的所有记录（如果有，说明发生过前进）
    stack.splice(idx + 1)
    stack.push(url)
    // 防止记录过多
    if (stack.length > 100) stack.shift()
    historyIndexRef.current = stack.length - 1
  }, [currentUrl])

  const toast = useToastStore()
  const updateBrowserTab = useTabStore((state) => state.updateBrowserTab)
  const markBrowserNavigationHandled = useTabStore((state) => state.markBrowserNavigationHandled)
  const { sendMessage } = useActiveSessionActions()
  const currentWorkspace = useWorkspaceStore((state) => state.getCurrentWorkspace())
  const closeTab = useTabStore((state) => state.closeTab)
  const isLocalDev = useMemo(() => isLocalDevUrl(currentUrl), [currentUrl])
  const latestOperation = operationEvents[0]

  const getContainerBounds = useCallback((): BrowserBounds | null => {
    const container = containerRef.current
    if (!container) {
      log('getContainerBounds: containerRef is null')
      return null
    }

    const rect = container.getBoundingClientRect()
    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
    log('getContainerBounds', bounds)
    return bounds
  }, [])

  const syncBounds = useCallback(async () => {
    if (!readyRef.current) {
      log('syncBounds: skipped (not ready)')
      return
    }
    const bounds = getContainerBounds()
    if (!bounds) {
      log('syncBounds: skipped (no bounds)')
      return
    }

    const occluded = isBrowserOccludedByAppOverlay(bounds, rootRef.current)
    const nextBounds = occluded ? HIDDEN_BROWSER_BOUNDS : bounds

    if (occluded) {
      log('syncBounds: OCCLUDED by app overlay → HIDDEN_BOUNDS', { bounds })
    }

    // 跳过相等检查的情况：当前 bounds 是隐藏状态但实际需要显示，必须强制恢复
    if (boundsEqual(lastAppliedBoundsRef.current, nextBounds)) {
      const isHidden = lastAppliedBoundsRef.current === HIDDEN_BROWSER_BOUNDS
      const needShow = nextBounds !== HIDDEN_BROWSER_BOUNDS
      if (!isHidden || !needShow) {
        log('syncBounds: skipped (bounds unchanged)', { prev: lastAppliedBoundsRef.current, next: nextBounds })
        return
      }
    }

    log('syncBounds: applying bounds', { prev: lastAppliedBoundsRef.current, next: nextBounds })
    await browserSetBounds(webviewLabel, nextBounds)
    lastAppliedBoundsRef.current = nextBounds
  }, [getContainerBounds, webviewLabel])

  const scheduleSyncBounds = useCallback(() => {
    const now = Date.now()
    if (now - lastSyncTimeRef.current < SYNC_THROTTLE_MS) {
      log('scheduleSyncBounds: throttled')
      return
    }
    lastSyncTimeRef.current = now
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current)
    }
    log('scheduleSyncBounds: scheduled')
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      syncBounds().catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
      })
    })
  }, [syncBounds])

  useEffect(() => {
    mountedRef.current = true
    readyRef.current = false

    if (!isTauriRuntime()) {
      setStatus('native-unavailable')
      return () => {
        mountedRef.current = false
        readyRef.current = false
      }
    }

    let resizeObserver: ResizeObserver | null = null
    let cleanup = false
    let unlistenSession: UnlistenFn | null = null
    let unlistenOperation: UnlistenFn | null = null
    let mutationObserver: MutationObserver | null = null

    async function completeAcquire(
      session: BrowserSessionInfo,
      created: boolean,
      acquireError?: string
    ) {
      if (!acquireRequestId) {
        return
      }
      // 每次 mount 都调用 completeAcquire，后端对重复调用幂等安全
      await browserAcquireComplete({
        requestId: acquireRequestId,
        label: acquireError ? undefined : webviewLabel,
        tabId: acquireError ? undefined : tabId,
        url: acquireError ? undefined : session.url || normalizedInitialUrl,
        title: acquireError ? undefined : session.title || 'Browser',
        created: acquireError ? undefined : created,
        error: acquireError,
      }).catch(() => undefined)
    }

    async function createNativeWebview() {
      setLoading(true); loadingRef.current = true
      setLoadingTimeout(false)
      setError(null)
      // 30s 加载超时检测
      loadingTimeoutRef.current = window.setTimeout(() => {
        if (mountedRef.current && loadingRef.current) {
          setLoadingTimeout(true)
        }
      }, LOADING_TIMEOUT_MS)
      try {
        const bounds = getContainerBounds() ?? { x: 0, y: 0, width: 320, height: 240 }
        log('createNativeWebview: initial bounds', { bounds, webviewLabel })
        const session = await browserCreate(webviewLabel, tabId, normalizedInitialUrl, bounds, 'Browser')
        lastAppliedBoundsRef.current = bounds

        unlistenSession = await listen<BrowserSessionInfo>('browser://session-updated', (event) => {
          const session = event.payload
          if (session.label !== webviewLabel) return

          if (session.url) {
            setCurrentUrl(session.url)
            if (!addressFocusedRef.current) {
              setAddress(session.url)
            }
            updateBrowserTab(tabId, { url: session.url })
          }
          if (session.title) {
            setPageTitle(session.title)
            updateBrowserTab(tabId, { title: session.title })
          }
          // 同步 agent 所有权标识(ADR 0004 P2 #3)
          setBoundAgentKey(session.boundAgentKey ?? null)
        })
        unlistenOperation = await listen<BrowserOperationEvent>('browser://operation', (event) => {
          const operation = event.payload
          if (operation.label !== webviewLabel) return

          setOperationEvents((items) => [operation, ...items].slice(0, MAX_OPERATION_EVENTS))
        })
        // 监听溢出菜单动作
        const unlistenOverflow = await listen<{ label: string; action: string }>('browser://overflow-menu-action', (event) => {
          const { action } = event.payload
          if (action === 'devtools') { browserToggleDevtools(webviewLabel).catch(() => undefined) }
          if (action === 'copyUrl') { copyUrl() }
          if (action === 'openExternal') { openExternal() }
          if (action === 'clearData') { browserClearData(webviewLabel).catch(() => undefined) }
        })
        unlistenOverflowRef.current = unlistenOverflow

        readyRef.current = true
        setStatus('ready')
        const nextUrl = session.url || normalizedInitialUrl
        const nextTitle = session.title || 'Browser'
        setCurrentUrl(nextUrl)
        setAddress(nextUrl)
        setPageTitle(nextTitle)
        updateBrowserTab(tabId, { url: nextUrl, title: nextTitle })
        const handledRequestId = initialNavigationRequestRef.current
        if (handledRequestId !== undefined) {
          markBrowserNavigationHandled(tabId, handledRequestId)
        }
        void completeAcquire(session, acquireCreated ?? true)

        resizeObserver = new ResizeObserver(scheduleSyncBounds)
        if (containerRef.current) {
          resizeObserver.observe(containerRef.current)
        }
        window.addEventListener('resize', scheduleSyncBounds)
        window.addEventListener('scroll', scheduleSyncBounds, true)
        document.addEventListener('animationend', scheduleSyncBounds, true)
        document.addEventListener('transitionend', scheduleSyncBounds, true)
        mutationObserver = new MutationObserver(scheduleSyncBounds)
        mutationObserver.observe(document.body, {
          attributes: true,
          attributeFilter: [
            'aria-hidden',
            'aria-modal',
            'class',
            'data-native-webview-overlay',
            'hidden',
            'open',
            'role',
            'style',
          ],
          // 仅监听顶层 childList 变化（模态框/弹窗的增删），
          // 不对所有后代元素做属性监听，避免 ~300ms/mutation 采集开销
          childList: true,
          subtree: false,
        })
        scheduleSyncBounds()
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        void completeAcquire(
          {
            label: webviewLabel,
            tabId,
            url: normalizedInitialUrl,
            title: 'Browser',
            updatedAt: Date.now(),
          },
          false,
          message
        )
        if (!cleanup && mountedRef.current) {
          setStatus('error')
          setError(message)
        }
      } finally {
        if (!cleanup && mountedRef.current) {
          setLoading(false); loadingRef.current = false
        }
      }
    }

    log('BrowserPanel MOUNT', { tabId, webviewLabel, normalizedInitialUrl, acquireRequestId })
    createNativeWebview()

    return () => {
      log('BrowserPanel UNMOUNT', { tabId, webviewLabel, lastAppliedBounds: lastAppliedBoundsRef.current })
      cleanup = true
      mountedRef.current = false
      readyRef.current = false
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      unlistenSession?.()
      unlistenOperation?.()
      unlistenOverflowRef.current?.()
      window.removeEventListener('resize', scheduleSyncBounds)
      window.removeEventListener('scroll', scheduleSyncBounds, true)
      document.removeEventListener('animationend', scheduleSyncBounds, true)
      document.removeEventListener('transitionend', scheduleSyncBounds, true)
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (loadingTimeoutRef.current !== null) {
        window.clearTimeout(loadingTimeoutRef.current)
        loadingTimeoutRef.current = null
      }
      browserSetAiOverlay(webviewLabel, false).catch(() => undefined)
      // 销毁 WebView 而非隐藏，释放 renderer 进程（~350MB）。
      // 开源节流：浏览器面板不是高频切换场景，销毁重建代价远小于常驻一个 350MB/40% CPU 的进程。
      log('BrowserPanel UNMOUNT: destroying webview', { webviewLabel })
      browserClose(webviewLabel).catch(() => undefined)
      lastAppliedBoundsRef.current = HIDDEN_BROWSER_BOUNDS
    }
  }, [
    getContainerBounds,
    acquireCreated,
    acquireRequestId,
    markBrowserNavigationHandled,
    normalizedInitialUrl,
    scheduleSyncBounds,
    tabId,
    updateBrowserTab,
    webviewLabel,
  ])

  useEffect(() => {
    if (!isTauriRuntime() || status !== 'ready') {
      return
    }

    let cancelled = false
    let intervalId: number | null = null

    async function refreshOverlay() {
      if (document.hidden) return
      try {
        const result = await browserSetAiOverlay(webviewLabel, aiOperationMode)
        if (cancelled) return
        setHighlightCount(result.enabled ? result.count : null)
      } catch (e) {
        if (cancelled) return
        setHighlightCount(null)
        if (aiOperationMode) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }
    }

    const timeout = window.setTimeout(refreshOverlay, aiOperationMode ? 350 : 0)

    if (aiOperationMode) {
      intervalId = window.setInterval(refreshOverlay, 3000)
    }

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
      if (intervalId !== null) window.clearInterval(intervalId)
    }
  }, [aiOperationMode, currentUrl, status, webviewLabel])

  // overlayStore 订阅：当有覆盖层打开时立即隐藏 WebView
  const overlayCount = useOverlayStore((s) => s.count)
  const overlayPrevCountRef = useRef(0)
  useEffect(() => {
    const prev = overlayPrevCountRef.current
    overlayPrevCountRef.current = overlayCount

    if (overlayCount > 0 && prev === 0) {
      // 覆盖层打开：立即隐藏 WebView
      log('overlayStore: hiding webview (count > 0)', { count: overlayCount })
      browserSetBounds(webviewLabel, HIDDEN_BROWSER_BOUNDS).catch(() => undefined)
      lastAppliedBoundsRef.current = HIDDEN_BROWSER_BOUNDS
    } else if (overlayCount === 0 && prev > 0) {
      // 覆盖层全部关闭：恢复 WebView
      log('overlayStore: restoring webview (count === 0)')
      syncBounds()
    }
  }, [overlayCount, webviewLabel, syncBounds])

  // 页面就绪后轮询网络信息
  useEffect(() => {
    if (status !== 'ready') return
    let cancelled = false
    const poll = async () => {
      await new Promise((r) => setTimeout(r, 1500))
      if (cancelled) return
      try {
        const info = await browserGetNetworkInfo(webviewLabel)
        if (!cancelled) setNetworkInfo(info)
      } catch {
        // 静默
      }
    }
    void poll()
    return () => { cancelled = true }
  }, [status, webviewLabel, currentUrl])

  const navigateTo = useCallback(
    async (rawUrl: string) => {
      const nextUrl = normalizeBrowserUrl(rawUrl)
      setLoading(true); loadingRef.current = true
      setLoadingTimeout(false)
      // 30s 加载超时检测
      if (loadingTimeoutRef.current !== null) {
        window.clearTimeout(loadingTimeoutRef.current)
      }
      loadingTimeoutRef.current = window.setTimeout(() => {
        if (mountedRef.current && loadingRef.current) {
          setLoadingTimeout(true)
        }
      }, LOADING_TIMEOUT_MS)
      setLoadProgress(10)
      setError(null)
      setAddress(nextUrl)
      setCurrentUrl(nextUrl)
      setPageTitle('Browser')
      setDiagnostics(null)
      setContextPreview(null)
      updateBrowserTab(tabId, { url: nextUrl, title: 'Browser' })

      const progressTimer = window.setInterval(() => {
        setLoadProgress((prev) => Math.min(prev + 15, 85))
      }, 300)

      try {
        if (status === 'native-unavailable') {
          return
        }
        await browserNavigate(webviewLabel, nextUrl)
        setLoadProgress(100)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        window.clearInterval(progressTimer)
        setLoading(false); loadingRef.current = false
          if (loadingTimeoutRef.current !== null) {
            window.clearTimeout(loadingTimeoutRef.current);
            loadingTimeoutRef.current = null
          }
        setTimeout(() => setLoadProgress(0), 400)
      }
    },
    [status, tabId, updateBrowserTab, webviewLabel]
  )

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault()
      addressFocusedRef.current = false
      navigateTo(address)
    },
    [address, navigateTo]
  )

  useEffect(() => {
    if (navigationRequestId === undefined || !navigationRequestUrl) {
      return
    }
    if (lastNavigationRequestRef.current === navigationRequestId) {
      return
    }
    if (status !== 'ready' && status !== 'native-unavailable') {
      return
    }

    lastNavigationRequestRef.current = navigationRequestId
    void navigateTo(navigationRequestUrl).then(() => {
      markBrowserNavigationHandled(tabId, navigationRequestId)
    })
  }, [markBrowserNavigationHandled, navigateTo, navigationRequestId, navigationRequestUrl, status, tabId])

  const refreshContextPreview = useCallback(async () => {
    setContextLoading(true)
    setError(null)
    try {
      const context = status === 'native-unavailable'
        ? {
            title: pageTitle || 'Browser',
            url: currentUrl,
            selectedText: '',
            metaDescription: '',
            text: '',
            headings: [],
            links: [],
          }
        : await browserGetPageContext(webviewLabel)

      setContextPreview(context)
      setAiPanelOpen(true)
      setAiPanelTab('context')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      showError(message)
    } finally {
      setContextLoading(false)
    }
  }, [currentUrl, pageTitle, status, toast, webviewLabel])

  const refreshDiagnostics = useCallback(async () => {
    if (status === 'native-unavailable') {
      setAiPanelOpen(true)
      setDiagnostics(null)
      return
    }

    setDiagnosticsLoading(true)
    setError(null)
    try {
      const result = await browserGetDiagnostics(webviewLabel, false)
      setDiagnostics(result)
      setContextPreview(result.context)
      setAiPanelOpen(true)
      setAiPanelTab('log')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      showError(message)
    } finally {
      setDiagnosticsLoading(false)
    }
  }, [status, toast, webviewLabel])

  const openExternal = useCallback(async () => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(currentUrl)
    } catch {
      window.open(currentUrl, '_blank')
    }
  }, [currentUrl])

  const copyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(currentUrl)
      toast.success(t('buttons.copied'))
    } catch (e) {
      const message = e instanceof Error ? e.message : t('browser.copyFailed', { defaultValue: '复制地址失败' })
      showError(message)
    }
  }, [currentUrl, t, toast])

  // ── 圈选 (Marquee Selection) ──

  const stopMarquee = useCallback(async () => {
    setMarqueeMode(false)
    setMarqueePolling(false)
    try {
      await browserSetMarquee(webviewLabel, false)
    } catch {
      // 静默：overlay 清理失败不应阻塞 UI
    }
  }, [webviewLabel])

  const startMarquee = useCallback(async () => {
    if (status !== 'ready') return
    setMarqueeRegions([])
    setMarqueeNote('')
    setMarqueeMode(true)
    setAiPanelOpen(true)
    setAiPanelTab('marquee')
    try {
      await browserSetMarquee(webviewLabel, true)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      showError(message)
      setMarqueeMode(false)
    }
  }, [status, webviewLabel, toast])

  // 圈选结果轮询：marqueeMode 开启期间，定期读取 overlay 写入的结果
  useEffect(() => {
    if (!marqueeMode || status !== 'ready') return
    let cancelled = false
    setMarqueePolling(true)

    const poll = async () => {
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, 400))
        if (cancelled) break
        try {
          const result = await browserGetMarqueeResult(webviewLabel)
          if (cancelled) break

          // 有矩形：先把 rects 写入 state（发送时至少有坐标）
          if (result.rects.length > 0) {
            setMarqueeRegions((prev) => {
              // 数量相同就跳过，避免重复 select_region
              if (prev.length === result.rects.length) return prev
              return result.rects.map((rect, idx) => ({
                id: idx,
                rect,
                count: 0,
                elements: [],
                htmlSnippet: '',
                textSnippet: '',
              }))
            })

            // 异步补充元素详情（不阻塞轮询）
            void Promise.all(
              result.rects.map(async (rect, idx) => {
                try {
                  const region = await browserSelectRegion(webviewLabel, rect)
                  return { idx, region }
                } catch {
                  return null
                }
              })
            ).then((details) => {
              if (cancelled) return
              setMarqueeRegions((prev) => {
                let changed = false
                const next = prev.map((r, i) => {
                  const detail = details.find((d) => d?.idx === i)
                  if (detail && r.elements.length === 0) {
                    changed = true
                    return {
                      ...r,
                      count: detail.region.count,
                      elements: detail.region.elements,
                      htmlSnippet: detail.region.htmlSnippet,
                      textSnippet: detail.region.textSnippet ?? '',
                    }
                  }
                  return r
                })
                return changed ? next : prev
              })
            })
          }

          // 圈选完成：先确保最后一次结果已写入，再延迟关闭 overlay
          if (result.done) {
            cancelled = true
            setMarqueePolling(false)
            // 延迟关闭 overlay，确保 select_region 能读到最终数据
            setTimeout(() => {
              void browserSetMarquee(webviewLabel, false).catch(() => undefined)
              setMarqueeMode(false)
            }, 300)
            break
          }
        } catch {
          // 轮询失败：继续尝试，不阻塞
        }
      }
    }

    void poll()
    return () => {
      cancelled = true
      setMarqueePolling(false)
    }
  }, [marqueeMode, status, webviewLabel])

  // 监听工具栏容器宽度，用于响应式显隐
  useEffect(() => {
    const el = toolbarWidthRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setToolbarWidth(entry.contentRect.width)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 组件卸载 / 会话切换时清理 overlay
  useEffect(() => {
    return () => {
      browserSetMarquee(webviewLabel, false).catch(() => undefined)
    }
  }, [webviewLabel])

  const sendMarqueeToChat = useCallback(async () => {
    if (!currentWorkspace) {
      toast.error(t('messages.noWorkspace'))
      return
    }

    // 发送前主动同步一次圈选结果，避免轮询未及时填充
    let regionsToSend = marqueeRegions
    if (regionsToSend.length === 0 && status === 'ready') {
      try {
        const result = await browserGetMarqueeResult(webviewLabel)
        if (result.rects.length > 0) {
          const fetched: (BrowserRegion | null)[] = await Promise.all(
            result.rects.map(async (rect, idx) => {
              try {
                const region = await browserSelectRegion(webviewLabel, rect)
                const r: BrowserRegion = {
                  id: idx,
                  rect,
                  count: region.count,
                  elements: region.elements,
                  htmlSnippet: region.htmlSnippet,
                  textSnippet: region.textSnippet ?? '',
                }
                return r
              } catch {
                return null
              }
            })
          )
          regionsToSend = fetched.filter((r): r is BrowserRegion => r !== null)
          setMarqueeRegions(regionsToSend)
        }
      } catch {
        // 同步失败，继续用现有 state
      }
    }

    if (regionsToSend.length === 0) {
      toast.error(t('browser.marqueeEmpty', { defaultValue: '请先在页面上圈选一个区域' }))
      return
    }

    setMarqueeSending(true)
    try {
      const context: BrowserRegionContext = {
        title: pageTitle || 'Browser',
        url: currentUrl,
        regions: regionsToSend,
        userNote: marqueeNote.trim() || undefined,
      }
      const text = formatMarqueeContext(context)
      await sendMessage(text, currentWorkspace.path)
      // 发送成功后清理圈选状态
      setMarqueeRegions([])
      setMarqueeNote('')
      setMarqueeMode(false)
      setAiPanelOpen(false)
      toast.success(t('browser.marqueeSent', { defaultValue: '已发送圈选上下文给 AI' }))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      showError(message)
    } finally {
      setMarqueeSending(false)
    }
  }, [marqueeRegions, currentWorkspace, pageTitle, currentUrl, marqueeNote, sendMessage, toast, t, status, webviewLabel])

  // ── 页面内查找 (Ctrl+F) ──

  const handleFind = useCallback(async (query: string) => {
    if (!query.trim() || status !== 'ready') return
    try {
      const result = await browserFind(webviewLabel, query)
      setFindResult(result)
    } catch (e) {
      setFindResult({ ok: false, action: 'find', index: null, text: query, url: currentUrl, message: String(e) })
    }
  }, [status, webviewLabel, currentUrl])

  const handleFindNext = useCallback(async (forward: boolean) => {
    if (status !== 'ready') return
    try {
      const result = await browserFindNext(webviewLabel, forward)
      setFindResult(result)
    } catch {
      // 静默
    }
  }, [status, webviewLabel])

  const openFind = useCallback(() => {
    setFindOpen(true)
    setFindQuery('')
    setFindResult(null)
    setTimeout(() => findInputRef.current?.focus(), 50)
  }, [])

  const closeFind = useCallback(() => {
    setFindOpen(false)
    setFindQuery('')
    setFindResult(null)
  }, [])

  // 键盘快捷键：Ctrl+F(查找)/Ctrl+L(地址栏)/Ctrl+W(关闭标签)/Alt+Left(后退)/Alt+Right(前进)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        if (!findOpen) openFind()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault()
        addressInputRef.current?.focus()
        addressInputRef.current?.select()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault()
        closeTab(tabId)
        return
      }
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        browserHistory(webviewLabel, 'back').catch(() => undefined)
        return
      }
      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault()
        browserHistory(webviewLabel, 'forward').catch(() => undefined)
        return
      }
      if (e.key === 'Escape' && findOpen) {
        closeFind()
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [findOpen, openFind, closeFind, closeTab, tabId, webviewLabel])

  // ── 缩放控制 ──

  const handleZoom = useCallback(async (newScale: number) => {
    const clamped = Math.max(0.25, Math.min(5.0, newScale))
    setZoomLevel(clamped)
    if (status === 'ready') {
      try {
        await browserZoom(webviewLabel, clamped)
      } catch {
        // 静默
      }
    }
  }, [status, webviewLabel])

  const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0]

  const zoomIn = useCallback(() => {
    const next = ZOOM_STEPS.find((s) => s > zoomLevel) || zoomLevel
    handleZoom(next)
  }, [zoomLevel, handleZoom])

  const zoomOut = useCallback(() => {
    const prev = [...ZOOM_STEPS].reverse().find((s) => s < zoomLevel) || zoomLevel
    handleZoom(prev)
  }, [zoomLevel, handleZoom])

  const resetZoom = useCallback(() => {
    handleZoom(1.0)
  }, [handleZoom])

  const toolbarButtonClass =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45'
  const taskButtonClass =
    'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border-subtle bg-background-surface px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45'


  const hostText = useMemo(() => {
    try {
      return new URL(currentUrl).host || currentUrl
    } catch {
      return currentUrl
    }
  }, [currentUrl])
  const faviconSrc = useMemo(() => {
    try {
      const url = new URL(currentUrl)
      return `https://icons.duckduckgo.com/ip3/${url.hostname}.ico`
    } catch {
      return null
    }
  }, [currentUrl])
  const contextExcerpt = useMemo(() => {
    const selected = contextPreview?.selectedText.trim()
    const text = selected || contextPreview?.metaDescription || contextPreview?.text || ''
    return text.trim().slice(0, 520)
  }, [contextPreview])
  const contextHeadings = useMemo(
    () => contextPreview?.headings.filter((heading) => heading.text).slice(0, 5) ?? [],
    [contextPreview]
  )
  const diagnosticsIssueCount = useMemo(
    () =>
      diagnostics?.consoleMessages.filter((item) =>
        ['error', 'warn'].includes(item.level.toLowerCase())
      ).length ?? 0,
    [diagnostics]
  )
  const diagnosticsLatestIssue = useMemo(
    () => {
      const issues =
        diagnostics?.consoleMessages.filter((item) =>
          ['error', 'warn'].includes(item.level.toLowerCase())
        ) ?? []
      return issues[issues.length - 1]
    },
    [diagnostics]
  )

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col overflow-hidden bg-background-base">
      <div ref={toolbarWidthRef} className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle bg-background-elevated px-3">
        {/* 导航按钮组 */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={toolbarButtonClass}
            onClick={() => browserHistory(webviewLabel, 'back').catch((e) => setError(String(e)))}
            onMouseDown={() => {
              // 长按 500ms 显示历史下拉菜单
              const timer = window.setTimeout(() => {
                if (historyStackRef.current.length > 0 && historyIndexRef.current > 0) {
                  setHistoryDropdownDirection('back')
                  setHistoryDropdownOpen(true)
                }
              }, 500)
              const handleMouseUp = () => { window.clearTimeout(timer); document.removeEventListener('mouseup', handleMouseUp) }
              document.addEventListener('mouseup', handleMouseUp)
            }}
            disabled={status !== 'ready'}
            title={t('browser.back', { defaultValue: '后退' })}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            type="button"
            className={toolbarButtonClass}
            onClick={() => browserHistory(webviewLabel, 'forward').catch((e) => setError(String(e)))}
            onMouseDown={() => {
              // 长按 500ms 显示历史下拉菜单
              const timer = window.setTimeout(() => {
                if (historyStackRef.current.length > 0 && historyIndexRef.current < historyStackRef.current.length - 1) {
                  setHistoryDropdownDirection('forward')
                  setHistoryDropdownOpen(true)
                }
              }, 500)
              const handleMouseUp = () => { window.clearTimeout(timer); document.removeEventListener('mouseup', handleMouseUp) }
              document.addEventListener('mouseup', handleMouseUp)
            }}
            disabled={status !== 'ready'}
            title={t('browser.forward', { defaultValue: '前进' })}
          >
            <ArrowRight size={16} />
          </button>
          <button
            type="button"
            className={toolbarButtonClass}
            onClick={() => browserReload(webviewLabel).catch((e) => setError(String(e)))}
            disabled={status !== 'ready'}
            title={t('buttons.refresh')}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* 地址栏：安全指示 + favicon + 加载进度 */}
        <form onSubmit={handleSubmit} className="min-w-0 flex-1">
          <div className="relative flex h-8 min-w-0 items-center gap-1 rounded-md border border-border-subtle bg-background-surface px-2 text-text-tertiary focus-within:border-primary/70 focus-within:text-text-secondary">
            {/* Favicon */}
            {faviconSrc && (
              <img
                src={faviconSrc}
                alt=""
                className="h-4 w-4 shrink-0 rounded-sm"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            )}
            {/* 安全指示 */}
            <span className="shrink-0 text-text-tertiary" title={currentUrl.startsWith('https://') ? '连接安全 (HTTPS)' : '连接不安全'}>
              {currentUrl.startsWith('https://') ? <Lock size={12} /> : <Unlock size={12} className="text-warning" />}
            </span>
            <input
              ref={addressInputRef}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onFocus={() => {
                addressFocusedRef.current = true
              }}
              onBlur={() => {
                addressFocusedRef.current = false
              }}
              className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
              placeholder={t('browser.addressPlaceholder', { defaultValue: '输入网址或搜索内容' })}
            />
            <button
              type="submit"
              className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-background-hover hover:text-text-primary"
              title={t('browser.go', { defaultValue: '访问' })}
            >
              <Search size={14} />
            </button>
            {address.trim() !== currentUrl && address.trim() !== '' && (
              <button
                type="button"
                onClick={() => setAddress('')}
                className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-background-hover hover:text-text-primary"
                title={t('browser.clearAddress', { defaultValue: '清除' })}
              >
                <X size={12} />
              </button>
            )}
            {/* 加载进度条 */}
            {loading && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden rounded-full">
                <div className="h-full w-full animate-pulse rounded-full bg-primary" />
              </div>
            )}
          </div>
        </form>

        {/* 书签：星标切换 + 下拉列表 */}
        <div className="relative flex items-center">
          <button
            type="button"
            className={clsx(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
              isBookmarked
                ? 'text-amber-400 hover:bg-background-hover'
                : 'text-text-tertiary hover:bg-background-hover hover:text-text-primary'
            )}
            onClick={toggleBookmark}
            disabled={status !== 'ready' || !currentUrl}
            title={
              isBookmarked
                ? t('browser.removeBookmark', { defaultValue: '取消收藏' })
                : t('browser.addBookmark', { defaultValue: '收藏当前页面' })
            }
          >
            <Bookmark size={15} fill={isBookmarked ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-background-hover hover:text-text-primary"
            onClick={openBookmarkDropdown}
            title={t('browser.bookmarkList', { defaultValue: '书签列表' })}
          >
            <ChevronDown size={14} />
          </button>
          {bookmarkDropdownOpen && (
            <div
              ref={bookmarkListRef}
              className="absolute right-0 top-9 z-50 max-h-72 w-72 overflow-y-auto rounded-md border border-border-subtle bg-background-elevated py-1 shadow-lg"
            >
              <div className="flex items-center justify-between px-3 py-1.5 text-xs font-medium text-text-secondary">
                <span>{t('browser.bookmarkList', { defaultValue: '书签' })}</span>
                <span className="text-[10px] text-text-tertiary">{bookmarks.length}</span>
              </div>
              {bookmarks.length === 0 && (
                <div className="px-3 py-2 text-xs text-text-tertiary">
                  {t('browser.bookmarksEmpty', { defaultValue: '暂无书签' })}
                </div>
              )}
              {bookmarks.map((bookmark) => (
                <button
                  key={bookmark.id}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-background-hover"
                  onClick={() => {
                    setBookmarkDropdownOpen(false)
                    navigateTo(bookmark.url)
                  }}
                  title={bookmark.url}
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{bookmark.title || bookmark.url}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="shrink-0 text-text-tertiary hover:text-danger"
                    onClick={(event) => {
                      event.stopPropagation()
                      browserBookmarkDelete(bookmark.id)
                        .then(() => {
                          setBookmarks((prev) => prev.filter((b) => b.id !== bookmark.id))
                          if (currentUrl === bookmark.url) setIsBookmarked(false)
                        })
                        .catch((e) => setError(String(e)))
                    }}
                  >
                    <X size={12} />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 工具按钮组 */}
        <div className="flex items-center gap-1">
          <div className="mx-1 h-5 w-px bg-border-subtle" />
          <button
            type="button"
            className={clsx(taskButtonClass, toolbarWidth < 680 && 'hidden')}
            onClick={refreshContextPreview}
            disabled={contextLoading}
            title={t('browser.previewContext', { defaultValue: '预览发送给 AI 的网页上下文' })}
          >
            {contextLoading ? <Loader2 size={15} className="animate-spin" /> : <ListTree size={15} />}
            <span className="hidden 2xl:inline">
              {t('browser.contextPreview', { defaultValue: '上下文' })}
            </span>
          </button>
          <button
            type="button"
            className={clsx(taskButtonClass, toolbarWidth < 680 && 'hidden')}
            onClick={refreshDiagnostics}
            disabled={diagnosticsLoading || status !== 'ready'}
            title={t('browser.diagnosticsHint', { defaultValue: '读取 DOM、Console 和可操作元素诊断' })}
          >
            {diagnosticsLoading ? <Loader2 size={15} className="animate-spin" /> : <Activity size={15} />}
            <span className="hidden 2xl:inline">
              {t('browser.diagnostics', { defaultValue: '诊断' })}
            </span>
          </button>
          <button
            type="button"
            className={clsx(
              taskButtonClass,
              toolbarWidth < 520 && 'hidden',
              aiOperationMode && 'border-primary/60 bg-primary/10 text-primary hover:text-primary'
            )}
            onClick={() => setAiOperationMode((enabled) => !enabled)}
            disabled={status !== 'ready'}
            title={t('browser.operationModeHint', { defaultValue: '显示 AI 可点击/可填写元素编号' })}
          >
            <MousePointer2 size={15} />
            <span className="hidden 2xl:inline">
              {t('browser.operationMode', { defaultValue: 'AI 操作' })}
            </span>
          </button>
          <button
            type="button"
            className={clsx(taskButtonClass, findOpen && 'border-primary/60 bg-primary/10 text-primary')}
            onClick={findOpen ? closeFind : openFind}
            disabled={status !== 'ready'}
            title={t('browser.find', { defaultValue: '在页面中查找 (Ctrl+F)' })}
          >
            <Search size={15} />
            <span className="hidden 2xl:inline">
              {t('browser.find', { defaultValue: '查找' })}
            </span>
          </button>
          <button
            type="button"
            className={clsx(
              taskButtonClass,
              marqueeMode && 'border-primary/60 bg-primary/10 text-primary hover:text-primary'
            )}
            onClick={() => (marqueeMode ? stopMarquee() : startMarquee())}
            disabled={status !== 'ready'}
            title={t('browser.marqueeHint', { defaultValue: '圈选页面区域发给 AI' })}
          >
            <BoxSelect size={15} />
            <span className="hidden 2xl:inline">
              {t('browser.marquee', { defaultValue: '圈选' })}
            </span>
          </button>
          {/* 溢出菜单按钮 */}
          <button
            type="button"
            className={toolbarButtonClass}
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              browserShowOverflowMenu(webviewLabel, rect.right, rect.bottom).catch(() => undefined)
            }}
            disabled={status !== 'ready'}
            title={t('browser.more', { defaultValue: '更多' })}
          >
            <Code2 size={15} />
          </button>
        </div>
      </div>

        {/* 历史快照下拉菜单 */}
        {historyDropdownOpen && (
          <div
            ref={historyDropdownRef}
            className="absolute z-50 mt-1 max-h-48 w-64 overflow-y-auto rounded-md border border-border-subtle bg-background-elevated shadow-lg"
            style={{ top: '44px', left: '12px' }}
            onClick={() => setHistoryDropdownOpen(false)}
            onMouseLeave={() => setHistoryDropdownOpen(false)}
          >
            {(() => {
              const stack = historyStackRef.current
              const idx = historyIndexRef.current
              const items = historyDropdownDirection === 'back'
                ? stack.slice(0, idx).reverse().slice(0, 15)
                : stack.slice(idx + 1).slice(0, 15)
              return items.length > 0 ? items.map((url, i) => (
                <button
                  key={`${url}-${i}`}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-background-hover hover:text-text-primary truncate"
                  onClick={() => {
                    navigateTo(url)
                    setHistoryDropdownOpen(false)
                  }}
                >
                  <Globe2 size={11} className="shrink-0 text-text-tertiary" />
                  <span className="truncate">{(() => { try { return new URL(url).hostname } catch { return url } })()}</span>
                </button>
              )) : (
                <div className="px-3 py-2 text-xs text-text-tertiary text-center">
                  {t('browser.noHistory', { defaultValue: '暂无历史记录' })}
                </div>
              )
            })()}
          </div>
        )}

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger">
          <AlertTriangle size={14} />
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-danger hover:bg-danger/10"
            onClick={() => setError(null)}
          >
            {t('buttons.close')}
          </button>
        </div>
      )}

      {findOpen && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-background-elevated px-3 py-1.5">
          <Search size={13} className="shrink-0 text-text-tertiary" />
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value)
              if (e.target.value.trim()) handleFind(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (e.shiftKey) handleFindNext(false)
                else if (findQuery.trim()) handleFind(findQuery)
              }
              if (e.key === 'Escape') closeFind()
            }}
            className="h-7 min-w-0 flex-1 rounded-md border border-border-subtle bg-background-surface px-2.5 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-primary/70"
            placeholder={t('browser.findPlaceholder', { defaultValue: '在页面中查找...' })}
          />
          {findResult && (
            <span className={clsx(
              'shrink-0 text-[11px]',
              findResult.ok ? 'text-text-secondary' : 'text-danger'
            )}>
              {findResult.message}
            </span>
          )}
          <button
            type="button"
            onClick={() => handleFindNext(false)}
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-background-hover hover:text-text-primary"
            title={t('browser.findPrevious', { defaultValue: '上一个' })}
          >
            <ChevronUp size={13} />
          </button>
          <button
            type="button"
            onClick={() => handleFindNext(true)}
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-background-hover hover:text-text-primary"
            title={t('browser.findNext', { defaultValue: '下一个' })}
          >
            <ChevronDown size={13} />
          </button>
          <button
            type="button"
            onClick={closeFind}
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-background-hover hover:text-text-primary"
            title={t('buttons.close')}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {loadProgress > 0 && (
          <div className="absolute top-0 left-0 right-0 h-0.5 z-10 bg-primary/20">
            <div
              className="h-full bg-primary transition-all duration-300 ease-out"
              style={{ width: `${loadProgress}%` }}
            />
          </div>
        )}
        <div ref={containerRef} className="absolute inset-0 bg-background-base" />

        {status === 'native-unavailable' && (
          <iframe
            title="Polaris Browser"
            src={currentUrl}
            className="absolute inset-0 h-full w-full border-0 bg-background-base"
            sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
          />
        )}

        {(loading || status === 'idle') && (
          <div className="absolute inset-0 flex flex-col bg-background-base">
            {/* 骨架屏：模拟页面结构 */}
            <div className="flex flex-col gap-4 p-6 animate-pulse">
              {/* 地址栏骨架 */}
              <div className="flex items-center gap-2">
                <div className="h-4 w-4 rounded-full bg-background-hover" />
                <div className="h-4 flex-1 rounded-md bg-background-hover" />
              </div>
              {/* 导航栏骨架 */}
              <div className="flex items-center gap-3">
                <div className="h-3 w-16 rounded bg-background-hover" />
                <div className="h-3 w-20 rounded bg-background-hover" />
                <div className="h-3 w-24 rounded bg-background-hover" />
              </div>
              {/* 内容骨架 */}
              <div className="flex flex-col gap-3">
                <div className="h-4 w-3/4 rounded bg-background-hover" />
                <div className="h-4 w-1/2 rounded bg-background-hover" />
                <div className="h-4 w-5/6 rounded bg-background-hover" />
                <div className="h-4 w-2/3 rounded bg-background-hover" />
                <div className="h-4 w-4/5 rounded bg-background-hover" />
              </div>
              {/* 卡片骨架 */}
              <div className="grid grid-cols-3 gap-3">
                <div className="h-24 rounded-lg bg-background-hover" />
                <div className="h-24 rounded-lg bg-background-hover" />
                <div className="h-24 rounded-lg bg-background-hover" />
              </div>
            </div>
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-md border border-border-subtle bg-background-elevated/95 px-3 py-1.5 text-xs text-text-secondary">
              <Loader2 size={13} className="animate-spin text-primary" />
              <span>{t('status.loading')}</span>
            </div>
          </div>
        )}

        {loadingTimeout && (
          <div className="absolute top-10 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning shadow-lg">
            <AlertTriangle size={12} />
            <span>{t('browser.loadingTimeout', { defaultValue: '页面加载超时，可能网络较慢或页面无响应' })}</span>
            <button
              type="button"
              onClick={() => navigateTo(currentUrl)}
              className="ml-1 rounded bg-warning/20 px-2 py-0.5 text-[11px] text-warning hover:bg-warning/30"
            >
              {t('browser.retryLoading', { defaultValue: '重试' })}
            </button>
          </div>
        )}
        {status === 'error' && !loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background-base">
            <div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
              <div className="rounded-full bg-danger/10 p-3">
                <Code2 size={32} className="text-danger" />
              </div>
              <div className="text-sm font-medium text-text-primary">
                {t('browser.nativeFailed', { defaultValue: '内置浏览器启动失败' })}
              </div>
              <div className="max-w-xs text-xs text-text-tertiary leading-5">{error}</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => navigateTo(currentUrl)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-4 text-xs font-medium text-white transition-colors hover:bg-primary-hover"
                >
                  <RefreshCw size={13} />
                  {t('buttons.retry')}
                </button>
                <button
                  type="button"
                  onClick={() => closeTab(tabId)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-subtle px-3 text-xs text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary"
                >
                  <X size={13} />
                  {t('browser.closeTab', { defaultValue: '关闭标签' })}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {aiPanelOpen && (
        <div className="shrink-0 border-t border-border-subtle bg-background-elevated">
          <div className="flex items-center justify-between gap-3 px-3 pt-2 pb-0">
            <div className="flex items-center gap-1 text-xs font-medium text-text-secondary">
              <PanelBottom size={14} className="text-primary" />
              <span className="truncate">
                {t('browser.aiPanel', { defaultValue: 'AI 面板' })}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setAiPanelOpen(false)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-background-hover hover:text-text-primary"
              title={t('buttons.close')}
            >
              <X size={13} />
            </button>
          </div>

          <div className="flex gap-0 border-b border-border-subtle px-3 mt-1">
            <TabButton
              active={aiPanelTab === 'context'}
              onClick={() => setAiPanelTab('context')}
              label={t('browser.contextPreview', { defaultValue: '上下文' })}
            />
            <TabButton
              active={aiPanelTab === 'marquee'}
              onClick={() => setAiPanelTab('marquee')}
              label={t('browser.marquee', { defaultValue: '圈选' })}
              count={marqueeRegions.length}
            />
            <TabButton
              active={aiPanelTab === 'log'}
              onClick={() => setAiPanelTab('log')}
              label={t('browser.operationLog', { defaultValue: '操作日志' })}
            />
          </div>

          <div className="px-3 py-2" style={{ minHeight: aiPanelTab === 'marquee' ? '120px' : '70px' }}>
            {aiPanelTab === 'context' && (
              <div className="min-w-0 overflow-hidden rounded-md border border-border-subtle bg-background-surface p-2">
                <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
                  <div className="min-w-0 truncate text-xs font-medium text-text-primary">
                    {contextPreview?.title || pageTitle || t('browser.contextPreview', { defaultValue: '上下文' })}
                  </div>
                  {contextPreview?.selectedText.trim() && (
                    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                      {t('browser.hasSelection', { defaultValue: '已选区' })}
                    </span>
                  )}
                </div>
                <div className="mb-1 truncate text-[11px] text-text-tertiary">
                  {contextPreview?.url || currentUrl}
                </div>
                <div className="line-clamp-2 text-xs leading-5 text-text-secondary">
                  {contextExcerpt || t('browser.noContextPreview', { defaultValue: '还没有读取网页上下文。' })}
                </div>
                {contextHeadings.length > 0 && (
                  <div className="mt-1 flex min-w-0 flex-wrap gap-1 overflow-hidden">
                    {contextHeadings.map((heading, index) => (
                      <span
                        key={`${heading.level}-${heading.text}-${index}`}
                        className="max-w-[180px] truncate rounded border border-border-subtle px-1.5 py-0.5 text-[11px] text-text-tertiary"
                        title={heading.text}
                      >
                        H{heading.level} {heading.text}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {aiPanelTab === 'marquee' && (
              <div>
                {marqueeRegions.length > 0 ? (
                  <div className="mb-2 flex max-h-24 flex-col gap-1 overflow-auto">
                    {marqueeRegions.map((region, idx) => (
                      <div
                        key={`region-${idx}`}
                        className="flex min-w-0 items-center gap-2 rounded border border-border-subtle bg-background-surface px-2 py-1 text-[11px]"
                      >
                        <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 font-medium text-primary">
                          {idx + 1}
                        </span>
                        <span className="shrink-0 text-text-tertiary">
                          {Math.round(region.rect.width)}x{Math.round(region.rect.height)}
                        </span>
                        <span className="min-w-0 truncate text-text-secondary">
                          {region.count > 0
                            ? t('browser.marqueeElementCount', {
                                count: region.count,
                                defaultValue: '{{count}} 个元素',
                              })
                            : region.textSnippet
                              ? t('browser.marqueeTextOnly', { defaultValue: '纯文本区域' })
                              : t('browser.marqueeNoElement', { defaultValue: '无元素' })}
                        </span>
                        {region.elements[0] ? (
                          <span className="min-w-0 truncate text-text-tertiary">
                            - {region.elements[0].kind} "{region.elements[0].text}"
                          </span>
                        ) : region.textSnippet ? (
                          <span className="min-w-0 truncate text-text-tertiary">
                            - {region.textSnippet.slice(0, 40)}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mb-2 text-[11px] text-text-tertiary">
                    {t('browser.marqueeEmptyHint', { defaultValue: '点击工具栏圈选按钮在页面上拖拽选择区域' })}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <input
                    value={marqueeNote}
                    onChange={(e) => setMarqueeNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void sendMarqueeToChat()
                      }
                    }}
                    placeholder={t('browser.marqueeNotePlaceholder', {
                      defaultValue: '补充说明：想怎么改这个区域？',
                    })}
                    className="h-8 min-w-0 flex-1 rounded-md border border-border-subtle bg-background-surface px-2.5 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-primary/70"
                  />
                  <button
                    type="button"
                    onClick={() => void sendMarqueeToChat()}
                    disabled={marqueeSending || marqueeRegions.length === 0}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                    title={t('browser.marqueeSend', { defaultValue: '发送给 AI' })}
                  >
                    {marqueeSending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                    <span className="hidden xl:inline">
                      {t('browser.marqueeSend', { defaultValue: '发送给 AI' })}
                    </span>
                  </button>
                </div>
              </div>
            )}

            {aiPanelTab === 'log' && (
              <div>
                {diagnostics && (
                  <div className="mb-2 border-b border-border-subtle pb-2">
                    <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
                      <span className="font-medium text-text-secondary">
                        {t('browser.diagnostics', { defaultValue: '诊断' })}
                      </span>
                      <span
                        className={clsx(
                          diagnosticsIssueCount > 0 ? 'text-warning' : 'text-success'
                        )}
                      >
                        {diagnosticsIssueCount > 0
                          ? t('browser.consoleIssues', {
                              count: diagnosticsIssueCount,
                              defaultValue: '{{count}} 条 Console 风险',
                            })
                          : t('browser.consoleClean', { defaultValue: 'Console 正常' })}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-[11px] text-text-tertiary">
                      <span>
                        {t('browser.actionableCount', {
                          count: diagnostics.elements.length,
                          defaultValue: '可操作 {{count}}',
                        })}
                      </span>
                      <span>
                        {t('browser.visibleCount', {
                          count: diagnostics.visual.elements.length,
                          defaultValue: '可视 {{count}}',
                        })}
                      </span>
                      <span>
                        {diagnostics.visual.screenshot
                          ? t('browser.screenshotReady', { defaultValue: '截图可用' })
                          : t('browser.textOnlyDiagnostics', { defaultValue: '文本诊断' })}
                      </span>
                    </div>
                    {diagnosticsLatestIssue && (
                      <div className="mt-1 truncate text-[11px] text-text-secondary" title={diagnosticsLatestIssue.message}>
                        {diagnosticsLatestIssue.level}: {diagnosticsLatestIssue.message}
                      </div>
                    )}
                  </div>
                )}
                <div className="flex max-h-24 flex-col gap-1 overflow-hidden">
                  {operationEvents.length === 0 ? (
                    <div className="text-xs text-text-tertiary">
                      {t('browser.noOperationLog', { defaultValue: '暂无 AI 浏览器操作。' })}
                    </div>
                  ) : (
                    operationEvents.slice(0, 4).map((operation) => (
                      <div key={`${operation.timestamp}-${operation.action}`} className="flex min-w-0 items-center gap-2 text-xs">
                        <span
                          className={clsx(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            operation.status === 'success'
                              ? 'bg-success'
                              : operation.status === 'warning'
                                ? 'bg-warning'
                                : 'bg-danger'
                          )}
                        />
                        <span className="shrink-0 text-text-tertiary">{operation.action}</span>
                        <span className="min-w-0 truncate text-text-secondary">
                          {operation.target ? `${operation.message}: ${operation.target}` : operation.message}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!aiPanelOpen && (
        <button
          type="button"
          onClick={() => setAiPanelOpen(true)}
          disabled={!latestOperation}
          className="flex h-8 shrink-0 items-center gap-2 border-t border-border-subtle bg-background-elevated px-3 text-left text-xs text-text-secondary hover:bg-background-hover disabled:cursor-default disabled:hover:bg-background-elevated"
        >
          <Sparkles size={13} className={clsx('shrink-0', latestOperation ? 'text-primary' : 'text-text-tertiary')} />
          <span className="shrink-0 font-medium text-text-primary">
            {t('browser.operationLog', { defaultValue: 'AI 操作日志' })}
          </span>
          <span className="min-w-0 truncate">
            {latestOperation
              ? latestOperation.target
                ? `${latestOperation.message}: ${latestOperation.target}`
                : latestOperation.message
              : t('browser.noOperationLog', { defaultValue: '暂无 AI 浏览器操作。' })}
          </span>
        </button>
      )}

      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border-subtle bg-background-elevated px-3 text-[11px] text-text-tertiary">
        <span
          className={clsx(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            status === 'ready' ? 'bg-success' : status === 'error' ? 'bg-danger' : 'bg-warning'
          )}
          title={
            status === 'ready'
              ? t('status.ready', { defaultValue: '已就绪' })
              : status === 'error'
                ? t('status.error', { defaultValue: '错误' })
                : status === 'native-unavailable'
                  ? t('browser.fallbackMode', { defaultValue: '降级模式' })
                  : t('status.loading', { defaultValue: '加载中' })
          }
        />
        <span
          className="truncate font-medium text-text-secondary cursor-pointer hover:text-text-primary"
          onClick={copyUrl}
          title={currentUrl}
        >
          {hostText}
        </span>
        <span className="min-w-0 flex-1 truncate text-text-tertiary" title={currentUrl}>
          {pageTitle || currentUrl}
        </span>
        {/* 网络信息 */}
        {networkInfo && networkInfo.loadTime > 0 && (
          <span className="hidden sm:inline shrink-0 text-[10px] text-text-tertiary" title={`${networkInfo.resourceCount} 个资源, ${networkInfo.totalSizeKB}KB`}>
            {networkInfo.loadTime < 1000 ? `<${networkInfo.loadTime}ms` : `${(networkInfo.loadTime / 1000).toFixed(1)}s`}
            {' · '}{networkInfo.totalSizeKB}KB
          </span>
        )}
        {/* 缩放控制 */}
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => zoomOut()}
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary"
            title={t('browser.zoomOut', { defaultValue: '缩小' })}
            disabled={status !== 'ready'}
          >
            <Minus size={12} />
          </button>
          <button
            type="button"
            onClick={resetZoom}
            onDoubleClick={resetZoom}
            className="min-w-[36px] rounded px-1 py-0.5 text-center text-[11px] text-text-secondary transition-colors hover:bg-background-hover"
            title={t('browser.zoomReset', { defaultValue: '重置缩放 (100%)' })}
          >
            {Math.round(zoomLevel * 100)}%
          </button>
          <button
            type="button"
            onClick={() => zoomIn()}
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary"
            title={t('browser.zoomIn', { defaultValue: '放大' })}
            disabled={status !== 'ready'}
          >
            <Plus size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}

export function BrowserLauncherPanel() {
  const { t } = useTranslation('common')
  const [url, setUrl] = useState('https://www.bing.com')
  const openBrowserTab = useTabStore((state) => state.openBrowserTab)
  const closeLeftPanel = useViewStore((state) => state.closeLeftPanel)

  const open = useCallback(() => {
    const normalized = normalizeBrowserUrl(url)
    openBrowserTab(normalized, 'Browser')
    closeLeftPanel()
  }, [closeLeftPanel, openBrowserTab, url])

  const openUrl = useCallback((nextUrl: string) => {
    const normalized = normalizeBrowserUrl(nextUrl)
    openBrowserTab(normalized, 'Browser')
    closeLeftPanel()
  }, [closeLeftPanel, openBrowserTab])

  return (
    <div data-theme-panel className="flex h-full min-h-0 flex-col bg-background-elevated">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Globe2 size={16} className="text-primary" />
        <span className="text-sm font-medium text-text-primary">
          {t('labels.browserPanel', { defaultValue: '内置浏览器' })}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="text-xs leading-5 text-text-tertiary">
          {t('browser.launcherHint', {
            defaultValue: '打开学习网站、文档或本地开发页面，然后把网页上下文发送给 AI。',
          })}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {QUICK_STARTS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => openUrl(item.url)}
              className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-background-surface px-2 text-left text-xs text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary"
              title={item.url}
            >
              <Globe2 size={13} className="shrink-0 text-text-tertiary" />
              <span className="min-w-0 truncate">{item.label}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-text-secondary">
            {t('browser.address', { defaultValue: '地址' })}
          </label>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                open()
              }
            }}
            className="h-9 rounded-md border border-border-subtle bg-background-surface px-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-primary/70"
            placeholder={t('browser.addressPlaceholder', { defaultValue: '输入网址或搜索内容' })}
          />
        </div>
        <button
          type="button"
          onClick={open}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
        >
          <Globe2 size={15} />
          {t('browser.openTab', { defaultValue: '打开浏览器标签' })}
        </button>
      </div>
    </div>
  )
}

function TabButton({ active, onClick, label, count }: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'px-3 py-1.5 text-xs font-medium border-b-2 transition-colors',
        active
          ? 'text-primary border-primary'
          : 'text-text-tertiary border-transparent hover:text-text-secondary'
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className="ml-1.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
          {count}
        </span>
      )}
    </button>
  )
}
