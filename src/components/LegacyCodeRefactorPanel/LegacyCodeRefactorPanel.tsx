import { useState, useCallback } from 'react'
import { Play, RefreshCw, Code2, ArrowRight, CheckCircle } from 'lucide-react'

interface LegacyCodeRefactorPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface LegacyCodeIssue {
  id: string
  type: string
  title: string
  description: string
  originalCode: string
  modernCode: string
  priority: 'high' | 'medium' | 'low'
  effort: 'small' | 'medium' | 'large'
}

export function LegacyCodeRefactorPanel({ pluginId, onSendToChat }: LegacyCodeRefactorPanelProps) {
  const [code, setCode] = useState('')
  const [issues, setIssues] = useState<LegacyCodeIssue[]>([])
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [selectedIssue, setSelectedIssue] = useState<LegacyCodeIssue | null>(null)

  const analyzeLegacyCode = useCallback(() => {
    if (!code.trim()) return

    setIsAnalyzing(true)

    // 模拟遗留代码分析
    setTimeout(() => {
      const mockIssues: LegacyCodeIssue[] = [
        {
          id: 'legacy-1',
          type: '过时语法',
          title: '使用var声明变量',
          description: '使用var声明变量，建议使用const或let',
          originalCode: 'var x = 10;\nvar y = 20;',
          modernCode: 'const x = 10;\nconst y = 20;',
          priority: 'medium',
          effort: 'small',
        },
        {
          id: 'legacy-2',
          type: '回调地狱',
          title: '嵌套回调函数',
          description: '存在多层嵌套回调，建议使用Promise或async/await',
          originalCode: 'getData(function(a) {\n  getMoreData(a, function(b) {\n    getEvenMoreData(b, function(c) {\n      console.log(c);\n    });\n  });\n});',
          modernCode: 'const a = await getData();\nconst b = await getMoreData(a);\nconst c = await getEvenMoreData(b);\nconsole.log(c);',
          priority: 'high',
          effort: 'medium',
        },
        {
          id: 'legacy-3',
          type: '原型污染',
          title: '直接修改原型',
          description: '直接修改对象原型，可能导致不可预期的行为',
          originalCode: 'Array.prototype.myMethod = function() {\n  // ...\n};',
          modernCode: 'const myMethod = (arr) => {\n  // ...\n};\n\nmyMethod(array);',
          priority: 'high',
          effort: 'medium',
        },
        {
          id: 'legacy-4',
          type: '全局变量',
          title: '使用全局变量',
          description: '使用全局变量可能导致命名冲突和难以维护',
          originalCode: 'var globalVar = "global";\nfunction useGlobal() {\n  console.log(globalVar);\n}',
          modernCode: 'const config = {\n  globalVar: "global"\n};\n\nfunction useGlobal() {\n  console.log(config.globalVar);\n}',
          priority: 'medium',
          effort: 'small',
        },
      ]

      setIssues(mockIssues)
      setIsAnalyzing(false)
    }, 1200)
  }, [code])

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high':
        return 'bg-red-500/10 text-red-500 border-red-500/30'
      case 'medium':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
      default:
        return 'bg-green-500/10 text-green-500 border-green-500/30'
    }
  }

  const getEffortColor = (effort: string) => {
    switch (effort) {
      case 'large':
        return 'bg-red-500/10 text-red-500 border-red-500/30'
      case 'medium':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
      default:
        return 'bg-green-500/10 text-green-500 border-green-500/30'
    }
  }

  const handleSendToChat = () => {
    if (onSendToChat && issues.length > 0) {
      const highPriority = issues.filter(i => i.priority === 'high').length
      const message = `遗留代码分析报告：
发现 ${issues.length} 个遗留代码问题

按优先级：
- 高优先级: ${highPriority}
- 中优先级: ${issues.filter(i => i.priority === 'medium').length}
- 低优先级: ${issues.filter(i => i.priority === 'low').length}

建议: ${highPriority > 0 ? '存在高优先级遗留代码问题，建议立即重构' : 
  '代码相对现代，可以逐步优化'}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={analyzeLegacyCode}
            disabled={isAnalyzing || !code.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isAnalyzing ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Code2 className="w-4 h-4" />
            )}
            {isAnalyzing ? '分析中...' : '分析遗留代码'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {issues.length > 0 && (
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
          placeholder="在此粘贴遗留代码，获取现代化改造建议..."
          className="w-full h-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 分析结果 */}
      <div className="flex-1 overflow-y-auto p-3">
        {issues.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Code2 className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">粘贴遗留代码并点击"分析遗留代码"按钮</div>
            <div className="text-text-muted text-xs mt-1">获取代码现代化改造建议</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-text-primary">
                发现 <span className="font-medium">{issues.length}</span> 个遗留代码问题
              </div>
            </div>
            
            {issues.map((issue) => (
              <div
                key={issue.id}
                className={`p-3 border rounded-md cursor-pointer transition-colors ${
                  selectedIssue?.id === issue.id
                    ? 'bg-primary/10 border-primary/30'
                    : 'bg-background-elevated border-border hover:border-border-hover'
                }`}
                onClick={() => setSelectedIssue(issue)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-2">
                    <CheckCircle className="w-4 h-4 mt-0.5 text-yellow-500" />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">{issue.title}</span>
                        <span className={`px-1.5 py-0.5 text-xs rounded ${getPriorityColor(issue.priority)}`}>
                          {issue.priority}
                        </span>
                        <span className={`px-1.5 py-0.5 text-xs rounded ${getEffortColor(issue.effort)}`}>
                          {issue.effort}
                        </span>
                      </div>
                      <div className="text-xs text-text-muted mt-1">{issue.description}</div>
                    </div>
                  </div>
                </div>
                
                {selectedIssue?.id === issue.id && (
                  <div className="mt-3 space-y-2">
                    <div className="p-2 bg-background rounded-md">
                      <div className="text-xs text-text-muted mb-1">遗留代码</div>
                      <pre className="text-xs font-mono text-red-500 overflow-x-auto">{issue.originalCode}</pre>
                    </div>
                    <div className="flex justify-center">
                      <ArrowRight className="w-4 h-4 text-text-muted" />
                    </div>
                    <div className="p-2 bg-background rounded-md">
                      <div className="text-xs text-text-muted mb-1">现代代码</div>
                      <pre className="text-xs font-mono text-green-500 overflow-x-auto">{issue.modernCode}</pre>
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