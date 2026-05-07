import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listPluginMcpServerStatuses, pluginIconMap, pluginRegistry } from '@/plugin-system'
import { listMcpHealthStatuses, type McpHealthStatus } from '@/services/mcpHealthService'
import { usePluginStore } from '@/stores/pluginStore'

function formatPermissionLabel(key: string, t: (key: string, options?: { defaultValue?: string }) => string): string {
  return t(`plugins.permissions.${key}`, { defaultValue: key })
}

export function PluginTab() {
  const { t } = useTranslation('settings')
  const [mcpHealthStatuses, setMcpHealthStatuses] = useState<McpHealthStatus[]>([])
  const [mcpHealthLoading, setMcpHealthLoading] = useState(false)
  const [mcpHealthError, setMcpHealthError] = useState<string | null>(null)
  const pluginStates = usePluginStore((state) => state.pluginStates)
  const getPluginState = usePluginStore((state) => state.getPluginState)
  const setPluginEnabled = usePluginStore((state) => state.setPluginEnabled)
  const setPluginUiEnabled = usePluginStore((state) => state.setPluginUiEnabled)
  const setPluginMcpEnabled = usePluginStore((state) => state.setPluginMcpEnabled)
  const resetPluginState = usePluginStore((state) => state.resetPluginState)

  const plugins = pluginRegistry.listPlugins()
  const mcpServerStatuses = listPluginMcpServerStatuses(pluginStates)
  const mcpHealthByName = useMemo(() => {
    return new Map(mcpHealthStatuses.map((status) => [status.name, status]))
  }, [mcpHealthStatuses])

  const refreshMcpHealth = useCallback(async () => {
    setMcpHealthLoading(true)
    setMcpHealthError(null)

    try {
      setMcpHealthStatuses(await listMcpHealthStatuses())
    } catch (error) {
      setMcpHealthError(error instanceof Error ? error.message : String(error))
      setMcpHealthStatuses([])
    } finally {
      setMcpHealthLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshMcpHealth()
  }, [refreshMcpHealth])

  return (
    <div className="space-y-4">
      <div className="text-sm text-text-secondary">
        {t('plugins.description')}
      </div>
      <div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-background-elevated px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs text-text-tertiary">
          {mcpHealthError
            ? t('plugins.mcpHealthError', { defaultValue: 'MCP status unavailable: {{error}}', error: mcpHealthError })
            : t('plugins.mcpHealthSummary', { defaultValue: '{{count}} MCP runtime statuses loaded', count: mcpHealthStatuses.length })}
        </div>
        <button
          type="button"
          onClick={refreshMcpHealth}
          disabled={mcpHealthLoading}
          className="self-start rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-background-hover disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
        >
          {mcpHealthLoading
            ? t('plugins.refreshingMcpStatus', { defaultValue: 'Refreshing...' })
            : t('plugins.refreshMcpStatus', { defaultValue: 'Refresh MCP status' })}
        </button>
      </div>

      <div className="space-y-3">
        {plugins.map((plugin) => {
          const state = getPluginState(plugin.id)
          const views = plugin.contributes.views ?? []
          const mcpServers = mcpServerStatuses.filter((server) => server.pluginId === plugin.id)
          const permissionEntries = Object.entries(plugin.permissions).filter(([, enabled]) => enabled)
          const isCorePlugin = plugin.id === 'polaris.core'

          return (
            <section
              key={plugin.id}
              className="rounded-lg border border-border-subtle bg-background-surface p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-semibold text-text-primary">{plugin.name}</h4>
                    <span className="rounded bg-background-hover px-1.5 py-0.5 text-[11px] text-text-tertiary">
                      v{plugin.version}
                    </span>
                    {plugin.builtin && (
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                        {t('plugins.builtin')}
                      </span>
                    )}
                    {!plugin.builtin && plugin.source && (
                      <span className="rounded bg-background-hover px-1.5 py-0.5 text-[11px] text-text-tertiary">
                        {plugin.source.kind === 'project'
                          ? t('plugins.projectInstalled', { defaultValue: 'Project' })
                          : t('plugins.userInstalled', { defaultValue: 'User installed' })}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-text-tertiary">{plugin.id}</div>
                  {!plugin.builtin && plugin.installPath && (
                    <div className="mt-1 truncate text-xs text-text-tertiary">
                      {plugin.installPath}
                    </div>
                  )}
                  {plugin.description && (
                    <p className="mt-2 text-sm text-text-secondary">{plugin.description}</p>
                  )}
                </div>

                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={state.enabled}
                    disabled={isCorePlugin}
                    onChange={(event) => setPluginEnabled(plugin.id, event.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                  {t('plugins.enablePlugin')}
                </label>
              </div>

              {isCorePlugin && (
                <div className="mt-3 rounded-md border border-border-subtle bg-background-elevated px-3 py-2 text-xs text-text-tertiary">
                  {t('plugins.coreLocked')}
                </div>
              )}

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-border-subtle bg-background-elevated p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-text-primary">{t('plugins.uiSurface')}</div>
                      <div className="mt-1 text-xs text-text-tertiary">
                        {t('plugins.viewCount', { count: views.length })}
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={state.uiEnabled}
                      disabled={!state.enabled || isCorePlugin}
                      onChange={(event) => setPluginUiEnabled(plugin.id, event.target.checked)}
                      className="h-4 w-4 accent-primary"
                    />
                  </div>
                  {views.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {views.map((view) => {
                        const Icon = pluginIconMap[view.icon]
                        return (
                          <span
                            key={view.id}
                            className="inline-flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs text-text-secondary"
                          >
                            <Icon size={12} />
                            {t(view.labelKey, { defaultValue: view.labelDefault ?? view.panelType })}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>

                <div className="rounded-md border border-border-subtle bg-background-elevated p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-text-primary">{t('plugins.mcpSurface')}</div>
                      <div className="mt-1 text-xs text-text-tertiary">
                        {t('plugins.mcpCount', { count: mcpServers.length })}
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={state.mcpEnabled}
                      disabled={!state.enabled || mcpServers.length === 0}
                      onChange={(event) => setPluginMcpEnabled(plugin.id, event.target.checked)}
                      className="h-4 w-4 accent-primary"
                    />
                  </div>
                  {mcpServers.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {mcpServers.map((server) => {
                        const runtime = mcpHealthByName.get(server.id)
                        return (
                          <div key={server.id} className="rounded border border-border-subtle px-2 py-1.5">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className={server.enabled ? 'font-medium text-text-secondary' : 'font-medium text-text-tertiary line-through'}>
                                {server.id}
                              </span>
                              <span className="text-text-tertiary">{server.transport}</span>
                              {!server.enabled ? (
                                <span className="rounded bg-background-hover px-1.5 py-0.5 text-[11px] text-text-tertiary">
                                  {t('plugins.disabled')}
                                </span>
                              ) : runtime ? (
                                <span
                                  className={
                                    runtime.connected
                                      ? 'rounded bg-success/10 px-1.5 py-0.5 text-[11px] text-success'
                                      : 'rounded bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning'
                                  }
                                >
                                  {runtime.connected
                                    ? t('plugins.mcpConnected', { defaultValue: 'Connected' })
                                    : t('plugins.mcpDisconnected', { defaultValue: 'Disconnected' })}
                                </span>
                              ) : (
                                <span className="rounded bg-background-hover px-1.5 py-0.5 text-[11px] text-text-tertiary">
                                  {t('plugins.mcpUnknown', { defaultValue: 'Not reported' })}
                                </span>
                              )}
                            </div>
                            {runtime?.status && (
                              <div className="mt-1 text-[11px] text-text-tertiary">
                                {runtime.status}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <div className="text-xs font-medium text-text-secondary">{t('plugins.permissionsTitle')}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {permissionEntries.length === 0 ? (
                      <span className="text-xs text-text-tertiary">{t('plugins.noPermissions')}</span>
                    ) : (
                      permissionEntries.map(([key]) => (
                        <span
                          key={key}
                          className="rounded border border-border-subtle px-2 py-1 text-xs text-text-secondary"
                        >
                          {formatPermissionLabel(key, t)}
                        </span>
                      ))
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => resetPluginState(plugin.id)}
                  disabled={pluginStates[plugin.id] === undefined}
                  className="self-start rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-background-hover disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
                >
                  {t('plugins.reset')}
                </button>
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
