/**
 * 会话历史面板
 *
 * 显示所有历史会话（localStorage + IFlow + Claude Code 原生），支持恢复和删除
 */

import { useState, useEffect } from 'react'
import { useEventChatStore, type UnifiedHistoryItem } from '../../stores/eventChatStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { Clock, MessageSquare, Trash2, RotateCcw, HardDrive, Zap, Loader2, X, Terminal } from 'lucide-react'

interface SessionHistoryPanelProps {
  onClose?: () => void
}

export function SessionHistoryPanel({ onClose }: SessionHistoryPanelProps) {
  const [history, setHistory] = useState<UnifiedHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'claude-code' | 'iflow' | 'deepseek' | 'codex'>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const currentWorkspace = useWorkspaceStore(state => state.getCurrentWorkspace())

  // 加载历史会话
  useEffect(() => {
    loadHistory()
  }, [currentWorkspace])

  const loadHistory = async () => {
    setLoading(true)
    try {
      const items = await useEventChatStore.getState().getUnifiedHistory()
      setHistory(items)
    } catch (e) {
      console.error('[SessionHistoryPanel] 加载历史失败:', e)
    } finally {
      setLoading(false)
    }
  }

  // 恢复会话
  const handleRestore = async (sessionId: string, engineId: 'claude-code' | 'iflow' | 'deepseek' | 'codex') => {
    setRestoring(sessionId)
    try {
      const success = await useEventChatStore.getState().restoreFromHistory(sessionId, engineId)
      if (success) {
        console.log('[SessionHistoryPanel] 会话已恢复:', sessionId)
        onClose?.()
      } else {
        console.error('[SessionHistoryPanel] 恢复会话失败')
      }
    } catch (e) {
      console.error('[SessionHistoryPanel] 恢复会话出错:', e)
    } finally {
      setRestoring(null)
    }
  }

  // 删除会话
  const handleDelete = (sessionId: string, source: 'local' | 'iflow' | 'claude-code-native' | 'codex') => {
    useEventChatStore.getState().deleteHistorySession(sessionId, source === 'local' ? 'local' : undefined)
    setHistory(prev => prev.filter(h => h.id !== sessionId))
  }

  // 格式化时间
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return '刚刚'
    if (diffMins < 60) return `${diffMins} 分钟前`
    if (diffHours < 24) return `${diffHours} 小时前`
    if (diffDays < 7) return `${diffDays} 天前`

    return date.toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
    })
  }

  // 获取引擎信息
  const getEngineInfo = (engineId: 'claude-code' | 'iflow' | 'deepseek' | 'codex', source: string) => {
    if (source === 'claude-code-native') {
      return {
        name: 'Claude Code',
        color: 'text-blue-500',
        bgColor: 'bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300',
        icon: HardDrive,
      }
    }
    if (engineId === 'iflow') {
      return {
        name: 'IFlow',
        color: 'text-purple-500',
        bgColor: 'bg-purple-100 text-purple-600 dark:bg-purple-900 dark:text-purple-300',
        icon: Zap,
      }
    }
    if (engineId === 'codex') {
      return {
        name: 'Codex',
        color: 'text-green-500',
        bgColor: 'bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-300',
        icon: Terminal,
      }
    }
    return {
      name: 'Claude Code',
      color: 'text-blue-500',
      bgColor: 'bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300',
      icon: HardDrive,
    }
  }

  // 过滤历史
  const filteredHistory = history.filter(item => {
    if (filter !== 'all' && item.engineId !== filter) return false
    if (searchQuery && !item.title.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false
    }
    return true
  })

  // 格式化文件大小
  const formatFileSize = (bytes: number) => {
    if (!bytes || bytes === 0) return ''
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary">会话历史</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 加载中 */}
        <div className="flex flex-col items-center justify-center flex-1 p-8">
          <Loader2 className="w-8 h-8 animate-spin text-text-tertiary" />
          <p className="mt-4 text-sm text-text-secondary">加载历史会话...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-base font-semibold text-text-primary">会话历史</h2>
        <button
          onClick={onClose}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 引擎筛选 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle shrink-0">
        <button
          onClick={() => setFilter('all')}
          className={`px-2 py-1 rounded-md text-xs transition-colors ${
            filter === 'all'
              ? 'bg-primary/20 text-primary'
              : 'text-text-secondary hover:bg-background-hover'
          }`}
        >
          全部
        </button>
        <button
          onClick={() => setFilter('claude-code')}
          className={`px-2 py-1 rounded-md text-xs transition-colors ${
            filter === 'claude-code'
              ? 'bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300'
              : 'text-text-secondary hover:bg-background-hover'
          }`}
        >
          Claude Code
        </button>
        <button
          onClick={() => setFilter('iflow')}
          className={`px-2 py-1 rounded-md text-xs transition-colors ${
            filter === 'iflow'
              ? 'bg-purple-100 text-purple-600 dark:bg-purple-900 dark:text-purple-300'
              : 'text-text-secondary hover:bg-background-hover'
          }`}
        >
          IFlow
        </button>
        <button
          onClick={() => setFilter('codex')}
          className={`px-2 py-1 rounded-md text-xs transition-colors ${
            filter === 'codex'
              ? 'bg-orange-100 text-orange-600 dark:bg-orange-900 dark:text-orange-300'
              : 'text-text-secondary hover:bg-background-hover'
          }`}
        >
          Codex
        </button>
      </div>

      {/* 搜索框 */}
      <div className="px-4 py-2 border-b border-border-subtle shrink-0">
        <input
          type="text"
          placeholder="搜索会话..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 bg-background"
        />
      </div>

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {filteredHistory.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-text-tertiary">
            <MessageSquare className="w-12 h-12 mb-4 opacity-50" />
            <p className="text-sm">暂无历史会话</p>
          </div>
        ) : (
          <ul>
            {filteredHistory.map((item, index) => {
              const isRestoring = restoring === item.id
              const canDelete = item.source === 'local'
              const engineInfo = getEngineInfo(item.engineId, item.source)
              const EngineIcon = engineInfo.icon

              return (
                <li
                  key={item.id}
                  className={`flex items-start gap-3 px-4 py-3 hover:bg-background-hover transition-colors ${index > 0 ? 'border-t border-border-subtle' : ''}`}
                >
                  {/* 引擎标识 */}
                  <div className={`mt-0.5 ${engineInfo.color}`}>
                    <EngineIcon className="w-4 h-4" />
                  </div>

                  {/* 会话信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-medium text-text-primary truncate">{item.title}</h3>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${engineInfo.bgColor}`}>
                        {engineInfo.name}
                      </span>
                    </div>

                    <div className="flex items-center gap-4 text-xs text-text-tertiary">
                      <span className="flex items-center gap-1">
                        <MessageSquare className="w-3 h-3" />
                        {item.messageCount} 条消息
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatTime(item.timestamp)}
                      </span>
                      {item.fileSize && (
                        <span>{formatFileSize(item.fileSize)}</span>
                      )}
                      {(item.inputTokens || item.outputTokens) && (
                        <span>
                          {((item.inputTokens || 0) + (item.outputTokens || 0)).toLocaleString()} Tokens
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 操作按钮 */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleRestore(item.id, item.engineId)}
                      disabled={isRestoring}
                      className={`p-1.5 rounded-md hover:bg-background-elevated transition-colors ${
                        isRestoring ? 'opacity-50 cursor-not-allowed' : 'text-text-secondary hover:text-text-primary'
                      }`}
                      title="恢复会话"
                    >
                      {isRestoring ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RotateCcw className="w-4 h-4" />
                      )}
                    </button>
                    {canDelete && (
                      <button
                        onClick={() => handleDelete(item.id, item.source)}
                        className="p-1.5 rounded-md hover:bg-danger/10 text-text-tertiary hover:text-danger transition-colors"
                        title="删除会话"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* 底部提示 */}
      <div className="px-4 py-2 border-t border-border-subtle text-xs text-text-tertiary shrink-0">
        <p>• Claude Code 会话来自原生历史记录</p>
        <p>• 本地会话可删除，CLI 会话只读</p>
      </div>
    </div>
  )
}

