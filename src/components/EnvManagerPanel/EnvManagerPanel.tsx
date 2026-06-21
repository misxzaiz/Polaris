import { useState, useCallback, useMemo } from 'react'

interface EnvVar {
  key: string
  value: string
  source: 'system' | 'user' | 'project'
}

const MOCK_ENV: EnvVar[] = [
  { key: 'NODE_ENV', value: 'development', source: 'system' },
  { key: 'PATH', value: '/usr/bin:/usr/local/bin:/opt/homebrew/bin', source: 'system' },
  { key: 'HOME', value: '/Users/developer', source: 'system' },
  { key: 'SHELL', value: '/bin/zsh', source: 'system' },
  { key: 'LANG', value: 'en_US.UTF-8', source: 'system' },
  { key: 'EDITOR', value: 'code', source: 'user' },
  { key: 'VISUAL', value: 'code', source: 'user' },
  { key: 'API_KEY', value: 'sk-xxxx', source: 'project' },
  { key: 'DATABASE_URL', value: 'postgres://localhost:5432/mydb', source: 'project' },
  { key: 'PORT', value: '3000', source: 'project' },
]

const SOURCE_COLORS: Record<string, string> = {
  system: '#3B82F6',
  user: '#22C55E',
  project: '#F59E0B',
}

const SOURCE_LABELS: Record<string, string> = {
  system: '系统',
  user: '用户',
  project: '项目',
}

export default function EnvManagerPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [envVars] = useState<EnvVar[]>(MOCK_ENV)
  const [search, setSearch] = useState('')
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [showValues, setShowValues] = useState(true)

  const filtered = useMemo(() => {
    return envVars.filter((v) => {
      const matchesSearch = !search || v.key.toLowerCase().includes(search.toLowerCase()) || v.value.toLowerCase().includes(search.toLowerCase())
      const matchesSource = !selectedSource || v.source === selectedSource
      return matchesSearch && matchesSource
    })
  }, [envVars, search, selectedSource])

  const handleCopy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }, [])

  const handleCopyAll = useCallback(() => {
    const text = filtered.map((v) => `${v.key}=${v.value}`).join('\n')
    navigator.clipboard.writeText(text)
    setCopied('all')
    setTimeout(() => setCopied(null), 1500)
  }, [filtered])

  const maskValue = (value: string) => {
    if (value.length > 10) return value.slice(0, 5) + '***' + value.slice(-3)
    return '***'
  }

  const sources = ['system', 'user', 'project'] as const

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>环境变量</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Search & Actions */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索变量..."
          style={{
            flex: 1,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#18181B',
            color: '#E8E8EC',
            fontSize: 12,
            outline: 'none',
          }}
        />
        <button
          onClick={() => setShowValues(!showValues)}
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: showValues ? '#3B82F6' : '#27272A',
            color: showValues ? '#fff' : '#A1A1AA',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {showValues ? '隐藏值' : '显示值'}
        </button>
        <button
          onClick={handleCopyAll}
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: copied === 'all' ? '#22C55E' : '#27272A',
            color: copied === 'all' ? '#fff' : '#A1A1AA',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {copied === 'all' ? '已复制' : '复制全部'}
        </button>
      </div>

      {/* Source Filter */}
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          onClick={() => setSelectedSource(null)}
          style={{
            padding: '3px 8px',
            borderRadius: 4,
            border: '1px solid',
            borderColor: !selectedSource ? '#3B82F6' : '#3F3F46',
            background: !selectedSource ? '#3B82F6' : '#27272A',
            color: !selectedSource ? '#fff' : '#A1A1AA',
            fontSize: 10,
            cursor: 'pointer',
          }}
        >
          全部 ({envVars.length})
        </button>
        {sources.map((s) => (
          <button
            key={s}
            onClick={() => setSelectedSource(s)}
            style={{
              padding: '3px 8px',
              borderRadius: 4,
              border: '1px solid',
              borderColor: selectedSource === s ? SOURCE_COLORS[s] : '#3F3F46',
              background: selectedSource === s ? SOURCE_COLORS[s] : '#27272A',
              color: selectedSource === s ? '#fff' : '#A1A1AA',
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            {SOURCE_LABELS[s]} ({envVars.filter((v) => v.source === s).length})
          </button>
        ))}
      </div>

      {/* Env Var List */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {filtered.map((v) => (
          <div
            key={v.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              borderRadius: 4,
              background: '#18181B',
              border: '1px solid #27272A',
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: SOURCE_COLORS[v.source],
                flexShrink: 0,
              }}
              title={SOURCE_LABELS[v.source]}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: '#E8E8EC', fontWeight: 500, fontFamily: 'monospace' }}>{v.key}</div>
              <div style={{ fontSize: 10, color: '#71717A', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {showValues ? v.value : maskValue(v.value)}
              </div>
            </div>
            <button
              onClick={() => handleCopy(v.value, v.key)}
              style={{
                padding: '2px 6px',
                borderRadius: 3,
                border: '1px solid #3F3F46',
                background: copied === v.key ? '#22C55E' : '#27272A',
                color: copied === v.key ? '#fff' : '#A1A1AA',
                fontSize: 9,
                cursor: 'pointer',
              }}
            >
              {copied === v.key ? '✓' : '复制'}
            </button>
          </div>
        ))}
      </div>

      {/* Info */}
      <div style={{ padding: '6px 10px', borderRadius: 6, background: '#27272A', fontSize: 10, color: '#71717A' }}>
        系统变量来自操作系统，用户变量来自用户配置，项目变量来自 .env 文件。
      </div>
    </div>
  )
}
