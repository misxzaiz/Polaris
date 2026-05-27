/**
 * 用户消息气泡组件
 */

import { memo, useState, useCallback } from 'react';
import { Image, Code, FileText, File } from 'lucide-react';
import type { UserChatMessage } from '@/types';
import { formatFileSize, getFileIcon } from '@/types/attachment';
import { MessageContextMenu } from '../chatBubbles/MessageContextMenu';

export const UserBubble = memo(function UserBubble({
  message,
  messageIndex,
  onScrollToMessage,
  onScrollToTop,
  onScrollToBottom,
}: {
  message: UserChatMessage;
  messageIndex?: number;
  onScrollToMessage?: (index: number) => void;
  onScrollToTop?: () => void;
  onScrollToBottom?: () => void;
}) {
  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
  } | null>(null);

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

  return (
    <>
      <div className="flex justify-end my-2" onContextMenu={handleContextMenu}>
        <div className="max-w-[85%] px-4 py-3 rounded-2xl
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
          <div className="text-sm leading-relaxed whitespace-pre-wrap">
            {message.content}
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
          onScrollToMessage={onScrollToMessage}
          onScrollToTop={onScrollToTop}
          onScrollToBottom={onScrollToBottom}
          onClose={handleCloseContextMenu}
        />
      )}
    </>
  );
});
