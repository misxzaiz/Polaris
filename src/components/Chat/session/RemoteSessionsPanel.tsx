/**
 * 远端会话入口区块（跨端只读跟随的呈现层）
 *
 * - RemoteSessionsNavSection：ChatNavigator headerSlot 注入位（预留）。
 * - RemoteSessionsQuickSection：QuickSwitchPanel 会话列表顶部（用户指定入口）。
 *   数据来自 remoteSessionFollower 的 lifecycle 轮询发现（独立于本端 store）。
 *
 * P4（session-history PRD）：RemoteSessionsStrip/RemoteSessionOverlay 随内置
 * 历史面板拆除（仅面板消费）；本文件的 Quick/Nav 区块是 QuickSwitchPanel
 * 常驻入口，保留。follower 双实现（宿主 vs history-desk 插件轻量发现）
 * 并存的已知债务见 PRD §7。
 */

import { memo, useState } from 'react'
import { useStore } from 'zustand'
import { useTranslation } from 'react-i18next'
import { Loader2, Radio, LogIn } from 'lucide-react'
import { useToastStore } from '@/stores/toastStore'
import {
  remoteSessionFollower,
  isListableRemote,
} from '@/services/remoteSessionFollower'

export const RemoteSessionsNavSection = memo(function RemoteSessionsNavSection() {
  const { t } = useTranslation('chat');
  const sessions = useStore(remoteSessionFollower.store, (s) => s.sessions)
  const [joiningId, setJoiningId] = useState<string | null>(null)

  const list = [...sessions.values()]
    .filter(isListableRemote)
    .sort((a, b) => b.startedAt - a.startedAt)

  if (list.length === 0) return null

  const handleJoin = async (conversationId: string) => {
    setJoiningId(conversationId)
    try {
      const sessionId = await remoteSessionFollower.joinSession(conversationId)
      if (sessionId) {
        remoteSessionFollower.closeSession()
        useToastStore.getState().success(
          t('remoteSession.joined', '已加入会话'),
          t('remoteSession.joinedHint', '实时同步中，可直接发送/中断；原设备仍可继续查看'),
        )
      } else {
        useToastStore.getState().warning(
          t('remoteSession.joinFailed', '加入失败'),
          t('remoteSession.joinFailedHint', '会话可能已结束或已在本端打开'),
        )
      }
    } finally {
      setJoiningId(null)
    }
  }

  return (
    <div className="border-b border-border-subtle bg-warning/[0.04]">
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-[10.5px] font-semibold text-warning">
        <Radio className="w-3 h-3" />
        {t('remoteSession.navTitle', '其他设备进行中')} ({list.length})
      </div>
      {list.map((s) => (
        <div
          key={s.conversationId}
          className="mx-2 mb-2 rounded-lg border border-warning/30 bg-background-surface p-2.5"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            {s.status === 'running' ? (
              <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse shrink-0" />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted shrink-0" />
            )}
            <span className="text-xs font-medium text-text-primary truncate flex-1">
              {shortNavTitle(s.conversationId)}
            </span>
            {s.status !== 'running' && (
              <span className="text-[10px] text-text-muted shrink-0">
                {t('remoteSession.ended', '已结束')}
              </span>
            )}
          </div>
          <p className="text-[10.5px] text-text-tertiary mt-0.5 ml-3">
            {s.engineId ? `${s.engineId} · ` : ''}
            {t('remoteSession.startedAt', '始于')} {relativeTime(s.startedAt)}
          </p>
          <div className="flex gap-1.5 ml-3 mt-1.5">
            <button
              onClick={() => void remoteSessionFollower.openSession(s.conversationId)}
              className="px-2.5 py-1 rounded-md text-[11px] border border-border bg-background-elevated text-text-secondary hover:text-text-primary hover:border-text-muted transition-colors"
            >
              {t('remoteSession.view', '查看')}
            </button>
            <button
              onClick={() => void handleJoin(s.conversationId)}
              disabled={joiningId === s.conversationId}
              className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
            >
              {joiningId === s.conversationId ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <LogIn className="w-3 h-3" />
              )}
              {t('remoteSession.join', '加入窗口')}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
})

function shortNavTitle(conversationId: string): string {
  return conversationId.length > 14 ? `${conversationId.slice(0, 12)}…` : conversationId
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/**
 * QuickSwitchPanel 内的「其他设备进行中」区块（跨端交互 v2 · 用户指定的入口位置）。
 *
 * 挂在 QuickSwitchContent 会话列表顶部——右缘悬浮把手展开的面板即见，
 * 每条会话可 [查看]（只读 overlay）或 [加入窗口]（接入本端会话格，
 * 实时同步且可中断/继续/发送）。空列表返回 null 不占空间。
 */
export const RemoteSessionsQuickSection = memo(function RemoteSessionsQuickSection() {
  const { t } = useTranslation('chat');
  const sessions = useStore(remoteSessionFollower.store, (s) => s.sessions);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const list = [...sessions.values()]
    .filter(isListableRemote)
    .sort((a, b) => b.startedAt - a.startedAt);

  if (list.length === 0) return null;

  const handleJoin = async (conversationId: string) => {
    setJoiningId(conversationId);
    try {
      const sessionId = await remoteSessionFollower.joinSession(conversationId);
      if (sessionId) {
        remoteSessionFollower.closeSession();
        useToastStore.getState().success(
          t('remoteSession.joined', '已加入会话'),
          t('remoteSession.joinedHint', '实时同步中，可直接发送/中断；原设备仍可继续查看'),
        );
      } else {
        useToastStore.getState().warning(
          t('remoteSession.joinFailed', '加入失败'),
          t('remoteSession.joinFailedHint', '会话可能已结束或已在本端打开'),
        );
      }
    } finally {
      setJoiningId(null);
    }
  };

  return (
    <div className="px-2 pt-2 pb-1 border-b border-border-subtle/20">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold text-warning mb-1.5">
        <Radio className="w-3 h-3" />
        {t('remoteSession.navTitle', '其他设备进行中')} ({list.length})
      </div>
      <div className="space-y-1.5 max-h-56 overflow-y-auto">
        {list.map((s) => (
          <div
            key={s.conversationId}
            className="rounded-lg border border-warning/25 bg-background-surface px-2.5 py-2"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              {s.status === 'running' ? (
                <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse shrink-0" />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-text-muted shrink-0" />
              )}
              <span className="text-[11.5px] font-medium text-text-primary truncate flex-1">
                {shortNavTitle(s.conversationId)}
              </span>
              {s.status !== 'running' && (
                <span className="text-[9.5px] text-text-muted shrink-0">
                  {t('remoteSession.ended', '已结束')}
                </span>
              )}
            </div>
            <p className="text-[10px] text-text-tertiary mt-0.5 ml-3">
              {s.engineId ? `${s.engineId} · ` : ''}
              {t('remoteSession.startedAt', '始于')} {relativeTime(s.startedAt)}
            </p>
            <div className="flex gap-1.5 ml-3 mt-1.5">
              <button
                onClick={() => void remoteSessionFollower.openSession(s.conversationId)}
                className="px-2 py-0.5 rounded text-[10.5px] border border-border bg-background-elevated text-text-secondary hover:text-text-primary hover:border-text-muted transition-colors"
              >
                {t('remoteSession.view', '查看')}
              </button>
              <button
                onClick={() => void handleJoin(s.conversationId)}
                disabled={joiningId === s.conversationId}
                className="px-2 py-0.5 rounded text-[10.5px] font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
              >
                {joiningId === s.conversationId ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <LogIn className="w-3 h-3" />
                )}
                {t('remoteSession.join', '加入窗口')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
