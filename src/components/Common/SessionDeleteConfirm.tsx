/**
 * 会话删除二次确认弹窗（U1 · ux-layout-r2）
 *
 * 根因：会话删除是不可逆链路——sessionStoreManager.deleteSession 会同时
 * 销毁内存 store、删除磁盘 JSONL（dialogStorageService.deleteConversation）
 * 与后端消息库（message_delete_by_conversation），且此前三个 UI 入口
 * （QuickSwitchPanel / SessionTabs / SessionCell）均零确认直调，
 * QuickSwitchContent 的删除按钮还挂了误导性 title「关闭」。
 *
 * 修法：复用 Common/ConfirmDialog（danger 型），统一本组件为唯一确认壳：
 * - 正文含会话标题与「不可恢复」损失预告；
 * - 目标会话正在流式/运行中（store 的 isStreaming 或元数据 status 为
 *   running/waiting/background-running）时追加「删除将终止回复」警告。
 *
 * 层级注意：QuickSwitchPanel 容器有 z-20 天花板，调用方需将本组件
 * portal 到 document.body（同文件 NewSessionPanel 先例）；其余入口
 * 内联渲染即可（fixed inset-0 + z-modal，同 FileTreeNode/GitPanel 先例）。
 */

import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from './ConfirmDialog';
import {
  useSessionManagerActions,
  useSessionMetadataList,
} from '@/stores/conversationStore/sessionStoreManager';
import { useSessionStreaming } from '@/stores/conversationStore/useActiveSession';
import type { SessionMetadata } from '@/stores/conversationStore/types';

/** 待删除会话目标（title 缺省时回落「未命名会话」） */
export interface SessionDeleteTarget {
  sessionId: string;
  title?: string | null;
}

interface SessionDeleteConfirmProps {
  /** null 时不渲染（由调用方持有状态，取消/确认后置回 null） */
  target: SessionDeleteTarget | null;
  onCancel: () => void;
}

export function SessionDeleteConfirm({ target, onCancel }: SessionDeleteConfirmProps) {
  const { t } = useTranslation('chat');
  const { deleteSession } = useSessionManagerActions();

  // 弹窗打开期间订阅目标会话的流式状态（null → false，无额外订阅开销）
  const targetId = target?.sessionId ?? null;
  const isStreaming = useSessionStreaming(targetId);
  const status = useSessionMetadataList().find(
    (m: SessionMetadata) => m.id === targetId,
  )?.status;

  if (!target) return null;

  // 「正在运行」判定：store 流式标志优先，元数据事件态（running/waiting/后台运行）兜底
  const isRunning =
    isStreaming ||
    status === 'running' ||
    status === 'waiting' ||
    status === 'background-running';

  const displayTitle = target.title?.trim() || t('sessionCell.unnamed');
  const message = isRunning
    ? `${t('deleteSessionConfirm.message', { title: displayTitle })}\n${t('deleteSessionConfirm.runningWarning')}`
    : t('deleteSessionConfirm.message', { title: displayTitle });

  return (
    <ConfirmDialog
      title={t('deleteSessionConfirm.title')}
      message={message}
      type="danger"
      confirmText={t('deleteSessionConfirm.confirm')}
      onConfirm={() => {
        // 先关弹窗再执行删除：deleteSession 同步销毁内存 store，
        // 磁盘/后端清理为 fire-and-forget（store 内 best-effort）。
        onCancel();
        deleteSession(target.sessionId);
      }}
      onCancel={onCancel}
    />
  );
}
