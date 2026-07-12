/**
 * 聊天导航组件
 *
 * 功能：
 * - 右侧进度条显示当前位置
 * - 悬停展开对话目录
 * - 点击对话轮次快速跳转
 * - 一键回到底部
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { BookOpen, User, Bot, ArrowDown, Wrench } from 'lucide-react';
import type { ConversationRound } from '@/utils/conversationRounds';
import { useWindowSize } from '@/hooks/useWindowSize';

interface ChatNavigatorProps {
  /** 对话轮次列表 */
  rounds: ConversationRound[];
  /** 当前可见的轮次索引 */
  currentRoundIndex: number;
  /** 回到底部回调 */
  onScrollToBottom: () => void;
  /** 滚动到指定轮次 */
  onScrollToRound: (roundIndex: number) => void;
}

/** 延迟隐藏时间（毫秒） */
const HIDE_DELAY = 150;

/** 悬停展开延迟（毫秒） */
const SHOW_DELAY = 0;

export function ChatNavigator({
  rounds,
  currentRoundIndex,
  onScrollToBottom,
  onScrollToRound,
}: ChatNavigatorProps) {
  const { t } = useTranslation('chat');
  const { isCompact } = useWindowSize({ compactThreshold: 500 });
  const [isPanelVisible, setIsPanelVisible] = useState(false);

  // 使用 ref 存储悬停状态，避免闭包陷阱
  const isHoveringRef = useRef(false);
  const isHoveringPanelRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 当前高亮项的 ref，用于自动滚动到可视区域
  const currentItemRef = useRef<HTMLDivElement>(null);

  // 清除所有定时器
  const clearTimers = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  // 隐藏面板（带延迟）
  const scheduleHide = useCallback(() => {
    clearTimers();
    hideTimerRef.current = setTimeout(() => {
      // 直接读取 ref 的当前值，不依赖闭包
      if (!isHoveringRef.current && !isHoveringPanelRef.current) {
        setIsPanelVisible(false);
      }
    }, HIDE_DELAY);
  }, [clearTimers]);

  // 显示面板（带延迟）
  const scheduleShow = useCallback(() => {
    clearTimers();
    showTimerRef.current = setTimeout(() => {
      setIsPanelVisible(true);
    }, SHOW_DELAY);
  }, [clearTimers]);

  // 悬浮球悬停处理
  const handleFloatingBallMouseEnter = useCallback(() => {
    isHoveringRef.current = true;
    scheduleShow();
  }, [scheduleShow]);

  const handleFloatingBallMouseLeave = useCallback(() => {
    isHoveringRef.current = false;
    scheduleHide();
  }, [scheduleHide]);

  // 面板悬停处理
  const handlePanelMouseEnter = useCallback(() => {
    isHoveringPanelRef.current = true;
    clearTimers();
  }, [clearTimers]);

  const handlePanelMouseLeave = useCallback(() => {
    isHoveringPanelRef.current = false;
    scheduleHide();
  }, [scheduleHide]);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  // 面板定位：相对当前聊天消息区域定位，避免在弹窗场景跑到窗口边缘
  const panelStyle = useMemo(() => {
    if (isCompact) {
      return {
        right: '8px',
        left: '8px',
        top: 'auto',
        bottom: '60px',
        maxHeight: '50vh',
      };
    }
    return {
      right: '24px',
      top: '50%',
      transform: 'translateY(-50%)',
      maxHeight: '70vh',
    };
  }, [isCompact]);

  // 当面板显示或当前项变化时，滚动到当前项
  useEffect(() => {
    if (isPanelVisible && currentItemRef.current) {
      currentItemRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [isPanelVisible, currentRoundIndex]);

  // 点击对话轮次
  const handleRoundClick = useCallback((roundIndex: number) => {
    onScrollToRound(roundIndex);
    setIsPanelVisible(false);
  }, [onScrollToRound]);

  // 点击回到底部
  const handleScrollToBottom = useCallback(() => {
    onScrollToBottom();
    setIsPanelVisible(false);
  }, [onScrollToBottom]);

  // 触摸/点击切换面板
  const handleFloatingBallClick = useCallback(() => {
    setIsPanelVisible(prev => !prev);
  }, []);

  // 点击面板外部关闭（触摸模式）
  const floatingBallRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isPanelVisible || !isCompact) return;
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      const inFloatingBall = floatingBallRef.current?.contains(target) ?? false;
      const inPanel = panelRef.current?.contains(target) ?? false;

      if (!inFloatingBall && !inPanel) {
        setIsPanelVisible(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isPanelVisible, isCompact]);

  if (rounds.length === 0) {
    return null;
  }

  return (
    <div className="absolute inset-0 pointer-events-none z-40">
      {/* 贴边悬浮球 - 位于当前聊天区域右边缘 */}
      <div
        ref={floatingBallRef}
        className={clsx(
          'absolute right-0 top-1/2 -translate-y-1/2',
          // 尺寸：紧凑模式更大方便触摸
          isCompact ? 'w-9 h-9 rounded-l-xl' : 'w-7 h-12 rounded-l-xl',
          // 实心背景
          'bg-[#1A1A1F]',
          'border border-border/50 border-r-0',
          'shadow-lg shadow-black/5',
          // 内容布局
          'flex items-center justify-center',
          // 交互
          'pointer-events-auto cursor-pointer transition-all duration-150',
          'group',
          // 悬停状态
          isPanelVisible
            ? 'bg-[#22222A] shadow-xl'
            : 'hover:bg-[#22222A] hover:shadow-xl'
        )}
        onMouseEnter={handleFloatingBallMouseEnter}
        onMouseLeave={handleFloatingBallMouseLeave}
        onClick={handleFloatingBallClick}
        title={t('navigator.title')}
      >
        {/* 列表图标 - 表示对话轮次 */}
        <div className={clsx(
          'w-4 h-4 flex flex-col items-center justify-center gap-0.5',
          'transition-transform duration-200',
          isPanelVisible ? 'scale-110' : 'group-hover:scale-110'
        )}>
          {/* 数字列表样式 */}
          <div className="flex items-center gap-1 w-full">
            <div className="w-1 h-1 bg-text-secondary rounded-full" />
            <div className="flex-1 h-0.5 bg-text-muted rounded" />
          </div>
          <div className="flex items-center gap-1 w-full">
            <div className="w-1 h-1 bg-text-tertiary rounded-full" />
            <div className="w-2.5 h-0.5 bg-text-muted rounded" />
          </div>
          <div className="flex items-center gap-1 w-full">
            <div className="w-1 h-1 bg-text-tertiary rounded-full" />
            <div className="w-2 h-0.5 bg-text-muted rounded" />
          </div>
        </div>
      </div>

      {/* 悬浮面板 */}
      {isPanelVisible && (
        <div
          ref={panelRef}
          className={clsx(
            isCompact
              ? 'w-auto bg-[#1A1A1F]'
              : 'w-56 bg-[#1A1A1F]',
            'border border-border rounded-lg shadow-lg shadow-primary/10',
            'overflow-hidden animate-in fade-in zoom-in-95 duration-150',
            'pointer-events-auto flex flex-col',
            'absolute z-50'
          )}
          style={panelStyle}
          onMouseEnter={handlePanelMouseEnter}
          onMouseLeave={handlePanelMouseLeave}
        >
          {/* 标题 */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle bg-[#25252B] shrink-0">
            <span className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5" />
              {t('navigator.title')}
            </span>
            <span className="text-xs text-text-tertiary">
              {rounds.length} {t('navigator.round')}
            </span>
          </div>

          {/* 对话轮次列表 */}
          <div className="overflow-y-auto chat-navigator-list flex-1 min-h-0 bg-[#1A1A1F]">
            {rounds.map((round, idx) => (
              <div
                key={round.roundIndex}
                ref={idx === currentRoundIndex ? currentItemRef : null}
                className={clsx(
                  'px-3 py-2 border-b border-border-subtle/50 cursor-pointer transition-colors',
                  'hover:bg-[#2D2D35]',
                  idx === currentRoundIndex && 'bg-primary/10 border-l-2 border-l-primary'
                )}
                onClick={() => handleRoundClick(idx)}
              >
                {/* 轮次标题 */}
                <div className="flex items-center gap-2 mb-1">
                  <span className={clsx(
                    'text-xs font-medium',
                    idx === currentRoundIndex ? 'text-primary' : 'text-text-tertiary'
                  )}>
                    {t('navigator.roundLabel', { round: round.roundIndex + 1 })}
                  </span>
                  {round.hasTools && (
                    <Wrench className="w-3 h-3 text-warning" />
                  )}
                  <span className="text-xs text-text-tertiary ml-auto">
                    {round.timestamp}
                  </span>
                </div>

                {/* 用户消息 */}
                <div className="flex items-start gap-1.5 mb-1">
                  <User className="w-3 h-3 text-text-secondary shrink-0 mt-0.5" />
                  <p className="text-xs text-text-secondary line-clamp-1">
                    {round.userSummary}
                  </p>
                </div>

                {/* 助手回复 */}
                {round.assistantMessage ? (
                  <div className="flex items-start gap-1.5">
                    <Bot className="w-3 h-3 text-primary shrink-0 mt-0.5" />
                    <p className={clsx(
                      'text-xs line-clamp-1',
                      idx === currentRoundIndex ? 'text-text-primary' : 'text-text-tertiary'
                    )}>
                      {round.assistantSummary || t('navigator.replying')}
                    </p>
                  </div>
                ) : (
                  <div className="flex items-start gap-1.5">
                    <Bot className="w-3 h-3 text-text-tertiary shrink-0 mt-0.5" />
                    <p className="text-xs text-text-tertiary italic">
                      {t('navigator.waitingReply')}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 底部按钮 */}
          <div className="p-2 border-t border-border-subtle bg-[#25252B] shrink-0">
            <button
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-text-secondary hover:text-primary hover:bg-primary/10 rounded-md transition-colors"
              onClick={handleScrollToBottom}
            >
              <ArrowDown className="w-4 h-4" />
              {t('navigator.scrollToBottom')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
