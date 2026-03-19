/**
 * CompactMessageList - 小屏模式专用消息列表
 *
 * 特点：
 * - 简单滚动列表（小屏消息量有限，无需虚拟列表）
 * - 紧凑的消息间距
 * - 自动滚动到底部
 * - 支持滚动到指定消息
 * - 支持流式消息实时显示（currentMessage）
 */

import { useEffect, useRef, forwardRef, useImperativeHandle, useMemo } from 'react'
import { useEventChatStore } from '../../stores'
import { CompactUserMessage } from './CompactUserMessage'
import { CompactAssistantMessage } from './CompactAssistantMessage'
import type { ChatMessage, AssistantChatMessage } from '../../types/chat'
import { isUserMessage, isAssistantMessage } from '../../types/chat'

export interface CompactMessageListRef {
  /** 滚动到指定消息索引 */
  scrollToMessage: (index: number) => void
  /** 滚动到底部 */
  scrollToBottom: () => void
}

interface CompactMessageListProps {
  /** 消息元素的类名，用于定位 */
  messageClassName?: string
}

export const CompactMessageList = forwardRef<CompactMessageListRef, CompactMessageListProps>(
  function CompactMessageList(_props, ref) {
    const messages = useEventChatStore(state => state.messages)
    const currentMessage = useEventChatStore(state => state.currentMessage)
    const isStreaming = useEventChatStore(state => state.isStreaming)
    const listRef = useRef<HTMLDivElement>(null)
    const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map())

    // 合并 messages 和 currentMessage（流式消息实时显示）
    // 参考 EnhancedChatMessages 的实现
    const displayMessages = useMemo(() => {
      if (!currentMessage || !isStreaming) {
        return messages
      }

      // 检查 currentMessage 是否已在 messages 中
      const existingIndex = messages.findIndex(m => m.id === currentMessage.id)

      if (existingIndex >= 0) {
        // 更新已存在的消息
        return messages.map((m, i) =>
          i === existingIndex
            ? { ...m, blocks: currentMessage.blocks, isStreaming: true } as AssistantChatMessage
            : m
        )
      } else {
        // 添加到末尾
        return [...messages, {
          id: currentMessage.id,
          type: 'assistant' as const,
          blocks: currentMessage.blocks,
          timestamp: new Date().toISOString(),
          isStreaming: true,
        } as AssistantChatMessage]
      }
    }, [messages, currentMessage, isStreaming])

    // 暴露方法给父组件
    useImperativeHandle(ref, () => ({
      scrollToMessage: (index: number) => {
        if (index < 0 || index >= displayMessages.length) return
        const message = displayMessages[index]
        const element = messageRefs.current.get(message.id)
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      },
      scrollToBottom: () => {
        if (listRef.current) {
          listRef.current.scrollTop = listRef.current.scrollHeight
        }
      }
    }), [displayMessages])

    // 自动滚动到底部
    useEffect(() => {
      if (listRef.current) {
        listRef.current.scrollTop = listRef.current.scrollHeight
      }
    }, [displayMessages, isStreaming])

    if (displayMessages.length === 0) {
      return (
        <div className="flex-1 min-h-0 flex items-center justify-center text-text-tertiary text-sm">
          <p>开始新对话...</p>
        </div>
      )
    }

    return (
      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-2"
      >
        {displayMessages.map((message) => (
          <div
            key={message.id}
            ref={(el) => {
              if (el) {
                messageRefs.current.set(message.id, el)
              } else {
                messageRefs.current.delete(message.id)
              }
            }}
          >
            <CompactMessageItem message={message} />
          </div>
        ))}

        {/* 流式输出指示器 */}
        {isStreaming && (
          <div className="flex items-center gap-1.5 px-2 py-1.5 text-text-tertiary text-xs">
            <span className="animate-pulse">●</span>
            <span>AI 正在回复...</span>
          </div>
        )}
      </div>
    )
  }
)

function CompactMessageItem({ message }: { message: ChatMessage }) {
  if (isUserMessage(message)) {
    return <CompactUserMessage message={message} />
  }

  if (isAssistantMessage(message)) {
    return <CompactAssistantMessage message={message} />
  }

  // 其他类型消息暂不显示
  return null
}
