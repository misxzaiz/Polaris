import { useState, useCallback } from 'react'
import { Play, RefreshCw } from 'lucide-react'

interface ComplexityAnalyzerPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface ComplexityResult {
  file: string
  cyclomaticComplexity: number
  cognitiveComplexity: number
  linesOfCode: number
  maintainabilityIndex: number
}

export function ComplexityAnalyzerPanel({ pluginId, onSendToChat }: ComplexityAnalyzerPanelProps) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _pluginId = pluginId
  const [code, setCode] = useState('')
  const [results, setResults] = useState<ComplexityResult[]>([])
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [selectedLanguage, setSelectedLanguage] = useState('javascript')

  const analyzeComplexity = useCallback(() => {
    if (!code.trim()) return

    setIsAnalyzing(true)

    // 模拟复杂度分析
    setTimeout(() => {
      const lines = code.split('\n')
      const linesOfCode = lines.length

      // 简单的圈复杂度计算
      let cyclomaticComplexity = 1
      const keywords = ['if', 'else', 'for', 'while', 'switch', 'case', 'catch', '&&', '||', '?']
      lines.forEach(line => {
        keywords.forEach(keyword => {
          if (line.includes(keyword)) {
            cyclomaticComplexity++
          }
        })
      })

      // 简单的认知复杂度计算
      let cognitiveComplexity = 0
      let nestingLevel = 0
      lines.forEach(line => {
        const trimmed = line.trim()
        if (trimmed.startsWith('if') || trimmed.startsWith('for') || trimmed.startsWith('while')) {
          nestingLevel++
          cognitiveComplexity += nestingLevel
        } else if (trimmed === '}') {
          nestingLevel = Math.max(0, nestingLevel - 1)
        }
      })

      // 可维护性指数计算
      const maintainabilityIndex = Math.max(0, Math.min(100, 
        100 - cyclomaticComplexity * 2 - cognitiveComplexity * 1.5 - linesOfCode * 0.1
      ))

      const result: ComplexityResult = {
        file: `selected-code.${selectedLanguage}`,
        cyclomaticComplexity,
        cognitiveComplexity,
        linesOfCode,
        maintainabilityIndex: Math.round(maintainabilityIndex),
      }

      setResults([result])
      setIsAnalyzing(false)
    }, 500)
  }, [code, selectedLanguage])

  const handleSendToChat = () => {
    if (onSendToChat && results.length > 0) {
      const result = results[0]
      const message = `代码复杂度分析结果：
圈复杂度: ${result.cyclomaticComplexity}
认知复杂度: ${result.cognitiveComplexity}
代码行数: ${result.linesOfCode}
可维护性指数: ${result.maintainabilityIndex}/100

建议：${result.cyclomaticComplexity > 10 ? '代码复杂度过高，建议重构' : 
  result.cognitiveComplexity > 15 ? '认知复杂度较高，建议简化逻辑' : 
  '代码复杂度在可接受范围内'}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 头部工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <select
            value={selectedLanguage}
            onChange={(e) => setSelectedLanguage(e.target.value)}
            className="px-2 py-1 text-sm bg-background-elevated border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary text-text-primary"
          >
            <option value="javascript">JavaScript</option>
            <option value="typescript">TypeScript</option>
            <option value="python">Python</option>
            <option value="java">Java</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={analyzeComplexity}
            disabled={isAnalyzing || !code.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isAnalyzing ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isAnalyzing ? '分析中...' : '分析'}
          </button>
        </div>
      </div>

      {/* 代码输入区 */}
      <div className="flex-1 p-3 border-b border-border">
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="在此粘贴代码进行分析..."
          className="w-full h-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 分析结果 */}
      <div className="flex-1 overflow-y-auto p-3">
        {results.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-text-muted text-sm">粘贴代码并点击"分析"按钮</div>
            <div className="text-text-muted text-xs mt-1">支持 JavaScript、TypeScript、Python、Java</div>
          </div>
        ) : (
          <div className="space-y-3">
            {results.map((result, index) => (
              <div key={index} className="p-3 bg-background-elevated border border-border rounded-md">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-medium text-text-primary">{result.file}</div>
                  <button
                    onClick={handleSendToChat}
                    className="text-xs text-primary hover:text-primary/80"
                  >
                    发送到聊天
                  </button>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-2 bg-background rounded-md">
                    <div className="text-xs text-text-muted">圈复杂度</div>
                    <div className={`text-lg font-bold ${
                      result.cyclomaticComplexity > 10 ? 'text-red-500' : 
                      result.cyclomaticComplexity > 5 ? 'text-yellow-500' : 'text-green-500'
                    }`}>
                      {result.cyclomaticComplexity}
                    </div>
                  </div>
                  
                  <div className="p-2 bg-background rounded-md">
                    <div className="text-xs text-text-muted">认知复杂度</div>
                    <div className={`text-lg font-bold ${
                      result.cognitiveComplexity > 15 ? 'text-red-500' : 
                      result.cognitiveComplexity > 8 ? 'text-yellow-500' : 'text-green-500'
                    }`}>
                      {result.cognitiveComplexity}
                    </div>
                  </div>
                  
                  <div className="p-2 bg-background rounded-md">
                    <div className="text-xs text-text-muted">代码行数</div>
                    <div className="text-lg font-bold text-text-primary">{result.linesOfCode}</div>
                  </div>
                  
                  <div className="p-2 bg-background rounded-md">
                    <div className="text-xs text-text-muted">可维护性指数</div>
                    <div className={`text-lg font-bold ${
                      result.maintainabilityIndex < 40 ? 'text-red-500' : 
                      result.maintainabilityIndex < 70 ? 'text-yellow-500' : 'text-green-500'
                    }`}>
                      {result.maintainabilityIndex}/100
                    </div>
                  </div>
                </div>
                
                <div className="mt-3 p-2 bg-background rounded-md">
                  <div className="text-xs text-text-muted mb-1">评估建议</div>
                  <div className="text-sm text-text-primary">
                    {result.cyclomaticComplexity > 10 ? '代码复杂度过高，建议拆分函数' : 
                     result.cognitiveComplexity > 15 ? '认知复杂度较高，建议简化条件逻辑' : 
                     '代码复杂度在可接受范围内'}
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