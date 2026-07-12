/**
 * SessionCell 组件 - 多会话窗口中的单个会话格子
 *
 * 功能：
 * - 渲染单个会话的消息列表（复用 EnhancedChatMessages）
 * - 显示会话标题和状态
 * - 支持点击切换活跃会话
 * - 支持展开/关闭操作
 */

import { memo, useCallback, useState, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Loader2, XCircle, X, Circle, Maximize2, Minimize2, Square } from 'lucide-react';
import { SessionMessagesView } from './SessionMessagesView';
import { useSessionMetadataList, useSessionManagerActions } from '@/stores/conversationStore/sessionStoreManager';
import { useSessionStreaming, useSessionHasPendingQuestion } from '@/stores/conversationStore/useActiveSession';
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager';
import { useWorkspaceStore, useConfigStore } from '@/stores';
import { getChatDisplayStyleVars } from '@/types';
import { WorkspaceBadge } from '../Session/WorkspaceBadge';
import { WorkspaceMenu } from '../Session/WorkspaceMenu';
import { getEngineDisplayName, getEngineFullName } from '@/utils/engineDisplay';

/** 状态图标映射 */
const SESSION_STATUS_CONFIG = {
  idle: { icon: Circle, className: 'text-text-muted' },
  running: { icon: Loader2, className: 'animate-spin text-primary' },
  waiting: { icon: Loader2, className: 'animate-spin text-warning' },
  error: { icon: XCircle, className: 'text-error' },
  background_running: { icon: Loader2, className: 'animate-spin text-text-muted' },
};

/** SessionCell Props */
interface SessionCellProps {
  sessionId: string;
  isActive: boolean;
  /** 是否处于展开模式 */
  isExpanded?: boolean;
  /** 展开按钮点击回调 */
  onToggleExpand?: () => void;
}

/**
 * SessionCell 组件
 */
export const SessionCell = memo(function SessionCell({
  sessionId,
  isActive,
  isExpanded = false,
  onToggleExpand,
}: SessionCellProps) {
  const { t } = useTranslation('chat');
  const { switchSession, deleteSession } = useSessionManagerActions();

  const chatDisplay = useConfigStore((state) => state.config?.chatDisplay);
  const chatDisplayStyle = useMemo(() => getChatDisplayStyleVars(chatDisplay), [chatDisplay]);

  // 获取会话元数据
  const sessionMetadata = useSessionMetadataList().find(m => m.id === sessionId);

  // 获取流式状态
  const isStreaming = useSessionStreaming(sessionId);

  // 是否有待回答的问题
  const hasPendingQuestion = useSessionHasPendingQuestion(sessionId);

  // 工作区菜单状态
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const badgeRef = useRef<HTMLButtonElement>(null);

  // 获取工作区信息
  const workspace = useWorkspaceStore(state =>
    sessionMetadata?.workspaceId
      ? state.workspaces.find(w => w.id === sessionMetadata.workspaceId)
      : null
  );

  // 获取关联工作区数量
  const contextCount = sessionMetadata?.contextWorkspaceIds?.length || 0;

  // 状态配置 - 需要将 hyphen 格式转换为 underscore 格式
  const statusKey = (sessionMetadata?.status || 'idle').replace(/-/g, '_') as keyof typeof SESSION_STATUS_CONFIG;
  const statusConfig = SESSION_STATUS_CONFIG[statusKey] || SESSION_STATUS_CONFIG.idle;
  const StatusIcon = statusConfig.icon;
  const engineId = sessionMetadata?.engineId;

  // 点击切换活跃会话
  const handleClick = useCallback(() => {
    if (!isActive) {
      switchSession(sessionId);
    }
  }, [isActive, sessionId, switchSession]);

  // 关闭格子：删除会话（会自动从多窗口移除）
  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    deleteSession(sessionId);
  }, [sessionId, deleteSession]);

  // 中断当前会话的 AI 回复
  const handleInterrupt = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // 直接调用对应会话的 interrupt 方法，而不是使用 activeSessionId
    sessionStoreManager.getState().interruptSession(sessionId);
  }, [sessionId]);

  // 展开/收起
  const handleExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand?.();
  }, [onToggleExpand]);

  return (
    <>
      <div
        className={clsx(
          'flex flex-col h-full overflow-hidden rounded-lg border transition-all',
          isActive ? 'border-primary shadow-glow' : 'border-border hover:border-border-strong'
        )}
        onClick={handleClick}
      >
        {/* 头部：标题 + 状态 + 操作按钮 */}
        <div className={clsx(
          'flex items-center gap-1.5 px-2 py-1 border-b shrink-0',
          isActive ? 'bg-primary/10 border-primary/20' : 'bg-background-surface border-border'
        )}>
          {/* 会话标题 */}
          <span className={clsx(
            'text-xs font-medium truncate min-w-0',
            isActive ? 'text-primary' : 'text-text-secondary'
          )}>
            {sessionMetadata?.title || t('sessionCell.unnamed')}
          </span>

          <span
            className={clsx(
              'shrink-0 px-1.5 py-0.5 rounded border text-[10px] leading-none',
              isActive
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border-subtle text-text-tertiary'
            )}
            title={getEngineFullName(engineId)}
          >
            {getEngineDisplayName(engineId)}
          </span>

          {/* 工作区徽章 */}
          <WorkspaceBadge
            ref={badgeRef}
            workspaceId={sessionMetadata?.workspaceId || null}
            workspaceName={workspace?.name || sessionMetadata?.workspaceName}
            contextWorkspaceCount={contextCount}
            onClick={(e) => {
              e.stopPropagation();
              setShowWorkspaceMenu(true);
            }}
          />

          {/* 弹性空间 - 把右侧元素推到右边 */}
          <span className="flex-1" />

          {/* 流式状态指示 */}
          {isStreaming && (
            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse shrink-0" />
          )}

          {/* 待回答问题指示 - 仅非活跃会话显示 */}
          {hasPendingQuestion && !isActive && !isStreaming && (
            <span className="w-1.5 h-1.5 bg-warning rounded-full shrink-0" title={t('sessionCell.pendingQuestion')} />
          )}

          {/* 状态图标 */}
          <StatusIcon className={clsx('w-3.5 h-3.5 shrink-0', statusConfig.className)} />

          {/* 中断按钮 - 仅在流式状态时显示 */}
          {isStreaming && (
            <button
              onClick={handleInterrupt}
              className="shrink-0 p-0.5 rounded bg-danger/80 text-white hover:bg-danger transition-colors"
              title={t('sessionCell.interrupt')}
            >
              <Square className="w-3 h-3" />
            </button>
          )}

          {/* 展开/收起按钮 */}
          <button
            onClick={handleExpand}
            className="shrink-0 p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-background-hover transition-colors"
            title={isExpanded ? t('sessionCell.collapse') : t('sessionCell.expand')}
          >
            {isExpanded ? (
              <Minimize2 className="w-3 h-3" />
            ) : (
              <Maximize2 className="w-3 h-3" />
            )}
          </button>

          {/* 关闭按钮 */}
          <button
            onClick={handleClose}
            className="shrink-0 p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-background-hover transition-colors"
            title={t('sessionCell.close')}
          >
            <X className="w-3 h-3" />
          </button>
        </div>

        {/* 消息区域 - 使用专门的多窗口消息组件 */}
        <div className="chat-display-root flex-1 min-h-0 overflow-hidden bg-background-base" style={chatDisplayStyle}>
          <SessionMessagesView sessionId={sessionId} />
        </div>
      </div>

      {/* 工作区菜单弹窗 */}
      {showWorkspaceMenu && (
        <WorkspaceMenu
          sessionId={sessionId}
          anchorEl={badgeRef.current}
          onClose={() => setShowWorkspaceMenu(false)}
        />
      )}
    </>
  );
});
