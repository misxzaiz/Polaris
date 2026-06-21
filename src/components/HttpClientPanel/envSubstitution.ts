/**
 * 环境变量替换
 *
 * 把 spec 中所有字符串字段的 `{{varName}}` 替换为当前环境的变量值。
 * 同时处理 URL 内嵌、headers、query、body。
 *
 * 设计：
 * - 未定义变量 → 保留原 `{{varName}}`，并在返回的 missing 列表中报告，便于前端提示
 * - 替换不区分大小写匹配变量名（环境变量通常大小写敏感，故保留大小写）
 * - 支持 `{{$guid}}` / `{{$timestamp}}` / `{{$randomInt}}` 内置动态变量（Postman 风格）
 */

import type { Environment, HttpRequestSpec, KeyValue } from './httpClientTypes'

/** 动态变量集合（Postman 兼容） */
function dynamicValue(name: string): string | undefined {
  switch (name) {
    case '$guid':
      return crypto.randomUUID()
    case '$timestamp':
      return Math.floor(Date.now() / 1000).toString()
    case '$randomInt':
      return Math.floor(Math.random() * 1000).toString()
    default:
      return undefined
  }
}

const VAR_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g

export interface SubstitutionResult {
  /** 替换后的 spec */
  spec: HttpRequestSpec
  /** 命中缺失的变量名集合 */
  missing: string[]
}

/** 单字段替换 */
function substituteString(
  input: string,
  lookup: Map<string, string>,
  missing: Set<string>,
): string {
  return input.replace(VAR_PATTERN, (_, rawName: string) => {
    const name = rawName.trim()
    // 动态变量优先
    const dyn = dynamicValue(name)
    if (dyn !== undefined) return dyn
    const val = lookup.get(name)
    if (val === undefined) {
      missing.add(name)
      return `{{${name}}}`
    }
    return val
  })
}

function substituteKv(
  rows: KeyValue[],
  lookup: Map<string, string>,
  missing: Set<string>,
): KeyValue[] {
  return rows.map((r) => ({
    name: substituteString(r.name, lookup, missing),
    value: substituteString(r.value, lookup, missing),
  }))
}

/**
 * 用指定环境替换 spec 中的变量。
 * environment 为 null 时仅处理动态变量，缺失报告为空。
 */
export function substituteEnv(spec: HttpRequestSpec, environment: Environment | null): SubstitutionResult {
  const lookup = new Map<string, string>()
  if (environment) {
    for (const v of environment.variables) {
      if (v.name.trim()) lookup.set(v.name.trim(), v.value)
    }
  }

  const missing = new Set<string>()
  const url = substituteString(spec.url, lookup, missing)
  const headers = substituteKv(spec.headers, lookup, missing)
  const query = substituteKv(spec.query, lookup, missing)
  const body = spec.body ? substituteString(spec.body, lookup, missing) : spec.body

  return {
    spec: { ...spec, url, headers, query, body },
    missing: Array.from(missing),
  }
}

/** 扫描 spec 中引用的所有变量名（用于在环境管理器中提示） */
export function extractVariables(spec: HttpRequestSpec): string[] {
  const names = new Set<string>()
  const scan = (s: string | undefined) => {
    if (!s) return
    let m: RegExpExecArray | null
    const re = new RegExp(VAR_PATTERN)
    while ((m = re.exec(s)) !== null) {
      const name = m[1].trim()
      if (!name.startsWith('$')) names.add(name)
    }
  }
  scan(spec.url)
  spec.headers.forEach((h) => {
    scan(h.name)
    scan(h.value)
  })
  spec.query.forEach((q) => {
    scan(q.name)
    scan(q.value)
  })
  scan(spec.body)
  return Array.from(names)
}
