/**
 * 响应查看器
 *
 * 视图切换：Pretty(JSON 高亮) / Tree(节点折叠+JSONPath复制) / Table(数组转表) / Preview(图片/HTML) / Raw。
 * 响应头可折叠展示，状态码彩色，耗时/大小/最终URL 元信息。
 */

import { useMemo, useState } from 'react'
import { Copy, Check, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react'
import { CodeBlock } from '@/components/Chat/CodeBlock'
import type { HttpResponseInfo } from './httpClientTypes'
import { JsonTreeView } from './JsonTreeView'
import { ResponseTableView } from './ResponseTableView'
import { ResponsePreview } from './ResponsePreview'

type ViewMode = 'pretty' | 'tree' | 'table' | 'preview' | 'raw'

function statusColor(status: number): string {
  if (status === 0) return 'text-gray-400'
  if (status < 300) return 'text-green-400'
  if (status < 400) return 'text-yellow-400'
  return 'text-red-400'
}

function tryParseJson(body: string): { ok: true; data: unknown } | { ok: false } {
  try {
    return { ok: true, data: JSON.parse(body) }
  } catch {
    return { ok: false }
  }
}

function contentTypeOf(headers: { name: string; value: string }[]): string {
  return headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? ''
}

export function ResponseViewer({ response, error }: { response: HttpResponseInfo | null; error: string | null }) {
  const [view, setView] = useState<ViewMode>('pretty')
  const [headersOpen, setHeadersOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const parsed = useMemo(() => (response ? tryParseJson(response.body) : { ok: false } as const), [response])
  const contentType = useMemo(() => (response ? contentTypeOf(response.headers) : ''), [response])

  const prettyBody = useMemo(() => {
    if (!response) return ''
    if (parsed.ok) return JSON.stringify(parsed.data, null, 2)
    return response.body
  }, [response, parsed])

  if (error) {
    return (
      <div className="flex items-start gap-2 m-3 px-2 py-2 text-xs text-red-400 bg-red-500/10 rounded">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span className="break-all">{error}</span>
      </div>
    )
  }

  if (!response) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-text-tertiary py-8">
        发送请求后在此查看响应
      </div>
    )
  }

  const isJson = parsed.ok
  const isArray = isJson && Array.isArray(parsed.data)
  const isPreviewable =
    contentType.toLowerCase().startsWith('image/') ||
    contentType.toLowerCase().includes('text/html') ||
    contentType.toLowerCase().includes('xml')

  // 当前响应不支持该视图时回退到美化视图，避免渲染错位
  const viewSupported =
    view === 'pretty' ||
    view === 'raw' ||
    (view === 'tree' && isJson) ||
    (view === 'table' && isJson) ||
    (view === 'preview' && isPreviewable)
  const effectiveView: ViewMode = viewSupported ? view : 'pretty'

  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(prettyBody || response.body)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* 状态行 */}
      <div className="flex items-center gap-3 px-3 py-1.5 text-xs border-b border-border shrink-0">
        <span className={`font-mono font-bold ${statusColor(response.status)}`}>
          {response.status} {response.statusText}
        </span>
        <span className="text-text-tertiary">{response.elapsedMs} ms</span>
        <span className="text-text-tertiary">{response.size} bytes</span>
        {response.truncated && <span className="text-yellow-400">已截断</span>}
        {response.url !== '' && (
          <span className="text-[10px] text-text-tertiary truncate ml-auto" title={response.url}>
            → {response.url}
          </span>
        )}
      </div>

      {/* 响应头 */}
      <div className="border-b border-border shrink-0">
        <button
          onClick={() => setHeadersOpen((v) => !v)}
          className="flex items-center gap-1 px-3 py-1 text-xs text-text-secondary hover:text-text-primary w-full"
        >
          {headersOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          Response Headers ({response.headers.length})
        </button>
        {headersOpen && (
          <div className="px-3 pb-2 max-h-40 overflow-y-auto">
            {response.headers.map((h, i) => (
              <div key={i} className="flex text-[10px] font-mono py-0.5">
                <span className="text-text-secondary shrink-0 max-w-[40%] truncate" title={h.name}>
                  {h.name}:
                </span>
                <span className="text-text-tertiary ml-1 break-all">{h.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 视图切换 */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
        {(['pretty', 'tree', 'table', 'preview', 'raw'] as ViewMode[]).map((m) => {
          const disabled =
            (m === 'tree' && !isJson) ||
            (m === 'table' && (!isJson || (!isArray && !parsed.ok))) ||
            (m === 'preview' && !isPreviewable)
          if (disabled) return null
          return (
            <button
              key={m}
              onClick={() => setView(m)}
              className={`px-2 py-1 text-[10px] rounded transition-colors ${
                effectiveView === m ? 'bg-background-elevated text-text-primary' : 'text-text-tertiary hover:text-text-primary hover:bg-background-elevated'
              }`}
            >
              {m === 'pretty' ? '美化' : m === 'tree' ? '树' : m === 'table' ? '表格' : m === 'preview' ? '预览' : '原始'}
            </button>
          )
        })}
        <button
          onClick={copyBody}
          className="flex items-center gap-1 px-2 py-1 text-[10px] rounded text-text-tertiary hover:text-text-primary hover:bg-background-elevated ml-auto"
          title="复制响应体"
        >
          {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>

      {/* 响应体 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {effectiveView === 'pretty' && (
          <div className="h-full overflow-auto">
            <CodeBlock className="language-json">{prettyBody || '(空响应体)'}</CodeBlock>
          </div>
        )}
        {effectiveView === 'tree' && isJson && <JsonTreeView data={parsed.data} />}
        {effectiveView === 'table' && isJson && <ResponseTableView data={parsed.data} />}
        {effectiveView === 'preview' && <ResponsePreview body={response.body} contentType={contentType} />}
        {effectiveView === 'raw' && (
          <pre className="p-2 text-[11px] font-mono whitespace-pre-wrap break-all text-text-primary overflow-auto h-full">
            {response.body || '(空响应体)'}
          </pre>
        )}
      </div>
    </div>
  )
}
