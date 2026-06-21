import { useState, useCallback } from 'react'
import { Play, RefreshCw, GitPullRequest, CheckCircle, AlertCircle, Clock } from 'lucide-react'

interface CiCdPipelinePanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface Pipeline {
  id: string
  name: string
  status: 'running' | 'success' | 'failed' | 'pending'
  branch: string
  commit: string
  duration: string
  stages: { name: string; status: string }[]
}

export function CiCdPipelinePanel({ pluginId, onSendToChat }: CiCdPipelinePanelProps) {
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null)

  const loadPipelines = useCallback(() => {
    setIsLoading(true)

    // 模拟加载管道数据
    setTimeout(() => {
      const mockPipelines: Pipeline[] = [
        {
          id: 'pipeline-1',
          name: 'Build and Test',
          status: 'success',
          branch: 'main',
          commit: 'a1b2c3d',
          duration: '2m 30s',
          stages: [
            { name: 'Checkout', status: 'success' },
            { name: 'Install', status: 'success' },
            { name: 'Test', status: 'success' },
            { name: 'Build', status: 'success' },
          ],
        },
        {
          id: 'pipeline-2',
          name: 'Deploy to Production',
          status: 'running',
          branch: 'main',
          commit: 'e4f5g6h',
          duration: '5m 15s',
          stages: [
            { name: 'Checkout', status: 'success' },
            { name: 'Build', status: 'success' },
            { name: 'Deploy', status: 'running' },
            { name: 'Verify', status: 'pending' },
          ],
        },
        {
          id: 'pipeline-3',
          name: 'Feature Branch Build',
          status: 'failed',
          branch: 'feature/new-feature',
          commit: 'i7j8k9l',
          duration: '1m 45s',
          stages: [
            { name: 'Checkout', status: 'success' },
            { name: 'Install', status: 'success' },
            { name: 'Test', status: 'failed' },
            { name: 'Build', status: 'pending' },
          ],
        },
      ]

      setPipelines(mockPipelines)
      setIsLoading(false)
    }, 1000)
  }, [])

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return <CheckCircle className="w-4 h-4 text-green-500" />
      case 'running':
        return <RefreshCw className="w-4 h-4 text-blue-500 animate-spin" />
      case 'failed':
        return <AlertCircle className="w-4 h-4 text-red-500" />
      default:
        return <Clock className="w-4 h-4 text-text-muted" />
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success':
        return 'bg-green-500/10 text-green-500 border-green-500/30'
      case 'running':
        return 'bg-blue-500/10 text-blue-500 border-blue-500/30'
      case 'failed':
        return 'bg-red-500/10 text-red-500 border-red-500/30'
      default:
        return 'bg-gray-500/10 text-gray-500 border-gray-500/30'
    }
  }

  const handleSendToChat = () => {
    if (onSendToChat && pipelines.length > 0) {
      const success = pipelines.filter(p => p.status === 'success').length
      const running = pipelines.filter(p => p.status === 'running').length
      const failed = pipelines.filter(p => p.status === 'failed').length

      const message = `CI/CD管道状态：
总管道数: ${pipelines.length}
- 成功: ${success}
- 运行中: ${running}
- 失败: ${failed}

管道列表:
${pipelines.map(p => `- ${p.name}: ${p.status} (${p.branch})`).join('\n')}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={loadPipelines}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isLoading ? '加载中...' : '刷新管道'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          <button
            onClick={handleSendToChat}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
          >
            发送状态
          </button>
        </div>
      </div>

      {/* 管道列表 */}
      <div className="flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-text-muted text-sm">加载管道数据...</div>
          </div>
        ) : pipelines.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <GitPullRequest className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">点击"刷新管道"加载CI/CD管道</div>
          </div>
        ) : (
          <div className="space-y-3">
            {pipelines.map((pipeline) => (
              <div
                key={pipeline.id}
                className={`p-3 border rounded-md cursor-pointer transition-colors ${
                  selectedPipeline?.id === pipeline.id
                    ? 'bg-primary/10 border-primary/30'
                    : getStatusColor(pipeline.status)
                }`}
                onClick={() => setSelectedPipeline(pipeline)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(pipeline.status)}
                    <div>
                      <div className="text-sm font-medium text-text-primary">{pipeline.name}</div>
                      <div className="text-xs text-text-muted mt-1">
                        {pipeline.branch} • {pipeline.commit} • {pipeline.duration}
                      </div>
                    </div>
                  </div>
                </div>

                {selectedPipeline?.id === pipeline.id && (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-text-muted mb-1">阶段</div>
                    {pipeline.stages.map((stage, index) => (
                      <div key={index} className="flex items-center gap-2 text-xs">
                        {getStatusIcon(stage.status)}
                        <span className="text-text-primary">{stage.name}</span>
                        <span className="text-text-muted">({stage.status})</span>
                      </div>
                    ))}
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