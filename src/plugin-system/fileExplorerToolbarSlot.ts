/**
 * 文件树工具栏 Slot（P0-5）
 *
 * 插件可通过此注册表向文件浏览器工具栏注入自定义内容，
 * 避免硬编码 import（如 GitStatusIndicator 直接 import useGitStore）。
 * 注入内容渲染在工具栏操作按钮之后、刷新按钮之前。
 */

import type { ComponentType } from 'react'
import { createLogger } from '@/utils/logger'

const log = createLogger('FileExplorerToolbarSlot')

export interface FileExplorerToolbarItemProps {
  /** 工具栏容器提供的额外上下文（可扩展） */
  workspacePath?: string
}

export type FileExplorerToolbarItemComponent = ComponentType<FileExplorerToolbarItemProps>

interface ToolbarItemEntry {
  pluginId: string
  component: FileExplorerToolbarItemComponent
  order: number
}

class FileExplorerToolbarSlot {
  private items = new Map<string, ToolbarItemEntry>()

  /**
   * 注册工具栏注入项。同一 itemId 重复注册覆盖旧值。
   */
  register(itemId: string, pluginId: string, component: FileExplorerToolbarItemComponent, order = 100): void {
    this.items.set(itemId, { pluginId, component, order })
    log.debug(`Registered file explorer toolbar item: ${itemId} (plugin: ${pluginId})`)
  }

  unregister(itemId: string): void {
    this.items.delete(itemId)
  }

  unregisterAll(pluginId: string): void {
    for (const [itemId, entry] of this.items) {
      if (entry.pluginId === pluginId) {
        this.items.delete(itemId)
      }
    }
  }

  listItems(): { itemId: string; component: FileExplorerToolbarItemComponent; order: number }[] {
    return Array.from(this.items.entries())
      .map(([itemId, entry]) => ({ itemId, ...entry }))
      .sort((a, b) => a.order - b.order)
  }

  hasItems(): boolean {
    return this.items.size > 0
  }
}

export const fileExplorerToolbarSlot = new FileExplorerToolbarSlot()