/**
 * CompactMode - 小屏对话模式组件
 *
 * 当窗口宽度小于阈值时，切换到精简的对话界面：
 * - 全屏对话消息区域
 * - 右侧悬浮导航球
 * - 底部固定输入框
 */

import { useRef, useMemo, useState, useCallback } from 'react'
import { useEventChatStore, useWorkspaceStore } from '../../stores'
import { CompactMessageList, type CompactMessageListRef } from './CompactMessageList'
import { CompactChatInput } from './CompactChatInput'
import { ChatNavigator } from '../Chat/ChatNavigator'
import { groupConversationRounds } from '../../utils/conversationRounds'
import type { Attachment } from '../../types/attachment'

interface CompactModeProps {
  onSend: (message: string, workspaceDir?: string, attachments?: Attachment[]) => void
  onInterrupt: () => void
  disabled?: boolean
  isStreaming?: boolean
}

export function CompactMode({ onSend, onInterrupt, disabled, isStreaming }: CompactModeProps) {
  const { error, messages } = useEventChatStore()
  const currentWorkspace = useWorkspaceStore(state => state.getCurrentWorkspace())
  const messageListRef = useRef<CompactMessageListRef>(null)

  // 当前可见的对话轮次索引（暂时未使用，保留供后续功能扩展）
  const [currentRoundIndex] = useState(0)

  // 对话轮次分组
  const conversationRounds = useMemo(() => {
    return groupConversationRounds(messages)
  }, [messages])

  // 滚动到指定轮次
  const scrollToRound = useCallback((roundIndex: number) => {
    const round = conversationRounds[roundIndex]
    if (!round) return

    // 优先跳转到 AI 回复，如果没有则跳转到用户消息
    const targetIndex = round.assistantMessage
      ? round.messageIndices[1]  // AI 回复索引
      : round.messageIndices[0] // 用户消息索引

    messageListRef.current?.scrollToMessage(targetIndex)
  }, [conversationRounds])

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    messageListRef.current?.scrollToBottom()
  }, [])

  return (
    <div className="flex flex-col h-full bg-background compact-mode-transition">
      {/* 错误提示 */}
      {error && (
        <div className="mx-2 mt-2 p-2 bg-danger-faint border border-danger/30 rounded-lg text-danger text-xs shrink-0">
          {error}
        </div>
      )}

      {/* 对话消息区域 - 占据剩余空间 */}
      <CompactMessageList ref={messageListRef} />

      {/* 右侧悬浮导航球 */}
      {conversationRounds.length > 0 && (
        <ChatNavigator
          rounds={conversationRounds}
          currentRoundIndex={currentRoundIndex}
          onScrollToBottom={scrollToBottom}
          onScrollToRound={scrollToRound}
        />
      )}

      {/* 底部固定输入框 */}
      <CompactChatInput
        onSend={onSend}
        onInterrupt={onInterrupt}
        disabled={disabled || !currentWorkspace}
        isStreaming={isStreaming}
      />
    </div>
  )
}
