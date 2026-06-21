import { useState, useCallback } from 'react'
import { Play, RefreshCw, CheckSquare, AlertCircle, AlertTriangle, Info } from 'lucide-react'

interface CodeReviewAssistantPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface ReviewIssue {
  id: string
  type: 'error' | 'warning' | 'info'
  message: string
  line?: number
  suggestion?: string
}

export function CodeReviewAssistantPanel({
  pluginId,
  onSendToChat,
}: CodeReviewAssistantPanelProps) {
  const [code, setCode] = useState('')
  const [issues, setIssues] = useState<ReviewIssue[]>([])
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [selectedIssue, setSelectedIssue] = useState<ReviewIssue | null>(null)

  const analyzeCode = useCallback(() => {
    if (!code.trim()) return

    setIsAnalyzing(true)

    // 模拟代码审查
    setTimeout(() => {
      const mockIssues: ReviewIssue[] = [
        {
          id: 'issue-1',
          type: 'error',
          message: '未处理的 Promise rejection',
          line: 15,
          suggestion: '添加 try-catch 或 .catch() 处理',
        },
        {
          id: 'issue-2',
          type: 'warning',
          message: '变量未使用',
          line: 23,
          suggestion: '删除未使用的变量或在代码中使用它',
        },
        {
          id: 'issue-3',
          type: 'warning',
          message: '函数参数过多',
          line: 45,
          suggestion: '考虑使用对象封装参数',
        },
        {
          id: 'issue-4',
          type: 'info',
          message: '可以使用可选链操作符',
          line: 67,
          suggestion: '使用 ?. 替代 && 链式调用',
        },
        {
          id: 'issue-5',
          type: 'info',
          message: '建议添加类型注解',
          line: 89,
          suggestion: '为函数参数和返回值添加 TypeScript 类型',
        },
      ]

      setIssues(mockIssues)
      setIsAnalyzing(false)
    }, 1000)
  }, [code])

  const getIssueIcon = (type: string) => {
    switch (type) {
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-500" />
      case 'warning':
        return <AlertTriangle className="w-4 h-4 text-yellow-500" />
      case 'info':
        return <Info className="w-4 h-4 text-blue-500" />
      default:
        return <Info className="w-4 h-4 text-gray-500" />
    }
  }

  const getIssueColor = (type: string) => {
    switch (type) {
      case 'error':
        return 'bg-red-500/10 text-red-500 border-red-500/30'
      case 'warning':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
      case 'info':
        return 'bg-blue-500/10 text-blue-500 border-blue-500/30'
      default:
        return 'bg-gray-500/10 text-gray-500 border-gray-500/30'
    }
  }

  const handleSendToChat = () => {
    if (onSendToChat && issues.length > 0) {
      const stats = {
        total: issues.length,
        errors: issues.filter((i) => i.type === 'error').length,
        warnings: issues.filter((i) => i.type === 'warning').length,
        info: issues.filter((i) => i.type === 'info').length,
      }
      const message = `代码审查结果：
总问题数: ${stats.total}
- 错误: ${stats.errors}
- 警告: ${stats.warnings}
- 建议: ${stats.info}`
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
            {isAnalyzing ? '分析中...' : '开始审查'}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleSendToChat}
            disabled={issues.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            导出报告
          </button>
        </div>
      </div>

      {/* 输入区域 */}
      <div className="p-3 border-b border-border">
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="粘贴代码进行审查..."
          className="w-full h-32 p-2 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 问题列表 */}
      <div className="flex-1 overflow-y-auto p-3">
        {issues.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <CheckSquare className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">
              {isAnalyzing ? '分析代码中...' : '粘贴代码并点击"开始审查"'}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {issues.map((issue) => (
              <div
                key={issue.id}
                className={`p-3 border rounded-md cursor-pointer transition-colors ${
                  selectedIssue?.id === issue.id
                    ? 'bg-primary/10 border-primary/30'
                    : getIssueColor(issue.type)
                }`}
                onClick={() => setSelectedIssue(issue)}
              >
                <div className="flex items-start gap-2">
                  {getIssueIcon(issue.type)}
                  <div className="flex-1">
                    <div className="text-sm text-text-primary">{issue.message}</div>
                    {issue.line && (
                      <div className="text-xs text-text-muted mt-1">行 {issue.line}</div>
                    )}
                    {selectedIssue?.id === issue.id && issue.suggestion && (
                      <div className="mt-2 p-2 bg-background rounded-md text-xs text-text-secondary">
                        建议: {issue.suggestion}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}