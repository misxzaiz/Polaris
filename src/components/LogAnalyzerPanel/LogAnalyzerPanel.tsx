import { useState, useCallback } from 'react'
import { Play, RefreshCw, Filter, Copy, Download } from 'lucide-react'

interface LogAnalyzerPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface LogEntry {
  timestamp: string
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'
  message: string
  source?: string
}

export function LogAnalyzerPanel({ pluginId, onSendToChat }: LogAnalyzerPanelProps) {
  const [logContent, setLogContent] = useState('')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [filterLevel, setFilterLevel] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const analyzeLogs = useCallback(() => {
    if (!logContent.trim()) return

    setIsAnalyzing(true)

    // 模拟日志分析
    setTimeout(() => {
      const mockLogs: LogEntry[] = [
        {
          timestamp: '2024-01-15 10:30:15',
          level: 'INFO',
          message: 'Application started successfully',
          source: 'main',
        },
        {
          timestamp: '2024-01-15 10:30:16',
          level: 'INFO',
          message: 'Database connection established',
          source: 'database',
        },
        {
          timestamp: '2024-01-15 10:30:20',
          level: 'WARN',
          message: 'High memory usage detected: 85%',
          source: 'monitor',
        },
        {
          timestamp: '2024-01-15 10:30:25',
          level: 'ERROR',
          message: 'Failed to connect to external API: Timeout',
          source: 'api-client',
        },
        {
          timestamp: '2024-01-15 10:30:30',
          level: 'INFO',
          message: 'Request processed successfully',
          source: 'http-server',
        },
        {
          timestamp: '2024-01-15 10:30:35',
          level: 'DEBUG',
          message: 'Cache hit for key: user_123',
          source: 'cache',
        },
      ]

      setLogs(mockLogs)
      setIsAnalyzing(false)
    }, 800)
  }, [logContent])

  const filteredLogs = logs.filter((log) => {
    const matchesLevel = filterLevel === 'all' || log.level === filterLevel
    const matchesSearch =
      searchQuery === '' ||
      log.message.toLowerCase().includes(searchQuery.toLowerCase())
    return matchesLevel && matchesSearch
  })

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'ERROR':
        return 'text-red-500 bg-red-500/10'
      case 'WARN':
        return 'text-yellow-500 bg-yellow-500/10'
      case 'INFO':
        return 'text-blue-500 bg-blue-500/10'
      case 'DEBUG':
        return 'text-gray-500 bg-gray-500/10'
      default:
        return 'text-gray-500 bg-gray-500/10'
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const handleSendToChat = () => {
    if (onSendToChat && logs.length > 0) {
      const stats = {
        total: logs.length,
        info: logs.filter((l) => l.level === 'INFO').length,
        warn: logs.filter((l) => l.level === 'WARN').length,
        error: logs.filter((l) => l.level === 'ERROR').length,
        debug: logs.filter((l) => l.level === 'DEBUG').length,
      }
      const message = `日志分析结果：
总日志数: ${stats.total}
- INFO: ${stats.info}
- WARN: ${stats.warn}
- ERROR: ${stats.error}
- DEBUG: ${stats.debug}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={analyzeLogs}
            disabled={isAnalyzing || !logContent.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isAnalyzing ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isAnalyzing ? '分析中...' : '分析日志'}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleSendToChat}
            disabled={logs.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Download className="w-4 h-4" />
            导出
          </button>
        </div>
      </div>

      {/* 输入区域 */}
      <div className="p-3 border-b border-border">
        <textarea
          value={logContent}
          onChange={(e) => setLogContent(e.target.value)}
          placeholder="粘贴日志内容..."
          className="w-full h-24 p-2 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 过滤器 */}
      {logs.length > 0 && (
        <div className="flex items-center gap-2 p-3 border-b border-border">
          <Filter className="w-4 h-4 text-text-muted" />
          <select
            value={filterLevel}
            onChange={(e) => setFilterLevel(e.target.value)}
            className="px-2 py-1 text-sm bg-background-elevated border border-border rounded-md text-text-primary"
          >
            <option value="all">所有级别</option>
            <option value="INFO">INFO</option>
            <option value="WARN">WARN</option>
            <option value="ERROR">ERROR</option>
            <option value="DEBUG">DEBUG</option>
          </select>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索日志..."
            className="flex-1 px-2 py-1 text-sm bg-background-elevated border border-border rounded-md text-text-primary placeholder-text-muted"
          />
        </div>
      )}

      {/* 日志列表 */}
      <div className="flex-1 overflow-y-auto p-3">
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-text-muted text-sm">
              {logs.length === 0 ? '粘贴日志内容并点击分析' : '没有匹配的日志'}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredLogs.map((log, index) => (
              <div
                key={index}
                className="p-2 bg-background-elevated border border-border rounded-md"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-muted">{log.timestamp}</span>
                    <span
                      className={`px-1.5 py-0.5 text-xs font-medium rounded ${getLevelColor(
                        log.level
                      )}`}
                    >
                      {log.level}
                    </span>
                    {log.source && (
                      <span className="text-xs text-text-muted">[{log.source}]</span>
                    )}
                  </div>
                  <button
                    onClick={() => copyToClipboard(log.message)}
                    className="p-1 text-text-muted hover:text-text-primary hover:bg-background-hover rounded transition-colors"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
                <div className="mt-1 text-sm text-text-primary">{log.message}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}