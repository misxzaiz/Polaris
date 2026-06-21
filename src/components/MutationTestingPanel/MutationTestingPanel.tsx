import { useState, useCallback } from 'react'
import { Play, RefreshCw, AlertTriangle, CheckCircle, XCircle } from 'lucide-react'

interface MutationTestingPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface Mutation {
  id: string
  type: string
  original: string
  mutated: string
  line: number
  status: 'killed' | 'survived' | 'timeout'
  testResult?: string
}

export function MutationTestingPanel({ pluginId, onSendToChat }: MutationTestingPanelProps) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _pluginId = pluginId
  const [code, setCode] = useState('')
  const [mutations, setMutations] = useState<Mutation[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [selectedMutation, setSelectedMutation] = useState<Mutation | null>(null)
  const [progress, setProgress] = useState(0)

  const runMutationTesting = useCallback(() => {
    if (!code.trim()) return

    setIsRunning(true)
    setProgress(0)
    setMutations([])

    // 模拟变异测试
    const mockMutations: Mutation[] = [
      {
        id: 'mut-1',
        type: '条件运算符替换',
        original: 'if (x > 0)',
        mutated: 'if (x >= 0)',
        line: 5,
        status: 'killed',
        testResult: '测试用例 "should handle positive numbers" 检测到变异',
      },
      {
        id: 'mut-2',
        type: '边界值变异',
        original: 'for (let i = 0; i < n; i++)',
        mutated: 'for (let i = 0; i <= n; i++)',
        line: 12,
        status: 'survived',
        testResult: '未检测到变异，需要增加边界测试',
      },
      {
        id: 'mut-3',
        type: '返回值变异',
        original: 'return true',
        mutated: 'return false',
        line: 20,
        status: 'killed',
        testResult: '测试用例 "should return true for valid input" 检测到变异',
      },
      {
        id: 'mut-4',
        type: '空值检查移除',
        original: 'if (obj !== null)',
        mutated: 'if (true)',
        line: 25,
        status: 'timeout',
        testResult: '测试超时，可能存在无限循环',
      },
      {
        id: 'mut-5',
        type: '数学运算符替换',
        original: 'sum += arr[i]',
        mutated: 'sum -= arr[i]',
        line: 30,
        status: 'killed',
        testResult: '测试用例 "should calculate sum correctly" 检测到变异',
      },
    ]

    let currentIndex = 0
    const interval = setInterval(() => {
      if (currentIndex < mockMutations.length) {
        setMutations(prev => [...prev, mockMutations[currentIndex]])
        setProgress(((currentIndex + 1) / mockMutations.length) * 100)
        currentIndex++
      } else {
        clearInterval(interval)
        setIsRunning(false)
      }
    }, 800)
  }, [code])

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'killed':
        return <CheckCircle className="w-4 h-4 text-green-500" />
      case 'survived':
        return <XCircle className="w-4 h-4 text-red-500" />
      case 'timeout':
        return <AlertTriangle className="w-4 h-4 text-yellow-500" />
      default:
        return null
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'killed':
        return 'bg-green-500/10 text-green-500 border-green-500/30'
      case 'survived':
        return 'bg-red-500/10 text-red-500 border-red-500/30'
      case 'timeout':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
      default:
        return 'bg-background-elevated text-text-primary border-border'
    }
  }

  const calculateScore = () => {
    if (mutations.length === 0) return 0
    const killed = mutations.filter(m => m.status === 'killed').length
    return Math.round((killed / mutations.length) * 100)
  }

  const handleSendToChat = () => {
    if (onSendToChat && mutations.length > 0) {
      const killed = mutations.filter(m => m.status === 'killed').length
      const survived = mutations.filter(m => m.status === 'survived').length
      const timeout = mutations.filter(m => m.status === 'timeout').length
      const score = calculateScore()

      const message = `变异测试报告：
变异分数: ${score}%
变异总数: ${mutations.length}

统计：
- 消除 (Killed): ${killed}
- 存活 (Survived): ${survived}
- 超时 (Timeout): ${timeout}

建议: ${score < 70 ? '测试质量较低，需要增加更多测试用例' : 
  score < 90 ? '测试质量良好，可以考虑增加边界条件测试' : 
  '测试质量优秀，测试用例覆盖全面'}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={runMutationTesting}
            disabled={isRunning || !code.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isRunning ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isRunning ? '运行中...' : '运行变异测试'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {mutations.length > 0 && (
            <>
              <div className="text-sm text-text-primary">
                变异分数: <span className="font-bold">{calculateScore()}%</span>
              </div>
              <button
                onClick={handleSendToChat}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
              >
                发送报告
              </button>
            </>
          )}
        </div>
      </div>

      {/* 进度条 */}
      {isRunning && (
        <div className="p-3 border-b border-border">
          <div className="flex items-center justify-between text-xs text-text-muted mb-1">
            <span>进度</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="w-full h-2 bg-background rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* 代码输入区 */}
      <div className="h-48 p-3 border-b border-border">
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="在此粘贴代码进行变异测试..."
          className="w-full h-full p-3 text-sm font-mono bg-background-elevated border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder-text-muted"
        />
      </div>

      {/* 变异测试结果 */}
      <div className="flex-1 overflow-y-auto p-3">
        {mutations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-text-muted text-sm">粘贴代码并点击"运行变异测试"按钮</div>
            <div className="text-text-muted text-xs mt-1">通过修改代码来验证测试用例的有效性</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-text-primary">
                发现 <span className="font-medium">{mutations.length}</span> 个变异
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-green-500">消除: {mutations.filter(m => m.status === 'killed').length}</span>
                <span className="text-red-500">存活: {mutations.filter(m => m.status === 'survived').length}</span>
                <span className="text-yellow-500">超时: {mutations.filter(m => m.status === 'timeout').length}</span>
              </div>
            </div>
            
            {mutations.map((mutation) => (
              <div
                key={mutation.id}
                className={`p-3 border rounded-md cursor-pointer transition-colors ${
                  selectedMutation?.id === mutation.id
                    ? 'bg-primary/10 border-primary/30'
                    : getStatusColor(mutation.status)
                }`}
                onClick={() => setSelectedMutation(mutation)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(mutation.status)}
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">{mutation.type}</span>
                        <span className="text-xs text-text-muted">行 {mutation.line}</span>
                      </div>
                      <div className="text-xs text-text-muted mt-1 font-mono">
                        原始: {mutation.original}
                      </div>
                      <div className="text-xs text-text-muted font-mono">
                        变异: {mutation.mutated}
                      </div>
                    </div>
                  </div>
                </div>
                
                {selectedMutation?.id === mutation.id && mutation.testResult && (
                  <div className="mt-2 p-2 bg-background rounded-md">
                    <div className="text-xs text-text-muted mb-1">测试结果</div>
                    <div className="text-xs text-text-secondary">{mutation.testResult}</div>
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