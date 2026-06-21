/**
 * 语法高亮共享工具
 *
 * 基于 highlight.js，提供：
 * - LRU 缓存（避免重复高亮同一内容）
 * - 异步调度（requestIdleCallback / setTimeout），不阻塞主线程
 * - DOMPurify 清洗高亮 HTML
 *
 * 抽自 CodeBlock，供 Chat 代码块与 HTTP Client 响应美化视图共享。
 */

import DOMPurify from 'dompurify'
import hljs from 'highlight.js'

import { LRUCache } from '@/utils/lru-cache'

// 导入常用语言
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import sql from 'highlight.js/lib/languages/sql'
import html from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import markdown from 'highlight.js/lib/languages/markdown'

// 注册语言（registerLanguage 幂等，重复调用无副作用）
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('go', go)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('html', html)
hljs.registerLanguage('css', css)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('shell', bash)

/** 高亮结果缓存（LRU，上限 50 条） */
const highlightCache = new LRUCache<string, string>({ maxSize: 50 })

/**
 * 超过此字节数的代码不做高亮，直接返回纯文本，避免主线程卡死。
 *
 * 实测：18KB JSON → hljs 41ms + DOMPurify 321ms = 362ms 主线程阻塞；
 * 36KB → 478ms。DOMPurify 对 span 密集 HTML 的解析是主要开销。
 * 阈值定 30KB：超过即纯文本，保证中大响应不卡死。
 */
export const HIGHLIGHT_MAX_BYTES = 30 * 1024 // 30 KB

/**
 * 生成缓存键。
 *
 * 用完整内容作 key（前缀 + 长度会有碰撞，导致不同响应命中错误缓存）。
 * 高亮内容本身已受 HIGHLIGHT_MAX_BYTES 限制（≤30KB），完整字符串作 Map key 无内存压力。
 */
function getCacheKey(code: string, language: string): string {
  return `${language}:${code}`
}

export interface HighlightOptions {
  /** 允许的 HTML 标签，默认仅 span（hljs 输出） */
  allowedTags?: string[]
  /** 允许的属性，默认仅 class */
  allowedAttr?: string[]
}

/**
 * 同步高亮单段代码，返回经 DOMPurify 清洗的 HTML 字符串。
 * 超过 HIGHLIGHT_MAX_BYTES 或高亮失败时返回空串（调用方应回退纯文本）。
 */
export function highlightSync(code: string, language: string, options: HighlightOptions = {}): string {
  if (!code) return ''
  if (code.length > HIGHLIGHT_MAX_BYTES) return ''
  const cacheKey = getCacheKey(code, language)
  const cached = highlightCache.get(cacheKey)
  if (cached !== undefined) return cached

  let raw: string
  try {
    raw = hljs.highlight(code, { language }).value
  } catch {
    try {
      raw = hljs.highlightAuto(code).value
    } catch {
      return ''
    }
  }

  const allowedTags = options.allowedTags ?? ['span']
  const allowedAttr = options.allowedAttr ?? ['class']
  const sanitized = DOMPurify.sanitize(raw, { ALLOWED_TAGS: allowedTags, ALLOWED_ATTR: allowedAttr })
  highlightCache.set(cacheKey, sanitized)
  return sanitized
}

/**
 * 异步调度高亮（requestIdleCallback / setTimeout 降级）。
 *
 * 高亮在空闲时段执行，完成时回调；调用方返回的 cancel 函数可在组件卸载时取消，
 * 避免卸载后 setState。命中缓存时同步回调。
 *
 * @returns 取消函数
 */
export function scheduleHighlight(
  code: string,
  language: string,
  callback: (result: string) => void,
  options?: HighlightOptions,
): () => void {
  // 超阈值：直接回调空串，调用方回退纯文本，不进调度
  if (code.length > HIGHLIGHT_MAX_BYTES) {
    callback('')
    return () => {}
  }

  const cacheKey = getCacheKey(code, language)
  const cached = highlightCache.get(cacheKey)
  if (cached !== undefined) {
    callback(cached)
    return () => {}
  }

  let cancelled = false

  const doHighlight = () => {
    if (cancelled) return
    const result = highlightSync(code, language, options)
    if (!cancelled) callback(result)
  }

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    const id = window.requestIdleCallback(doHighlight, { timeout: 200 })
    return () => {
      cancelled = true
      window.cancelIdleCallback(id)
    }
  }
  const id = setTimeout(doHighlight, 16)
  return () => {
    cancelled = true
    clearTimeout(id)
  }
}
