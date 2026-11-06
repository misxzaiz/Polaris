/**
 * 插件模块 import 重写器（代码上下文感知）
 *
 * 为什么不能用裸正则全局替换：插件 bundle 的字符串/模板字面量里可能内嵌代码
 * 模板（如 plugin-forge 的脚手架模板含 react import），盲替换会把模板文本也
 * 改写——注入的 blob URL 带裸双引号，截断外层字符串/污染模板内容
 * （实测报错：Unexpected identifier 'blob'）。
 *
 * 最小词法扫描：跳过字符串字面量（'' "" ``）、模板字面量的 ${} 嵌套、行/块
 * 注释、正则字面量（含引号的正则如 /"/g 若不识别，会把后续配对整个错位），
 * 只在代码上下文匹配并重写。
 *
 * 正则 vs 除法的判定用经典启发式：看前一个有效 token——关键字或运算符后是
 * 正则；标识符/数字/`)`/`]`/引号后是除法。对 esbuild 产物足够。
 *
 * 规则集（rewriteImports）：
 * - react / react/jsx-runtime → 宿主 React shim（既有行为，rewriteReactImports）
 * - polaris-host/<name> → 宿主桥 shim（plugin-ui-contribution-spec [S-1]/[S-3]，
 *   插件经桥消费宿主通用核心，禁止 import 宿主内部路径）
 */

/** 这些关键字后面跟 `/` 是正则字面量（而非除法） */
const REGEX_AFTER_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
])

/** `/` 处于正则起始位还是除法位（向前看一个有效 token） */
function regexAllowedAt(code: string, i: number): boolean {
  let j = i - 1
  while (j >= 0 && (code[j] === ' ' || code[j] === '\t' || code[j] === '\n' || code[j] === '\r')) j--
  if (j < 0) return true
  const c = code[j]
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j
    while (k >= 0 && /[A-Za-z0-9_$]/.test(code[k])) k--
    return REGEX_AFTER_KEYWORDS.has(code.slice(k + 1, j + 1))
  }
  // 操作数结束（右括号/引号收尾）后是除法；其余标点/运算符后是正则
  return !(c === ')' || c === ']' || c === '"' || c === "'" || c === '`')
}

/** 跳过一个字符串/模板字面量：code[start] 是引号，返回结束后的下一个下标 */
function skipStringLiteral(code: string, start: number): number {
  const quote = code[start]
  let i = start + 1
  let braceDepth = 0 // 仅模板字面量：${ } 嵌套深度
  const n = code.length
  while (i < n) {
    const c = code[i]
    if (c === '\\') { i += 2; continue }
    if (quote === '`') {
      if (braceDepth === 0 && c === '`') return i + 1
      if (c === '$' && code[i + 1] === '{') { braceDepth++; i += 2; continue }
      if (braceDepth > 0 && c === '}') { braceDepth--; i++; continue }
      i++
      continue
    }
    if (c === quote) return i + 1
    i++
  }
  return n
}

/** 跳过一个正则字面量（含 flags）；本行未闭合则按除法回退为只消费 `/` */
function skipRegexLiteral(code: string, start: number): number {
  let i = start + 1
  let inClass = false // [...] 字符类内的 / 不终结正则
  const n = code.length
  while (i < n) {
    const c = code[i]
    if (c === '\\') { i += 2; continue }
    if (c === '\n') return start + 1
    if (inClass) {
      if (c === ']') inClass = false
      i++
      continue
    }
    if (c === '[') { inClass = true; i++; continue }
    if (c === '/') {
      i++
      while (i < n && /[a-z]/i.test(code[i])) i++ // flags
      return i
    }
    i++
  }
  return start + 1
}

/** 单条重写规则：from '<spec>' 或 require('<spec>') → shim 引用 */
export interface ImportRewriteRule {
  /** 匹配 from '<spec>'；与 requireRe 二选一（分开声明，替换文本形态不同） */
  fromRe?: RegExp
  /** 匹配 require('<spec>') */
  requireRe?: RegExp
  /** m 为命中正则的 exec 结果；返回完整替换文本（覆盖匹配跨度） */
  replace: (m: RegExpExecArray) => string
}

/**
 * 代码上下文感知的重写主循环：逐位置尝试 rules，命中即整段替换。
 * 字符串、模板字面量、注释、正则字面量内的同名文本原样保留。
 */
export function rewriteImports(code: string, rules: ImportRewriteRule[]): string {
  let out = ''
  let i = 0
  const n = code.length
  while (i < n) {
    const ch = code[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipStringLiteral(code, i)
      out += code.slice(i, end)
      i = end
      continue
    }
    if (ch === '/' && code[i + 1] === '/') {
      let e = code.indexOf('\n', i)
      if (e < 0) e = n
      out += code.slice(i, e)
      i = e
      continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      let e = code.indexOf('*/', i + 2)
      e = e < 0 ? n : e + 2
      out += code.slice(i, e)
      i = e
      continue
    }
    if (ch === '/' && regexAllowedAt(code, i)) {
      const end = skipRegexLiteral(code, i)
      out += code.slice(i, end)
      i = end
      continue
    }
    const rest = code.slice(i, i + 120)
    let matched = false
    for (const rule of rules) {
      const fm = rule.fromRe?.exec(rest)
      if (fm) {
        out += rule.replace(fm)
        i += fm[0].length
        matched = true
        break
      }
      const rm = rule.requireRe?.exec(rest)
      if (rm) {
        out += rule.replace(rm)
        i += rm[0].length
        matched = true
        break
      }
    }
    if (matched) continue
    out += ch
    i++
  }
  return out
}

const REACT_FROM_RE = /^from\s*(['"])react(\/jsx-runtime)?\1/
const REACT_REQUIRE_RE = /^require\(\s*(['"])react(\/jsx-runtime)?\1\s*\)/
const HOST_FROM_RE = /^from\s*(['"])polaris-host\/([A-Za-z0-9_-]+)\1/
const HOST_REQUIRE_RE = /^require\(\s*(['"])polaris-host\/([A-Za-z0-9_-]+)\1\s*\)/

/** quote 引号：m[1] */
function quoteOf(m: RegExpExecArray): string {
  return m[1]
}

/**
 * 重写代码上下文中的 react / react/jsx-runtime 引用为 shimUrl。
 * 字符串、模板字面量、注释、正则字面量内的同名文本原样保留。
 * （兼容签名：等价 rewriteImports 的 react 单规则形态）
 */
export function rewriteReactImports(code: string, shimUrl: string): string {
  return rewriteImports(code, [
    { fromRe: REACT_FROM_RE, replace: (m) => `from ${quoteOf(m)}${shimUrl}${quoteOf(m)}` },
    { requireRe: REACT_REQUIRE_RE, replace: (m) => `require(${quoteOf(m)}${shimUrl}${quoteOf(m)})` },
  ])
}

/**
 * 重写 react 与 polaris-host/<name> 引用（plugin-ui-contribution-spec [S-1]）。
 * - hostShims[name] = shim blob URL：已注册的宿主桥
 * - onUnknownHost(name)：未注册桥的兜底（通常返回报错 stub 的 blob URL，
 *   让插件在 import 阶段拿到明确错误而非裸 SyntaxError）
 */
export function rewritePluginImports(
  code: string,
  opts: { reactShimUrl: string; hostShims: Record<string, string>; onUnknownHost?: (name: string) => string },
): string {
  const rules: ImportRewriteRule[] = [
    { fromRe: REACT_FROM_RE, replace: (m) => `from ${quoteOf(m)}${opts.reactShimUrl}${quoteOf(m)}` },
    { requireRe: REACT_REQUIRE_RE, replace: (m) => `require(${quoteOf(m)}${opts.reactShimUrl}${quoteOf(m)})` },
    {
      fromRe: HOST_FROM_RE,
      replace: (m) => {
        const name = m[2]
        const url = opts.hostShims[name] ?? opts.onUnknownHost?.(name)
        if (!url) return m[0] // 无兜底：保留原样（import 阶段自然失败）
        return `from ${quoteOf(m)}${url}${quoteOf(m)}`
      },
    },
    {
      requireRe: HOST_REQUIRE_RE,
      replace: (m) => {
        const name = m[2]
        const url = opts.hostShims[name] ?? opts.onUnknownHost?.(name)
        if (!url) return m[0]
        return `require(${quoteOf(m)}${url}${quoteOf(m)})`
      },
    },
  ]
  return rewriteImports(code, rules)
}
