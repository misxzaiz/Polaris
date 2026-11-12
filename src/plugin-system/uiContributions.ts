/**
 * 插件 UI 槽位宿主 API（H7）—— 通用贡献点，不含任何业务域语义。
 *
 * 插件在 `contributes.uiSlots` 中声明需要的槽位后，宿主在插件注册时
 * 加载其 panel entry 并调用模块导出的 `registerUi(host, ctx)` 一次：
 *
 *   export function registerUi(host, ctx) {
 *     host.registerFileExplorerToolbar('branch-badge', BranchBadge, 10)
 *     host.registerDiffRefreshProvider(async (filePath, workspacePath) => {...})
 *   }
 *
 * 约定：
 * - 组件必须用宿主 React（panel bundle 已做 import 重写），否则实例不同源；
 * - 注册幂等：同一插件重复注册同名 itemId 覆盖旧值（slot 自身保证）；
 * - 只允许注册，不允许读取宿主内部 store —— 数据必须由插件自己的服务提供。
 */

import type { ComponentType } from 'react'
import {
  fileExplorerToolbarSlot,
  type FileExplorerToolbarItemProps,
} from './fileExplorerToolbarSlot'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginUiContributions')

/** diff 刷新提供者：返回 null 表示"我没有这个文件的最新差异"，宿主退回旧数据 */
export type DiffRefreshProvider = (
  filePath: string,
  workspacePath: string,
) => Promise<unknown | null>

interface DiffRefreshEntry {
  pluginId: string
  provider: DiffRefreshProvider
}

let diffRefreshEntry: DiffRefreshEntry | null = null

/** 插件可见的宿主 UI API（按插件实例化，避免跨插件串扰） */
export interface PluginUiHostApi {
  /** 向文件浏览器工具栏注入组件（渲染在工具栏操作按钮之后、刷新按钮之前） */
  registerFileExplorerToolbar(
    itemId: string,
    component: ComponentType<FileExplorerToolbarItemProps>,
    order?: number,
  ): void
  /** 注册「重新获取某文件最新 diff」提供者，供宿主 diff tab 恢复时刷新 */
  registerDiffRefreshProvider(provider: DiffRefreshProvider): void
}

/** 注册 diff 刷新提供者（后注册覆盖先注册；插件禁用时应调用 unregister） */
export function registerDiffRefreshProvider(
  pluginId: string,
  provider: DiffRefreshProvider,
): void {
  diffRefreshEntry = { pluginId, provider }
  log.debug(`Diff refresh provider registered by ${pluginId}`)
}

export function unregisterDiffRefreshProvider(pluginId: string): void {
  if (diffRefreshEntry?.pluginId === pluginId) diffRefreshEntry = null
}

export function hasDiffRefreshProvider(): boolean {
  return diffRefreshEntry !== null
}

/**
 * 请求插件刷新某文件的 diff。无提供者 / 提供者抛错 / 返回 null 时返回 null，
 * 调用方退回原有 diffData（不阻塞、不弹错）。
 */
export async function refreshDiffViaPlugin(
  filePath: string,
  workspacePath: string,
): Promise<unknown | null> {
  const entry = diffRefreshEntry
  if (!entry) return null
  try {
    return await entry.provider(filePath, workspacePath)
  } catch (err) {
    log.debug('diff refresh provider failed', { pluginId: entry.pluginId, err: String(err) })
    return null
  }
}

/** 按插件创建注入视图（pluginId 用于隔离与卸载） */
export function createPluginUiHostApi(pluginId: string): PluginUiHostApi {
  return {
    registerFileExplorerToolbar(itemId, component, order = 100) {
      if (typeof component !== 'function' && typeof component !== 'object') {
        log.warn(`registerFileExplorerToolbar 组件非法，忽略`, { pluginId, itemId })
        return
      }
      fileExplorerToolbarSlot.register(`plugin:${pluginId}:${itemId}`, pluginId, component, order)
    },
    registerDiffRefreshProvider(provider) {
      if (typeof provider !== 'function') {
        log.warn(`registerDiffRefreshProvider 参数非法，忽略`, { pluginId })
        return
      }
      registerDiffRefreshProvider(pluginId, provider)
    },
  }
}

/** 插件禁用/卸载时清理它注册的全部 UI 贡献 */
export function unregisterPluginUi(pluginId: string): void {
  fileExplorerToolbarSlot.unregisterAll(pluginId)
  unregisterDiffRefreshProvider(pluginId)
}

/**
 * 加载插件 entry 并调用其 `registerUi` 导出（若存在）。
 * 失败只记日志，不影响插件面板加载。
 */
export async function hydratePluginUi(
  pluginId: string,
  installPath: string,
  entry: string,
): Promise<void> {
  try {
    const { loadModuleFromFile, resolvePluginEntryPath } = await import('./pluginModuleLoader')
    const mod = await loadModuleFromFile(resolvePluginEntryPath(installPath, entry))
    const registerUi = (mod as { registerUi?: unknown }).registerUi
    if (typeof registerUi !== 'function') {
      log.debug(`插件 ${pluginId} 未导出 registerUi，跳过 UI 注入`)
      return
    }
    await (
      registerUi as (
        api: PluginUiHostApi,
        ctx: { pluginId: string },
      ) => void | Promise<void>
    )(createPluginUiHostApi(pluginId), { pluginId })
    log.info(`插件 ${pluginId} UI 贡献已注入`)
  } catch (err) {
    log.warn(`插件 ${pluginId} UI 注入失败`, { err: String(err) })
  }
}
