/**
 * 第三方 UI 模板注册表（plugin-ui-contribution-spec [R-12..R-15]）
 *
 * 插件经 `contributes.uiTemplates` 注册模板；「卡片即数据」marker
 * `{ template: '<pluginId>/<tplId>', data }` 引用。校验（命名空间/保留名）
 * 在 registry.register 时执行；引用未注册模板由渲染方回落兜底卡（[R-15]）。
 *
 * 与宿主 `ui.template` 域同域治理（ui_render_capability v2）：本表持有
 * 「插件注册模板」这一子域；entry/html 的渲染消费在 chatActions 渲染集成
 * 批次接入（当前批交付：契约 + 注册 + 校验 + 观测）。
 */

import type { PluginUiTemplateContribution } from './types'
import { createLogger } from '@/utils/logger'

const log = createLogger('UiTemplateRegistry')

/** 内置保留模板名（第三方不可注册/覆盖，[R-12]） */
export const RESERVED_TEMPLATE_NAMES = ['ask-card', 'form-card', 'artifact-card', 'chart-card'] as const

export interface UiTemplateRegistration {
  pluginId: string
  template: PluginUiTemplateContribution
}

class UiTemplateRegistry {
  private byId = new Map<string, UiTemplateRegistration>()

  /** 注册（命名空间/保留名校验；失败 warn 降级不抛错，[R-18]） */
  register(manifestId: string, tpl: PluginUiTemplateContribution): void {
    if (!tpl.id.startsWith(`${manifestId}/`)) {
      log.warn('uiTemplates 注册被拒（id 未以插件 id 为命名空间）', { pluginId: manifestId, id: tpl.id })
      return
    }
    const tail = tpl.id.slice(manifestId.length + 1)
    if ((RESERVED_TEMPLATE_NAMES as readonly string[]).includes(tail)) {
      log.warn('uiTemplates 注册被拒（保留模板名不可覆盖）', { pluginId: manifestId, id: tpl.id })
      return
    }
    if (tpl.entry && tpl.html) {
      log.warn('uiTemplates 注册被拒（entry 与 html 二选一）', { pluginId: manifestId, id: tpl.id })
      return
    }
    if (!tpl.entry && !tpl.html) {
      log.warn('uiTemplates 注册被拒（entry/html 缺一不可）', { pluginId: manifestId, id: tpl.id })
      return
    }
    if (this.byId.has(tpl.id) && this.byId.get(tpl.id)!.pluginId !== manifestId) {
      log.warn('uiTemplates 注册被拒（跨插件覆盖他人模板 id）', { pluginId: manifestId, id: tpl.id })
      return
    }
    this.byId.set(tpl.id, { pluginId: manifestId, template: tpl })
    log.info('uiTemplate 已注册', { pluginId: manifestId, id: tpl.id })
  }

  unregisterPlugin(manifestId: string): void {
    for (const [id, reg] of this.byId) {
      if (reg.pluginId === manifestId) this.byId.delete(id)
    }
  }

  lookup(id: string): UiTemplateRegistration | null {
    return this.byId.get(id) ?? null
  }

  list(): UiTemplateRegistration[] {
    return [...this.byId.values()]
  }

  resetForTest(): void {
    this.byId.clear()
  }
}

export const uiTemplateRegistry = new UiTemplateRegistry()
