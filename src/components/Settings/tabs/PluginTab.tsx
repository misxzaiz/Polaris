import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, PackagePlus, RefreshCw, Trash2 } from 'lucide-react'
import { listPluginMcpServerStatuses, pluginIconMap, pluginRegistry } from '@/plugin-system'
import {
  checkPluginUpdate,
  discoverInstalledPlugins,
  getPluginInstallLocations,
  installLocalPlugin,
  uninstallLocalPlugin,
  type PluginDiscoveryIssue,
  type PluginInstallLocations,
  type PluginUpdateCheckResult,
} from '@/services/pluginDiscoveryService'
import { listMcpHealthStatuses, type McpHealthStatus } from '@/services/mcpHealthService'
import { openInDefaultApp } from '@/services/tauri/windowService'
import { usePluginStore } from '@/stores/pluginStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'

function formatPermissionLabel(key: string, t: (key: string, options?: { defaultValue?: string }) => string): string {
  return t(`plugins.permissions.${key}`, { defaultValue: key })
}

export function PluginTab() {
  const { t } = useTranslation('settings')
  const [mcpHealthStatuses, setMcpHealthStatuses] = useState<McpHealthStatus[]>([])
  const [mcpHealthLoading, setMcpHealthLoading] = useState(false)
  const [mcpHealthError, setMcpHealthError] = useState<string | null>(null)
  const [pluginDiscoveryLoading, setPluginDiscoveryLoading] = useState(false)
  const [pluginDiscoveryError, setPluginDiscoveryError] = useState<string | null>(null)
  const [pluginDiscoveryIssues, setPluginDiscoveryIssues] = useState<PluginDiscoveryIssue[]>([])
  const [pluginInstallLocations, setPluginInstallLocations] = useState<PluginInstallLocations | null>(null)
  const [pluginOperationLoading, setPluginOperationLoading] = useState(false)
  const [pluginOperationMessage, setPluginOperationMessage] = useState<string | null>(null)
  const [pluginUpdateChecks, setPluginUpdateChecks] = useState<Record<string, PluginUpdateCheckResult>>({})
  const [pluginUpdateLoadingId, setPluginUpdateLoadingId] = useState<string | null>(null)
  const [pluginInstallScope, setPluginInstallScope] = useState<'user' | 'project'>('user')
  const [plugins, setPlugins] = useState(() => pluginRegistry.listPlugins())
  const currentWorkspacePath = useWorkspaceStore((state) => state.getCurrentWorkspace()?.path)
  const pluginStates = usePluginStore((state) => state.pluginStates)
  const getPluginState = usePluginStore((state) => state.getPluginState)
  const setPluginEnabled = usePluginStore((state) => state.setPluginEnabled)
  const setPluginUiEnabled = usePluginStore((state) => state.setPluginUiEnabled)
  const setPluginMcpEnabled = usePluginStore((state) => state.setPluginMcpEnabled)
  const resetPluginState = usePluginStore((state) => state.resetPluginState)

  const discoveredPluginCount = plugins.filter((plugin) => !plugin.builtin).length
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

  const refreshInstalledPlugins = useCallback(async () => {
    setPluginDiscoveryLoading(true)
    setPluginDiscoveryError(null)

    try {
      const result = await discoverInstalledPlugins(currentWorkspacePath)
      pluginRegistry.replaceInstalled(result.plugins)
      setPluginDiscoveryIssues(result.errors)
      setPlugins(pluginRegistry.listPlugins())
    } catch (error) {
      setPluginDiscoveryError(error instanceof Error ? error.message : String(error))
      setPluginDiscoveryIssues([])
    } finally {
      setPluginDiscoveryLoading(false)
    }
  }, [currentWorkspacePath])

  const refreshInstallLocations = useCallback(async () => {
    try {
      setPluginInstallLocations(await getPluginInstallLocations(currentWorkspacePath))
    } catch (error) {
      setPluginDiscoveryError(error instanceof Error ? error.message : String(error))
      setPluginInstallLocations(null)
    }
  }, [currentWorkspacePath])

  const handleOpenInstallDirectory = useCallback(async () => {
    const path = pluginInstallScope === 'project'
      ? pluginInstallLocations?.projectPath
      : pluginInstallLocations?.userPath
    if (!path) return
    await openInDefaultApp(path)
  }, [pluginInstallLocations, pluginInstallScope])

  const handleInstallLocalPlugin = useCallback(async () => {
    setPluginOperationMessage(null)

    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('plugins.selectPluginDirectory', { defaultValue: 'Select plugin directory' }),
      })
      const sourcePath = Array.isArray(selected) ? selected[0] : selected
      if (!sourcePath) return

      setPluginOperationLoading(true)
      const result = await installLocalPlugin(sourcePath, pluginInstallScope, currentWorkspacePath)
      if (!result.success) {
        setPluginOperationMessage(result.error ?? t('plugins.installFailed', { defaultValue: 'Plugin install failed' }))
        return
      }

      setPluginOperationMessage(result.message ?? t('plugins.installSucceeded', { defaultValue: 'Plugin installed' }))
      await refreshInstalledPlugins()
      await refreshInstallLocations()
    } catch (error) {
      setPluginOperationMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginOperationLoading(false)
    }
  }, [currentWorkspacePath, pluginInstallScope, refreshInstallLocations, refreshInstalledPlugins, t])

  const handleUninstallLocalPlugin = useCallback(async (pluginId: string, installPath?: string) => {
    if (!installPath) return
    const confirmed = window.confirm(t('plugins.uninstallConfirm', {
      defaultValue: 'Uninstall plugin {{pluginId}}? This removes its installed directory.',
      pluginId,
    }))
    if (!confirmed) return

    setPluginOperationLoading(true)
    setPluginOperationMessage(null)

    try {
      const result = await uninstallLocalPlugin(installPath, currentWorkspacePath)
      if (!result.success) {
        setPluginOperationMessage(result.error ?? t('plugins.uninstallFailed', { defaultValue: 'Plugin uninstall failed' }))
        return
      }

      resetPluginState(pluginId)
      setPluginOperationMessage(result.message ?? t('plugins.uninstallSucceeded', { defaultValue: 'Plugin uninstalled' }))
      await refreshInstalledPlugins()
      await refreshInstallLocations()
    } catch (error) {
      setPluginOperationMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginOperationLoading(false)
    }
  }, [currentWorkspacePath, refreshInstallLocations, refreshInstalledPlugins, resetPluginState, t])

  const handleCheckPluginUpdate = useCallback(async (pluginId: string, installPath?: string) => {
    if (!installPath) return

    setPluginOperationMessage(null)
    setPluginUpdateLoadingId(pluginId)

    try {
      const result = await checkPluginUpdate(installPath)
      setPluginUpdateChecks((checks) => ({ ...checks, [pluginId]: result }))
      if (result.error) {
        setPluginOperationMessage(result.error)
      }
    } catch (error) {
      setPluginOperationMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginUpdateLoadingId(null)
    }
  }, [])

  useEffect(() => {
    refreshMcpHealth()
  }, [refreshMcpHealth])

  useEffect(() => {
    refreshInstallLocations()
  }, [refreshInstallLocations])

  return (
    <div className="space-y-4">
      <div className="text-sm text-text-secondary">
        {t('plugins.description')}
      </div>
      <div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-background-elevated px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-xs text-text-tertiary">
          {pluginDiscoveryError
            ? t('plugins.discoveryError', { defaultValue: 'Plugin discovery failed: {{error}}', error: pluginDiscoveryError })
            : t('plugins.discoverySummary', {
              defaultValue: '{{count}} installed plugins discovered, {{issues}} diagnostics',
              count: discoveredPluginCount,
              issues: pluginDiscoveryIssues.length,
            })}
        </div>
        <button
          type="button"
          onClick={refreshInstalledPlugins}
          disabled={pluginDiscoveryLoading}
          className="inline-flex items-center gap-1.5 self-start rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-background-hover disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
        >
          <RefreshCw size={13} />
          {pluginDiscoveryLoading
            ? t('plugins.refreshingDiscovery', { defaultValue: 'Refreshing...' })
            : t('plugins.refreshDiscovery', { defaultValue: 'Refresh installed plugins' })}
        </button>
      </div>
      <div className="rounded-md border border-border-subtle bg-background-elevated px-3 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="text-xs font-medium text-text-secondary">
              {t('plugins.installDirectoryTitle', { defaultValue: 'Install directories' })}
            </div>
            <div className="mt-1 truncate text-xs text-text-tertiary">
              {pluginInstallScope === 'project'
                ? pluginInstallLocations?.projectPath ?? t('plugins.projectInstallUnavailable', { defaultValue: 'Open a workspace to install project plugins' })
                : pluginInstallLocations?.userPath ?? t('plugins.installLocationsUnavailable', { defaultValue: 'Install locations unavailable' })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={pluginInstallScope}
              onChange={(event) => setPluginInstallScope(event.target.value as 'user' | 'project')}
              className="rounded-md border border-border-subtle bg-background-surface px-2 py-1.5 text-xs text-text-secondary"
            >
              <option value="user">{t('plugins.userInstallScope', { defaultValue: 'User' })}</option>
              <option value="project" disabled={!currentWorkspacePath}>
                {t('plugins.projectInstallScope', { defaultValue: 'Project' })}
              </option>
            </select>
            <button
              type="button"
              onClick={handleOpenInstallDirectory}
              disabled={pluginInstallScope === 'project' && !pluginInstallLocations?.projectPath}
              className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-background-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FolderOpen size={13} />
              {t('plugins.openInstallDirectory', { defaultValue: 'Open directory' })}
            </button>
            <button
              type="button"
              onClick={handleInstallLocalPlugin}
              disabled={pluginOperationLoading || (pluginInstallScope === 'project' && !currentWorkspacePath)}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PackagePlus size={13} />
              {pluginOperationLoading
                ? t('plugins.installingPlugin', { defaultValue: 'Installing...' })
                : t('plugins.installFromDirectory', { defaultValue: 'Install from directory' })}
            </button>
          </div>
        </div>
        {pluginOperationMessage && (
          <div className="mt-2 text-xs text-text-tertiary">{pluginOperationMessage}</div>
        )}
      </div>
      {pluginDiscoveryIssues.length > 0 && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
          <div className="text-xs font-medium text-warning">
            {t('plugins.discoveryIssuesTitle', { defaultValue: 'Manifest diagnostics' })}
          </div>
          <div className="mt-2 space-y-1">
            {pluginDiscoveryIssues.map((issue, index) => (
              <div key={`${issue.path}-${index}`} className="text-xs text-text-secondary">
                <span className="font-medium">{issue.path}</span>
                <span className="text-text-tertiary"> - {issue.error}</span>
              </div>
            ))}
          </div>
        </div>
      )}
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
          const updateCheck = pluginUpdateChecks[plugin.id]
          const originEntries = Object.entries(plugin.origin ?? {})
            .filter(([, value]) => typeof value === 'string' && value.length > 0)

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
                  {originEntries.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {originEntries.map(([key, value]) => (
                        <div key={key} className="truncate text-xs text-text-tertiary">
                          <span className="text-text-secondary">
                            {t(`plugins.origin.${key}`, { defaultValue: key })}
                          </span>
                          <span> {value}</span>
                        </div>
                      ))}
                    </div>
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
                {!plugin.builtin && (
                  <button
                    type="button"
                    onClick={() => handleCheckPluginUpdate(plugin.id, plugin.installPath)}
                    disabled={pluginUpdateLoadingId === plugin.id || !plugin.installPath}
                    className="inline-flex items-center gap-1.5 self-start rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-background-hover disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
                  >
                    <RefreshCw size={13} />
                    {pluginUpdateLoadingId === plugin.id
                      ? t('plugins.checkingUpdate', { defaultValue: 'Checking...' })
                      : t('plugins.checkUpdate', { defaultValue: 'Check update' })}
                  </button>
                )}
                {!plugin.builtin && (
                  <button
                    type="button"
                    onClick={() => handleUninstallLocalPlugin(plugin.id, plugin.installPath)}
                    disabled={pluginOperationLoading || !plugin.installPath}
                    className="inline-flex items-center gap-1.5 self-start rounded-md border border-danger/30 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
                  >
                    <Trash2 size={13} />
                    {t('plugins.uninstall', { defaultValue: 'Uninstall' })}
                  </button>
                )}
              </div>
              {updateCheck && (
                <div className="mt-3 rounded-md border border-border-subtle bg-background-elevated px-3 py-2 text-xs text-text-tertiary">
                  {updateCheck.checked
                    ? updateCheck.updateAvailable
                      ? t('plugins.updateAvailable', {
                        defaultValue: 'Update available: {{current}} -> {{latest}}',
                        current: updateCheck.currentVersion,
                        latest: updateCheck.latestVersion ?? '?',
                      })
                      : t('plugins.noUpdateAvailable', {
                        defaultValue: 'No update found. Current version: {{version}}',
                        version: updateCheck.currentVersion,
                      })
                    : updateCheck.error ?? t('plugins.updateUnavailable', { defaultValue: 'Update check unavailable' })}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
