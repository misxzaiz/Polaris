import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bug,
  Code2,
  Eraser,
  ExternalLink,
  Globe2,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
} from 'lucide-react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { clsx } from 'clsx'
import { useTranslation } from 'react-i18next'
import {
  browserClearData,
  browserClose,
  browserCreate,
  browserGetPageContext,
  browserHistory,
  browserNavigate,
  browserReload,
  browserSetBounds,
  browserToggleDevtools,
  normalizeBrowserUrl,
  type BrowserBounds,
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
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function makeWebviewLabel(tabId: string): string {
  return `browser-${tabId.replace(/[^a-zA-Z0-9_:/-]/g, '-')}`
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

export function BrowserPanel({ tabId, initialUrl = 'https://www.bing.com' }: BrowserPanelProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const mountedRef = useRef(false)
  const readyRef = useRef(false)
  const webviewLabel = useMemo(() => makeWebviewLabel(tabId), [tabId])
  const normalizedInitialUrl = useMemo(() => normalizeBrowserUrl(initialUrl), [initialUrl])

  const [address, setAddress] = useState(normalizedInitialUrl)
  const [currentUrl, setCurrentUrl] = useState(normalizedInitialUrl)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<'idle' | 'ready' | 'native-unavailable' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  const { sendMessage } = useActiveSessionActions()
  const toast = useToastStore()
  const currentWorkspace = useWorkspaceStore((state) => state.getCurrentWorkspace())

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

    async function createNativeWebview() {
      setLoading(true)
      setError(null)
      try {
        const bounds = getContainerBounds() ?? { x: 0, y: 0, width: 320, height: 240 }
        await browserCreate(webviewLabel, tabId, normalizedInitialUrl, bounds, 'Browser')

        unlistenSession = await listen<BrowserSessionInfo>('browser://session-updated', (event) => {
          const session = event.payload
          if (session.label !== webviewLabel) return

          if (session.url) {
            setCurrentUrl(session.url)
            setAddress(session.url)
          }
        })

        readyRef.current = true
        setStatus('ready')
        setCurrentUrl(normalizedInitialUrl)
        setAddress(normalizedInitialUrl)

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
      window.removeEventListener('resize', scheduleSyncBounds)
      window.removeEventListener('scroll', scheduleSyncBounds, true)
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      browserClose(webviewLabel).catch(() => undefined)
    }
  }, [getContainerBounds, normalizedInitialUrl, scheduleSyncBounds, tabId, webviewLabel])

  const navigateTo = useCallback(
    async (rawUrl: string) => {
      const nextUrl = normalizeBrowserUrl(rawUrl)
      setLoading(true)
      setError(null)
      setAddress(nextUrl)
      setCurrentUrl(nextUrl)
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
    [status, webviewLabel]
  )

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault()
      navigateTo(address)
    },
    [address, navigateTo]
  )

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

  const openExternal = useCallback(async () => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(currentUrl)
    } catch {
      window.open(currentUrl, '_blank')
    }
  }, [currentUrl])

  const toolbarButtonClass =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45'

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
            className={toolbarButtonClass}
            onClick={() => handleContextToChat('learn')}
            title={t('browser.explainSelection', { defaultValue: '讲解当前网页或选区' })}
          >
            <BookOpen size={15} />
          </button>
          <button
            type="button"
            className={toolbarButtonClass}
            onClick={() => handleContextToChat('modify')}
            title={t('browser.modifyPage', { defaultValue: '让 AI 协助修改页面' })}
          >
            <MessageSquare size={15} />
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

      <div className="flex h-7 shrink-0 items-center justify-between border-t border-border-subtle bg-background-elevated px-3 text-[11px] text-text-tertiary">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={clsx(
              'h-1.5 w-1.5 rounded-full',
              status === 'ready' ? 'bg-success' : status === 'error' ? 'bg-danger' : 'bg-warning'
            )}
          />
          <span className="truncate">{currentUrl}</span>
        </div>
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
