import { useRef, useEffect } from 'react'
import { useAssistantStore } from '../store/assistantStore'
import { ProgressiveStreamingMarkdown } from '../../utils/lightweightMarkdown'

/**
 * 助手对话消息流
 */
export function AssistantChat() {
  const { messages, streamingMessageId } = useAssistantStore()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        <div className="text-center">
          <p className="mb-2">👋 你好！我是 AI 助手</p>
          <p className="text-xs text-text-tertiary">
            我可以帮你分析需求、调用 Claude Code 执行项目操作
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`mb-4 ${
            message.role === 'user' ? 'text-right' : 'text-left'
          }`}
        >
          <div
            className={`inline-block max-w-[80%] px-3 py-2 rounded-lg text-sm ${
              message.role === 'user'
                ? 'bg-primary text-white'
                : 'bg-background-surface text-text-primary'
            }`}
          >
            {message.role === 'user' ? (
              <span className="whitespace-pre-wrap break-words">{message.content}</span>
            ) : (
              <div className="prose prose-sm max-w-none dark:prose-invert">
                <ProgressiveStreamingMarkdown
                  content={message.content}
                  completed={streamingMessageId !== message.id}
                />
              </div>
            )}
          </div>

          {/* 工具调用指示 */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="mt-2 text-left">
              {message.toolCalls.map((tc) => (
                <div
                  key={tc.id}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-background-surface rounded text-xs text-text-muted"
                >
                  {tc.status === 'running' && (
                    <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                  )}
                  {tc.status === 'completed' && (
                    <span className="w-2 h-2 rounded-full bg-success" />
                  )}
                  {tc.status === 'error' && (
                    <span className="w-2 h-2 rounded-full bg-danger" />
                  )}
                  <span>Claude Code: {tc.arguments.reason || tc.arguments.prompt?.slice(0, 30)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <div ref={messagesEndRef} />
    </div>
  )
}
