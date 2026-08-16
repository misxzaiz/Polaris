/**
 * 语法高亮工具
 * 基于 highlight.js（core 模式），提供共享的高亮函数和缓存
 *
 * hljs 实例与语言注册统一在 src/utils/highlight.ts（core + 单次注册），
 * 此处复用，不再重复 full import / 重复注册语言。
 */

import hljs from '@/utils/highlight'
import { LRUCache } from '@/utils/lru-cache'
import { isSyntaxHighlightingEnabled } from '@/utils/performanceFeatures'

// 高亮结果缓存（LRU，上限 500 条）——markdown 渲染管线专用
const highlightCache = new LRUCache<string, string>({ maxSize: 500 })

/**
 * 对代码进行语法高亮
 * @param code 代码内容
 * @param language highlight.js 语言名称
 * @returns 高亮后的 HTML 字符串
 */
export function highlightCode(code: string, language: string): string {
  if (!code) return ''

  // 性能开关：语法高亮关闭时返回转义后的纯文本（不应用高亮 HTML，但保留文字可见）
  if (!isSyntaxHighlightingEnabled()) return escapeHtml(code)

  const cacheKey = `${language}:${code}`
  const cached = highlightCache.get(cacheKey)
  if (cached !== undefined) return cached

  try {
    let result: string
    if (language && hljs.getLanguage(language)) {
      result = hljs.highlight(code, { language }).value
    } else {
      result = hljs.highlightAuto(code).value
    }
    highlightCache.set(cacheKey, result)
    return result
  } catch {
    return escapeHtml(code)
  }
}

/**
 * 转义 HTML 特殊字符
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
