import { useState, useCallback, useEffect } from 'react'

interface DiskUsage {
  path: string
  name: string
  size: number
  type: 'file' | 'folder'
  children?: DiskUsage[]
}

function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${bytes} B`
}

function getSizePercent(size: number, total: number): number {
  return Math.round((size / total) * 100)
}

function getColorByPercent(percent: number): string {
  if (percent > 50) return '#EF4444'
  if (percent > 30) return '#F59E0B'
  if (percent > 15) return '#3B82F6'
  return '#22C55E'
}

const MOCK_DATA: DiskUsage[] = [
  { path: '/src', name: 'src', size: 15728640, type: 'folder' },
  { path: '/node_modules', name: 'node_modules', size: 524288000, type: 'folder' },
  { path: '/dist', name: 'dist', size: 52428800, type: 'folder' },
  { path: '/.git', name: '.git', size: 104857600, type: 'folder' },
  { path: '/docs', name: 'docs', size: 2097152, type: 'folder' },
  { path: '/public', name: 'public', size: 5242880, type: 'folder' },
  { path: '/package.json', name: 'package.json', size: 2048, type: 'file' },
  { path: '/tsconfig.json', name: 'tsconfig.json', size: 1024, type: 'file' },
  { path: '/README.md', name: 'README.md', size: 4096, type: 'file' },
  { path: '/.gitignore', name: '.gitignore', size: 512, type: 'file' },
]

export default function DiskAnalyzerPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [data, setData] = useState<DiskUsage[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)

  const totalSize = data.reduce((sum, item) => sum + item.size, 0)

  const refresh = useCallback(() => {
    setLoading(true)
    setTimeout(() => {
      setData(MOCK_DATA)
      setLastUpdate(new Date())
      setLoading(false)
    }, 500)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const sortedData = [...data].sort((a, b) => b.size - a.size)

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>磁盘分析</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, padding: '8px 10px', borderRadius: 6, background: '#18181B', border: '1px solid #3F3F46' }}>
          <div style={{ fontSize: 10, color: '#71717A' }}>总大小</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#3B82F6' }}>{formatSize(totalSize)}</div>
        </div>
        <div style={{ flex: 1, padding: '8px 10px', borderRadius: 6, background: '#18181B', border: '1px solid #3F3F46' }}>
          <div style={{ fontSize: 10, color: '#71717A' }}>项目数</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#22C55E' }}>{data.length}</div>
        </div>
        <div style={{ flex: 1, padding: '8px 10px', borderRadius: 6, background: '#18181B', border: '1px solid #3F3F46' }}>
          <div style={{ fontSize: 10, color: '#71717A' }}>文件夹</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#A78BFA' }}>{data.filter((d) => d.type === 'folder').length}</div>
        </div>
      </div>

      {/* Refresh Button */}
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
        {loading ? '扫描中...' : '重新扫描'}
      </button>

      {/* Size Distribution Bar */}
      <div style={{ display: 'flex', height: 24, borderRadius: 6, overflow: 'hidden', border: '1px solid #3F3F46' }}>
        {sortedData.slice(0, 6).map((item) => {
          const percent = getSizePercent(item.size, totalSize)
          return (
            <div
              key={item.path}
              style={{
                width: `${percent}%`,
                background: getColorByPercent(percent),
                minWidth: percent > 0 ? 4 : 0,
                cursor: 'pointer',
                position: 'relative',
              }}
              title={`${item.name}: ${formatSize(item.size)} (${percent}%)`}
              onClick={() => setSelectedPath(item.path)}
            />
          )
        })}
      </div>

      {/* File List */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {sortedData.map((item) => {
          const percent = getSizePercent(item.size, totalSize)
          const isSelected = selectedPath === item.path
          return (
            <div
              key={item.path}
              onClick={() => setSelectedPath(item.path)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 4,
                background: isSelected ? '#3B82F620' : '#18181B',
                border: `1px solid ${isSelected ? '#3B82F6' : '#27272A'}`,
                cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: 14, width: 20 }}>{item.type === 'folder' ? '📁' : '📄'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#E8E8EC', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.name}
                </div>
                <div style={{ fontSize: 10, color: '#71717A' }}>
                  {formatSize(item.size)} · {percent}%
                </div>
              </div>
              <div style={{ width: 60, height: 4, borderRadius: 2, background: '#27272A', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${percent}%`,
                    height: '100%',
                    background: getColorByPercent(percent),
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>

      {/* Last Update */}
      {lastUpdate && (
        <div style={{ fontSize: 10, color: '#52525B', textAlign: 'center' }}>
          最后扫描: {lastUpdate.toLocaleTimeString()}
        </div>
      )}
    </div>
  )
}
