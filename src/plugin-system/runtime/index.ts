/**
 * Plugin runtime barrel — host-side public surface.
 *
 * Plugins themselves should NOT import from this module; they receive their
 * `PolarisPluginApi` via `window.__POLARIS__.forPlugin(pluginId)` (or as an
 * argument to their entry component). This barrel is for the host's own
 * loader, settings UI, and tests.
 */

export type {
  PolarisHostRuntime,
  PolarisPluginApi,
  PluginTransport,
  PluginCodeMirrorEditorProps,
  PluginConfirmDialogProps,
  PluginProgressiveMarkdownProps,
  PluginZoomableDiagramProps,
} from './api'

export {
  HOST_API_VERSION,
  PluginApiVersionMismatchError,
  RangeSyntaxError,
  assertHostSatisfies,
  compareVersions,
  parseVersion,
  satisfies,
} from './version'

export {
  PluginPermissionDeniedError,
  compileAllowlist,
  createPluginTransport,
} from './transport'
export type { PluginTransportOptions } from './transport'

export {
  __resetPluginRuntimeForTests,
  installPluginRuntime,
} from './installer'

export {
  PluginEntryShapeError,
  PluginLoadError,
  loadPluginPanel,
} from './loader'
export type {
  LoadPluginPanelOptions,
  PluginPanelComponent,
} from './loader'
