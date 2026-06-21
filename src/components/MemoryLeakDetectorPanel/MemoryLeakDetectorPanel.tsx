import { useState, useCallback } from 'react'
import { Play, RefreshCw, AlertTriangle, CheckCircle, Info } from 'lucide-react'

interface MemoryLeakDetectorPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface MemoryLeak {
  id: string
  type: string
  severity: 'high' | 'medium' | 'low'
  title: string
  description: string
  line: number
  code: string
  recommendation: string
}

export function MemoryLeakDetectorPanel({ pluginId, onSendToChat }: MemoryLeakDetectorPanelProps) {
  const [code, setCode] = useState('')
  const [leaks, setLeaks] = useState<MemoryLeak[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [selectedLeak, setSelectedLeak] = useState<MemoryLeak | null>(null)

  const scanCode = useCallback(() => {
    if (!code.trim()) return

    setIsScanning(true)

    // 模拟内存泄漏检测
    setTimeout(() => {
      const mockLeaks: MemoryLeak[] = [
        {
          id: 'leak-1',
          type: '事件监听器',
          severity: 'high',
          title: '未移除的事件监听器',
          description: '添加了事件监听器但未在组件卸载时移除',
          line: 15,
          code: 'window.addEventListener("resize", handleResize)',
          recommendation: '在组件卸载时使用removeEventListener移除监听器',
        },
        {
          id: 'leak-2',
          type: '定时器',
          severity: 'medium',
          title: '未清理的定时器',
          description: '创建了setInterval但未在组件卸载时清理',
          line: 25,
          code: 'setInterval(() => updateData(), 1000)',
          recommendation: '使用clearInterval清理定时器',
        },
        {
          id: 'leak-3',
          type: '闭包引用',
          severity: 'medium',
          title: '闭包引用大对象',
          description: '闭包引用了大对象，阻止垃圾回收',
          line: 35,
          code: 'const handler = () => console.log(largeData)',
          recommendation: '避免在闭包中引用大对象，或使用WeakRef',
        },
        {
          id: 'leak-4',
          type: 'DOM引用',
          severity: 'low',
          title: 'DOM元素引用未释放',
          description: '保持了DOM元素的引用但未在不需要时释放',
          line: 45,
          code: 'this.element = document.getElementById("container")',
          recommendation: '在不需要时将引用设置为null',
        },
      ]

      setLeaks(mockLeaks)
      setIsScanning(false)
    }, 1000)
  }, [code])

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'high':
        return 'bg-red-500/10 text-red-500 border-red-500/30'
      case 'medium':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
      default:
        return 'bg-blue-500/10 text-blue-500 border-blue-500/30'
    }
  }

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'high':
        return <AlertTriangle className="w-4 h-4 text-red-500" />
      case 'medium':
        return <Info className="w-4 h-4 text-yellow-500" />
      default:
        return <CheckCircle className="w-4 h-4 text-blue-500" />
    }
  }

  const handleSendToChat = () => {
    if (onSendToChat && leaks.length > 0) {
      const high = leaks.filter(l => l.severity === 'high').length
      const medium = leaks.filter(l => l.severity === 'medium').length

      const message = `内存泄漏检测报告：
发现 ${leaks.length} 个潜在内存泄漏

按严重程度：
- 高危 (High): ${high}
- 中危 (Medium): ${medium}

建议: ${high > 0 ? '存在高危内存泄漏，建议立即修复' : 
  medium > 0 ? '存在中危内存泄漏，建议优化' : 
  '内存使用情况良好'}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={scanCode}
            disabled={isScanning || !code.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isScanning ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isScanning ? '检测中...' : '检测内存泄漏'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {leaks.length > 0 && (
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
          placeholder="在此粘贴代码检测内存泄漏..."
          className="w-full h-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 检测结果 */}
      <div className="flex-1 overflow-y-auto p-3">
        {leaks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <AlertTriangle className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">粘贴代码并点击"检测内存泄漏"按钮</div>
            <div className="text-text-muted text-xs mt-1">检测事件监听器、定时器、闭包等内存泄漏</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-text-primary">
                发现 <span className="font-medium">{leaks.length}</span> 个潜在内存泄漏
              </div>
            </div>
            
            {leaks.map((leak) => (
              <div
                key={leak.id}
                className={`p-3 border rounded-md cursor-pointer transition-colors ${
                  selectedLeak?.id === leak.id
                    ? 'bg-primary/10 border-primary/30'
                    : getSeverityColor(leak.severity)
                }`}
                onClick={() => setSelectedLeak(leak)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-2">
                    {getSeverityIcon(leak.severity)}
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">{leak.title}</span>
                        <span className="text-xs text-text-muted">行 {leak.line}</span>
                      </div>
                      <div className="text-xs text-text-muted mt-1">{leak.description}</div>
                    </div>
                  </div>
                </div>
                
                {selectedLeak?.id === leak.id && (
                  <div className="mt-3 space-y-2">
                    <div className="p-2 bg-background rounded-md">
                      <div className="text-xs text-text-muted mb-1">问题代码</div>
                      <pre className="text-xs font-mono text-text-secondary overflow-x-auto">{leak.code}</pre>
                    </div>
                    <div className="p-2 bg-background rounded-md">
                      <div className="text-xs text-text-muted mb-1">修复建议</div>
                      <div className="text-xs text-text-secondary">{leak.recommendation}</div>
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