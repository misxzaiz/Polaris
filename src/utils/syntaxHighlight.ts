/**
 * 语法高亮工具
 * 基于 highlight.js，提供共享的高亮函数和缓存
 */

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

// 注册语言（单例，重复调用安全）
let initialized = false
function ensureInitialized() {
  if (initialized) return
  initialized = true
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
  hljs.registerLanguage('shell', bash)
  hljs.registerLanguage('markdown', markdown)
}

// 高亮结果缓存（LRU，上限 500 条）
const highlightCache = new LRUCache<string, string>({ maxSize: 500 })

/**
 * 对代码进行语法高亮
 * @param code 代码内容
 * @param language highlight.js 语言名称
 * @returns 高亮后的 HTML 字符串
 */
export function highlightCode(code: string, language: string): string {
  if (!code) return ''

  ensureInitialized()

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
