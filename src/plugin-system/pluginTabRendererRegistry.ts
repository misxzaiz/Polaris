/**
 * 插件工作台 Tab 渲染器注册表（P0-3）
 *
 * CenterStage 的 switch(activeTab.type) 目前硬编码 editor/diff/git/browser/preview。
 * 插件可通过此注册表声明自己的 Tab 类型渲染器，CenterStage 对未知 Tab 类型
 * 回退到查此注册表，找不到则渲染空态。
 *
 * 渲染器接收 Tab 基础信息，返回 ReactNode。
 */

import type { ComponentType } from 'react'
import type { Tab } from '@/stores/tabStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginTabRendererRegistry')

export interface PluginTabRendererProps {
  /** Tab 数据（含 metadata） */
  tab: Tab
  /** 打开 Diff 或文件（由 CenterStage 注入，插件复用） */
  onOpenDiffInTab?: (diff: unknown, options?: unknown) => string
  onOpenFileInEditor?: (filePath: string) => string
  className?: string
}

export type PluginTabRenderer = ComponentType<PluginTabRendererProps>

interface TabRendererEntry {
  pluginId: string
  renderer: PluginTabRenderer
}

class PluginTabRendererRegistry {
  private renderers = new Map<string, TabRendererEntry>()

  register(tabType: string, pluginId: string, renderer: PluginTabRenderer): void {
    this.renderers.set(tabType, { pluginId, renderer })
    log.debug(`Registered tab renderer: ${tabType} (plugin: ${pluginId})`)
  }

  unregister(tabType: string): void {
    this.renderers.delete(tabType)
  }

  unregisterAll(pluginId: string): void {
    for (const [tabType, entry] of this.renderers) {
      if (entry.pluginId === pluginId) {
        this.renderers.delete(tabType)
      }
    }
  }

  has(tabType: string): boolean {
    return this.renderers.has(tabType)
  }

  get(tabType: string): PluginTabRenderer | undefined {
    return this.renderers.get(tabType)?.renderer
  }

  listTabTypes(): string[] {
    return Array.from(this.renderers.keys())
  }
}

export const pluginTabRendererRegistry = new PluginTabRendererRegistry()