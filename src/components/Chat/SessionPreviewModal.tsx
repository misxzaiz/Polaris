/**
 * 会话预览弹窗（只读）
 *
 * 解决「必须恢复会话才能看到上下文」的核心痛点：
 * 点击历史条目即就地加载并只读渲染完整对话，无需创建新会话。
 * 复用 renderChatMessage（与实时聊天完全一致的气泡渲染），
 * 底部提供「继续会话 / 创建分支」动作，把「恢复」从盲操作变为看后再决定。
 */

import { useEffect, useRef, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { X, MessageSquare, Clock, RotateCcw, GitBranch, Loader2, FolderOpen, ArrowDownToLine } from 'lucide-react'
import type { UnifiedHistoryItem } from '@/services/historyService'
import { historyService } from '@/services/historyService'
import type { ChatMessage } from '@/types'
import { renderChatMessage } from './renderChatMessage'
import { getEngineFullName } from '@/utils/engineDisplay'
import { getPathBasename } from '@/utils/workspacePath'
import { createLogger } from '@/utils/logger'

const log = createLogger('SessionPreviewModal')

interface SessionPreviewModalProps {
  item: UnifiedHistoryItem
  /** 继续（恢复）该会话 */
  onRestore: (item: UnifiedHistoryItem) => void
  /** 基于该会话创建分支 */
  onFork: (item: UnifiedHistoryItem) => void
  onClose: () => void
}

/** 只读渲染时无需真实滚动动作，传入空实现即可 */
const NOOP_SCROLL_ACTIONS = {
  scrollToMessage: () => {},
  scrollToTop: () => {},
  scrollToBottom: () => {},
}

export function SessionPreviewModal({ item, onRestore, onFork, onClose }: SessionPreviewModalProps) {
  const { t } = useTranslation('chat')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  // 加载会话消息（只读，不创建 session）
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    setMessages([])
    ;(async () => {
      try {
        const loaded = await historyService.loadMessagesForItem(
          item.id,
          item.engineId,
          item.projectPath,
          item.claudeProjectName,
          item.title,
        )
        if (cancelled) return
        setMessages(loaded.messages)
        if (loaded.messages.length === 0) setError(true)
      } catch (e) {
        if (cancelled) return
        log.error('预览加载失败', e instanceof Error ? e : new Error(String(e)))
        setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [item.id, item.engineId, item.projectPath, item.claudeProjectName, item.title])

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const engineName = useMemo(() => getEngineFullName(item.engineId), [item.engineId])

  const scrollToBottom = () => {
    virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, align: 'end', behavior: 'smooth' })
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex flex-col bg-background-elevated rounded-xl shadow-2xl border border-border w-[900px] max-w-[95vw] h-[84vh] max-h-[860px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-start justify-between gap-3 px-5 py-3.5 border-b border-border shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-text-primary truncate" title={item.title}>
              {item.title}
            </h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs text-text-tertiary">
              <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
                {engineName}
              </span>
              <span className="flex items-center gap-1">
                <MessageSquare className="w-3 h-3" />
                {t('history.messages', { count: item.messageCount })}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {new Date(item.timestamp).toLocaleString('zh-CN', {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              {item.projectPath && (
                <span className="flex items-center gap-1 max-w-[200px] truncate" title={item.projectPath}>
                  <FolderOpen className="w-3 h-3 shrink-0" />
                  <span className="truncate">{getPathBasename(item.projectPath)}</span>
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors shrink-0"
            title={t('preview.close', '关闭')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 消息区（只读） */}
        <div className="relative flex-1 min-h-0 bg-background">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
              <Loader2 className="w-7 h-7 animate-spin" />
              <p className="mt-3 text-sm">{t('preview.loading', '正在加载对话内容…')}</p>
            </div>
          ) : error || messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-text-tertiary p-8 text-center">
              <MessageSquare className="w-10 h-10 mb-3 opacity-50" />
              <p className="text-sm">{t('preview.empty', '无法加载对话内容，数据可能已过期或为空')}</p>
            </div>
          ) : (
            <>
              <Virtuoso
                ref={virtuosoRef}
                style={{ height: '100%' }}
                data={messages}
                itemContent={(index, msg) => (
                  <div className="px-1">{renderChatMessage(msg, index, NOOP_SCROLL_ACTIONS)}</div>
                )}
                atBottomStateChange={setAtBottom}
                atBottomThreshold={120}
                increaseViewportBy={{ top: 200, bottom: 300 }}
                components={{ Footer: () => <div style={{ height: 24 }} /> }}
              />
              {!atBottom && (
                <button
                  onClick={scrollToBottom}
                  className="absolute bottom-4 right-4 p-2 rounded-full bg-primary text-white shadow-lg hover:bg-primary/90 transition-colors"
                  title={t('preview.scrollToBottom', '滚动到底部')}
                >
                  <ArrowDownToLine className="w-4 h-4" />
                </button>
              )}
            </>
          )}
        </div>

        {/* 底部动作栏 */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border shrink-0">
          <p className="text-xs text-text-tertiary">
            {t('preview.readOnlyHint', '只读预览 · 无需恢复即可查看完整上下文')}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onFork(item)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-md transition-colors"
              title={t('history.createBranch', '创建分支')}
            >
              <GitBranch className="w-4 h-4" />
              {t('preview.fork', '创建分支')}
            </button>
            <button
              onClick={() => onRestore(item)}
              disabled={loading || error || messages.length === 0}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-primary hover:bg-primary/90 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RotateCcw className="w-4 h-4" />
              {t('preview.continue', '继续该会话')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default SessionPreviewModal
