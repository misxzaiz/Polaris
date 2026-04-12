import { useEffect } from 'react'
import { useAssistantStore } from '../store/assistantStore'
import { useConfigStore } from '../../stores/configStore'
import { getAssistantEngine, resetAssistantEngine } from '../core/AssistantEngine'
import { AssistantChat } from './AssistantChat'
import { AssistantInput } from './AssistantInput'
import { ClaudeCodeSessionPanel, CompletionNotificationPanel } from './ClaudeCodeSessionPanel'
import { DEFAULT_ASSISTANT_CONFIG } from '../types'

/**
 * 助手面板 - 主界面
 */
export function AssistantPanel() {
  const { claudeCodeSessions, initialize } = useAssistantStore()
  const { config } = useConfigStore()

  // 初始化
  useEffect(() => {
    initialize()
  }, [initialize])

  // 初始化引擎
  useEffect(() => {
    const assistantConfig = config?.assistant || DEFAULT_ASSISTANT_CONFIG

    if (assistantConfig.enabled && assistantConfig.llm.apiKey) {
      const engine = getAssistantEngine()
      engine.initialize({
        baseUrl: assistantConfig.llm.baseUrl,
        apiKey: assistantConfig.llm.apiKey,
        model: assistantConfig.llm.model,
        maxTokens: assistantConfig.llm.maxTokens,
        temperature: assistantConfig.llm.temperature,
      })

      return () => {
        resetAssistantEngine()
      }
    }
  }, [config?.assistant])

  const sessionCount = claudeCodeSessions.size
  const runningCount = Array.from(claudeCodeSessions.values()).filter(
    (s) => s.status === 'running'
  ).length

  const assistantConfig = config?.assistant || DEFAULT_ASSISTANT_CONFIG
  const isConfigured = assistantConfig.enabled && !!assistantConfig.llm.apiKey

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

      {/* 未配置提示 */}
      {!isConfigured && (
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="text-center text-text-muted">
            <p className="mb-2">AI 助手未配置</p>
            <p className="text-xs text-text-tertiary">
              请在设置中启用 AI 助手并配置 API Key
            </p>
          </div>
        </div>
      )}

      {/* 对话消息流 */}
      {isConfigured && (
        <div className="flex-1 overflow-hidden">
          <AssistantChat />
        </div>
      )}

      {/* 完成通知面板 */}
      {isConfigured && <CompletionNotificationPanel />}

      {/* Claude Code 多会话面板 */}
      {isConfigured && <ClaudeCodeSessionPanel />}

      {/* 输入框 */}
      {isConfigured && <AssistantInput />}
    </div>
  )
}
