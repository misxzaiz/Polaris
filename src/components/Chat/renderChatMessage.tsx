/**
 * 消息渲染器 + 滚动操作类型
 */

import React from 'react';
import type { ChatMessage, SystemChatMessage } from '@/types';
import { UserBubble } from './chatBubbles/UserBubble';
import { AssistantBubble } from './chatBubbles/AssistantBubble';
import { SystemBubble } from './chatBubbles/SystemBubble';

/** 消息滚动操作集合 */
export interface MessageScrollActions {
  scrollToMessage: (index: number) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
}

/** 消息操作集合 */
export interface MessageActions {
  onEdit?: (messageId: string, content: string) => void;
  onRegenerate?: (messageId: string) => void;
}

/** 消息渲染器 */
export function renderChatMessage(
  message: ChatMessage,
  messageIndex: number | undefined,
  scrollActions: MessageScrollActions | undefined,
  messageActions?: MessageActions,
): React.ReactNode {
  switch (message.type) {
    case 'user':
      return (
        <UserBubble
          key={message.id}
          message={message}
          messageIndex={messageIndex}
          onScrollToMessage={scrollActions?.scrollToMessage}
          onScrollToTop={scrollActions?.scrollToTop}
          onScrollToBottom={scrollActions?.scrollToBottom}
          onEdit={messageActions?.onEdit}
        />
      );
    case 'assistant':
      return (
        <AssistantBubble
          key={message.id}
          message={message}
          messageIndex={messageIndex}
          onScrollToMessage={scrollActions?.scrollToMessage}
          onScrollToTop={scrollActions?.scrollToTop}
          onScrollToBottom={scrollActions?.scrollToBottom}
          onRegenerate={messageActions?.onRegenerate}
        />
      );
    case 'system':
      return <SystemBubble key={message.id} content={(message as SystemChatMessage).content} />;
    default:
      return null;
  }
}
