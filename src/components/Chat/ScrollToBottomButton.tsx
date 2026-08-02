/**
 * 回到底部悬浮按钮
 *
 * 当用户向上滚动离开消息列表底部时显示，点击平滑滚回底部。
 * 流式输出且不在底部时，右上角脉冲点提示有新内容正在生成。
 *
 * 设计意图：
 * - 现有"回到底部"入口埋在 ChatNavigator 悬浮面板底部（需 hover 展开 + 点击），
 *   可发现性差。本组件提供始终可见、一键直达的独立入口。
 * - 复用 navigator.scrollToBottom 文案，不新增 i18n。
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown } from 'lucide-react';
import { clsx } from 'clsx';

interface ScrollToBottomButtonProps {
  /** 点击回到底部 */
  onClick: () => void;
  /** 是否提示有新内容（流式输出中且不在底部） */
  showNewIndicator?: boolean;
}

export const ScrollToBottomButton = memo(function ScrollToBottomButton({
  onClick,
  showNewIndicator = false,
}: ScrollToBottomButtonProps) {
  const { t } = useTranslation('chat');

  return (
    <button
      type="button"
      onClick={onClick}
      title={t('navigator.scrollToBottom')}
      aria-label={t('navigator.scrollToBottom')}
      className={clsx(
        'absolute bottom-4 right-4 z-30',
        'flex items-center justify-center',
        'w-9 h-9 rounded-full',
        'bg-[#22222A] border border-border/60',
        'text-text-secondary hover:text-primary',
        'shadow-lg shadow-black/20 hover:shadow-xl',
        'pointer-events-auto cursor-pointer',
        'transition-all duration-150 hover:scale-105',
        'animate-in fade-in zoom-in-95 duration-200'
      )}
    >
      <ArrowDown className="w-4 h-4" />
      {/* 新内容提示脉冲点 */}
      {showNewIndicator && (
        <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-ping" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
        </span>
      )}
    </button>
  );
});
