import { useState, useRef, KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'
import { useAssistantStore } from '../store/assistantStore'
import { getAssistantEngine } from '../core/AssistantEngine'

/**
 * 助手输入框
 */
export function AssistantInput() {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { isLoading, setLoading, setError, abortAllSessions, getRunningSessions } = useAssistantStore()

  const handleSubmit = async () => {
    const trimmedInput = input.trim()
    if (!trimmedInput || isLoading) return

    setInput('')
    setLoading(true)
    setError(null)

    try {
      const engine = getAssistantEngine()
      for await (const _ of engine.processMessage(trimmedInput)) {
        // 处理事件
      }
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleAbort = async () => {
    await abortAllSessions()
    setLoading(false)
  }

  const runningSessions = getRunningSessions()
  const isRunning = runningSessions.length > 0 || isLoading

  return (
    <div className="border-t border-border p-3 shrink-0 bg-background-elevated">
      <div className="flex items-end gap-2">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息..."
            rows={1}
            className="w-full px-3 py-2 bg-background-surface border border-border rounded-lg text-sm text-text-primary placeholder-text-muted resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
            style={{ minHeight: '40px', maxHeight: '120px' }}
          />
        </div>

        {isRunning ? (
          <button
            onClick={handleAbort}
            className="flex items-center justify-center w-10 h-10 bg-danger rounded-lg text-white hover:bg-danger/90 transition-colors"
          >
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            className="flex items-center justify-center w-10 h-10 bg-primary rounded-lg text-white hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}
