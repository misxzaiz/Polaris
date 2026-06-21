import { useState, useEffect } from 'react'

interface SystemInfo {
  platform: string
  userAgent: string
  language: string
  cores: number
  memory: string
  screen: string
  colorDepth: number
  timezone: string
  cookieEnabled: boolean
  doNotTrack: boolean | null
}

function getSystemInfo(): SystemInfo {
  const nav = navigator
  return {
    platform: nav.platform || 'Unknown',
    userAgent: nav.userAgent,
    language: nav.language || 'Unknown',
    cores: nav.hardwareConcurrency || 0,
    memory: (nav as Navigator & { deviceMemory?: number }).deviceMemory ? `${(nav as Navigator & { deviceMemory?: number }).deviceMemory} GB` : 'Unknown',
    screen: `${screen.width}x${screen.height}`,
    colorDepth: screen.colorDepth,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cookieEnabled: nav.cookieEnabled,
    doNotTrack: nav.doNotTrack as boolean | null,
  }
}

const INFO_ITEMS: { key: keyof SystemInfo; label: string; icon: string }[] = [
  { key: 'platform', label: '操作系统', icon: '💻' },
  { key: 'cores', label: 'CPU 核心数', icon: '⚡' },
  { key: 'memory', label: '设备内存', icon: '🧠' },
  { key: 'screen', label: '屏幕分辨率', icon: '🖥️' },
  { key: 'colorDepth', label: '颜色深度', icon: '🎨' },
  { key: 'language', label: '语言', icon: '🌐' },
  { key: 'timezone', label: '时区', icon: '🕐' },
  { key: 'cookieEnabled', label: 'Cookie', icon: '🍪' },
  { key: 'doNotTrack', label: 'Do Not Track', icon: '🔒' },
]

export default function SystemInfoPanel({ pluginId }: { pluginId: string; onSendToChat?: (msg: string) => void }) {
  const [info, setInfo] = useState<SystemInfo>(getSystemInfo())
  const [copied, setCopied] = useState(false)
  const [showUA, setShowUA] = useState(false)

  useEffect(() => {
    const handleResize = () => {
      setInfo(getSystemInfo())
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const handleCopy = () => {
    const text = INFO_ITEMS.map((item) => `${item.label}: ${info[item.key]}`).join('\n')
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleRefresh = () => {
    setInfo(getSystemInfo())
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#E8E8EC' }}>系统信息</h3>
        <span style={{ fontSize: 10, color: '#71717A' }}>Plugin: {pluginId}</span>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={handleRefresh}
          style={{
            flex: 1,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: '#27272A',
            color: '#A1A1AA',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          刷新
        </button>
        <button
          onClick={handleCopy}
          style={{
            flex: 1,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #3F3F46',
            background: copied ? '#22C55E' : '#27272A',
            color: copied ? '#fff' : '#A1A1AA',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {copied ? '已复制' : '复制全部'}
        </button>
      </div>

      {/* System Info List */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {INFO_ITEMS.map((item) => (
          <div
            key={item.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 10px',
              borderRadius: 6,
              background: '#18181B',
              border: '1px solid #27272A',
            }}
          >
            <span style={{ fontSize: 16, width: 24 }}>{item.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: '#71717A' }}>{item.label}</div>
              <div style={{ fontSize: 12, color: '#E8E8EC', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                {String(info[item.key])}
              </div>
            </div>
          </div>
        ))}

        {/* User Agent */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            onClick={() => setShowUA(!showUA)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 10px',
              borderRadius: 6,
              background: '#18181B',
              border: '1px solid #27272A',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 16, width: 24 }}>🔗</span>
              <div>
                <div style={{ fontSize: 10, color: '#71717A' }}>User Agent</div>
                <div style={{ fontSize: 12, color: '#E8E8EC' }}>点击查看完整 UA</div>
              </div>
            </div>
            <span style={{ color: '#71717A', fontSize: 12 }}>{showUA ? '▼' : '▶'}</span>
          </button>
          {showUA && (
            <div
              style={{
                padding: 10,
                borderRadius: 6,
                background: '#18181B',
                border: '1px solid #3F3F46',
                fontFamily: 'monospace',
                fontSize: 10,
                color: '#A1A1AA',
                lineHeight: 1.5,
                wordBreak: 'break-all',
              }}
            >
              {info.userAgent}
            </div>
          )}
        </div>
      </div>

      {/* Browser Features */}
      <div style={{ padding: '8px 10px', borderRadius: 6, background: '#27272A', border: '1px solid #3F3F46' }}>
        <div style={{ fontSize: 11, color: '#71717A', marginBottom: 6 }}>浏览器特性</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {[
            { name: 'LocalStorage', supported: typeof localStorage !== 'undefined' },
            { name: 'SessionStorage', supported: typeof sessionStorage !== 'undefined' },
            { name: 'Web Workers', supported: typeof Worker !== 'undefined' },
            { name: 'Service Workers', supported: 'serviceWorker' in navigator },
            { name: 'WebGL', supported: (() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl') || c.getContext('experimental-webgl')) } catch { return false } })() },
            { name: 'Touch Events', supported: 'ontouchstart' in window },
          ].map((feature) => (
            <div
              key={feature.name}
              style={{
                padding: '2px 6px',
                borderRadius: 3,
                background: feature.supported ? '#22C55E20' : '#EF444420',
                border: `1px solid ${feature.supported ? '#22C55E40' : '#EF444440'}`,
                fontSize: 9,
                color: feature.supported ? '#22C55E' : '#EF4444',
              }}
            >
              {feature.supported ? '✓' : '✗'} {feature.name}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
