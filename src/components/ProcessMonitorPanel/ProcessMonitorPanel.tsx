import { useState, useCallback, useEffect } from 'react'

interface ProcessInfo {
  pid: number
  name: string
  cpu: number
  memory: number
  status: string
}

export default function ProcessMonitorPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<'cpu' | 'memory' | 'name'>('cpu')
  const [loading, setLoading] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)

  const mockProcesses: ProcessInfo[] = [
    { pid: 1, name: 'System', cpu: 0.5, memory: 12.5, status: 'Running' },
    { pid: 1234, name: 'node.exe', cpu: 2.3, memory: 156.8, status: 'Running' },
    { pid: 2345, name: 'polaris.exe', cpu: 1.8, memory: 234.2, status: 'Running' },
    { pid: 3456, name: 'chrome.exe', cpu: 5.6, memory: 456.7, status: 'Running' },
    { pid: 4567, name: 'vscode.exe', cpu: 3.2, memory: 312.4, status: 'Running' },
    { pid: 5678, name: 'docker.exe', cpu: 1.2, memory: 234.5, status: 'Running' },
    { pid: 6789, name: 'git.exe', cpu: 0.3, memory: 23.4, status: 'Sleeping' },
    { pid: 7890, name: 'explorer.exe', cpu: 0.8, memory: 89.6, status: 'Running' },
  ]

  const refresh = useCallback(() => {
    setLoading(true)
    setTimeout(() => {
      const randomized = mockProcesses.map((p) => ({
        ...p,
        cpu: Math.max(0, p.cpu + (Math.random() - 0.5) * 2),
        memory: Math.max(10, p.memory + (Math.random() - 0.5) * 20),
      }))
      setProcesses(randomized)
      setLastUpdate(new Date())
      setLoading(false)
    }, 500)
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [refresh])

  const filtered = processes
    .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || p.pid.toString().includes(search))
    .sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name)
      return b[sortBy] - a[sortBy]
    })

  const totalCpu = processes.reduce((sum, p) => sum + p.cpu, 0)
  const totalMemory = processes.reduce((sum, p) => sum + p.memory, 0)

  const formatMemory = (mb: number) => {
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
    return `${mb.toFixed(1)} MB`
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>进程监控</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, padding: '8px 10px', borderRadius: 6, background: '#18181B', border: '1px solid #3F3F46' }}>
          <div style={{ fontSize: 10, color: '#71717A' }}>CPU 使用率</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#3B82F6' }}>{totalCpu.toFixed(1)}%</div>
        </div>
        <div style={{ flex: 1, padding: '8px 10px', borderRadius: 6, background: '#18181B', border: '1px solid #3F3F46' }}>
          <div style={{ fontSize: 10, color: '#71717A' }}>内存使用</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#22C55E' }}>{formatMemory(totalMemory)}</div>
        </div>
        <div style={{ flex: 1, padding: '8px 10px', borderRadius: 6, background: '#18181B', border: '1px solid #3F3F46' }}>
          <div style={{ fontSize: 10, color: '#71717A' }}>进程数</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#A78BFA' }}>{processes.length}</div>
        </div>
      </div>

      {/* Search & Refresh */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索进程..."
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
          onClick={refresh}
          disabled={loading}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#27272A',
            color: '#A1A1AA',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {/* Sort Buttons */}
      <div style={{ display: 'flex', gap: 4 }}>
        {(['cpu', 'memory', 'name'] as const).map((key) => (
          <button
            key={key}
            onClick={() => setSortBy(key)}
            style={{
              padding: '3px 8px',
              borderRadius: 4,
              border: '1px solid',
              borderColor: sortBy === key ? '#3B82F6' : '#3F3F46',
              background: sortBy === key ? '#3B82F6' : '#27272A',
              color: sortBy === key ? '#fff' : '#A1A1AA',
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            {key === 'cpu' ? '按 CPU' : key === 'memory' ? '按内存' : '按名称'}
          </button>
        ))}
      </div>

      {/* Process List */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {/* Header */}
        <div style={{ display: 'grid', gridTemplateColumns: '50px 1fr 60px 70px 60px', gap: 4, padding: '4px 8px', fontSize: 10, color: '#71717A', fontWeight: 500 }}>
          <span>PID</span>
          <span>进程名</span>
          <span>CPU</span>
          <span>内存</span>
          <span>状态</span>
        </div>

        {filtered.map((p) => (
          <div
            key={p.pid}
            style={{
              display: 'grid',
              gridTemplateColumns: '50px 1fr 60px 70px 60px',
              gap: 4,
              padding: '6px 8px',
              borderRadius: 4,
              background: '#18181B',
              border: '1px solid #27272A',
              fontSize: 11,
            }}
          >
            <span style={{ color: '#71717A', fontFamily: 'monospace' }}>{p.pid}</span>
            <span style={{ color: '#E8E8EC', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            <span style={{ color: p.cpu > 5 ? '#EF4444' : '#3B82F6', fontFamily: 'monospace' }}>{p.cpu.toFixed(1)}%</span>
            <span style={{ color: '#22C55E', fontFamily: 'monospace' }}>{formatMemory(p.memory)}</span>
            <span style={{ color: p.status === 'Running' ? '#22C55E' : '#F59E0B', fontSize: 10 }}>{p.status}</span>
          </div>
        ))}
      </div>

      {/* Last Update */}
      {lastUpdate && (
        <div style={{ fontSize: 10, color: '#52525B', textAlign: 'center' }}>
          最后更新: {lastUpdate.toLocaleTimeString()}
        </div>
      )}
    </div>
  )
}
