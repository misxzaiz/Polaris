/**
 * 插件样式注入服务
 *
 * 把插件声明的 CSS 片段注入到独立 <style> 标签，
 * 让插件能改造任意 UI 样式（输入框、面板、布局等）。
 *
 * 注入位置：head 末尾，优先级高于主题变量但低于用户自定义 CSS。
 * 每个 style 用 `plugin-css-{pluginId}-{styleId}` 作为 style 标签 id，
 * 便于插件卸载时精确清理。
 */

import { pluginRegistry } from '@/plugin-system/registry'
import { usePluginStore } from '@/stores/pluginStore'
import type { PluginStyleContribution } from '@/plugin-system/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginStyles')

const STYLE_TAG_PREFIX = 'plugin-css-'

/** 为单个 style 贡献生成 style 标签 id */
function styleTagId(pluginId: string, styleId: string): string {
  return `${STYLE_TAG_PREFIX}${pluginId}-${styleId}`
}

/** 注入单个 style 贡献的 CSS */
function injectStyle(pluginId: string, style: PluginStyleContribution): void {
  if (typeof document === 'undefined') return

  const tagId = styleTagId(pluginId, style.id)
  let styleEl = document.getElementById(tagId) as HTMLStyleElement | null

  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = tagId
    styleEl.dataset.pluginId = pluginId
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = style.css

  if (style.target === 'slot') {
    styleEl.dataset.slotId = style.slotId ?? ''
    log.debug(`注入 slot 样式: ${pluginId}/${style.id} → slot:${style.slotId}`)
  } else {
    log.debug(`注入全局样式: ${pluginId}/${style.id}`)
  }
}

/** 移除某插件的所有 style 标签 */
function removePluginStyles(pluginId: string): void {
  if (typeof document === 'undefined') return
  const tags = document.head.querySelectorAll<HTMLStyleElement>(
    `style[data-plugin-id="${pluginId}"]`
  )
  tags.forEach((t) => t.remove())
  if (tags.length > 0) {
    log.info(`移除插件 ${pluginId} 的 ${tags.length} 个样式标签`)
  }
}

/**
 * 根据当前已启用插件，注入所有 styles 贡献。
 *
 * 启用状态变化时调用（插件加载/启用/禁用/卸载）。
 * 策略：先移除所有插件样式标签，再重新注入已启用插件的样式，
 * 保证状态一致性。
 */
export function applyPluginStyles(): void {
  if (typeof document === 'undefined') return

  // 移除所有插件样式标签
  const existing = document.head.querySelectorAll<HTMLStyleElement>(
    `style[data-plugin-id]`
  )
  existing.forEach((t) => t.remove())

  // 重新注入已启用插件的样式
  const pluginStates = usePluginStore.getState().pluginStates
  const manifests = pluginRegistry.listPlugins()

  let injectedCount = 0
  for (const manifest of manifests) {
    const state = pluginStates[manifest.id]
    const enabled = state ? state.enabled && state.uiEnabled : manifest.enabledByDefault
    if (!enabled) continue

    const styles = manifest.contributes.styles
    if (!styles || styles.length === 0) continue

    for (const style of styles) {
      injectStyle(manifest.id, style)
      injectedCount++
    }
  }

  if (injectedCount > 0) {
    log.info(`插件样式注入完成：${injectedCount} 个样式`)
  }
}

/**
 * 移除某插件注入的样式（插件禁用/卸载时调用）
 */
export function removeStyles(pluginId: string): void {
  removePluginStyles(pluginId)
}
