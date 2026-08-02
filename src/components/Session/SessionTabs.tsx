/**
 * SessionTabs - 会话标签栏组件
 *
 * 支持功能:
 * - 显示多窗口中的会话标签（与 MultiSessionGrid 同步）
 * - 切换会话（点击联动滚动）
 * - 关闭会话
 * - 新建会话
 * - 显示会话状态
 */

import { memo, useCallback, useState, useRef } from 'react'
import { cn } from '@/utils/cn'
import { Plus } from 'lucide-react'
import { SessionTab } from './SessionTab'
import { CreateSessionModal } from './CreateSessionModal'
import {
  useSessionMetadataList,
  useActiveSessionId,
  useSessionManagerActions,
} from '@/stores/conversationStore/sessionStoreManager'
import { useViewStore } from '@/stores'

/** 暴露给父组件的方法 */
export interface SessionTabsRef {
  /** 滚动到指定会话标签 */
  scrollToTab: (sessionId: string) => void;
}

interface SessionTabsProps {
  /** 可选：点击会话时的额外回调（用于联动滚动 MultiSessionGrid） */
  onSessionSelect?: (sessionId: string) => void;
}

export const SessionTabs = memo(function SessionTabs({ onSessionSelect }: SessionTabsProps = {}) {
  // 数据源：使用 multiSessionIds 而不是所有会话
  const multiSessionIds = useViewStore(state => state.multiSessionIds)
  const activeSessionId = useActiveSessionId()
  const { deleteSession, switchSession } = useSessionManagerActions()

  // 滚动容器 ref
  const containerRef = useRef<HTMLDivElement>(null)

  // 弹窗状态
  const [showCreateModal, setShowCreateModal] = useState(false)

  // 获取所有会话元数据
  const allSessionMetadata = useSessionMetadataList()

  // 过滤出多窗口中显示的会话（按照 multiSessionIds 的顺序）
  const visibleSessions = multiSessionIds
    .map(id => allSessionMetadata.find(s => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)

  // 是否可以关闭（至少保留一个会话）
  const canClose = visibleSessions.length > 1

  // 新建会话 - 打开弹窗
  const handleCreateSession = useCallback(() => {
    setShowCreateModal(true)
  }, [])

  // 选择会话
  const handleSelect = useCallback((sessionId: string) => {
    switchSession(sessionId)
    // 触发联动回调
    onSessionSelect?.(sessionId)
  }, [switchSession, onSessionSelect])

  // 关闭会话：删除会话（会自动从多窗口移除）
  const handleClose = useCallback((sessionId: string) => {
    deleteSession(sessionId)
  }, [deleteSession])

  // 如果没有可见会话，显示新建按钮
  if (visibleSessions.length === 0) {
    return (
      <>
        <div className="flex items-center px-2 py-1 border-b border-border bg-background-surface">
          <button
            onClick={handleCreateSession}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg',
              'text-sm text-text-secondary hover:text-text-primary',
              'hover:bg-background-hover transition-colors'
            )}
          >
            <Plus className="w-4 h-4" />
            新建会话
          </button>
        </div>
        {/* 新建会话弹窗 */}
        {showCreateModal && (
          <CreateSessionModal onClose={() => setShowCreateModal(false)} />
        )}
      </>
    )
  }

  return (
    <>
      <div
        ref={containerRef}
        className="flex items-center gap-1 px-2 py-1 border-b border-border bg-background-surface overflow-x-auto"
        role="tablist"
      >
        {/* 会话标签 */}
        {visibleSessions.map((session) => (
          <SessionTab
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onSelect={() => handleSelect(session.id)}
            onClose={() => handleClose(session.id)}
            canClose={canClose}
          />
        ))}

        {/* 新建按钮 */}
        <button
          onClick={handleCreateSession}
          className={cn(
            'flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0',
            'text-text-muted hover:text-text-primary hover:bg-background-hover',
            'transition-colors'
          )}
          title="新建会话"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
      {/* 新建会话弹窗 */}
      {showCreateModal && (
        <CreateSessionModal onClose={() => setShowCreateModal(false)} />
      )}
    </>
  )
})