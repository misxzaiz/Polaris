import { useState, useCallback } from 'react'
import { Play, RefreshCw, AlertTriangle, Clock, Zap } from 'lucide-react'

interface PerformanceBottleneckPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface Bottleneck {
  id: string
  type: string
  title: string
  description: string
  impact: 'high' | 'medium' | 'low'
  suggestion: string
  estimatedImprovement: string
}

export function PerformanceBottleneckPanel({ pluginId, onSendToChat }: PerformanceBottleneckPanelProps) {
  const [code, setCode] = useState('')
  const [bottlenecks, setBottlenecks] = useState<Bottleneck[]>([])
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [selectedBottleneck, setSelectedBottleneck] = useState<Bottleneck | null>(null)

  const analyzeCode = useCallback(() => {
    if (!code.trim()) return

    setIsAnalyzing(true)

    // 模拟性能瓶颈分析
    setTimeout(() => {
      const mockBottlenecks: Bottleneck[] = [
        {
          id: 'bottleneck-1',
          type: '循环优化',
          title: '嵌套循环导致性能下降',
          description: '检测到多层嵌套循环，时间复杂度为O(n²)',
          impact: 'high',
          suggestion: '使用Map或Set数据结构替代嵌套循环，或将循环改为递归',
          estimatedImprovement: '性能提升50-80%',
        },
        {
          id: 'bottleneck-2',
          type: 'DOM操作',
          title: '频繁的DOM操作',
          description: '在循环中进行DOM操作，导致重绘重排',
          impact: 'high',
          suggestion: '使用DocumentFragment批量插入DOM节点',
          estimatedImprovement: '性能提升30-60%',
        },
        {
          id: 'bottleneck-3',
          type: '内存分配',
          title: '频繁创建临时对象',
          description: '在循环中创建大量临时对象，增加GC压力',
          impact: 'medium',
          suggestion: '复用对象或使用对象池模式',
          estimatedImprovement: '内存使用减少40-70%',
        },
        {
          id: 'bottleneck-4',
          type: '算法优化',
          title: '使用低效算法',
          description: '检测到低效的算法实现',
          impact: 'medium',
          suggestion: '使用更高效的算法，如二分查找替代线性查找',
          estimatedImprovement: '时间复杂度从O(n)降为O(log n)',
        },
      ]

      setBottlenecks(mockBottlenecks)
      setIsAnalyzing(false)
    }, 1200)
  }, [code])

  const getImpactColor = (impact: string) => {
    switch (impact) {
      case 'high':
        return 'bg-red-500/10 text-red-500 border-red-500/30'
      case 'medium':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
      default:
        return 'bg-green-500/10 text-green-500 border-green-500/30'
    }
  }

  const getImpactIcon = (impact: string) => {
    switch (impact) {
      case 'high':
        return <AlertTriangle className="w-4 h-4 text-red-500" />
      case 'medium':
        return <Clock className="w-4 h-4 text-yellow-500" />
      default:
        return <Zap className="w-4 h-4 text-green-500" />
    }
  }

  const handleSendToChat = () => {
    if (onSendToChat && bottlenecks.length > 0) {
      const highImpact = bottlenecks.filter(b => b.impact === 'high').length
      const message = `性能瓶颈分析报告：
发现 ${bottlenecks.length} 个性能瓶颈

按影响程度：
- 高影响: ${highImpact}
- 中影响: ${bottlenecks.filter(b => b.impact === 'medium').length}
- 低影响: ${bottlenecks.filter(b => b.impact === 'low').length}

建议: ${highImpact > 0 ? '存在高影响性能瓶颈，建议优先优化' : 
  '性能表现良好，可以进一步优化'}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={analyzeCode}
            disabled={isAnalyzing || !code.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isAnalyzing ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isAnalyzing ? '分析中...' : '分析瓶颈'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {bottlenecks.length > 0 && (
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
          placeholder="在此粘贴代码，分析性能瓶颈..."
          className="w-full h-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 分析结果 */}
      <div className="flex-1 overflow-y-auto p-3">
        {bottlenecks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <AlertTriangle className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">粘贴代码并点击"分析瓶颈"按钮</div>
            <div className="text-text-muted text-xs mt-1">分析代码性能瓶颈和优化机会</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-text-primary">
                发现 <span className="font-medium">{bottlenecks.length}</span> 个性能瓶颈
              </div>
            </div>
            
            {bottlenecks.map((bottleneck) => (
              <div
                key={bottleneck.id}
                className={`p-3 border rounded-md cursor-pointer transition-colors ${
                  selectedBottleneck?.id === bottleneck.id
                    ? 'bg-primary/10 border-primary/30'
                    : getImpactColor(bottleneck.impact)
                }`}
                onClick={() => setSelectedBottleneck(bottleneck)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-2">
                    {getImpactIcon(bottleneck.impact)}
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">{bottleneck.title}</span>
                        <span className={`px-1.5 py-0.5 text-xs rounded ${getImpactColor(bottleneck.impact)}`}>
                          {bottleneck.impact}
                        </span>
                      </div>
                      <div className="text-xs text-text-muted mt-1">{bottleneck.description}</div>
                    </div>
                  </div>
                </div>
                
                {selectedBottleneck?.id === bottleneck.id && (
                  <div className="mt-3 space-y-2">
                    <div className="p-2 bg-background rounded-md">
                      <div className="text-xs text-text-muted mb-1">优化建议</div>
                      <div className="text-xs text-text-secondary">{bottleneck.suggestion}</div>
                    </div>
                    <div className="p-2 bg-background rounded-md">
                      <div className="text-xs text-text-muted mb-1">预期改进</div>
                      <div className="text-xs text-green-500 font-medium">{bottleneck.estimatedImprovement}</div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}