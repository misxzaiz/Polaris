import { useState, useCallback } from 'react'

interface TestResult {
  host: string
  success: boolean
  latency?: number
  error?: string
  timestamp: Date
}

const PRESET_HOSTS = [
  { name: 'Google DNS', host: '8.8.8.8' },
  { name: 'Cloudflare DNS', host: '1.1.1.1' },
  { name: 'Baidu', host: 'www.baidu.com' },
  { name: 'Google', host: 'www.google.com' },
  { name: 'GitHub', host: 'github.com' },
  { name: 'Localhost', host: '127.0.0.1' },
]

export default function NetworkDiagnosticPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [host, setHost] = useState('')
  const [results, setResults] = useState<TestResult[]>([])
  const [testing, setTesting] = useState(false)

  const testHost = useCallback(async (targetHost: string): Promise<TestResult> => {
    const start = Date.now()
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)

      await fetch(`https://${targetHost}`, {
        mode: 'no-cors',
        signal: controller.signal,
      })
      clearTimeout(timeout)

      return {
        host: targetHost,
        success: true,
        latency: Date.now() - start,
        timestamp: new Date(),
      }
    } catch {
      return {
        host: targetHost,
        success: false,
        error: '连接失败或超时',
        timestamp: new Date(),
      }
    }
  }, [])

  const handleTest = useCallback(async () => {
    if (!host.trim()) return
    setTesting(true)
    const result = await testHost(host.trim())
    setResults((prev) => [result, ...prev].slice(0, 20))
    setTesting(false)
  }, [host, testHost])

  const handleTestPreset = useCallback(async (presetHost: string) => {
    setTesting(true)
    const result = await testHost(presetHost)
    setResults((prev) => [result, ...prev].slice(0, 20))
    setTesting(false)
  }, [testHost])

  const handleClear = useCallback(() => {
    setResults([])
  }, [])

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>网络诊断</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleTest()}
          placeholder="输入域名或 IP..."
          style={{
            flex: 1,
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#18181B',
            color: '#E8E8EC',
            fontSize: 12,
            outline: 'none',
          }}
        />
        <button
          onClick={handleTest}
          disabled={!host.trim() || testing}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: 'none',
            background: host.trim() && !testing ? '#3B82F6' : '#3F3F46',
            color: host.trim() && !testing ? '#fff' : '#71717A',
            fontSize: 12,
            fontWeight: 500,
            cursor: host.trim() && !testing ? 'pointer' : 'not-allowed',
          }}
        >
          {testing ? '测试中...' : '测试'}
        </button>
        {results.length > 0 && (
          <button
            onClick={handleClear}
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid #3F3F46',
              background: '#27272A',
              color: '#A1A1AA',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            清空
          </button>
        )}
      </div>

      {/* Preset Hosts */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, color: '#71717A' }}>快捷测试</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {PRESET_HOSTS.map((p) => (
            <button
              key={p.host}
              onClick={() => handleTestPreset(p.host)}
              disabled={testing}
              style={{
                padding: '4px 10px',
                borderRadius: 4,
                border: '1px solid #3F3F46',
                background: '#27272A',
                color: '#A1A1AA',
                fontSize: 10,
                cursor: testing ? 'not-allowed' : 'pointer',
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {results.map((r, i) => (
          <div
            key={`${r.host}-${i}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 10px',
              borderRadius: 6,
              background: r.success ? '#1A2E1A' : '#2E1A1A',
              border: `1px solid ${r.success ? '#22C55E40' : '#EF444440'}`,
            }}
          >
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: r.success ? '#22C55E' : '#EF4444' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: '#E8E8EC', fontWeight: 500 }}>{r.host}</div>
              <div style={{ fontSize: 10, color: '#71717A' }}>
                {r.success ? `延迟: ${r.latency}ms` : r.error}
              </div>
            </div>
            <div style={{ fontSize: 9, color: '#52525B' }}>
              {r.timestamp.toLocaleTimeString()}
            </div>
          </div>
        ))}

        {results.length === 0 && (
          <div style={{ textAlign: 'center', padding: 20, color: '#52525B', fontSize: 12 }}>
            输入域名或 IP 地址进行网络测试
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '6px 10px', borderRadius: 6, background: '#27272A', fontSize: 10, color: '#71717A' }}>
        提示: 网络测试使用 fetch API，受浏览器安全策略限制，可能无法完全反映真实网络状态。
      </div>
    </div>
  )
}
