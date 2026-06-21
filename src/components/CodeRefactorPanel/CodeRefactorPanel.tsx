import { useState, useCallback } from 'react'
import { Play, RefreshCw, Code2, ArrowRight, CheckCircle } from 'lucide-react'

interface CodeRefactorPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface RefactorSuggestion {
  id: string
  type: string
  title: string
  description: string
  originalCode: string
  refactoredCode: string
  impact: 'low' | 'medium' | 'high'
  difficulty: 'easy' | 'medium' | 'hard'
}

export function CodeRefactorPanel({ pluginId, onSendToChat }: CodeRefactorPanelProps) {
  const [code, setCode] = useState('')
  const [suggestions, setSuggestions] = useState<RefactorSuggestion[]>([])
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [selectedSuggestion, setSelectedSuggestion] = useState<RefactorSuggestion | null>(null)

  const analyzeCode = useCallback(() => {
    if (!code.trim()) return

    setIsAnalyzing(true)

    // 模拟代码分析
    setTimeout(() => {
      const mockSuggestions: RefactorSuggestion[] = [
        {
          id: 'refactor-1',
          type: '提取函数',
          title: '提取重复代码为函数',
          description: '检测到重复代码块，建议提取为独立函数',
          originalCode: 'for (let i = 0; i < items.length; i++) {\n  console.log(items[i].name);\n  // ... 重复逻辑\n}',
          refactoredCode: 'function processItem(item) {\n  console.log(item.name);\n  // ... 重复逻辑\n}\n\nitems.forEach(processItem);',
          impact: 'medium',
          difficulty: 'easy',
        },
        {
          id: 'refactor-2',
          type: '简化条件',
          title: '简化复杂条件表达式',
          description: '条件表达式过于复杂，建议简化',
          originalCode: 'if (a > 0 && b < 10 && c === "test" && d !== null) {\n  // ...\n}',
          refactoredCode: 'const isValid = a > 0 && b < 10 && c === "test" && d !== null;\nif (isValid) {\n  // ...\n}',
          impact: 'low',
          difficulty: 'easy',
        },
        {
          id: 'refactor-3',
          type: '使用现代语法',
          title: '使用ES6+语法',
          description: '可以使用更现代的JavaScript语法',
          originalCode: 'var self = this;\nvar that = this;\nfunction() {\n  var x = arguments[0];\n}',
          refactoredCode: 'const x = args[0];\n// 使用箭头函数自动绑定this',
          impact: 'low',
          difficulty: 'medium',
        },
        {
          id: 'refactor-4',
          type: '错误处理',
          title: '改善错误处理',
          description: '错误处理不完善，建议添加更详细的错误处理',
          originalCode: 'try {\n  // ... risky operation\n} catch (e) {\n  console.error(e);\n}',
          refactoredCode: 'try {\n  // ... risky operation\n} catch (error) {\n  if (error instanceof ValidationError) {\n    // 处理验证错误\n  } else if (error instanceof NetworkError) {\n    // 处理网络错误\n  } else {\n    // 处理其他错误\n    logger.error("Unexpected error:", error);\n  }\n}',
          impact: 'high',
          difficulty: 'medium',
        },
      ]

      setSuggestions(mockSuggestions)
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

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
      case 'hard':
        return 'bg-red-500/10 text-red-500 border-red-500/30'
      case 'medium':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
      default:
        return 'bg-green-500/10 text-green-500 border-green-500/30'
    }
  }

  const handleSendToChat = () => {
    if (onSendToChat && suggestions.length > 0) {
      const highImpact = suggestions.filter(s => s.impact === 'high').length
      const message = `代码重构建议：
发现 ${suggestions.length} 个重构建议

按影响程度：
- 高影响: ${highImpact}
- 中影响: ${suggestions.filter(s => s.impact === 'medium').length}
- 低影响: ${suggestions.filter(s => s.impact === 'low').length}

建议: ${highImpact > 0 ? '存在高影响重构，建议优先处理' : 
  '代码结构良好，可以考虑优化'}`
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
              <Code2 className="w-4 h-4" />
            )}
            {isAnalyzing ? '分析中...' : '分析代码'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {suggestions.length > 0 && (
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
          placeholder="在此粘贴代码，获取重构建议..."
          className="w-full h-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 重构建议 */}
      <div className="flex-1 overflow-y-auto p-3">
        {suggestions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Code2 className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">粘贴代码并点击"分析代码"按钮</div>
            <div className="text-text-muted text-xs mt-1">获取代码重构和优化建议</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-text-primary">
                发现 <span className="font-medium">{suggestions.length}</span> 个重构建议
              </div>
            </div>
            
            {suggestions.map((suggestion) => (
              <div
                key={suggestion.id}
                className={`p-3 border rounded-md cursor-pointer transition-colors ${
                  selectedSuggestion?.id === suggestion.id
                    ? 'bg-primary/10 border-primary/30'
                    : 'bg-background-elevated border-border hover:border-border-hover'
                }`}
                onClick={() => setSelectedSuggestion(suggestion)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-2">
                    <CheckCircle className="w-4 h-4 mt-0.5 text-green-500" />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">{suggestion.title}</span>
                        <span className={`px-1.5 py-0.5 text-xs rounded ${getImpactColor(suggestion.impact)}`}>
                          {suggestion.impact}
                        </span>
                        <span className={`px-1.5 py-0.5 text-xs rounded ${getDifficultyColor(suggestion.difficulty)}`}>
                          {suggestion.difficulty}
                        </span>
                      </div>
                      <div className="text-xs text-text-muted mt-1">{suggestion.description}</div>
                    </div>
                  </div>
                </div>
                
                {selectedSuggestion?.id === suggestion.id && (
                  <div className="mt-3 space-y-2">
                    <div className="p-2 bg-background rounded-md">
                      <div className="text-xs text-text-muted mb-1">原始代码</div>
                      <pre className="text-xs font-mono text-text-secondary overflow-x-auto">{suggestion.originalCode}</pre>
                    </div>
                    <div className="flex justify-center">
                      <ArrowRight className="w-4 h-4 text-text-muted" />
                    </div>
                    <div className="p-2 bg-background rounded-md">
                      <div className="text-xs text-text-muted mb-1">重构后代码</div>
                      <pre className="text-xs font-mono text-green-500 overflow-x-auto">{suggestion.refactoredCode}</pre>
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