import { Component, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ErrorInfo } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { pluginPanelRegistry } from '@/plugin-system/panelRegistry'
import type { PluginPanelComponent } from '@/plugin-system/types'

interface PluginPanelHostProps {
  panelType: string
  onSendToChat?: (message: string) => void | Promise<void>
}

function ErrorFallback({ panelType, error, onRetry }: { panelType: string; error: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <AlertTriangle size={32} className="text-warning" />
      <div className="text-sm font-medium text-text-primary">面板加载失败</div>
      <div className="max-w-xs text-xs text-text-tertiary">{error}</div>
      <div className="text-[11px] text-text-muted font-mono">{panelType}</div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-background-hover"
      >
        <RefreshCw size={12} />
        重试
      </button>
    </div>
  )
}

function LoadingFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-xs text-text-muted">加载中...</div>
    </div>
  )
}

/**
 * 渲染期错误边界：插件面板与宿主同 window 运行，面板组件 render 抛错若无
 * 边界拦截会冒泡到 App 根边界把整个应用打崩到全局错误页。此处按面板隔离，
 * 崩溃只降级为单面板错误视图（重试 = 重挂载组件）。
 */
class PanelErrorBoundary extends Component<
  { panelType: string; children: ReactNode; onError: (message: string) => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError(`${error.message}${info.componentStack ? ` @${info.componentStack.split('\n')[1]?.trim() ?? ''}` : ''}`)
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorFallback
          panelType={this.props.panelType}
          error={this.state.error.message}
          onRetry={() => this.setState({ error: null })}
        />
      )
    }
    return this.props.children
  }
}

export function PluginPanelHost({ panelType, onSendToChat }: PluginPanelHostProps) {
  const [Component, setComponent] = useState<PluginPanelComponent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadKey, setLoadKey] = useState(0)

  const pluginId = pluginPanelRegistry.getPluginId(panelType) ?? ''

  const loadPanel = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const C = await pluginPanelRegistry.load(panelType)
      setComponent(() => C)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [panelType])

  useEffect(() => {
    loadPanel()
  }, [loadPanel, loadKey])

  if (error) {
    return <ErrorFallback panelType={panelType} error={error} onRetry={() => setLoadKey((k) => k + 1)} />
  }

  if (loading || !Component) {
    return <LoadingFallback />
  }

  // P5：data-plugin-scope —— slot 模式的插件样式以该属性为作用域根
  // （styles.ts scopeCss 前缀 [data-plugin-scope="<pluginId>"]）
  return (
    <div data-plugin-scope={pluginId} className="contents">
      <PanelErrorBoundary panelType={panelType} onError={(msg) => setError(msg)}>
        <Suspense fallback={<LoadingFallback />}>
          <Component pluginId={pluginId} onSendToChat={onSendToChat} />
        </Suspense>
      </PanelErrorBoundary>
    </div>
  )
}
