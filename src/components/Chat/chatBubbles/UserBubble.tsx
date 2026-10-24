/**
 * 用户消息气泡组件
 */

import { memo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Code, FileText, File, Pencil, Copy, Check } from 'lucide-react';
import type { UserChatMessage } from '@/types';
import { formatFileSize, getFileIcon } from '@/types/attachment';
import { useToastStore } from '@/stores/toastStore';
import { MessageContextMenu } from '../chatBubbles/MessageContextMenu';

export const UserBubble = memo(function UserBubble({
  message,
  messageIndex,
  onScrollToMessage,
  onScrollToTop,
  onScrollToBottom,
  onEdit,
}: {
  message: UserChatMessage;
  messageIndex?: number;
  onScrollToMessage?: (index: number) => void;
  onScrollToTop?: () => void;
  onScrollToBottom?: () => void;
  onEdit?: (messageId: string, content: string) => void;
}) {
  const { t } = useTranslation('chat');

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
  } | null>(null);

  // 复制反馈状态
  const [copied, setCopied] = useState(false);

  // 右键事件处理 - 避免与文字选中冲突
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const selectedText = window.getSelection()?.toString().trim();

    // 有文字选中 → 不拦截，让全局 SelectionContextMenu 处理
    if (selectedText && selectedText.length > 0) {
      return;
    }

    // 无文字选中 → 显示消息菜单
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
    });
  }, []);

  // 关闭右键菜单
  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // 复制消息内容
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      // 此前静默吞错，用户以为复制成功（审计 5.11）
      useToastStore.getState().error(
        t('contextMenu.copyFailed', '复制失败'),
        e instanceof Error ? e.message : String(e)
      );
    }
  }, [message.content, t]);

  // 编辑消息
  const handleEdit = useCallback(() => {
    onEdit?.(message.id, message.content);
  }, [onEdit, message.id, message.content]);

  return (
    <>
      <div className="chat-user-message flex justify-end group" onContextMenu={handleContextMenu}>
        <div className="chat-user-bubble-wrap relative max-w-[85%]">
          {/* Hover 操作栏 - 始终显示复制按钮，有 onEdit 时显示编辑按钮。
              根因修复：原 -top-8 向上溢出，第一条消息上方是滚动容器
              overflow 裁剪区（scrollTop=0 无负向可视空间，仅 10px 消息间
              隙不够 32px），按钮被裁掉看不见。改放下方（列表底部有 120px
              footer spacer，末条/首条均安全）；-bottom-8 会溅溢到 virtuoso
              相邻后项区域内，DOM 在后绘制在上层，须加 z-10 反盖工具栏。 */}
          <div className="absolute -bottom-8 right-0 z-10 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
              title={copied ? t('contextMenu.copied') : t('contextMenu.copyMessage')}
            >
              {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
            </button>
            {onEdit && (
              <button
                onClick={handleEdit}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
                title={t('contextMenu.edit')}
              >
                <Pencil size={14} />
              </button>
            )}
          </div>
          <div className="chat-user-bubble
                      bg-gradient-to-br from-primary to-primary-600
                      text-white shadow-glow">
            {/* 附件列表 */}
            {message.attachments && message.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2 pb-2 border-b border-white/20">
                {message.attachments.map((att) => {
                  const iconType = getFileIcon(
                    att.type === 'image' ? 'image/png' : att.mimeType,
                    att.fileName
                  )
                  const IconComp = iconType === 'image' ? Image
                    : (iconType === 'code' || iconType === 'config') ? Code
                    : iconType === 'document' ? FileText
                    : File
                  return (
                    <div
                      key={att.id}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/15 text-xs"
                    >
                      <IconComp size={12} className="shrink-0 opacity-80" />
                      <span className="truncate max-w-[100px]">{att.fileName}</span>
                      <span className="opacity-60">{formatFileSize(att.fileSize)}</span>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="chat-user-text whitespace-pre-wrap break-words">
              {message.content}
            </div>
          </div>
        </div>
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <MessageContextMenu
          visible={contextMenu.visible}
          x={contextMenu.x}
          y={contextMenu.y}
          messageIndex={messageIndex}
          messageText={message.content}
          message={message}
          onScrollToMessage={onScrollToMessage}
          onScrollToTop={onScrollToTop}
          onScrollToBottom={onScrollToBottom}
          onClose={handleCloseContextMenu}
        />
      )}
    </>
  );
});
