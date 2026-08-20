import type { PluginPanelComponent, PluginPanelLoader } from './types'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginPanelRegistry')

interface PanelEntry {
  pluginId: string
  loader: PluginPanelLoader
}

class PluginPanelRegistry {
  private panels = new Map<string, PanelEntry>()
  private cache = new Map<string, PluginPanelComponent>()

  register(panelType: string, pluginId: string, loader: PluginPanelLoader): void {
    if (this.panels.has(panelType)) {
      log.warn(`Panel type "${panelType}" already registered by ${this.panels.get(panelType)?.pluginId}, overriding with ${pluginId}`)
    }
    this.panels.set(panelType, { pluginId, loader })
    this.cache.delete(panelType)
    log.debug(`Registered panel: ${panelType} (plugin: ${pluginId})`)
  }

  unregister(panelType: string): void {
    this.panels.delete(panelType)
    this.cache.delete(panelType)
  }

  unregisterAll(pluginId: string): void {
    for (const [panelType, entry] of this.panels) {
      if (entry.pluginId === pluginId) {
        this.panels.delete(panelType)
        this.cache.delete(panelType)
      }
    }
  }

  has(panelType: string): boolean {
    return this.panels.has(panelType)
  }

  getPluginId(panelType: string): string | undefined {
    return this.panels.get(panelType)?.pluginId
  }

  listPanelTypes(): string[] {
    return Array.from(this.panels.keys())
  }

  async load(panelType: string): Promise<PluginPanelComponent> {
    const cached = this.cache.get(panelType)
    if (cached) return cached

    const entry = this.panels.get(panelType)
    if (!entry) {
      throw new Error(`No panel registered for type: ${panelType}`)
    }

    const mod = await entry.loader()
    const component = mod.default
    if (!component) {
      throw new Error(`Panel module for "${panelType}" does not export a default component`)
    }

    this.cache.set(panelType, component)
    return component
  }

  resolveEntryPath(panelType: string): string | null {
    const entry = this.panels.get(panelType)
    return entry?.loader ? panelType : null
  }
}

export const pluginPanelRegistry = new PluginPanelRegistry()
