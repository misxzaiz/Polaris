import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Activity,
  ArrowLeft,
  ArrowRight,
  Bug,
  Code2,
  Copy,
  Eraser,
  ExternalLink,
  BoxSelect,
  Globe2,
  ListTree,
  Loader2,
  MousePointer2,
  PanelBottom,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { clsx } from 'clsx'
import { useTranslation } from 'react-i18next'
import {
  browserAcquireComplete,
  browserClearData,
  browserCreate,
  browserGetDiagnostics,
  browserGetMarqueeResult,
  browserGetPageContext,
  browserHistory,
  browserNavigate,
  browserReload,
  browserSelectRegion,
  browserSetAiOverlay,
  browserSetBounds,
  browserSetMarquee,
  browserToggleDevtools,
  formatMarqueeContext,
  makeBrowserWebviewLabel,
  normalizeBrowserUrl,
  type BrowserBounds,
  type BrowserDiagnostics,
  type BrowserOperationEvent,
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
  const [loading, setLoading] = useState(false)
  const [loadProgress, setLoadProgress] = useState(0)
  const [status, setStatus] = useState<'idle' | 'ready' | 'native-unavailable' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
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

  const toast = useToastStore()
  const updateBrowserTab = useTabStore((state) => state.updateBrowserTab)
  const markBrowserNavigationHandled = useTabStore((state) => state.markBrowserNavigationHandled)
  const { sendMessage } = useActiveSessionActions()
  const currentWorkspace = useWorkspaceStore((state) => state.getCurrentWorkspace())
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
      setLoading(true)
      setError(null)
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
          childList: true,
          subtree: true,
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
          setLoading(false)
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
      window.removeEventListener('resize', scheduleSyncBounds)
      window.removeEventListener('scroll', scheduleSyncBounds, true)
      document.removeEventListener('animationend', scheduleSyncBounds, true)
      document.removeEventListener('transitionend', scheduleSyncBounds, true)
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      browserSetAiOverlay(webviewLabel, false).catch(() => undefined)
      // 移出屏幕而非隐藏，避免重挂载时 hide→show 帧窗口期黑屏；
      // 真正的遮挡隐藏由 syncBounds 的 occlusion 检测控制
      log('BrowserPanel UNMOUNT: hiding webview', { webviewLabel })
      browserSetBounds(webviewLabel, HIDDEN_BROWSER_BOUNDS).catch(() => undefined)
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

  const navigateTo = useCallback(
    async (rawUrl: string) => {
      const nextUrl = normalizeBrowserUrl(rawUrl)
      setLoading(true)
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
        setLoading(false)
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
      setError(message)
      toast.error(message)
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
      setError(message)
      toast.error(message)
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
      setError(message)
      toast.error(message)
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
      setError(message)
      toast.error(message)
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
      setError(message)
      toast.error(message)
    } finally {
      setMarqueeSending(false)
    }
  }, [marqueeRegions, currentWorkspace, pageTitle, currentUrl, marqueeNote, sendMessage, toast, t, status, webviewLabel])

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
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={toolbarButtonClass}
            onClick={() => browserHistory(webviewLabel, 'back').catch((e) => setError(String(e)))}
            disabled={status !== 'ready'}
            title={t('browser.back', { defaultValue: '后退' })}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            type="button"
            className={toolbarButtonClass}
            onClick={() => browserHistory(webviewLabel, 'forward').catch((e) => setError(String(e)))}
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

        <form onSubmit={handleSubmit} className="min-w-0 flex-1">
          <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-background-surface px-2 text-text-tertiary focus-within:border-primary/70 focus-within:text-text-secondary">
            <Globe2 size={15} className="shrink-0" />
            <input
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
          </div>
        </form>

        <div className="flex items-center gap-1">
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
        </div>
      </div>

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
          <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-md border border-border-subtle bg-background-elevated/95 px-2.5 py-1.5 text-xs text-text-secondary">
            <Loader2 size={13} className="animate-spin text-primary" />
            <span>{t('status.loading')}</span>
          </div>
        )}

        {status === 'error' && !loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background-base">
            <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
              <Code2 size={36} className="text-text-tertiary" />
              <div className="text-sm font-medium text-text-primary">
                {t('browser.nativeFailed', { defaultValue: '内置浏览器启动失败' })}
              </div>
              <div className="text-xs text-text-tertiary">{error}</div>
              <button
                type="button"
                onClick={() => navigateTo(currentUrl)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-subtle px-3 text-xs text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary"
              >
                <RefreshCw size={13} />
                {t('buttons.retry')}
              </button>
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
