/**
 * HTTP Client 类型定义
 *
 * 多标签请求 + 环境变量 + 请求集合的数据模型。
 * 字段命名与后端 HttpRequestSpec (camelCase) 保持一致。
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
export type BodyType = 'none' | 'json' | 'text' | 'form'

export interface KeyValue {
  name: string
  value: string
}

/** HTTP 请求规格（与后端 HttpRequestSpec 对齐） */
export interface HttpRequestSpec {
  method: string
  url: string
  headers: KeyValue[]
  query: KeyValue[]
  body?: string
  bodyType?: BodyType
  timeoutMs?: number
  followRedirects?: boolean
}

/** HTTP 响应信息（与后端 HttpResponseInfo 对齐） */
export interface HttpResponseInfo {
  status: number
  statusText: string
  headers: KeyValue[]
  body: string
  truncated: boolean
  elapsedMs: number
  url: string
  size: number
}

/** 环境变量 */
export interface EnvVar {
  name: string
  value: string
}

/** 环境（一组命名变量，如 "本地" / "测试" / "生产"） */
export interface Environment {
  id: string
  name: string
  variables: EnvVar[]
}

/** 保存到集合的请求（用户命名，可复用） */
export interface SavedRequest {
  id: string
  name: string
  method: string
  url: string
  spec: HttpRequestSpec
  updatedAt: number
}

/** 请求标签页（内存态，含临时编辑 + 最近一次响应） */
export interface RequestTab {
  id: string
  /** 标签显示名（默认从 url/method 推断） */
  name: string
  spec: HttpRequestSpec
  /** 最近一次响应（null = 未发送过） */
  response: HttpResponseInfo | null
  /** 发送中 */
  loading: boolean
  /** 发送错误 */
  error: string | null
  /** 关联的已保存请求 id（来自集合则非空，新建则为 null） */
  savedId: string | null
  /** 未保存改动 */
  dirty: boolean
}

/** 持久化集合文件结构 */
export interface CollectionFile {
  version: 1
  requests: SavedRequest[]
}

/** 持久化环境文件结构 */
export interface EnvironmentsFile {
  version: 1
  environments: Environment[]
  activeId: string | null
}

export const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

export const BODY_TYPES: { value: BodyType; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'form', label: 'Form' },
]

export function emptySpec(): HttpRequestSpec {
  return {
    method: 'GET',
    url: '',
    headers: [],
    query: [],
    body: '',
    bodyType: 'none',
    timeoutMs: 30000,
    followRedirects: true,
  }
}

/** 由 spec 推断标签名 */
export function deriveTabName(spec: HttpRequestSpec): string {
  if (spec.url) {
    try {
      const u = new URL(spec.url)
      const path = u.pathname === '/' ? '' : u.pathname
      return `${spec.method} ${u.host}${path}`.slice(0, 40)
    } catch {
      return `${spec.method} ${spec.url}`.slice(0, 40)
    }
  }
  return 'Untitled'
}
