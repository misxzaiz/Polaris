import { useState, useCallback } from 'react'
import { Play, RefreshCw, GitPullRequest, CheckCircle, AlertTriangle } from 'lucide-react'

interface DataMigrationPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

interface Migration {
  id: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  timestamp: string
  description: string
}

export function DataMigrationPanel({ pluginId, onSendToChat }: DataMigrationPanelProps) {
  const [migrations, setMigrations] = useState<Migration[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [selectedMigration, setSelectedMigration] = useState<Migration | null>(null)

  const runMigration = useCallback(() => {
    setIsRunning(true)

    // 模拟迁移执行
    setTimeout(() => {
      const mockMigrations: Migration[] = [
        {
          id: 'migration-1',
          name: 'create_users_table',
          status: 'completed',
          timestamp: new Date().toISOString(),
          description: '创建用户表',
        },
        {
          id: 'migration-2',
          name: 'add_email_index',
          status: 'completed',
          timestamp: new Date().toISOString(),
          description: '为邮箱字段添加索引',
        },
        {
          id: 'migration-3',
          name: 'create_posts_table',
          status: 'running',
          timestamp: new Date().toISOString(),
          description: '创建文章表',
        },
      ]

      setMigrations(mockMigrations)
      setIsRunning(false)
    }, 2000)
  }, [])

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-green-500" />
      case 'running':
        return <RefreshCw className="w-4 h-4 text-blue-500 animate-spin" />
      case 'failed':
        return <AlertTriangle className="w-4 h-4 text-red-500" />
      default:
        return <GitPullRequest className="w-4 h-4 text-text-muted" />
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
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
    if (onSendToChat && migrations.length > 0) {
      const completed = migrations.filter(m => m.status === 'completed').length
      const running = migrations.filter(m => m.status === 'running').length
      const failed = migrations.filter(m => m.status === 'failed').length

      const message = `迁移执行报告：
总迁移数: ${migrations.length}
已完成: ${completed}
运行中: ${running}
失败: ${failed}

迁移列表:
${migrations.map(m => `- ${m.name}: ${m.status}`).join('\n')}`
      onSendToChat(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button
            onClick={runMigration}
            disabled={isRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isRunning ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isRunning ? '执行中...' : '执行迁移'}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          {migrations.length > 0 && (
            <button
              onClick={handleSendToChat}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-text-secondary bg-background-elevated border border-border rounded-md hover:bg-background-hover transition-colors"
            >
              发送报告
            </button>
          )}
        </div>
      </div>

      {/* 迁移列表 */}
      <div className="flex-1 overflow-y-auto p-3">
        {migrations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <GitPullRequest className="w-12 h-12 text-text-muted mb-3" />
            <div className="text-text-muted text-sm">点击"执行迁移"按钮</div>
            <div className="text-text-muted text-xs mt-1">管理数据库迁移</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-text-primary">
                <span className="font-medium">{migrations.length}</span> 个迁移
              </div>
            </div>
            
            {migrations.map((migration) => (
              <div
                key={migration.id}
                className={`p-3 border rounded-md cursor-pointer transition-colors ${
                  selectedMigration?.id === migration.id
                    ? 'bg-primary/10 border-primary/30'
                    : getStatusColor(migration.status)
                }`}
                onClick={() => setSelectedMigration(migration)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(migration.status)}
                    <div>
                      <div className="text-sm font-medium text-text-primary">{migration.name}</div>
                      <div className="text-xs text-text-muted mt-1">{migration.description}</div>
                    </div>
                  </div>
                  <div className="text-xs text-text-muted">{migration.status}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}