/**
 * 远端会话面板（批 3，跨端只读跟随的呈现层）
 *
 * - RemoteSessionsStrip：其他设备正在进行/刚结束的会话横条（挂在历史面板顶部）。
 *   数据来自 remoteSessionFollower 的 lifecycle 轮询发现（独立于本端 store）。
 * - RemoteSessionOverlay：只读流式视图——回补（后端消息库）+ 实时增量
 *   （chat-event 按 conversationId 归集）。冻结只读：不提供发送/中断/答题。
 *
 * 冻结条款：批 5 主路由正典化验收后一个版本周期内退役（见
 * remoteSessionFollower.ts 头注与裁决方案修正条款）。
 */

import { memo, useEffect, useRef } from 'react'
import { useStore } from 'zustand'
import { X, Loader2, Wrench, AlertTriangle, Brain, Radio } from 'lucide-react'
import {
  remoteSessionFollower,
  type FollowerMessage,
} from '@/services/remoteSessionFollower'

function shortId(conversationId: string): string {
  return conversationId.length > 14 ? `${conversationId.slice(0, 12)}…` : conversationId
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 其他设备的会话横条（running 优先；无远端会话时不渲染） */
export const RemoteSessionsStrip = memo(function RemoteSessionsStrip() {
  const sessions = useStore(remoteSessionFollower.store, (s) => s.sessions)
  const openSession = remoteSessionFollower.openSession

  const list = [...sessions.values()]
    .filter((s) => s.status === 'running')
    .sort((a, b) => b.startedAt - a.startedAt)

  if (list.length === 0) return null

  return (
    <div className="px-3 sm:px-4 pt-3 pb-1">
      <div className="flex items-center gap-1.5 text-xs font-medium text-text-tertiary mb-2">
        <Radio className="w-3 h-3 text-primary" />
        其他设备进行中
      </div>
      <div className="flex gap-2 overflow-x-auto pb-2">
        {list.map((s) => (
          <button
            key={s.conversationId}
            onClick={() => void openSession(s.conversationId)}
            className="w-52 shrink-0 rounded-lg border border-primary/30 bg-primary/5 hover:border-primary/60 transition-colors p-2.5 flex flex-col gap-1 text-left"
            title={s.conversationId}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" />
              <span className="text-xs font-medium text-text-primary truncate flex-1">
                {shortId(s.conversationId)}
              </span>
            </div>
            <p className="text-[11px] text-text-tertiary">
              {s.engineId ? `${s.engineId} · ` : ''}始于 {relativeTime(s.startedAt)} · 点击只读查看
            </p>
          </button>
        ))}
      </div>
    </div>
  )
})

/** 只读流式视图（全屏 overlay） */
export const RemoteSessionOverlay = memo(function RemoteSessionOverlay() {
  const viewingId = useStore(remoteSessionFollower.store, (s) => s.viewingConversationId)
  const session = useStore(remoteSessionFollower.store, (s) =>
    s.viewingConversationId ? s.sessions.get(s.viewingConversationId) : undefined,
  )

  // 流式时自动贴底
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (session?.status === 'running') {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [session?.messages.length, session?.status])

  if (!viewingId) return null

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl h-[80vh] rounded-xl border border-border bg-background shadow-xl flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <span
            className={`w-2 h-2 rounded-full ${
              session?.status === 'running' ? 'bg-primary animate-pulse' : 'bg-text-muted'
            }`}
          />
          <span className="text-sm font-medium text-text-primary truncate flex-1">
            {session ? shortId(session.conversationId) : viewingId}
          </span>
          <span className="text-xs text-text-tertiary">
            {session?.status === 'running' ? '进行中 · 实时同步' : `已结束（${session?.endReason ?? '-'}）`}
          </span>
          <button
            onClick={() => remoteSessionFollower.closeSession()}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 消息流（只读） */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {session && session.messages.length > 0 ? (
            session.messages.map((m) => <FollowerMessageView key={m.id} message={m} />)
          ) : (
            <div className="flex items-center justify-center gap-2 text-xs text-text-tertiary py-8">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              正在从后端拉取会话内容…
            </div>
          )}
          {session?.status === 'running' && (
            <div className="flex items-center gap-2 text-xs text-text-tertiary px-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              实时接收中（只读跟随，来自其他设备的会话）
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* 底部提示（冻结只读） */}
        <div className="px-4 py-2 border-t border-border text-[11px] text-text-tertiary shrink-0">
          只读视图：此会话由其他设备发起，在本设备查看实时同步；操作（发送/停止/回答）请回到发起设备。
        </div>
      </div>
    </div>
  )
})

function FollowerMessageView({ message }: { message: FollowerMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary/15 border border-primary/20 px-3 py-2 text-sm text-text-primary whitespace-pre-wrap break-words">
          {message.text}
        </div>
      </div>
    )
  }
  return (
    <div className="rounded-lg bg-background-elevated/60 border border-border-subtle px-3 py-2 space-y-1.5">
      {message.thinking && (
        <div className="flex items-start gap-1.5 text-xs text-text-tertiary">
          <Brain className="w-3 h-3 mt-0.5 shrink-0" />
          <span className="line-clamp-3 whitespace-pre-wrap">{message.thinking}</span>
        </div>
      )}
      {message.toolCalls?.map((t) => (
        <div
          key={t.id}
          className="flex items-center gap-1.5 text-xs text-text-secondary bg-background-hover/60 rounded px-2 py-1"
        >
          {t.status === 'running' ? (
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
          ) : (
            <Wrench
              className={`w-3 h-3 shrink-0 ${t.status === 'failed' ? 'text-danger' : 'text-text-muted'}`}
            />
          )}
          <span className="truncate">{t.name || t.id}</span>
          {t.output && (
            <span className="text-text-muted truncate flex-1" title={t.output}>
              {t.output.slice(0, 80)}
            </span>
          )}
        </div>
      ))}
      {message.text && (
        <div className="text-sm text-text-primary whitespace-pre-wrap break-words">
          {message.text}
        </div>
      )}
      {message.errorMessage && (
        <div className="flex items-start gap-1.5 text-xs text-danger">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{message.errorMessage}</span>
        </div>
      )}
      {message.streaming && !message.text && !message.thinking && (
        <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
          <Loader2 className="w-3 h-3 animate-spin" />
          等待输出…
        </div>
      )}
    </div>
  )
}
