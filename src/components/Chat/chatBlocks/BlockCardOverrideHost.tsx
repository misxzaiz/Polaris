/**
 * 内容块插件覆盖渲染宿主
 *
 * 职责：renderContentBlock 命中插件注册的 block:/tool: 覆盖卡片时，懒加载插件
 * 组件并渲染。与 PluginCardHost 的区别：
 * - PluginCardHost 消费 PluginCardBlock（plugin_card 类型，MCP 工具结果/交互帧）
 * - BlockCardOverrideHost 消费任意 ContentBlock（question/form/plan_mode/...），
 *   插件按 block.type / tool 名覆盖宿主默认渲染
 *
 * 语义（对齐 plans/chat-block-renderer-registry.md §4.5）：
 * - 插件覆盖仅替换「视觉渲染面」，宿主语义层（ask 管线 / form_submit / 应答
 *   回填）保持不变。因此本宿主不提供 respond——交互应答仍由宿主原生处理。
 * - 插件组件崩溃由内部 ErrorBoundary 兜住，不拖垮整条对话，也不回退宿主默认
 *   （避免插件反复崩溃→宿主默认→插件再渲染的抖动环）。
 * - 加载失败/崩溃显示错误卡片（含重试）。
 */

import { Component, Suspense, useCallback, useEffect, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { ContentBlock } from '@/types'
import { chatCardRegistry, type CardEntry } from '@/plugin-system/chatCardRegistry'
import type {
  PluginChatCardComponent,
  PluginChatCardProps,
  PluginChatCardStatus,
} from '@/plugin-system/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('BlockCardOverrideHost')

interface BlockCardOverrideHostProps {
  block: ContentBlock
  entry: CardEntry
  cardKey: string
}

/** 块 → 插件卡片 props 适配（不含 respond：语义层留宿主） */
function blockToCardProps(block: ContentBlock, entry: CardEntry): PluginChatCardProps {
  const status: PluginChatCardStatus =
    block.type === 'tool_call'
      ? block.status === 'completed'
        ? 'ready'
        : block.status === 'failed'
          ? 'failed'
          : 'pending'
      : 'ready'
  return {
    pluginId: entry.pluginId,
    cardId: entry.cardId,
    toolName: block.type === 'tool_call' ? block.name : block.type,
    mode: entry.mode,
    status,
    data: block,
    sessionId: undefined,
    onSendToChat: undefined,
    respond: undefined,
  }
}

/** 插件组件内部错误边界（防崩溃拖垮整条对话） */
class OverrideErrorBoundary extends Component<
  { children: ReactNode; onError: (err: Error) => void },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error('插件覆盖渲染崩溃', error, { componentStack: info.componentStack })
    this.props.onError(error)
  }

  render(): ReactNode {
    return this.state.hasError ? null : this.props.children
  }
}

/** 加载失败/崩溃展示（不渲染宿主默认，避免抖动环） */
function OverrideError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="my-2 rounded-lg border border-error/30 bg-error-faint/50 px-3 py-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-error" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-error">插件覆盖渲染失败</div>
          <div className="mt-0.5 truncate text-xs text-text-secondary" title={message}>
            {message}
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1.5 flex items-center gap-1 rounded px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary"
          >
            <RefreshCw className="h-3 w-3" />
            <span>重试</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export function BlockCardOverrideHost({ block, entry, cardKey }: BlockCardOverrideHostProps) {
  const [Component, setComponent] = useState<PluginChatCardComponent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadKey, setLoadKey] = useState(0)

  const loadCard = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const C = await chatCardRegistry.load(cardKey)
      setComponent(() => C)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log.warn('插件覆盖卡片加载失败，显示错误卡片', {
        cardKey,
        pluginId: entry.pluginId,
        error: message,
      })
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [cardKey, entry.pluginId])

  useEffect(() => {
    loadCard()
  }, [loadCard, loadKey])

  if (error) {
    return <OverrideError message={error} onRetry={() => setLoadKey((k) => k + 1)} />
  }
  if (loading || !Component) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-border bg-background-elevated px-3 py-3">
        <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span className="text-xs text-text-muted">加载插件渲染…</span>
      </div>
    )
  }

  const props = blockToCardProps(block, entry)
  return (
    <OverrideErrorBoundary onError={(err) => setError(err.message)}>
      <Suspense fallback={null}>
        <Component {...props} />
      </Suspense>
    </OverrideErrorBoundary>
  )
}
