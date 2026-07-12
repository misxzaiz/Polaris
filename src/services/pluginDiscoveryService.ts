import { invoke } from './transport'
import type {
  PluginIconId,
  PluginLeftPanelType,
  PluginOriginMetadata,
  PluginManifestSource,
  PluginMcpServerContribution,
  PluginChatCardContribution,
  PluginPanelContribution,
  PluginPermissionDeclaration,
  PluginViewContribution,
  PolarisPluginManifest,
} from '@/plugin-system/types'

export interface PluginDiscoveryIssue {
  path: string
  error: string
}

interface BackendPluginDiscoveryResult {
  plugins: unknown[]
  errors: PluginDiscoveryIssue[]
}

export interface PluginInstallLocations {
  userPath: string
  projectPath?: string
  discoveryPaths: string[]
}

export interface PluginOperationResult {
  success: boolean
  message?: string
  error?: string
}

export interface PluginManifestValidationResult {
  valid: boolean
  manifestPath?: string
  pluginId?: string
  errors: PluginDiscoveryIssue[]
}

export interface PluginUpdateCheckResult {
  pluginId: string
  currentVersion: string
  latestVersion?: string
  updateAvailable: boolean
  checked: boolean
  sourceUrl?: string
  downloadUrl?: string
  error?: string
}

export interface PluginDiscoveryResult {
  plugins: PolarisPluginManifest[]
  errors: PluginDiscoveryIssue[]
}

const VALID_VIEW_AREAS = new Set(['activityBar'])
const VALID_TRANSPORTS = new Set(['stdio', 'http'])
const VALID_SOURCE_KINDS = new Set(['user', 'project'])
const VALID_CARD_MODES = new Set(['result', 'interaction'])
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

function normalizeViews(
  value: unknown,
  errors: string[]
): Omit<PluginViewContribution, 'pluginId'>[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item, index) => {
    if (!isRecord(item)) {
      errors.push(`contributes.views[${index}] must be an object`)
      return []
    }

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
      !VALID_PLUGIN_ICONS.has(icon as PluginIconId)
    ) {
      errors.push(`contributes.views[${index}] is invalid and was ignored`)
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

function normalizeMcpServers(
  value: unknown,
  errors: string[]
): Omit<PluginMcpServerContribution, 'pluginId'>[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item, index) => {
    if (!isRecord(item)) {
      errors.push(`contributes.mcpServers[${index}] must be an object`)
      return []
    }

    const id = asString(item.id)
    const transport = asString(item.transport)
    const command = asString(item.command)

    if (!id || !transport || !command || !VALID_TRANSPORTS.has(transport)) {
      errors.push(`contributes.mcpServers[${index}] is invalid and was ignored`)
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

function normalizeOrigin(value: unknown): PluginOriginMetadata | undefined {
  if (!isRecord(value)) return undefined
  const origin = {
    repository: asString(value.repository),
    homepage: asString(value.homepage),
    updateUrl: asString(value.updateUrl),
    downloadUrl: asString(value.downloadUrl),
  }
  return origin.repository || origin.homepage || origin.updateUrl || origin.downloadUrl ? origin : undefined
}

function normalizePanel(value: unknown): PluginPanelContribution | undefined {
  if (!isRecord(value)) return undefined
  const entry = asString(value.entry)
  if (!entry) return undefined
  return { entry }
}

/**
 * 归一化 chatCards 贡献点。
 *
 * 安全校验：mcpServerId 必须属于本插件声明的 mcpServers[].id，否则丢弃该卡片
 * （防止插件劫持内置工具或其他插件的渲染）。
 */
function normalizeChatCards(
  value: unknown,
  ownMcpServerIds: Set<string>,
  errors: string[]
): Omit<PluginChatCardContribution, 'pluginId'>[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item, index) => {
    if (!isRecord(item)) {
      errors.push(`contributes.chatCards[${index}] must be an object`)
      return []
    }

    const id = asString(item.id)
    const mcpServerId = asString(item.mcpServerId)
    const mode = asString(item.mode) ?? 'result'
    const tools = Array.isArray(item.tools)
      ? item.tools.filter((tool): tool is string => typeof tool === 'string' && tool.trim().length > 0)
      : []

    if (!id || !mcpServerId || !VALID_CARD_MODES.has(mode) || tools.length === 0) {
      errors.push(`contributes.chatCards[${index}] is invalid and was ignored`)
      return []
    }

    if (!ownMcpServerIds.has(mcpServerId)) {
      errors.push(
        `contributes.chatCards[${index}].mcpServerId "${mcpServerId}" is not declared in this plugin's mcpServers and was ignored`
      )
      return []
    }

    return [{
      id,
      entry: asString(item.entry),
      mcpServerId,
      tools,
      mode: mode as PluginChatCardContribution['mode'],
    }]
  })
}

export function normalizeDiscoveredPlugin(raw: unknown): PolarisPluginManifest | null {
  return validateDiscoveredPlugin(raw).plugin
}

export function validateDiscoveredPlugin(raw: unknown): {
  plugin: PolarisPluginManifest | null
  errors: string[]
} {
  const errors: string[] = []

  if (!isRecord(raw)) {
    return { plugin: null, errors: ['manifest must be an object'] }
  }

  const id = asString(raw.id)
  const name = asString(raw.name)
  const version = asString(raw.version)
  const source = normalizeSource(raw.source)

  if (!id) errors.push('id is required and must be a string')
  if (!name) errors.push('name is required and must be a string')
  if (!version) errors.push('version is required and must be a string')
  if (!source) errors.push('source.kind must be user or project')
  if (!id || !name || !version || !source) {
    return { plugin: null, errors }
  }

  const contributes = isRecord(raw.contributes) ? raw.contributes : {}

  const mcpServers = normalizeMcpServers(contributes.mcpServers, errors)
  const ownMcpServerIds = new Set(mcpServers.map((server) => server.id))

  return {
    plugin: {
      id,
      name,
      version,
      description: asString(raw.description),
      builtin: false,
      enabledByDefault: raw.enabledByDefault === true,
      contributes: {
        views: normalizeViews(contributes.views, errors),
        mcpServers,
        panel: normalizePanel(contributes.panel),
        chatCards: normalizeChatCards(contributes.chatCards, ownMcpServerIds, errors),
      },
      permissions: normalizePermissions(raw.permissions),
      origin: normalizeOrigin(raw.origin),
      source,
      installPath: asString(raw.installPath),
    },
    errors,
  }
}

export async function discoverInstalledPlugins(workspacePath?: string): Promise<PluginDiscoveryResult> {
  const result = await invoke<BackendPluginDiscoveryResult>('plugin_discover', { workspacePath })
  const normalized = Array.isArray(result.plugins)
    ? result.plugins.map((raw) => ({
      raw,
      validation: validateDiscoveredPlugin(raw),
    }))
    : []

  const backendErrors = Array.isArray(result.errors) ? result.errors : []
  const validationErrors = normalized.flatMap(({ raw, validation }) => {
    if (validation.errors.length === 0) return []
    const path = isRecord(raw)
      ? asString(raw.installPath) ?? asString(raw.id) ?? '<unknown plugin>'
      : '<unknown plugin>'
    return validation.errors.map((error) => ({ path, error }))
  })

  return {
    plugins: normalized
      .map(({ validation }) => validation.plugin)
      .filter((plugin): plugin is PolarisPluginManifest => plugin !== null),
    errors: backendErrors.concat(validationErrors),
  }
}

export async function getPluginInstallLocations(
  workspacePath?: string
): Promise<PluginInstallLocations> {
  return invoke<PluginInstallLocations>('plugin_install_locations', { workspacePath })
}

export async function validatePluginManifest(
  sourcePath: string
): Promise<PluginManifestValidationResult> {
  return invoke<PluginManifestValidationResult>('plugin_validate_manifest', { sourcePath })
}

export async function installLocalPlugin(
  sourcePath: string,
  scope: 'user' | 'project',
  workspacePath?: string
): Promise<PluginOperationResult> {
  return invoke<PluginOperationResult>('plugin_install_local', {
    sourcePath,
    scope,
    workspacePath,
  })
}

export async function installPluginPackage(
  packagePath: string,
  scope: 'user' | 'project',
  workspacePath?: string
): Promise<PluginOperationResult> {
  return invoke<PluginOperationResult>('plugin_install_package', {
    packagePath,
    scope,
    workspacePath,
  })
}

export async function installRemotePlugin(
  sourceUrl: string,
  scope: 'user' | 'project',
  workspacePath?: string
): Promise<PluginOperationResult> {
  return invoke<PluginOperationResult>('plugin_install_remote', {
    sourceUrl,
    scope,
    workspacePath,
  })
}

export async function uninstallLocalPlugin(
  installPath: string,
  workspacePath?: string
): Promise<PluginOperationResult> {
  return invoke<PluginOperationResult>('plugin_uninstall_local', {
    installPath,
    workspacePath,
  })
}

export async function checkPluginUpdate(installPath: string): Promise<PluginUpdateCheckResult> {
  return invoke<PluginUpdateCheckResult>('plugin_check_update', { installPath })
}

export async function applyPluginUpdate(
  installPath: string,
  workspacePath?: string
): Promise<PluginOperationResult> {
  return invoke<PluginOperationResult>('plugin_apply_update', { installPath, workspacePath })
}
