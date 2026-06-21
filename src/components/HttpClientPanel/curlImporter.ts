/**
 * curl 命令解析器
 *
 * 将 `curl 'URL' -H '...' -d '...' -X POST` 这样的命令字符串解析为
 * HttpClientPanel 使用的 HttpRequestSpec。纯前端解析，无需后端改动。
 *
 * 支持：URL、-X 方法（或由 -d 推断 POST）、-H 头、-d/--data-raw/--data-binary
 * 请求体、-L 跟随重定向、-A User-Agent、-u Basic 鉴权、-b Cookie、-e Referer、
 * --url、--compressed/-i/-s/-v 等可忽略开关。
 */

export interface ParsedCurl {
  spec: {
    method: string
    url: string
    headers: { name: string; value: string }[]
    query: { name: string; value: string }[]
    body?: string
    bodyType?: 'none' | 'json' | 'text' | 'form'
    timeoutMs?: number
    followRedirects?: boolean
  }
  warnings: string[]
}

/**
 * Shell 词法分析：按空白拆分，尊重单引号、双引号与反斜杠转义。
 * 支持 $'...' (ANSI-C 引用，按单引号处理)。
 */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let i = 0
  let inSingle = false
  let inDouble = false
  let hasToken = false

  while (i < input.length) {
    const ch = input[i]

    if (inSingle) {
      if (ch === "'") {
        inSingle = false
      } else {
        current += ch
      }
      i++
      continue
    }

    if (inDouble) {
      if (ch === '\\' && i + 1 < input.length) {
        // 双引号内仅转义 $ ` " \ 换行
        const next = input[i + 1]
        if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
          current += next
          i += 2
          continue
        }
        current += ch
        i++
        continue
      }
      if (ch === '"') {
        inDouble = false
      } else {
        current += ch
      }
      i++
      continue
    }

    // 未引用状态
    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1]
      hasToken = true
      i += 2
      continue
    }
    if (ch === "'") {
      inSingle = true
      hasToken = true
      i++
      continue
    }
    if (ch === '"') {
      inDouble = true
      hasToken = true
      i++
      continue
    }
    // $'...' 开头：跳过 $，按单引号处理
    if (ch === '$' && input[i + 1] === "'") {
      inSingle = true
      hasToken = true
      i += 2
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '|') {
      // `|` 视为命令边界（如 `curl ... | jq`），后续忽略
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      if (ch === '|') break
      i++
      continue
    }
    current += ch
    hasToken = true
    i++
  }

  if (hasToken) tokens.push(current)
  return tokens
}

function splitHeader(raw: string): { name: string; value: string } | null {
  // "Name: value" 或 "Name;" (删除头，忽略)
  const idx = raw.indexOf(':')
  if (idx === -1) return null
  const name = raw.slice(0, idx).trim()
  const value = raw.slice(idx + 1).trim()
  if (!name) return null
  return { name, value }
}

function looksLikeJson(s: string): boolean {
  const t = s.trim()
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))
}

function isFlag(token: string): boolean {
  return token.startsWith('-') && token.length > 1
}

/** 解析 curl 命令字符串为 HttpRequestSpec */
export function parseCurl(input: string): ParsedCurl {
  const warnings: string[] = []
  let raw = input.trim()

  // 去掉行尾续行反斜杠 + 换行，合并多行
  raw = raw.replace(/\\\s*\n\s*/g, ' ').replace(/\r\n/g, '\n')

  // 去掉开头的 `curl `
  const curlStart = raw.match(/^\s*curl\s+/i)
  if (curlStart) {
    raw = raw.slice(curlStart[0].length)
  } else if (!raw.includes('curl')) {
    warnings.push('未检测到 curl 前缀，仍尝试按 curl 语法解析')
  }

  const tokens = tokenize(raw)

  const headers: { name: string; value: string }[] = []
  const query: { name: string; value: string }[] = []
  let method = 'GET'
  let url = ''
  let bodyParts: string[] = []
  let followRedirects = false
  let userPassword: string | null = null
  let userAgent: string | null = null
  let cookie: string | null = null
  let referer: string | null = null

  let i = 0
  const takeValue = (): string | null => {
    if (i + 1 >= tokens.length) return null
    i++
    return tokens[i]
  }

  while (i < tokens.length) {
    const tok = tokens[i]

    if (tok === '-X' || tok === '--request') {
      const v = takeValue()
      if (v) method = v.toUpperCase()
      else warnings.push('-X 缺少参数')
    } else if (tok === '-H' || tok === '--header') {
      const v = takeValue()
      if (v) {
        const h = splitHeader(v)
        if (h && h.value !== '') headers.push(h)
        // value === '' 表示 `Name;` 删除头，忽略
      } else warnings.push('-H 缺少参数')
    } else if (
      tok === '-d' ||
      tok === '--data' ||
      tok === '--data-raw' ||
      tok === '--data-binary' ||
      tok === '--data-ascii'
    ) {
      const v = takeValue()
      if (v !== null) {
        if (v.startsWith('@')) {
          warnings.push(`忽略 @file 形式的请求体（${tok} @${v.slice(1)}），需手动粘贴文件内容`)
        } else {
          bodyParts.push(v)
        }
      } else warnings.push(`${tok} 缺少参数`)
    } else if (tok === '--data-urlencode') {
      const v = takeValue()
      if (v) bodyParts.push(v)
    } else if (tok === '-L' || tok === '--location') {
      followRedirects = true
    } else if (tok === '-k' || tok === '--insecure') {
      // 后端始终接受自签证书，此处无需额外处理
    } else if (tok === '-A' || tok === '--user-agent') {
      userAgent = takeValue()
    } else if (tok === '-u' || tok === '--user') {
      userPassword = takeValue()
    } else if (tok === '-b' || tok === '--cookie') {
      cookie = takeValue()
    } else if (tok === '-e' || tok === '--referer') {
      referer = takeValue()
    } else if (tok === '--url') {
      const v = takeValue()
      if (v) url = v
    } else if (tok === '-G' || tok === '--get') {
      // -G：把 -d 转为查询参数并使用 GET
      method = 'GET'
    } else if (
      tok === '--compressed' ||
      tok === '-i' ||
      tok === '--include' ||
      tok === '-s' ||
      tok === '--silent' ||
      tok === '-S' ||
      tok === '--show-error' ||
      tok === '-v' ||
      tok === '--verbose' ||
      tok === '-f' ||
      tok === '--fail'
    ) {
      // 可忽略的开关
    } else if (tok === '-o' || tok === '--output' || tok === '-w' || tok === '--write-out') {
      takeValue() // 消费参数值，忽略
    } else if (tok === '--') {
      // 选项结束分隔符，后续首个为 URL
      i++
      if (i < tokens.length && !url) url = tokens[i]
    } else if (isFlag(tok)) {
      // 形如 -Hvalue 或 --header=value
      const eqIdx = tok.indexOf('=')
      if (eqIdx !== -1) {
        const flag = tok.slice(0, eqIdx)
        const val = tok.slice(eqIdx + 1)
        if (flag === '-H' || flag === '--header') {
          const h = splitHeader(val)
          if (h && h.value !== '') headers.push(h)
        } else if (flag === '-X' || flag === '--request') {
          method = val.toUpperCase()
        } else if (flag === '--url') {
          url = val
        } else if (flag === '-A' || flag === '--user-agent') {
          userAgent = val
        } else {
          warnings.push(`忽略未知参数: ${tok}`)
        }
      } else {
        warnings.push(`忽略未知参数: ${tok}`)
      }
    } else {
      // 非选项参数 → URL（curl 中第一个非选项参数即 URL）
      if (!url) {
        url = tok
      } else {
        warnings.push(`忽略多余位置参数: ${tok}`)
      }
    }
    i++
  }

  if (!url) {
    warnings.push('未解析到 URL')
  }

  // 方法推断：有请求体且未显式指定方法 → POST
  const hasBody = bodyParts.length > 0
  if (hasBody && method === 'GET') {
    method = 'POST'
  }

  // 请求体合并：多个 -d 用 & 连接（curl 行为）
  const body = bodyParts.join('&')
  let bodyType: 'none' | 'json' | 'text' | 'form' = 'none'
  if (body) {
    bodyType = looksLikeJson(body) ? 'json' : 'form'
  }

  // 补全派生请求头
  if (userAgent && !headers.some((h) => h.name.toLowerCase() === 'user-agent')) {
    headers.unshift({ name: 'User-Agent', value: userAgent })
  }
  if (cookie && !headers.some((h) => h.name.toLowerCase() === 'cookie')) {
    headers.push({ name: 'Cookie', value: cookie })
  }
  if (referer && !headers.some((h) => h.name.toLowerCase() === 'referer')) {
    headers.push({ name: 'Referer', value: referer })
  }
  if (userPassword && !headers.some((h) => h.name.toLowerCase() === 'authorization')) {
    try {
      const b64 = btoa(userPassword)
      headers.push({ name: 'Authorization', value: `Basic ${b64}` })
    } catch {
      warnings.push('Basic 鉴权编码失败（含非 ASCII 字符）')
    }
  }

  return {
    spec: {
      method,
      url,
      headers,
      query,
      body: body || '',
      bodyType,
      timeoutMs: 30000,
      followRedirects,
    },
    warnings,
  }
}
