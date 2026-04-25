/**
 * Plugin 服务
 *
 * 封装 Tauri 命令调用
 */

import { invoke } from '@/services/transport'
import type {
  PluginListResult,
  PluginOperationResult,
  Marketplace,
  PluginScope,
} from '../types/plugin';

/**
 * 列出插件
 * @param available 是否包含可用插件
 */
export async function pluginList(available: boolean = false): Promise<PluginListResult> {
  return invoke<PluginListResult>('plugin_list', { available });
}

/**
 * 安装插件
 * @param pluginId 插件 ID
 * @param scope 安装范围
 */
export async function pluginInstall(
  pluginId: string,
  scope: PluginScope = 'user'
): Promise<PluginOperationResult> {
  return invoke<PluginOperationResult>('plugin_install', { pluginId, scope });
}

/**
 * 启用插件
 * @param pluginId 插件 ID
 * @param scope 安装范围
 */
export async function pluginEnable(
  pluginId: string,
  scope: PluginScope = 'user'
): Promise<PluginOperationResult> {
  return invoke<PluginOperationResult>('plugin_enable', { pluginId, scope });
}

/**
 * 禁用插件
 * @param pluginId 插件 ID
 * @param scope 安装范围
 */
export async function pluginDisable(
  pluginId: string,
  scope: PluginScope = 'user'
): Promise<PluginOperationResult> {
  return invoke<PluginOperationResult>('plugin_disable', { pluginId, scope });
}

/**
 * 更新插件
 * @param pluginId 插件 ID
 * @param scope 安装范围
 */
export async function pluginUpdate(
  pluginId: string,
  scope: PluginScope = 'user'
): Promise<PluginOperationResult> {
  return invoke<PluginOperationResult>('plugin_update', { pluginId, scope });
}

/**
 * 卸载插件
 * @param pluginId 插件 ID
 * @param scope 安装范围
 * @param keepData 是否保留数据
 */
export async function pluginUninstall(
  pluginId: string,
  scope: PluginScope = 'user',
  keepData: boolean = false
): Promise<PluginOperationResult> {
  return invoke<PluginOperationResult>('plugin_uninstall', { pluginId, scope, keepData });
}

/**
 * 列出市场
 */
export async function marketplaceList(): Promise<Marketplace[]> {
  return invoke<Marketplace[]>('marketplace_list');
}

/**
 * 添加市场
 * @param source 市场来源 (GitHub repo 或 URL)
 */
export async function marketplaceAdd(source: string): Promise<Marketplace> {
  return invoke<Marketplace>('marketplace_add', { source });
}

/**
 * 移除市场
 * @param name 市场名称
 */
export async function marketplaceRemove(name: string): Promise<void> {
  return invoke('marketplace_remove', { name });
}

/**
 * 更新市场
 * @param name 市场名称（可选，不指定则更新所有）
 */
export async function marketplaceUpdate(name?: string): Promise<void> {
  return invoke('marketplace_update', { name });
}
