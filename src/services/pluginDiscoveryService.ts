import { invoke } from './transport'
import type {
  PluginIconId,
  PluginLeftPanelType,
  PluginManifestSource,
  PluginMcpServerContribution,
  PluginPermissionDeclaration,
  PluginViewContribution,
  PolarisPluginManifest,
} from '@/plugin-system/types'

interface PluginDiscoveryResult {
  plugins: PolarisPluginManifest[]
  errors: Array<{
    path: string
    error: string
  }>
}

const VALID_VIEW_AREAS = new Set(['activityBar'])
const VALID_TRANSPORTS = new Set(['stdio', 'http'])
const VALID_SOURCE_KINDS = new Set(['user', 'project'])
const VALID_PLUGIN_ICONS = new Set<PluginIconId>([
  'Files',
  'GitPullRequest',
  'CheckSquare',
  'Languages',
  'Clock',
  'ClipboardList',
  'Terminal',
  'Code2',
  'Bot',
  'BookOpen',
  'AlertCircle',
])
const VALID_PANEL_TYPES = new Set<PluginLeftPanelType>([
  'files',
  'git',
  'translate',
  'scheduler',
  'requirement',
  'terminal',
  'developer',
  'integration',
  'knowledge',
  'todo',
  'problems',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function normalizeSource(value: unknown): PluginManifestSource | undefined {
  if (!isRecord(value)) return undefined
  const kind = asString(value.kind)
  if (!kind || !VALID_SOURCE_KINDS.has(kind)) return undefined
  return {
    kind: kind as PluginManifestSource['kind'],
    workspacePath: asString(value.workspacePath),
  }
}

function normalizeViews(value: unknown): Omit<PluginViewContribution, 'pluginId'>[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const id = asString(item.id)
    const area = asString(item.area)
    const panelType = asString(item.panelType)
    const icon = asString(item.icon)
    const labelKey = asString(item.labelKey)

    if (
      !id ||
      !area ||
      !panelType ||
      !icon ||
      !labelKey ||
      !VALID_VIEW_AREAS.has(area) ||
      !VALID_PANEL_TYPES.has(panelType as PluginLeftPanelType) ||
      !VALID_PLUGIN_ICONS.has(icon as PluginIconId)
    ) {
      return []
    }

    return [{
      id,
      area: area as PluginViewContribution['area'],
      panelType: panelType as PluginLeftPanelType,
      icon: icon as PluginIconId,
      labelKey,
      labelDefault: asString(item.labelDefault),
      order: typeof item.order === 'number' ? item.order : 1000,
      badge: item.badge === 'problems' ? 'problems' : undefined,
    }]
  })
}

function normalizeMcpServers(value: unknown): Omit<PluginMcpServerContribution, 'pluginId'>[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const id = asString(item.id)
    const transport = asString(item.transport)
    const command = asString(item.command)

    if (!id || !transport || !command || !VALID_TRANSPORTS.has(transport)) {
      return []
    }

    return [{
      id,
      transport: transport as PluginMcpServerContribution['transport'],
      command,
      argsTemplate: Array.isArray(item.argsTemplate)
        ? item.argsTemplate.filter((arg): arg is string => typeof arg === 'string')
        : undefined,
    }]
  })
}

function normalizePermissions(value: unknown): PluginPermissionDeclaration {
  if (!isRecord(value)) return {}

  return Object.fromEntries(
    Object.entries(value).filter(([, permissionValue]) => typeof permissionValue === 'boolean')
  ) as PluginPermissionDeclaration
}

export function normalizeDiscoveredPlugin(raw: unknown): PolarisPluginManifest | null {
  if (!isRecord(raw)) return null

  const id = asString(raw.id)
  const name = asString(raw.name)
  const version = asString(raw.version)
  const source = normalizeSource(raw.source)

  if (!id || !name || !version || !source) return null

  const contributes = isRecord(raw.contributes) ? raw.contributes : {}

  return {
    id,
    name,
    version,
    description: asString(raw.description),
    builtin: false,
    enabledByDefault: raw.enabledByDefault === true,
    contributes: {
      views: normalizeViews(contributes.views),
      mcpServers: normalizeMcpServers(contributes.mcpServers),
    },
    permissions: normalizePermissions(raw.permissions),
    source,
    installPath: asString(raw.installPath),
  }
}

export async function discoverInstalledPlugins(workspacePath?: string): Promise<PluginDiscoveryResult> {
  const result = await invoke<PluginDiscoveryResult>('plugin_discover', { workspacePath })

  return {
    plugins: result.plugins
      .map(normalizeDiscoveredPlugin)
      .filter((plugin): plugin is PolarisPluginManifest => plugin !== null),
    errors: Array.isArray(result.errors) ? result.errors : [],
  }
}
