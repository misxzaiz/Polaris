/**
 * AI-6 v0：自然语言 → GitLogSearchFilter 编译器（无 LLM，纯本地确定性规则）
 *
 * master-plan 裁决：AI-6 = NL 查询历史。v0 砍掉 LLM 归纳层，只做
 * 「结构化编译」——把可识别模式（显式键 / 中文时间 / 作者 / 路径 / 引号短语）
 * 编译进 P1 已有的 git_search_log 过滤器；语义归纳（LLM 解释层）留 v2。
 *
 * 设计纪律（必须恒真）：
 * - 纯函数、零 IO：同输入恒同输出，测试即规格
 * - 编不出任何结构 → 原样成 grep（fixedStrings 字面子串），行为不比旧路径差
 * - 只认高置信模式，不做过重的猜测（宁漏勿错）
 */

import type { GitLogSearchFilter } from '@/types/git'

/** 编译产物 + 命中的规则（便于 UI tooltip 与测试断言） */
export interface CompiledGitQuery {
  filter: GitLogSearchFilter
  /** 命中的规则名（author/since/path/phrase/keys）；空 = 纯 grep 降级 */
  hints: string[]
}

/** 中文相对时间 → git --since 可解析短语 */
function compileSince(query: string): string | undefined {
  const RULES: Array<[RegExp, string]> = [
    [/今天(起|以来)?/, '1 day ago'],
    [/昨天(起|以来)?/, '2 days ago'], // git --since 不含端点，"昨天以来"取含昨天的保守端（v0 保守，不追精细）
    [/本周|这一周|这周/, '1 week ago'],
    [/上周|上个星期/, '2 weeks ago'],
    [/本月|这个月/, '1 month ago'],
    [/上个月|上月/, '2 months ago'],
    [/今年/, '1 year ago'],
    [/去年/, '2 years ago'],
    [/(\d+)\s*天(前|内)?/, '$1 days ago'],
    [/(\d+)\s*周(前|内)?/, '$1 weeks ago'],
    [/(\d+)\s*个月(前|内)?/, '$1 months ago'],
  ]
  for (const [re, out] of RULES) {
    const m = query.match(re)
    if (m) {
      return out.replace('$1', m[1] ?? '')
    }
  }
  return undefined
}

/** 显式键（英文）提取：author:/path:/pickaxe:/since:/keyword: */
function compileKeys(query: string): Partial<GitLogSearchFilter> {
  const out: Partial<GitLogSearchFilter> = {}
  const grab = (re: RegExp): string | undefined => {
    const m = query.match(re)
    return m?.[1]?.trim() || undefined
  }
  out.author = grab(/author[:：](\S+)/)
  out.path = grab(/path[:：](\S+)/)
  out.pickaxe = grab(/pickaxe[:：](\S+)/)
  out.since = grab(/since[:：]([^，。;;,]+(?: ago)?)/)
  return out
}

/** 「作者X」 / 「by X」：X 取到下一个逗号/句号/空格短语边界 */
function compileAuthorCn(query: string): string | undefined {
  const m =
    query.match(/作者\s*[:：]?\s*([\p{Script=Han}A-Za-z0-9_\-.]+)/u) ??
    query.match(/\bby[:\s]+([A-Za-z0-9_\-.]+)/)
  return m?.[1]?.trim() || undefined
}

/** 路径词：含 `/` 或带扩展名的token（src/main.ts、.ts） */
function compilePathWord(query: string): string | undefined {
  const m = query.match(/[^\s'",，。;；]+[/.][^\s'",，。;；]+/)
  return m?.[0]
}

/**
 * 编译主入口。规则优先级：显式键 > 双引号短语 > 作者 > 时间 > 路径；
 * 全部落空 → 整句 grep（fixedStrings）
 */
export function compileGitQuery(query: string): CompiledGitQuery {
  const q = query.trim()
  if (!q) return { filter: {}, hints: [] }

  const filter: GitLogSearchFilter = {}
  const hints: string[] = []

  // 1. 显式键
  const keys = compileKeys(q)
  let rest = q
  for (const [key, value] of Object.entries(keys)) {
    if (value != null) {
      ;(filter as Record<string, unknown>)[key] = value
      hints.push(key)
      rest = rest.replace(new RegExp(`${key}[:：]\\S+`), ' ')
    }
  }

  // 2. 双引号短语 → grep 字面子串（取第一个）
  const phrase = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1])[0]
  if (phrase) {
    if (filter.grep == null) {
      filter.grep = phrase
      filter.fixedStrings = true
      hints.push('phrase')
    }
    rest = rest.split(`"${phrase}"`).join(' ')
  }

  // 3. 作者（未由 author: 提供时）
  if (filter.author == null) {
    const author = compileAuthorCn(rest)
    if (author) {
      filter.author = author
      hints.push('author')
      rest = rest.replace(/作者\s*[:：]?\s*[\p{Script=Han}A-Za-z0-9_\-.]+/u, ' ').replace(/\bby[:\s]+[A-Za-z0-9_\-.]+/, ' ')
    }
  }

  // 4. 中文相对时间（未由 since: 提供时）
  if (filter.since == null) {
    const since = compileSince(rest)
    if (since) {
      filter.since = since
      hints.push('since')
      // 去除对应短语碎片（保守：按已识别规则 re-run 后只从原句剔除，见下）
      rest = stripChineseTime(rest)
    }
  }

  // 5. 路径词
  if (filter.path == null) {
    const path = compilePathWord(rest)
    if (path) {
      filter.path = path
      hints.push('path')
      rest = rest.replace(path, ' ')
    }
  }

  // 6. 余句非空 → grep 字面子串（不含引号后的断尾词；宁漏勿错：仅当余句 ≥2 字符）
  if (filter.grep == null) {
    const leftover = rest.replace(/[\s：:,，。;；"']+/g, ' ').trim()
    if (leftover.length >= 2) {
      filter.grep = leftover
      filter.fixedStrings = true
      hints.push('grep')
    }
  }

  return { filter, hints }
}

/** 从句中剥离已识别的中文时间短语（compileSince 的镜像，仅服务于 grep 余句净化） */
function stripChineseTime(query: string): string {
  const REs = [
    /今天(起|以来)?/, /昨天(起|以来)?/, /本周|这一周|这周/, /上周|上个星期/,
    /本月|这个月/, /上个月|上月/, /今年/, /去年/,
    /\d+\s*天(前|内)?/, /\d+\s*周(前|内)?/, /\d+\s*个月(前|内)?/,
  ]
  let out = query
  for (const re of REs) out = out.replace(re, ' ')
  return out
}
