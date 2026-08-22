/**
 * 插件配置读写 API
 *
 * 插件配置存储在 config.json 的 `plugins[pluginId]` 命名空间，跨设备同步。
 * 读写受 manifest.permissions.appConfigRead/appConfigWrite 权限约束（后端校验）。
 *
 * - 内置 React 插件 / 外部 ESM 插件：用本模块的 TS API
 * - MCP server 插件：用 polaris_get/set_plugin_config MCP 工具
 *
 * sensitive 字段（如 API key）读取时脱敏，写入时不回显。
 */

import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginConfig')

/**
 * 读取插件配置（整个配置对象）。
 * @param pluginId 插件 id
 * @returns 该插件的配置对象（合并 manifest.configSchema 默认值）；无配置时返回 {}
 *
 * 后端校验：pluginId 必须是已注册插件且 manifest.permissions.appConfigRead === true。
 * sensitive 字段返回脱敏值（如 "sk-***xxxx"），不返回明文。
 */
export async function getPluginConfig(pluginId: string): Promise<Record<string, unknown>> {
  try {
    const result = await invoke<Record<string, unknown>>('plugin_get_config', { pluginId })
    return result ?? {}
  } catch (e) {
    log.error('getPluginConfig failed', e instanceof Error ? e : new Error(String(e)), { pluginId })
    throw e
  }
}

/**
 * 读取插件配置单个字段。
 * @param pluginId 插件 id
 * @param key 字段 key（应在 manifest.configSchema 中声明）
 * @returns 字段值；未设置时返回 schema default 或 undefined
 */
export async function getPluginConfigField<T = unknown>(pluginId: string, key: string): Promise<T | undefined> {
  const config = await getPluginConfig(pluginId)
  return config[key] as T | undefined
}

/**
 * 写入插件配置（字段级 patch 合并）。
 * @param pluginId 插件 id
 * @param patch 要合并的配置字段（浅合并到现有配置）
 * @returns 合并后的完整配置对象
 *
 * 后端校验：pluginId 必须是已注册插件且 manifest.permissions.appConfigWrite === true。
 * sensitive 字段写入后，返回值中该字段脱敏。
 */
export async function setPluginConfig(
  pluginId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const result = await invoke<Record<string, unknown>>('plugin_set_config', { pluginId, patch })
    return result ?? {}
  } catch (e) {
    log.error('setPluginConfig failed', e instanceof Error ? e : new Error(String(e)), { pluginId })
    throw e
  }
}

/**
 * 写入插件配置单个字段（便捷方法）。
 */
export async function setPluginConfigField(
  pluginId: string,
  key: string,
  value: unknown,
): Promise<Record<string, unknown>> {
  return setPluginConfig(pluginId, { [key]: value })
}
