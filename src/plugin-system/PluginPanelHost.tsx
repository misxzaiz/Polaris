/**
 * PluginPanelHost — host-side wrapper that loads a plugin's UI entry,
 * mints a `PolarisPluginApi` for it, and renders it inside the host's
 * React tree under Suspense + ErrorBoundary.
 *
 * Usage:
 *
 * ```tsx
 * <PluginPanelHost
 *   pluginId="polaris.knowledge"
 *   entryUrl="/examples/plugins/knowledge-panel-plugin/dist/index.js"
 * />
 * ```
 *
 * The component caches loaded plugin entries by URL so flipping between
 * panels does not reload the same module.
 *
 * ## Error model
 *
 * - Network / import failure → wrapped in `PluginLoadError`, surfaced as
 *   an inline error block
 * - Bad export shape → `PluginEntryShapeError`, inline error
 * - Plugin component runtime error → caught by inner `ErrorBoundary` and
 *   surfaced inline (without unmounting the rest of the host)
 */

import {
  Component,
  Suspense,
  lazy,
  memo,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react'

import {
  loadPluginPanel,
  type PluginPanelComponent,
  type PolarisPluginApi,
} from '@/plugin-system/runtime'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginPanelHost')

// ---------------------------------------------------------------------------
// Local error boundary — the host's `Common/ErrorBoundary` takes a static
// `fallback` node, but here we need to surface the actual error to the
// caller's `renderError`. A 30-line inline class is the right tool.
// ---------------------------------------------------------------------------

interface PluginErrorBoundaryProps {
  renderError: (error: Error) => ReactNode
  children: ReactNode
}

interface PluginErrorBoundaryState {
  error: Error | null
}

class PluginErrorBoundary extends Component<
  PluginErrorBoundaryProps,
  PluginErrorBoundaryState
> {
  state: PluginErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): PluginErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error('plugin panel crashed', error, {
      componentStack: info.componentStack,
    })
  }

  render() {
    if (this.state.error) {
      return this.props.renderError(this.state.error)
    }
    return this.props.children
  }
}

// ---------------------------------------------------------------------------
// Module-level cache: { url → lazy component }
// ---------------------------------------------------------------------------
//
// React.lazy needs a *stable* loader reference per component identity, so we
// memoize by entryUrl. Cache survives the lifetime of the document; HMR is
// handled by Vite separately.

interface CachedEntry {
  lazyComponent: ComponentType<{ api: PolarisPluginApi }>
}

const moduleCache = new Map<string, CachedEntry>()

function getOrCreateLazyComponent(
  pluginId: string,
  entryUrl: string,
  requiredApiVersion: string | undefined
): ComponentType<{ api: PolarisPluginApi }> {
  const cacheKey = `${pluginId}::${entryUrl}`
  const cached = moduleCache.get(cacheKey)
  if (cached) return cached.lazyComponent

  // React.lazy expects `() => Promise<{ default: Component }>`.
  // Our loader returns the bare component, so wrap it.
  const lazyComponent = lazy(async () => {
    log.info('loading plugin panel', { pluginId, entryUrl })
    const Component: PluginPanelComponent = await loadPluginPanel({
      pluginId,
      entryUrl,
      requiredApiVersion,
    })
    return { default: Component }
  })

  moduleCache.set(cacheKey, { lazyComponent })
  return lazyComponent
}

/** Test-only: clear the module cache between tests. */
export function __resetPluginPanelHostCacheForTests(): void {
  moduleCache.clear()
}

// ---------------------------------------------------------------------------
// PluginPanelHost
// ---------------------------------------------------------------------------

export interface PluginPanelHostProps {
  /** Plugin id — also feeds the per-plugin API mint. */
  pluginId: string
  /** ES-module URL the webview can `import()`. */
  entryUrl: string
  /** Optional semver range the plugin requires of the host. */
  requiredApiVersion?: string
  /** Optional fallback rendered while the plugin module loads. */
  fallback?: ReactNode
  /** Optional error renderer. Default surfaces a minimal inline block. */
  renderError?: (error: Error) => ReactNode
}

function DefaultFallback() {
  return (
    <div
      style={{ padding: 16, opacity: 0.6, fontFamily: 'system-ui' }}
      role="status"
      aria-live="polite"
    >
      Loading plugin…
    </div>
  )
}

function defaultErrorRenderer(error: Error): ReactNode {
  return (
    <div
      style={{
        padding: 16,
        margin: 8,
        border: '1px solid currentColor',
        borderRadius: 8,
        color: '#f97066',
        background: 'rgba(249, 112, 102, 0.08)',
      }}
      role="alert"
    >
      <strong>Plugin failed to load</strong>
      <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8, fontSize: 12 }}>
        {error.name}: {error.message}
      </pre>
    </div>
  )
}

export const PluginPanelHost = memo(function PluginPanelHost(
  props: PluginPanelHostProps
) {
  const {
    pluginId,
    entryUrl,
    requiredApiVersion,
    fallback = <DefaultFallback />,
    renderError = defaultErrorRenderer,
  } = props

  const [api, setApi] = useState<PolarisPluginApi | null>(null)
  const [mintError, setMintError] = useState<Error | null>(null)

  // Mint a per-plugin API once the host runtime is installed.
  // Idempotent guard against the StrictMode double-effect.
  useEffect(() => {
    const runtime = typeof window !== 'undefined' ? window.__POLARIS__ : undefined
    if (!runtime) {
      setMintError(
        new Error(
          'window.__POLARIS__ is not installed. Call installPluginRuntime() during app boot.'
        )
      )
      return
    }
    try {
      setApi(runtime.forPlugin(pluginId))
      setMintError(null)
    } catch (err) {
      setMintError(err instanceof Error ? err : new Error(String(err)))
    }
  }, [pluginId])

  const LazyComponent = useMemo(
    () => getOrCreateLazyComponent(pluginId, entryUrl, requiredApiVersion),
    [pluginId, entryUrl, requiredApiVersion]
  )

  if (mintError) {
    return <>{renderError(mintError)}</>
  }
  if (!api) {
    return <>{fallback}</>
  }

  return (
    <PluginErrorBoundary renderError={renderError}>
      <Suspense fallback={fallback}>
        <LazyComponent api={api} />
      </Suspense>
    </PluginErrorBoundary>
  )
})
