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

/** CSS 内容上限（256KB）——防病态体积拖垮重排（2026-10-24 审计 P5） */
const MAX_CSS_BYTES = 256 * 1024

/**
 * CSS 内容校验（安装注入前）：超限 / @import / 外联 url() 一律拒绝。
 * 外联资源是数据外泄与内容注入通道（url() 可携带请求），@import 可绕过
 * 本模块的注入时机。本地引用（url(#id)）与 data: 内联不受限。
 */
function validateCss(css: string): { ok: boolean; reason?: string } {
  if (css.length > MAX_CSS_BYTES) {
    return { ok: false, reason: `CSS 超过 ${Math.floor(MAX_CSS_BYTES / 1024)}KB 上限` }
  }
  if (/@import\b/i.test(css)) {
    return { ok: false, reason: 'CSS 含 @import（禁止：绕过注入时机与校验）' }
  }
  if (/url\(\s*['"]?https?:/i.test(css)) {
    return { ok: false, reason: 'CSS 含外联 url()（禁止：数据外泄/内容注入通道）' }
  }
  return { ok: true }
}

/**
 * slot 作用域前缀化（P5）：target==='slot' 的样式不再裸注全局——
 * 每条规则的选择器加 `[data-plugin-scope="<pluginId>"]` 前缀，只命中
 * 本插件面板容器（PluginPanelHost 挂 data-plugin-scope）。
 * 此前 target:'slot' 有名无实（只写 dataset，样式仍全局生效），插件间
 * 与插件对宿主可互相覆盖（也是点击劫持面）。
 */
function scopeCss(css: string, pluginId: string): string {
  const prefix = `[data-plugin-scope="${pluginId}"]`
  const readBlock = (openIdx: number): { content: string; end: number } => {
    let depth = 1
    let k = openIdx + 1
    while (k < css.length && depth > 0) {
      if (css[k] === '{') depth++
      else if (css[k] === '}') depth--
      k++
    }
    return { content: css.slice(openIdx + 1, depth === 0 ? k - 1 : k), end: k - 1 }
  }

  let out = ''
  let i = 0
  while (i < css.length) {
    let j = i
    while (j < css.length && css[j] !== '{' && css[j] !== '}' && css[j] !== ';') j++
    const head = css.slice(i, j)
    if (j >= css.length) {
      out += head
      break
    }
    if (css[j] === ';' || css[j] === '}') {
      // 顶层声明（@import/@charset 已被校验拒绝，这里理论上只剩 @font-face 外声明）与闭括号：原样
      out += head + css[j]
      i = j + 1
      continue
    }
    // '{'：head 为 at-rule 头或 selector
    if (head.trim().startsWith('@')) {
      const inner = readBlock(j)
      // 嵌套条件块递归前缀；@keyframes/@font-face/@property 内容原样
      if (/^@(media|supports|layer|container|scope)\b/.test(head.trim())) {
        out += head + '{' + scopeCss(inner.content, pluginId) + '}'
      } else {
        out += head + '{' + inner.content + '}'
      }
      i = inner.end + 1
    } else {
      const inner = readBlock(j)
      const selectors = head
        .split(',')
        .map((sel) => sel.trim())
        .filter(Boolean)
      out += selectors.map((sel) => `${prefix} ${sel}`).join(', ') + '{' + inner.content + '}'
      i = inner.end + 1
    }
  }
  return out
}

/** 为单个 style 贡献生成 style 标签 id */
function styleTagId(pluginId: string, styleId: string): string {
  return `${STYLE_TAG_PREFIX}${pluginId}-${styleId}`
}

/** 注入单个 style 贡献的 CSS */
function injectStyle(pluginId: string, style: PluginStyleContribution): void {
  if (typeof document === 'undefined') return

  // 内容校验：拒绝超限 / @import / 外联 url（fail-closed：跳过该 style，可见告警）
  const verdict = validateCss(style.css)
  if (!verdict.ok) {
    log.warn(`插件样式被拒绝: ${pluginId}/${style.id} — ${verdict.reason}`)
    return
  }

  // slot 作用域：前缀化后注入（scoped 到本插件面板容器）
  const scoped = style.target === 'slot' ? scopeCss(style.css, pluginId) : style.css

  const tagId = styleTagId(pluginId, style.id)
  let styleEl = document.getElementById(tagId) as HTMLStyleElement | null

  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = tagId
    styleEl.dataset.pluginId = pluginId
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = scoped

  if (style.target === 'slot') {
    styleEl.dataset.slotId = style.slotId ?? ''
    log.debug(`注入 slot 样式（scoped）: ${pluginId}/${style.id} → slot:${style.slotId}`)
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
