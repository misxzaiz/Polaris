import { useState, useCallback, useMemo } from 'react'

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

interface LogEntry {
  timestamp: Date
  level: LogLevel
  source: string
  message: string
}

const MOCK_LOGS: LogEntry[] = [
  { timestamp: new Date(Date.now() - 1000), level: 'info', source: 'app', message: 'Application started successfully' },
  { timestamp: new Date(Date.now() - 2000), level: 'info', source: 'server', message: 'Server listening on port 3000' },
  { timestamp: new Date(Date.now() - 3000), level: 'debug', source: 'db', message: 'Connected to database' },
  { timestamp: new Date(Date.now() - 4000), level: 'warn', source: 'cache', message: 'Cache miss for key: user_123' },
  { timestamp: new Date(Date.now() - 5000), level: 'error', source: 'api', message: 'Failed to fetch data: timeout' },
  { timestamp: new Date(Date.now() - 6000), level: 'info', source: 'auth', message: 'User login: admin@example.com' },
  { timestamp: new Date(Date.now() - 7000), level: 'debug', source: 'router', message: 'Route matched: GET /api/users' },
  { timestamp: new Date(Date.now() - 8000), level: 'warn', source: 'ratelimit', message: 'Rate limit approaching for IP: 192.168.1.1' },
  { timestamp: new Date(Date.now() - 9000), level: 'info', source: 'worker', message: 'Background job completed: email_sync' },
  { timestamp: new Date(Date.now() - 10000), level: 'error', source: 'payment', message: 'Payment gateway error: insufficient funds' },
]

const LEVEL_COLORS: Record<LogLevel, string> = {
  info: '#3B82F6',
  warn: '#F59E0B',
  error: '#EF4444',
  debug: '#71717A',
}

const LEVEL_BG: Record<LogLevel, string> = {
  info: '#3B82F620',
  warn: '#F59E0B20',
  error: '#EF444420',
  debug: '#71717A20',
}

export default function LogViewerPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [logs, setLogs] = useState<LogEntry[]>(MOCK_LOGS)
  const [search, setSearch] = useState('')
  const [levelFilter, setLevelFilter] = useState<Set<LogLevel>>(new Set(['info', 'warn', 'error', 'debug']))
  const [copied, setCopied] = useState(false)

  const filtered = useMemo(() => {
    return logs.filter((log) => {
      const matchesLevel = levelFilter.has(log.level)
      const matchesSearch =
        !search ||
        log.message.toLowerCase().includes(search.toLowerCase()) ||
        log.source.toLowerCase().includes(search.toLowerCase())
      return matchesLevel && matchesSearch
    })
  }, [logs, search, levelFilter])

  const toggleLevel = useCallback((level: LogLevel) => {
    setLevelFilter((prev) => {
      const next = new Set(prev)
      if (next.has(level)) {
        next.delete(level)
      } else {
        next.add(level)
      }
      return next
    })
  }, [])

  const handleCopy = useCallback(() => {
    const text = filtered
      .map((log) => `[${log.timestamp.toISOString()}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}`)
      .join('\n')
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [filtered])

  const handleClear = useCallback(() => {
    setLogs([])
  }, [])

  const handleAddMockLog = useCallback(() => {
    const levels: LogLevel[] = ['info', 'warn', 'error', 'debug']
    const sources = ['app', 'server', 'db', 'cache', 'api', 'auth']
    const messages = [
      'Request processed successfully',
      'Connection timeout',
      'Memory usage high',
      'Cache invalidated',
      'New session created',
      'Rate limit exceeded',
    ]
    const newLog: LogEntry = {
      timestamp: new Date(),
      level: levels[Math.floor(Math.random() * levels.length)],
      source: sources[Math.floor(Math.random() * sources.length)],
      message: messages[Math.floor(Math.random() * messages.length)],
    }
    setLogs((prev) => [newLog, ...prev])
  }, [])

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>日志查看</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ padding: '4px 8px', borderRadius: 4, background: '#3B82F620', border: '1px solid #3B82F640' }}>
          <span style={{ fontSize: 10, color: '#3B82F6' }}>Info: {logs.filter((l) => l.level === 'info').length}</span>
        </div>
        <div style={{ padding: '4px 8px', borderRadius: 4, background: '#F59E0B20', border: '1px solid #F59E0B40' }}>
          <span style={{ fontSize: 10, color: '#F59E0B' }}>Warn: {logs.filter((l) => l.level === 'warn').length}</span>
        </div>
        <div style={{ padding: '4px 8px', borderRadius: 4, background: '#EF444420', border: '1px solid #EF444440' }}>
          <span style={{ fontSize: 10, color: '#EF4444' }}>Error: {logs.filter((l) => l.level === 'error').length}</span>
        </div>
      </div>

      {/* Search & Level Filter */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索日志..."
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
          onClick={handleAddMockLog}
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#27272A',
            color: '#A1A1AA',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          + 模拟
        </button>
        <button
          onClick={handleCopy}
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: copied ? '#22C55E' : '#27272A',
            color: copied ? '#fff' : '#A1A1AA',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
        <button
          onClick={handleClear}
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#27272A',
            color: '#A1A1AA',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          清空
        </button>
      </div>

      {/* Level Filter */}
      <div style={{ display: 'flex', gap: 4 }}>
        {(['info', 'warn', 'error', 'debug'] as const).map((level) => (
          <button
            key={level}
            onClick={() => toggleLevel(level)}
            style={{
              padding: '3px 8px',
              borderRadius: 4,
              border: '1px solid',
              borderColor: levelFilter.has(level) ? LEVEL_COLORS[level] : '#3F3F46',
              background: levelFilter.has(level) ? LEVEL_COLORS[level] : '#27272A',
              color: levelFilter.has(level) ? '#fff' : '#A1A1AA',
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            {level.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Log List */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 1, fontFamily: 'Consolas, Monaco, "Courier New", monospace', fontSize: 11 }}>
        {filtered.map((log, i) => (
          <div
            key={`${log.timestamp.getTime()}-${i}`}
            style={{
              display: 'flex',
              gap: 8,
              padding: '4px 8px',
              background: LEVEL_BG[log.level],
              borderLeft: `3px solid ${LEVEL_COLORS[log.level]}`,
            }}
          >
            <span style={{ color: '#52525B', whiteSpace: 'nowrap' }}>{formatTime(log.timestamp)}</span>
            <span style={{ color: LEVEL_COLORS[log.level], width: 40, textTransform: 'uppercase', fontWeight: 500 }}>{log.level}</span>
            <span style={{ color: '#A78BFA', minWidth: 50 }}>[{log.source}]</span>
            <span style={{ color: '#E8E8EC', flex: 1, wordBreak: 'break-all' }}>{log.message}</span>
          </div>
        ))}

        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: 20, color: '#52525B' }}>
            {search || levelFilter.size < 4 ? '没有匹配的日志' : '暂无日志'}
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '6px 10px', borderRadius: 6, background: '#27272A', fontSize: 10, color: '#71717A' }}>
        显示 {filtered.length} / {logs.length} 条日志
      </div>
    </div>
  )
}
