import { useState, useCallback } from 'react'
import { Play, RefreshCw, Clock, Zap, AlertTriangle } from 'lucide-react'

interface PerformanceProfilerPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface PerformanceMetric {
  name: string
  value: number
  unit: string
  status: 'good' | 'warning' | 'critical'
  description: string
}

interface ProfilerResult {
  metrics: PerformanceMetric[]
  suggestions: string[]
}

export function PerformanceProfilerPanel({ pluginId, onSendToChat }: PerformanceProfilerPanelProps) {
  const [code, setCode] = useState('')
  const [result, setResult] = useState<ProfilerResult | null>(null)
  const [isProfiling, setIsProfiling] = useState(false)

  const profileCode = useCallback(() => {
    if (!code.trim()) return

    setIsProfiling(true)

    // 模拟性能分析
    setTimeout(() => {
      const mockResult: ProfilerResult = {
        metrics: [
          {
            name: '执行时间',
            value: 45.2,
            unit: 'ms',
            status: 'good',
            description: '代码执行时间在可接受范围内',
          },
          {
            name: '内存使用',
            value: 12.5,
            unit: 'MB',
            status: 'warning',
            description: '内存使用较高，可能存在内存泄漏',
          },
          {
            name: 'CPU使用率',
            value: 35,
            unit: '%',
            status: 'good',
            description: 'CPU使用率正常',
          },
          {
            name: '函数调用次数',
            value: 1250,
            unit: '次',
            status: 'warning',
            description: '函数调用次数较多，考虑优化循环',
          },
          {
            name: '垃圾回收',
            value: 8,
            unit: '次',
            status: 'critical',
            description: '垃圾回收频繁，影响性能',
          },
        ],
        suggestions: [
          '使用缓存减少重复计算',
          '避免在循环中创建新对象',
          '使用Web Worker处理CPU密集型任务',
          '优化DOM操作，减少重绘重排',
          '使用懒加载减少初始加载时间',
        ],
      }

      setResult(mockResult)
      setIsProfiling(false)
    }, 1500)
  }, [code])

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'critical':
        return 'bg-red-500/10 text-red-500 border-red-500/30'
      case 'warning':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
      default:
        return 'bg-green-500/10 text-green-500 border-green-500/30'
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'critical':
        return <AlertTriangle className="w-4 h-4 text-red-500" />
      case 'warning':
        return <Clock className="w-4 h-4 text-yellow-500" />
      default:
        return <Zap className="w-4 h-4 text-green-500" />
    }
  }

  const handleSendToChat = () => {
    if (onSendToChat && result) {
      const criticalMetrics = result.metrics.filter(m => m.status === 'critical')
      const warningMetrics = result.metrics.filter(m => m.status === 'warning')

      const message = `性能分析报告：
性能指标:
${result.metrics.map(m => `- ${m.name}: ${m.value}${m.unit} (${m.status})`).join('\n')}

优化建议:
${result.suggestions.map(s => `- ${s}`).join('\n')}

总结: ${criticalMetrics.length > 0 ? '存在严重性能问题' : 
  warningMetrics.length > 0 ? '存在性能警告，建议优化' : 
  '性能表现良好'}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={profileCode}
            disabled={isProfiling || !code.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isProfiling ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isProfiling ? '分析中...' : '性能分析'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {result && (
            <button
              onClick={handleSendToChat}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
            >
              发送报告
            </button>
          )}
        </div>
      </div>

      {/* 代码输入区 */}
      <div className="h-48 p-3 border-b border-border">
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="在此粘贴代码进行性能分析..."
          className="w-full h-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 分析结果 */}
      <div className="flex-1 overflow-y-auto p-3">
        {!result ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Zap className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">粘贴代码并点击"性能分析"按钮</div>
            <div className="text-text-muted text-xs mt-1">分析代码执行性能和资源使用</div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* 性能指标 */}
            <div className="space-y-2">
              <div className="text-sm text-text-primary mb-2">性能指标</div>
              {result.metrics.map((metric, index) => (
                <div
                  key={index}
                  className={`p-3 border rounded-md ${getStatusColor(metric.status)}`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-2">
                      {getStatusIcon(metric.status)}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-text-primary">{metric.name}</span>
                          <span className="text-lg font-bold">{metric.value}{metric.unit}</span>
                        </div>
                        <div className="text-xs text-text-muted mt-1">{metric.description}</div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* 优化建议 */}
            <div className="space-y-2">
              <div className="text-sm text-text-primary mb-2">优化建议</div>
              {result.suggestions.map((suggestion, index) => (
                <div
                  key={index}
                  className="p-2 bg-background-elevated border border-border rounded-md"
                >
                  <div className="text-xs text-text-secondary">{suggestion}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}