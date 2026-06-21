/**
 * HTTP Client 面板（内置插件 panel）
 *
 * API 调试器：构建请求（方法/URL/头/查询参数/请求体）→ 发送 → 查看响应。
 * 历史记录持久化到 localStorage，可一键回填。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Globe,
  Send,
  Plus,
  Trash2,
  Loader2,
  Clock,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Inbox,
  TerminalSquare,
} from 'lucide-react'
import { invoke } from '@/services/transport'
import { parseCurl } from './curlImporter'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
type BodyType = 'none' | 'json' | 'text' | 'form'

interface KeyValue {
  name: string
  value: string
}

interface HttpRequestSpec {
  method: string
  url: string
  headers: KeyValue[]
  query: KeyValue[]
  body?: string
  bodyType?: BodyType
  timeoutMs?: number
  followRedirects?: boolean
}

interface HttpResponseInfo {
  status: number
  statusText: string
  headers: KeyValue[]
  body: string
  truncated: boolean
  elapsedMs: number
  url: string
  size: number
}

interface HistoryEntry {
  id: string
  method: string
  url: string
  spec: HttpRequestSpec
  status: number
  elapsedMs: number
  at: number
}

const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const BODY_TYPES: { value: BodyType; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'form', label: 'Form' },
]

const HISTORY_KEY = 'polaris.http-client.history'
const MAX_HISTORY = 30

function emptySpec(): HttpRequestSpec {
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

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)))
  } catch {
    /* ignore quota errors */
  }
}

function statusColor(status: number): string {
  if (status === 0) return 'text-gray-400'
  if (status < 300) return 'text-green-400'
  if (status < 400) return 'text-yellow-400'
  return 'text-red-400'
}

interface HttpClientPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

type Tab = 'headers' | 'query' | 'body'

export function HttpClientPanel({ onSendToChat }: HttpClientPanelProps) {
  const [spec, setSpec] = useState<HttpRequestSpec>(emptySpec)
  const [tab, setTab] = useState<Tab>('headers')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<HttpResponseInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [showHeaders, setShowHeaders] = useState(true)
  const [bodyOpen, setBodyOpen] = useState(true)
  const [curlOpen, setCurlOpen] = useState(false)
  const [curlText, setCurlText] = useState('')
  const [curlWarnings, setCurlWarnings] = useState<string[]>([])

  useEffect(() => {
    setHistory(loadHistory())
  }, [])

  const updateSpec = useCallback(<K extends keyof HttpRequestSpec>(key: K, value: HttpRequestSpec[K]) => {
    setSpec((prev) => ({ ...prev, [key]: value }))
  }, [])

  const updateKv = useCallback(
    (field: 'headers' | 'query', idx: number, key: 'name' | 'value', value: string) => {
      setSpec((prev) => {
        const list = [...prev[field]]
        list[idx] = { ...list[idx], [key]: value }
        return { ...prev, [field]: list }
      })
    },
    [],
  )

  const addKv = useCallback((field: 'headers' | 'query') => {
    setSpec((prev) => ({ ...prev, [field]: [...prev[field], { name: '', value: '' }] }))
  }, [])

  const removeKv = useCallback((field: 'headers' | 'query', idx: number) => {
    setSpec((prev) => ({ ...prev, [field]: prev[field].filter((_, i) => i !== idx) }))
  }, [])

  const send = useCallback(async () => {
    const url = spec.url.trim()
    if (!url) {
      setError('请输入 URL')
      return
    }
    setLoading(true)
    setError(null)
    setResponse(null)
    try {
      const res = await invoke<HttpResponseInfo>('http_request', { spec })
      setResponse(res)
      const entry: HistoryEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        method: spec.method,
        url,
        spec: { ...spec, url },
        status: res.status,
        elapsedMs: res.elapsedMs,
        at: Date.now(),
      }
      setHistory((prev) => {
        const next = [entry, ...prev].slice(0, MAX_HISTORY)
        saveHistory(next)
        return next
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [spec])

  const restoreFromHistory = useCallback((entry: HistoryEntry) => {
    setSpec({ ...entry.spec })
    setResponse(null)
    setError(null)
  }, [])

  const importCurl = useCallback(() => {
    const text = curlText.trim()
    if (!text) {
      setCurlWarnings(['请粘贴 curl 命令'])
      return
    }
    const { spec: parsed, warnings } = parseCurl(text)
    if (!parsed.url) {
      setCurlWarnings([...warnings, '解析失败：未识别到 URL'])
      return
    }
    setSpec(parsed)
    setResponse(null)
    setError(null)
    setCurlWarnings(warnings)
    setCurlOpen(false)
    // 自动切到 Headers 标签便于核对导入结果
    setTab(parsed.bodyType && parsed.bodyType !== 'none' ? 'body' : 'headers')
  }, [curlText])

  const clearHistory = useCallback(() => {
    setHistory([])
    saveHistory([])
  }, [])

  const handleSendToChat = useCallback(() => {
    if (!onSendToChat || !response) return
    const lines = [
      `${spec.method} ${spec.url}`,
      `→ HTTP ${response.status} ${response.statusText} | ${response.elapsedMs} ms | ${response.size} bytes`,
      '',
      response.body.slice(0, 2000),
    ]
    onSendToChat(lines.join('\n'))
  }, [onSendToChat, response, spec])

  const kvRows = (field: 'headers' | 'query') => (
    <div className="space-y-1">
      {spec[field].map((row, idx) => (
        <div key={idx} className="flex items-center gap-1">
          <input
            type="text"
            value={row.name}
            onChange={(e) => updateKv(field, idx, 'name', e.target.value)}
            placeholder="name"
            className="flex-1 min-w-0 px-2 py-1 text-xs bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50"
          />
          <input
            type="text"
            value={row.value}
            onChange={(e) => updateKv(field, idx, 'value', e.target.value)}
            placeholder="value"
            className="flex-1 min-w-0 px-2 py-1 text-xs bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50"
          />
          <button
            onClick={() => removeKv(field, idx)}
            className="p-1 rounded hover:bg-background-elevated text-text-tertiary hover:text-red-400 transition-colors"
            title="删除"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      ))}
      <button
        onClick={() => addKv(field)}
        className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        <Plus className="w-3 h-3" /> 添加
      </button>
    </div>
  )

  const activeKvCount = useMemo(
    () => ({
      headers: spec.headers.filter((h) => h.name.trim()).length,
      query: spec.query.filter((q) => q.name.trim()).length,
    }),
    [spec.headers, spec.query],
  )

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-text-secondary" />
          <span className="text-xs font-medium text-text-primary">HTTP Client</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCurlOpen((v) => !v)}
            className={`p-1.5 rounded transition-colors ${
              curlOpen
                ? 'bg-background-elevated text-text-primary'
                : 'text-text-secondary hover:bg-background-elevated hover:text-text-primary'
            }`}
            title="导入 cURL 命令"
          >
            <TerminalSquare className="w-3.5 h-3.5" />
          </button>
          {onSendToChat && (
            <button
              onClick={handleSendToChat}
              disabled={!response}
              className="p-1.5 rounded hover:bg-background-elevated text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
              title="发送响应到聊天"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* cURL import */}
        {curlOpen && (
          <div className="p-3 space-y-2 border-b border-border bg-background/50">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">粘贴 cURL 命令（支持 -X / -H / -d / -L / -u 等）</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={importCurl}
                  className="px-2 py-1 text-xs font-medium bg-primary text-white rounded hover:bg-primary/90 transition-colors"
                >
                  导入
                </button>
                <button
                  onClick={() => {
                    setCurlOpen(false)
                    setCurlWarnings([])
                  }}
                  className="px-2 py-1 text-xs text-text-tertiary hover:text-text-primary transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
            <textarea
              value={curlText}
              onChange={(e) => setCurlText(e.target.value)}
              placeholder={`curl -X POST https://api.example.com/users \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer xxx' \\\n  -d '{"name":"test"}'`}
              className="w-full h-28 px-2 py-1.5 text-xs font-mono bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50 resize-y"
            />
            {curlWarnings.length > 0 && (
              <div className="space-y-0.5">
                {curlWarnings.map((w, idx) => (
                  <div key={idx} className="flex items-start gap-1.5 text-[10px] text-yellow-400">
                    <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Request builder */}
        <div className="p-3 space-y-2 border-b border-border">
          <div className="flex items-center gap-1.5">
            <select
              value={spec.method}
              onChange={(e) => updateSpec('method', e.target.value)}
              className="px-2 py-1.5 text-xs bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-primary/50"
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={spec.url}
              onChange={(e) => updateSpec('url', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send()
              }}
              placeholder="https://api.example.com/resource"
              className="flex-1 min-w-0 px-2 py-1.5 text-xs bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50"
            />
            <button
              onClick={send}
              disabled={loading}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50 shrink-0"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              发送
            </button>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-3 border-b border-border">
            {(['headers', 'query', 'body'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-1 py-1.5 text-xs transition-colors border-b-2 -mb-px ${
                  tab === t
                    ? 'text-text-primary border-primary'
                    : 'text-text-tertiary border-transparent hover:text-text-secondary'
                }`}
              >
                {t === 'headers'
                  ? `Headers${activeKvCount.headers ? ` (${activeKvCount.headers})` : ''}`
                  : t === 'query'
                    ? `Query${activeKvCount.query ? ` (${activeKvCount.query})` : ''}`
                    : 'Body'}
              </button>
            ))}
          </div>

          <div className="pt-1">
            {tab === 'headers' && kvRows('headers')}
            {tab === 'query' && kvRows('query')}
            {tab === 'body' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-tertiary">类型</span>
                  <select
                    value={spec.bodyType}
                    onChange={(e) => updateSpec('bodyType', e.target.value as BodyType)}
                    className="px-2 py-1 text-xs bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-primary/50"
                  >
                    {BODY_TYPES.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </div>
                <textarea
                  value={spec.body ?? ''}
                  onChange={(e) => updateSpec('body', e.target.value)}
                  disabled={spec.bodyType === 'none'}
                  placeholder={spec.bodyType === 'json' ? '{ "key": "value" }' : '请求体内容'}
                  className="w-full h-32 px-2 py-1.5 text-xs font-mono bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50 disabled:opacity-50 resize-y"
                />
              </div>
            )}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 m-3 px-2 py-2 text-xs text-red-400 bg-red-500/10 rounded">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}

        {/* Response */}
        {response && (
          <div className="p-3 space-y-2">
            <div className="flex items-center gap-3 text-xs">
              <span className={`font-mono font-bold ${statusColor(response.status)}`}>
                {response.status} {response.statusText}
              </span>
              <span className="text-text-tertiary">{response.elapsedMs} ms</span>
              <span className="text-text-tertiary">{response.size} bytes</span>
              {response.truncated && (
                <span className="text-yellow-400">已截断</span>
              )}
            </div>
            {response.url !== spec.url && (
              <div className="text-[10px] text-text-tertiary break-all">→ {response.url}</div>
            )}

            {/* Response headers */}
            <div>
              <button
                onClick={() => setShowHeaders((v) => !v)}
                className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                {showHeaders ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Response Headers ({response.headers.length})
              </button>
              {showHeaders && (
                <div className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                  {response.headers.map((h, i) => (
                    <div key={i} className="flex text-[10px] font-mono">
                      <span className="text-text-secondary shrink-0">{h.name}:</span>
                      <span className="text-text-tertiary ml-1 break-all">{h.value}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Response body */}
            <div>
              <button
                onClick={() => setBodyOpen((v) => !v)}
                className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                {bodyOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Response Body
              </button>
              {bodyOpen && (
                <pre className="mt-1 p-2 text-[10px] font-mono bg-background-elevated border border-border rounded max-h-80 overflow-auto whitespace-pre-wrap break-all text-text-primary">
                  {response.body || '(空响应体)'}
                </pre>
              )}
            </div>
          </div>
        )}

        {/* History */}
        <div className="border-t border-border">
          <div className="flex items-center justify-between px-3 py-1.5">
            <div className="flex items-center gap-1.5 text-xs text-text-secondary">
              <Clock className="w-3 h-3" />
              历史
            </div>
            {history.length > 0 && (
              <button
                onClick={clearHistory}
                className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-red-400 transition-colors"
              >
                <Trash2 className="w-3 h-3" /> 清空
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-text-tertiary">
              <Inbox className="w-5 h-5 mb-1" />
              <span className="text-[10px]">暂无历史记录</span>
            </div>
          ) : (
            <div className="space-y-px">
              {history.map((h) => (
                <button
                  key={h.id}
                  onClick={() => restoreFromHistory(h)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] hover:bg-background-elevated transition-colors text-left"
                >
                  <span className={`font-mono font-bold shrink-0 w-12 ${statusColor(h.status)}`}>
                    {h.method}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-text-secondary">{h.url}</span>
                  <span className={`shrink-0 ${statusColor(h.status)}`}>{h.status}</span>
                  <span className="text-text-tertiary shrink-0">{h.elapsedMs}ms</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
