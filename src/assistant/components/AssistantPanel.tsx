import { useEffect } from 'react'
import { useAssistantStore } from '../store/assistantStore'
import { AssistantChat } from './AssistantChat'
import { AssistantInput } from './AssistantInput'
import { ClaudeCodeSessionPanel } from './ClaudeCodeSessionPanel'

/**
 * 助手面板 - 主界面
 */
export function AssistantPanel() {
  const { claudeCodeSessions, initialize } = useAssistantStore()

  // 初始化
  useEffect(() => {
    initialize()
  }, [initialize])

  const sessionCount = claudeCodeSessions.size
  const runningCount = Array.from(claudeCodeSessions.values()).filter(
    (s) => s.status === 'running'
  ).length

  return (
    <div className="flex flex-col h-full bg-background-elevated">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-sm font-medium text-text-primary">AI 助手</h2>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          {sessionCount > 0 && (
            <span>
              {runningCount > 0 && (
                <span className="inline-flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                  {runningCount} 运行中
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* 对话消息流 */}
      <div className="flex-1 overflow-hidden">
        <AssistantChat />
      </div>

      {/* Claude Code 多会话面板 */}
      <ClaudeCodeSessionPanel />

      {/* 输入框 */}
      <AssistantInput />
    </div>
  )
}
