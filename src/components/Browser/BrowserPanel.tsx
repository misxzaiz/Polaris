import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Activity,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bug,
  Code2,
  Copy,
  Eraser,
  ExternalLink,
  Globe2,
  Hammer,
  ListTree,
  Loader2,
  MousePointer2,
  PanelBottom,
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { clsx } from 'clsx'
import { useTranslation } from 'react-i18next'
import {
  browserClearData,
  browserCreate,
  browserGetDiagnostics,
  browserGetPageContext,
  browserHistory,
  browserNavigate,
  browserReload,
  browserSetAiOverlay,
  browserSetBounds,
  browserToggleDevtools,
  makeBrowserWebviewLabel,
  normalizeBrowserUrl,
  type BrowserBounds,
  type BrowserDiagnostics,
  type BrowserOperationEvent,
  type BrowserPageContext,
  type BrowserSessionInfo,
} from '@/services/tauri/browserService'
import { useActiveSessionActions } from '@/stores/conversationStore/useActiveSession'
import { useToastStore } from '@/stores/toastStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useTabStore } from '@/stores/tabStore'
import { useViewStore } from '@/stores/viewStore'

interface BrowserPanelProps {
  tabId: string
  initialUrl?: string
  navigationRequestUrl?: string
  navigationRequestId?: number
}

const QUICK_STARTS = [
  { key: 'search', url: 'https://www.bing.com', label: 'Bing' },
  { key: 'local5173', url: 'localhost:5173', label: 'localhost:5173' },
  { key: 'local3000', url: 'localhost:3000', label: 'localhost:3000' },
  { key: 'mdn', url: 'https://developer.mozilla.org', label: 'MDN' },
  { key: 'tauri', url: 'https://tauri.app', label: 'Tauri' },
]

const MAX_OPERATION_EVENTS = 8

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function isLocalDevUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

function formatContextForChat(context: BrowserPageContext, mode: 'learn' | 'modify'): string {
  const selected = context.selectedText.trim()
  const excerpt = selected || context.text.slice(0, 4000)
  const headingText = context.headings
    .slice(0, 10)
    .map((h) => `${'#'.repeat(Math.min(Math.max(h.level, 1), 6))} ${h.text}`)
    .join('\n')

  if (mode === 'modify') {
    return [
      '我正在用 Polaris 内置浏览器查看一个页面，请根据网页上下文协助我修改当前项目。',
      '',
      `标题: ${context.title || 'Untitled'}`,
      `URL: ${context.url}`,
      headingText ? `页面标题结构:\n${headingText}` : '',
      excerpt ? `关注内容:\n${excerpt}` : '',
      '',
      '请先判断这可能对应项目中的哪些文件或组件，再给出修改方案；如果信息足够，可以直接实施修改。',
    ]
      .filter(Boolean)
      .join('\n')
  }

  return [
    '请讲解这个网页内容，重点帮助我学习和理解。',
    '',
    `标题: ${context.title || 'Untitled'}`,
    `URL: ${context.url}`,
    headingText ? `页面标题结构:\n${headingText}` : '',
    excerpt ? `引用内容:\n${excerpt}` : '',
    '',
    selected ? '请围绕我选中的内容讲解。' : '请先总结核心概念，再给出适合开发者的例子。',
  ]
    .filter(Boolean)
    .join('\n')
}

export function BrowserPanel({
  tabId,
  initialUrl = 'https://www.bing.com',
  navigationRequestUrl,
  navigationRequestId,
}: BrowserPanelProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const mountedRef = useRef(false)
  const readyRef = useRef(false)
  const addressFocusedRef = useRef(false)
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

  const [address, setAddress] = useState(normalizedInitialUrl)
  const [currentUrl, setCurrentUrl] = useState(normalizedInitialUrl)
  const [pageTitle, setPageTitle] = useState('Browser')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<'idle' | 'ready' | 'native-unavailable' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiOperationMode, setAiOperationMode] = useState(false)
  const [highlightCount, setHighlightCount] = useState<number | null>(null)
  const [contextPreview, setContextPreview] = useState<BrowserPageContext | null>(null)
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnostics | null>(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [operationEvents, setOperationEvents] = useState<BrowserOperationEvent[]>([])

  const { sendMessage } = useActiveSessionActions()
  const toast = useToastStore()
  const currentWorkspace = useWorkspaceStore((state) => state.getCurrentWorkspace())
  const updateBrowserTab = useTabStore((state) => state.updateBrowserTab)
  const markBrowserNavigationHandled = useTabStore((state) => state.markBrowserNavigationHandled)
  const isLocalDev = useMemo(() => isLocalDevUrl(currentUrl), [currentUrl])
  const latestOperation = operationEvents[0]

  const getContainerBounds = useCallback((): BrowserBounds | null => {
    const container = containerRef.current
    if (!container) return null

    const rect = container.getBoundingClientRect()
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
  }, [])

  const syncBounds = useCallback(async () => {
    if (!readyRef.current) return
    const bounds = getContainerBounds()
    if (!bounds) return

    await browserSetBounds(webviewLabel, bounds)
  }, [getContainerBounds, webviewLabel])

  const scheduleSyncBounds = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current)
    }
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

    async function createNativeWebview() {
      setLoading(true)
      setError(null)
      try {
        const bounds = getContainerBounds() ?? { x: 0, y: 0, width: 320, height: 240 }
        const session = await browserCreate(webviewLabel, tabId, normalizedInitialUrl, bounds, 'Browser')

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

        resizeObserver = new ResizeObserver(scheduleSyncBounds)
        if (containerRef.current) {
          resizeObserver.observe(containerRef.current)
        }
        window.addEventListener('resize', scheduleSyncBounds)
        window.addEventListener('scroll', scheduleSyncBounds, true)
        scheduleSyncBounds()
      } catch (e) {
        if (!cleanup && mountedRef.current) {
          setStatus('error')
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (!cleanup && mountedRef.current) {
          setLoading(false)
        }
      }
    }

    createNativeWebview()

    return () => {
      cleanup = true
      mountedRef.current = false
      readyRef.current = false
      resizeObserver?.disconnect()
      unlistenSession?.()
      unlistenOperation?.()
      window.removeEventListener('resize', scheduleSyncBounds)
      window.removeEventListener('scroll', scheduleSyncBounds, true)
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      browserSetAiOverlay(webviewLabel, false).catch(() => undefined)
      browserSetBounds(webviewLabel, { x: 0, y: 0, width: 0, height: 0 }).catch(() => undefined)
    }
  }, [
    getContainerBounds,
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
    const timeout = window.setTimeout(
      () => {
        browserSetAiOverlay(webviewLabel, aiOperationMode)
          .then((result) => {
            if (cancelled) return
            setHighlightCount(result.enabled ? result.count : null)
          })
          .catch((e) => {
            if (cancelled) return
            setHighlightCount(null)
            if (aiOperationMode) {
              setError(e instanceof Error ? e.message : String(e))
            }
          })
      },
      aiOperationMode ? 350 : 0
    )

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [aiOperationMode, currentUrl, status, webviewLabel])

  const navigateTo = useCallback(
    async (rawUrl: string) => {
      const nextUrl = normalizeBrowserUrl(rawUrl)
      setLoading(true)
      setError(null)
      setAddress(nextUrl)
      setCurrentUrl(nextUrl)
      setPageTitle('Browser')
      setDiagnostics(null)
      setContextPreview(null)
      updateBrowserTab(tabId, { url: nextUrl, title: 'Browser' })
      try {
        if (status === 'native-unavailable') {
          return
        }
        await browserNavigate(webviewLabel, nextUrl)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
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

  const handleContextToChat = useCallback(
    async (mode: 'learn' | 'modify') => {
      if (!currentWorkspace) {
        toast.error(t('messages.noWorkspace'))
        return
      }

      setLoading(true)
      setError(null)
      try {
        const context = status === 'native-unavailable'
          ? {
              title: 'Browser',
              url: currentUrl,
              selectedText: '',
              metaDescription: '',
              text: '',
              headings: [],
              links: [],
            }
          : await browserGetPageContext(webviewLabel)

        await sendMessage(formatContextForChat(context, mode), currentWorkspace.path)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setError(message)
        toast.error(message)
      } finally {
        setLoading(false)
      }
    },
    [currentUrl, currentWorkspace, sendMessage, status, t, toast, webviewLabel]
  )

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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background-base">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle bg-background-elevated px-3">
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
            className={taskButtonClass}
            onClick={() => handleContextToChat('learn')}
            disabled={loading}
            title={t('browser.explainSelection', { defaultValue: '讲解当前网页或选区' })}
          >
            <BookOpen size={15} />
            <span className="hidden xl:inline">{t('browser.learnMode', { defaultValue: '讲解' })}</span>
          </button>
          <button
            type="button"
            className={taskButtonClass}
            onClick={() => handleContextToChat('modify')}
            disabled={loading}
            title={t('browser.modifyPage', { defaultValue: '让 AI 协助修改页面' })}
          >
            <Hammer size={15} />
            <span className="hidden xl:inline">{t('browser.devMode', { defaultValue: '修改' })}</span>
          </button>
          <button
            type="button"
            className={taskButtonClass}
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
            className={taskButtonClass}
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
            className={toolbarButtonClass}
            onClick={() => browserToggleDevtools(webviewLabel).catch((e) => setError(String(e)))}
            disabled={status !== 'ready'}
            title={t('browser.devtools', { defaultValue: '开发者工具' })}
          >
            <Bug size={15} />
          </button>
          <button
            type="button"
            className={toolbarButtonClass}
            onClick={copyUrl}
            title={t('browser.copyUrl', { defaultValue: '复制当前地址' })}
          >
            <Copy size={15} />
          </button>
          <button
            type="button"
            className={toolbarButtonClass}
            onClick={openExternal}
            title={t('browser.openExternal', { defaultValue: '外部浏览器打开' })}
          >
            <ExternalLink size={15} />
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
        <div className="shrink-0 border-t border-border-subtle bg-background-elevated px-3 py-2">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-text-secondary">
              <PanelBottom size={14} className="text-primary" />
              <span className="truncate">
                {t('browser.aiPanel', { defaultValue: '网页上下文与 AI 操作' })}
              </span>
              {isLocalDev && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded border border-success/30 bg-success/10 px-1.5 py-0.5 text-[11px] text-success">
                  <Terminal size={11} />
                  {t('browser.localDev', { defaultValue: '本地开发页' })}
                </span>
              )}
              {aiOperationMode && highlightCount !== null && (
                <span className="shrink-0 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                  {t('browser.highlightCount', {
                    count: highlightCount,
                    defaultValue: '已标记 {{count}} 个元素',
                  })}
                </span>
              )}
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

          <div className="grid max-h-40 min-h-0 grid-cols-[minmax(0,1fr)_minmax(220px,320px)] gap-3 overflow-hidden max-lg:grid-cols-1">
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

            <div className="min-w-0 overflow-hidden rounded-md border border-border-subtle bg-background-surface p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-text-primary">
                  {t('browser.operationLog', { defaultValue: 'AI 操作日志' })}
                </div>
                <span className="text-[11px] text-text-tertiary">{operationEvents.length}</span>
              </div>
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

      <div className="flex h-7 shrink-0 items-center justify-between border-t border-border-subtle bg-background-elevated px-3 text-[11px] text-text-tertiary">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={clsx(
              'h-1.5 w-1.5 rounded-full',
              status === 'ready' ? 'bg-success' : status === 'error' ? 'bg-danger' : 'bg-warning'
            )}
          />
          <span className="shrink-0 truncate font-medium text-text-secondary">{hostText}</span>
          <span className="min-w-0 truncate">{pageTitle || currentUrl}</span>
          {isLocalDev && (
            <span className="hidden shrink-0 items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 text-success md:inline-flex">
              <Terminal size={11} />
              {t('browser.localDev', { defaultValue: '本地开发页' })}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {aiOperationMode && (
            <span className="hidden items-center gap-1 text-primary lg:inline-flex">
              <MousePointer2 size={12} />
              {highlightCount === null
                ? t('browser.operationMode', { defaultValue: 'AI 操作' })
                : t('browser.highlightCount', {
                    count: highlightCount,
                    defaultValue: '已标记 {{count}} 个元素',
                  })}
            </span>
          )}
          <span className="hidden items-center gap-1 text-text-tertiary lg:inline-flex">
            <Sparkles size={12} />
            {t('browser.aiReady', { defaultValue: 'AI 可读取并操作当前页' })}
          </span>
          <button
            type="button"
            onClick={() => {
              browserClearData(webviewLabel).catch((e) => setError(String(e)))
            }}
            disabled={status !== 'ready'}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary disabled:opacity-45"
            title={t('browser.clearData', { defaultValue: '清理浏览数据' })}
          >
            <Eraser size={12} />
            <span>{t('browser.clearDataShort', { defaultValue: '清理' })}</span>
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
    <div className="flex h-full min-h-0 flex-col bg-background-elevated">
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
