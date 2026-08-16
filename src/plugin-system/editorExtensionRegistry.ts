/**
 * CM6 编辑器扩展注册表
 *
 * 插件可以通过此注册表将自己的 CM6 Extension 注入到编辑器实例。
 * 注册的扩展按插件 ID 去重，同一插件多次注册覆盖旧值。
 */

import type { Extension } from '@codemirror/state'
import { createLogger } from '@/utils/logger'

const log = createLogger('EditorExtensionRegistry')

/**
 * 编辑器扩展工厂函数。
 * 接收当前文件路径，返回 CM6 Extension 或 Extension 数组。
 * 返回 null/undefined 表示该插件在此文件上不贡献扩展。
 */
export type EditorExtensionFactory = (filePath?: string) => Extension | Extension[] | null | undefined

interface EditorExtensionEntry {
  pluginId: string
  factory: EditorExtensionFactory
  description?: string
}

class EditorExtensionRegistry {
  private extensions = new Map<string, EditorExtensionEntry>()

  /**
   * 注册插件编辑器扩展。
   * 同一 pluginId 的多次注册会覆盖旧值（插件热重载场景）。
   */
  register(pluginId: string, factory: EditorExtensionFactory, description?: string): void {
    this.extensions.set(pluginId, { pluginId, factory, description })
    log.debug(`Registered editor extension: ${pluginId}${description ? ` (${description})` : ''}`)
  }

  /**
   * 卸载插件编辑器扩展。
   */
  unregister(pluginId: string): void {
    this.extensions.delete(pluginId)
    log.debug(`Unregistered editor extension: ${pluginId}`)
  }

  /**
   * 列出所有已注册的扩展工厂。
   */
  listFactories(): { pluginId: string; factory: EditorExtensionFactory; description?: string }[] {
    return Array.from(this.extensions.values())
  }

  /**
   * 收集当前文件的所有插件扩展。
   * 在编辑器创建时调用，结果展开到 extensions 数组。
   */
  collectExtensions(filePath?: string): Extension[] {
    const result: Extension[] = []
    for (const [, entry] of this.extensions) {
      try {
        const ext = entry.factory(filePath)
        if (ext != null) {
          if (Array.isArray(ext)) {
            result.push(...ext)
          } else {
            result.push(ext)
          }
        }
      } catch (err) {
        log.warn(`Editor extension factory "${entry.pluginId}" threw: ${String(err)}`)
      }
    }
    return result
  }

  /**
   * 判断是否有插件注册了扩展。
   */
  hasExtensions(): boolean {
    return this.extensions.size > 0
  }
}

export const editorExtensionRegistry = new EditorExtensionRegistry()