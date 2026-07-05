/**
 * 插件自定义卡片宿主组件
 *
 * 职责：
 * 1. 按 block.toolName 从 chatCardRegistry 懒加载插件卡片组件
 * 2. 加载失败 / 渲染崩溃时回落到 PluginCardFallback（工具名 + JSON 折叠）
 * 3. 向插件组件透传 PluginChatCardProps（data / status / mode / onSendToChat / respond）
 *
 * result 模式：data 来自 tool_call_end 解析，status === 'ready'
 * interaction 模式：data 来自 plugin_card 事件，status 由 respond 推进（Phase 3 接入）
 */

import { Suspense, useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { chatCardRegistry } from '@/plugin-system/chatCardRegistry'
import type { PluginChatCardComponent, PluginChatCardProps } from '@/plugin-system/types'
import type { PluginCardBlock } from '@/types'
import { copyToClipboard } from '@/utils/clipboard'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginCardHost')

interface PluginCardHostProps {
  block: PluginCardBlock
  /** 注入下一轮聊天消息（展示型卡片可用） */
  onSendToChat?: (message: string) => void | Promise<void>
}

function LoadingFallback() {
  return (
    <div className="my-2 flex items-center gap-2 rounded-lg border border-border bg-background-elevated px-3 py-3">
      <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <span className="text-xs text-text-muted">加载卡片...</span>
    </div>
  )
}

function ErrorFallback({
  block,
  error,
  onRetry,
}: {
  block: PluginCardBlock
  error: string
  onRetry: () => void
}) {
  return (
    <div className="my-2 rounded-lg border border-error/30 bg-error-faint/50 px-3 py-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-error" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-error">插件卡片加载失败</div>
          <div className="mt-0.5 truncate text-xs text-text-secondary" title={error}>
            {error}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-text-muted">{block.toolName}</div>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary"
        >
          <RefreshCw className="h-3 w-3" />
          <span>重试</span>
        </button>
      </div>
    </div>
  )
}

/**
 * 注册表未命中或加载失败时的兜底渲染：工具名 + data JSON 折叠展示。
 */
function PluginCardFallback({ block }: { block: PluginCardBlock }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const dataText =
    typeof block.data === 'string' ? block.data : JSON.stringify(block.data, null, 2)
  const preview = dataText.length > 120 ? dataText.slice(0, 120) + '…' : dataText

  const handleCopy = useCallback(async () => {
    await copyToClipboard(dataText)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }, [dataText])

  return (
    <section className="my-2 w-full overflow-hidden rounded-lg border border-border bg-background-elevated">
      <header className="flex min-w-0 items-center gap-2 border-b border-border bg-background-surface px-3 py-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-[10px] font-semibold text-primary">
          MCP
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">{block.toolName}</div>
          <div className="mt-0.5 text-[11px] text-text-tertiary">
            {block.pluginId} · {block.cardId}
          </div>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 rounded px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </header>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-text-secondary hover:bg-background-hover"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate font-mono">{preview}</span>
      </button>
      {expanded && (
        <pre className="max-h-72 overflow-auto border-t border-border bg-background-surface px-3 py-2 font-mono text-xs leading-relaxed text-text-secondary">
          {dataText}
        </pre>
      )}
    </section>
  )
}

export function PluginCardHost({ block, onSendToChat }: PluginCardHostProps) {
  const [Component, setComponent] = useState<PluginChatCardComponent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadKey, setLoadKey] = useState(0)

  const loadCard = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const C = await chatCardRegistry.load(block.toolName)
      setComponent(() => C)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log.warn('卡片加载失败，回落兜底渲染', { toolName: block.toolName, error: message })
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [block.toolName])

  useEffect(() => {
    loadCard()
  }, [loadCard, loadKey])

  // 加载失败：若注册表根本没命中（非临时错误），直接兜底渲染，不显示重试
  const registered = chatCardRegistry.match(block.toolName)
  if (!loading && error && !registered) {
    return <PluginCardFallback block={block} />
  }
  if (error) {
    return (
      <ErrorFallback block={block} error={error} onRetry={() => setLoadKey((k) => k + 1)} />
    )
  }
  if (loading || !Component) {
    return <LoadingFallback />
  }

  const props: PluginChatCardProps = {
    pluginId: block.pluginId,
    cardId: block.cardId,
    toolName: block.toolName,
    mode: block.mode,
    status: block.status,
    data: block.data,
    response: block.response,
    onSendToChat,
    // respond 由 Phase 3 接入（interaction 模式）；此处对 pending 的交互卡片不提供 respond
  }

  return (
    <Suspense fallback={<LoadingFallback />}>
      <Component {...props} />
    </Suspense>
  )
}
