import { useState, useCallback } from 'react'

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

interface ApiResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  time: number
}

export default function ApiTesterPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [method, setMethod] = useState<HttpMethod>('GET')
  const [url, setUrl] = useState('https://jsonplaceholder.typicode.com/posts/1')
  const [headers, setHeaders] = useState('{\n  "Content-Type": "application/json"\n}')
  const [body, setBody] = useState('')
  const [response, setResponse] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSend = useCallback(async () => {
    setLoading(true)
    setError(null)
    setResponse(null)

    const startTime = Date.now()

    try {
      let parsedHeaders: Record<string, string> = {}
      try {
        parsedHeaders = JSON.parse(headers)
      } catch {
        // Ignore header parse errors
      }

      const options: RequestInit = {
        method,
        headers: parsedHeaders,
      }

      if (method !== 'GET' && body) {
        options.body = body
      }

      const res = await fetch(url, options)
      const responseBody = await res.text()
      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })

      setResponse({
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
        body: responseBody,
        time: Date.now() - startTime,
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [method, url, headers, body])

  const methods: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']

  const getMethodColor = (m: HttpMethod) => {
    switch (m) {
      case 'GET': return '#22C55E'
      case 'POST': return '#3B82F6'
      case 'PUT': return '#F59E0B'
      case 'DELETE': return '#EF4444'
      case 'PATCH': return '#A78BFA'
    }
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>API 测试</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Method & URL */}
      <div style={{ display: 'flex', gap: 6 }}>
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value as HttpMethod)}
          style={{
            width: 90,
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: getMethodColor(method),
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            outline: 'none',
          }}
        >
          {methods.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="输入 URL..."
          style={{
            flex: 1,
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#18181B',
            color: '#E8E8EC',
            fontFamily: 'monospace',
            fontSize: 12,
            outline: 'none',
          }}
        />
      </div>

      {/* Send Button */}
      <button
        onClick={handleSend}
        disabled={!url.trim() || loading}
        style={{
          padding: '8px 12px',
          borderRadius: 6,
          border: 'none',
          background: url.trim() && !loading ? getMethodColor(method) : '#3F3F46',
          color: url.trim() && !loading ? '#fff' : '#71717A',
          fontSize: 12,
          fontWeight: 500,
          cursor: url.trim() && !loading ? 'pointer' : 'not-allowed',
        }}
      >
        {loading ? '发送中...' : '发送请求'}
      </button>

      {/* Headers */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, color: '#71717A' }}>请求头</span>
        <textarea
          value={headers}
          onChange={(e) => setHeaders(e.target.value)}
          style={{
            minHeight: 60,
            padding: 8,
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#18181B',
            color: '#E8E8EC',
            fontFamily: 'Consolas, Monaco, monospace',
            fontSize: 11,
            lineHeight: 1.4,
            resize: 'vertical',
            outline: 'none',
          }}
        />
      </div>

      {/* Body */}
      {method !== 'GET' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: '#71717A' }}>请求体</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder='{"key": "value"}'
            style={{
              minHeight: 60,
              padding: 8,
              borderRadius: 6,
              border: '1px solid #3F3F46',
              background: '#18181B',
              color: '#E8E8EC',
              fontFamily: 'Consolas, Monaco, monospace',
              fontSize: 11,
              lineHeight: 1.4,
              resize: 'vertical',
              outline: 'none',
            }}
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: '8px 10px', borderRadius: 6, background: '#2E1A1A', border: '1px solid #EF4444', fontSize: 11, color: '#EF4444' }}>
          {error}
        </div>
      )}

      {/* Response */}
      {response && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                background: response.status < 400 ? '#22C55E' : '#EF4444',
                color: '#fff',
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {response.status} {response.statusText}
            </span>
            <span style={{ fontSize: 10, color: '#71717A' }}>
              {response.time}ms
            </span>
          </div>
          <pre
            style={{
              flex: 1,
              margin: 0,
              padding: 10,
              borderRadius: 6,
              border: '1px solid #3F3F46',
              background: '#18181B',
              color: '#E8E8EC',
              fontFamily: 'Consolas, Monaco, monospace',
              fontSize: 11,
              lineHeight: 1.5,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {response.body}
          </pre>
        </div>
      )}
    </div>
  )
}
