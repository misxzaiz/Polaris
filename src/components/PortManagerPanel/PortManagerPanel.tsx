/**
 * Port Manager 面板（内置插件 panel）
 *
 * 系统端口监控与管理：列出监听端口、释放占用、常用端口高亮。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  RefreshCw,
  Send,
  Search,
  Trash2,
  AlertCircle,
  Inbox,
  Loader2,
  CheckCircle,
  XCircle,
} from 'lucide-react'
import { invoke } from '@/services/transport'

interface PortInfo {
  port: number
  protocol: string
  address: string
  pid: number
  processName: string
  commandLine?: string
}

interface KillResult {
  port: number
  pid: number
  processName: string
  success: boolean
  error?: string
}

const COMMON_DEV_PORTS = new Set([
  3000, 3001, 5173, 5174, 8080, 8081, 8443, 4200, 4201,
  3306, 5432, 6379, 27017, 9200, 9300, 1433, 1521,
  8000, 8888, 9000, 9090, 2181, 9092, 5672, 15672,
])

const COMMON_PORT_NAMES: Record<number, string> = {
  3000: 'React/Next.js',
  3001: 'React Dev',
  5173: 'Vite',
  5174: 'Vite Alt',
  8080: 'HTTP Proxy',
  8081: 'HTTP Alt',
  8443: 'HTTPS Alt',
  4200: 'Angular',
  4201: 'Angular Alt',
  3306: 'MySQL',
  5432: 'PostgreSQL',
  6379: 'Redis',
  27017: 'MongoDB',
  9200: 'Elasticsearch',
  9300: 'ES Alt',
  1433: 'SQL Server',
  1521: 'Oracle',
  8000: 'HTTP Alt',
  8888: 'HTTP Alt',
  9000: 'SonarQube',
  9090: 'Prometheus',
  2181: 'ZooKeeper',
  9092: 'Kafka',
  5672: 'RabbitMQ',
  15672: 'RabbitMQ Mgmt',
}

interface PortManagerPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

export function PortManagerPanel({ onSendToChat }: PortManagerPanelProps) {

  const [ports, setPorts] = useState<PortInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [killingPort, setKillingPort] = useState<number | null>(null)
  const [confirmKill, setConfirmKill] = useState<number | null>(null)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const fetchPorts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await invoke<PortInfo[]>('port_list')
      setPorts(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPorts()
  }, [fetchPorts])

  const filteredPorts = useMemo(() => {
    if (!searchQuery.trim()) return ports
    const q = searchQuery.toLowerCase()
    return ports.filter(
      (p) =>
        String(p.port).includes(q) ||
        (p.processName ?? '').toLowerCase().includes(q) ||
        (p.address ?? '').toLowerCase().includes(q) ||
        (COMMON_PORT_NAMES[p.port]?.toLowerCase().includes(q) ?? false)
    )
  }, [ports, searchQuery])

  const handleKill = useCallback(
    async (port: number) => {
      setKillingPort(port)
      setConfirmKill(null)
      try {
        const result = await invoke<KillResult>('port_kill', { port })
        if (result.success) {
          setToast({ type: 'success', message: `已释放端口 ${port} (PID: ${result.pid})` })
          fetchPorts()
        } else {
          setToast({
            type: 'error',
            message: result.error ?? `释放端口 ${port} 失败`,
          })
        }
      } catch (e) {
        setToast({
          type: 'error',
          message: e instanceof Error ? e.message : String(e),
        })
      } finally {
        setKillingPort(null)
      }
    },
    [fetchPorts]
  )

  const handleSendToChat = useCallback(() => {
    if (!onSendToChat) return
    const summary = filteredPorts
      .map((p) => {
        const svc = COMMON_PORT_NAMES[p.port]
        return `:${p.port} (${p.processName}, PID:${p.pid})${svc ? ` [${svc}]` : ''}`
      })
      .join('\n')
    onSendToChat(`当前监听端口:\n${summary}`)
  }, [filteredPorts, onSendToChat])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(timer)
  }, [toast])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-text-secondary" />
          <span className="text-xs font-medium text-text-primary">Ports</span>
          <span className="text-[10px] text-text-tertiary bg-background-elevated px-1.5 py-0.5 rounded">
            {filteredPorts.length}/{ports.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onSendToChat && (
            <button
              onClick={handleSendToChat}
              className="p-1.5 rounded hover:bg-background-elevated text-text-secondary hover:text-text-primary transition-colors"
              title="发送到聊天"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={fetchPorts}
            disabled={loading}
            className="p-1.5 rounded hover:bg-background-elevated text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            title="刷新"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索端口、进程名..."
            className="w-full pl-7 pr-2 py-1.5 text-xs bg-background-elevated border border-border rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-red-400 bg-red-500/10 m-2 rounded">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && filteredPorts.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 text-text-tertiary">
            <Inbox className="w-8 h-8 mb-2 opacity-50" />
            <span className="text-xs">
              {ports.length === 0 ? '暂无监听端口' : '无匹配结果'}
            </span>
          </div>
        )}

        {filteredPorts.map((port, index) => {
          const isCommon = COMMON_DEV_PORTS.has(port.port)
          const serviceName = COMMON_PORT_NAMES[port.port]
          const isKilling = killingPort === port.port
          const isConfirming = confirmKill === port.port

          return (
            <div
              key={`${port.port}-${port.pid}-${index}`}
              className={`flex items-center gap-2 px-3 py-2 border-b border-border hover:bg-background-elevated/50 transition-colors group ${
                isCommon ? 'bg-primary/5' : ''
              }`}
            >
              {/* 端口号 */}
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className={`text-xs font-mono font-medium ${
                    isCommon ? 'text-primary' : 'text-text-primary'
                  }`}
                >
                  :{port.port}
                </span>
                {serviceName && (
                  <span className="text-[10px] text-primary/70 bg-primary/10 px-1 py-0.5 rounded shrink-0">
                    {serviceName}
                  </span>
                )}
              </div>

              {/* 进程信息 */}
              <div className="flex-1 min-w-0 text-right">
                <span className="text-[11px] text-text-secondary truncate block">
                  {port.processName}
                </span>
                <span className="text-[10px] text-text-tertiary">
                  PID:{port.pid} · {port.protocol}
                </span>
              </div>

              {/* 操作按钮 */}
              <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                {isConfirming ? (
                  <>
                    <button
                      onClick={() => handleKill(port.port)}
                      disabled={isKilling}
                      className="p-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors text-[10px]"
                    >
                      {isKilling ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        '确认'
                      )}
                    </button>
                    <button
                      onClick={() => setConfirmKill(null)}
                      className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-background-elevated transition-colors text-[10px]"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmKill(port.port)}
                    className="p-1 rounded text-text-tertiary hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="释放端口"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-4 right-4 flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg text-xs z-50 ${
            toast.type === 'success'
              ? 'bg-green-500/20 text-green-400 border border-green-500/30'
              : 'bg-red-500/20 text-red-400 border border-red-500/30'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle className="w-3.5 h-3.5" />
          ) : (
            <XCircle className="w-3.5 h-3.5" />
          )}
          {toast.message}
        </div>
      )}
    </div>
  )
}
