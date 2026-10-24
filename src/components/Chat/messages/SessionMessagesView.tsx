/**
 * SessionMessagesView - 多窗口专用的消息显示组件
 *
 * 直接使用 zustand store 订阅特定 session 的状态，避免复杂的 hook 链
 */

import { forwardRef, memo, useMemo, useRef, useCallback, useEffect, useState } from 'react';
import type { ComponentProps, MutableRefObject } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useConfigStore } from '@/stores/configStore';
import { useToastStore } from '@/stores/toastStore';
import { useSessionState } from '@/stores/conversationStore/useActiveSession';
import { renderChatMessage } from './renderChatMessage';
import type { MessageScrollActions, MessageActions } from './renderChatMessage';
import type { ChatMessage, AssistantChatMessage } from '@/types/chat';
import {
  findCurrentRoundIndexForRange,
  getRoundScrollTargetIndex,
  groupConversationRounds,
} from '@/utils/conversationRounds';
import { ThinkingOrb } from '../common/ThinkingOrb';
import { ChatNavigator } from '../session/ChatNavigator';
import { DynamicIsland } from '../dynamic-island';
import { VIEWPORT_EXTENSION, FOOTER_SPACER_STYLE } from '../chatUtils/constants';
import { useMessageAutoScroll, BOTTOM_ANCHOR_EPSILON_PX } from './useMessageAutoScroll';
import { ScrollToBottomButton } from '../common/ScrollToBottomButton';
import { EmptyState as RichEmptyState } from '../common/EmptyState';
import { useKernelSessionState } from '@/session-v2/hooks/useKernelSessionState';
import { getKernel } from '@/session-v2/kernel/registry';
import { ChatScrollContext } from './ChatScrollContext';

// 模块级稳定空数组（useSessionState fallback 必须引用稳定）
const EMPTY_MESSAGES: ChatMessage[] = [];

// 批 6（审计 5.11）：空态从一行字升级为富引导（common/EmptyState——Bot 图标 +
// 三特性卡片，此前是死代码从未渲染）。Virtuoso EmptyPlaceholder 承接，整树不卸载。
const EmptyState = RichEmptyState;

interface SessionMessagesViewProps {
  sessionId: string;
  /** 编辑消息回调 */
  onEditMessage?: (messageId: string, content: string) => void;
}

export const SessionMessagesView = memo(function SessionMessagesView({ sessionId, onEditMessage }: SessionMessagesViewProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [currentRoundIndex, setCurrentRoundIndex] = useState(0);
  const collapseMode = useConfigStore((s) => s.config?.chatDisplay?.processBlockCollapse ?? 'auto');

  // 直接订阅特定 session store 的状态
  const messages = useSessionState(
    sessionId,
    useCallback((state) => state.messages, []),
    EMPTY_MESSAGES
  );

  const currentMessage = useSessionState(
    sessionId,
    useCallback((state) => state.currentMessage, []),
    null
  );

  const isStreaming = useSessionState(
    sessionId,
    useCallback((state) => state.isStreaming, []),
    false
  );

  // 流式状态后端权威（滚动层数据源，不再以本地 isStreaming 为准）
  const { isStreaming: kernelStreaming } = useKernelSessionState(sessionId);
  const scrollIsStreaming = isStreaming || kernelStreaming;

  // 可见区域锚点（滚动位置恢复用）
  const visibleRange = useSessionState(
    sessionId,
    useCallback((state) => state.visibleRange, []),
    null as { start: number; end: number } | null
  );



  // 合并流式消息到消息列表
  // 注意：合并条件用 scrollIsStreaming（含后端权威 kernelStreaming），与滚动层一致。
  // 仅看本地 isStreaming 会在 error/resume-gap 等路径上出现"本地已 false 但 currentMessage
  // 未归档、kernel 仍 running"的中间态，导致 displayMessages 退化丢弃流式消息。
  const displayMessages = useMemo(() => {
    if (!currentMessage || !scrollIsStreaming) {
      return messages;
    }

    // 检查 currentMessage 是否已在 messages 中
    const existingIndex = messages.findIndex((m: ChatMessage) => m.id === currentMessage.id);

    if (existingIndex >= 0) {
      // 更新已存在的消息
      const updated: ChatMessage[] = [
        ...messages.slice(0, existingIndex),
        {
          ...messages[existingIndex],
          engineId: currentMessage.engineId,
          blocks: currentMessage.blocks,
          isStreaming: true,
        } as AssistantChatMessage,
        ...messages.slice(existingIndex + 1),
      ];
      return updated;
    } else {
      // 添加到末尾
      return [...messages, {
        id: currentMessage.id,
        type: 'assistant' as const,
        engineId: currentMessage.engineId,
        blocks: currentMessage.blocks,
        timestamp: new Date().toISOString(),
        isStreaming: true,
      }];
    }
  }, [messages, currentMessage, scrollIsStreaming]);

  const isEmpty = displayMessages.length === 0;
  // PENDING 状态：已发送消息、正在等待首 token
  const isPending = isStreaming && !currentMessage;

  // ===== 滚动位置恢复锚点 =====
  const atBottomOnMount = !visibleRange || visibleRange.end >= displayMessages.length - 1;
  const restoreIndex = visibleRange && !atBottomOnMount
    ? Math.min(visibleRange.start, displayMessages.length - 1)
    : displayMessages.length - 1;

  // ===== 锚点模式自动滚动（useMessageAutoScroll）=====
  // 消灭 150px 死区（atBottomThreshold→4），followOutput 回调精确跟随：
  // 流式期间始终贴底（内容向上生长），非流式仅在「跟随态&&贴底」时跟随；
  // 用户主动上滑才停止跟随（handleWheel），内容高度增长不误判为用户离开；
  // 流式结束/内容测量完成后 compensateScroll 补偿贴底。
  const scrollState = useMessageAutoScroll(virtuosoRef, { isStreaming: scrollIsStreaming, initialAutoScroll: atBottomOnMount });
  const { autoScroll, followOutput, handleAtBottomStateChange, handleWheel, handleScroll, handleKeyDown, setAutoScroll, compensateScroll, setScrollerRef, suspendFollow } = scrollState;

  // 流式结束 / 内容变化后补偿一次贴底（锚点模式核心：测量完成后主动贴底）
  useEffect(() => {
    if (!isStreaming && autoScroll) {
      compensateScroll();
    }
    // 依赖 displayMessages 末尾消息内容长度：流式结束归档后补偿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  // 对话轮次分组
  const conversationRounds = useMemo(() => {
    return groupConversationRounds(displayMessages);
  }, [displayMessages]);

  // 可见范围变化时更新当前轮次
  const handleRangeChange = useCallback((range: { startIndex: number; endIndex: number }) => {
    const target = findCurrentRoundIndexForRange(conversationRounds, range.startIndex, range.endIndex);
    if (target >= 0) setCurrentRoundIndex(target);
  }, [conversationRounds]);

  // 滚动到指定轮次
  const scrollToRound = useCallback((roundIndex: number) => {
    const round = conversationRounds[roundIndex];
    if (!round || !virtuosoRef.current) return;

    const targetIndex = getRoundScrollTargetIndex(round);
    if (targetIndex === null) return;

    virtuosoRef.current.scrollToIndex({
      index: targetIndex,
      align: 'start',
      behavior: 'smooth',
    });

    setAutoScroll(false);
    setCurrentRoundIndex(roundIndex);
  }, [conversationRounds, setAutoScroll]);

  // 滚动到指定消息
  const scrollToMessage = useCallback((index: number) => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollToIndex({
      index,
      align: 'start',
      behavior: 'smooth',
    });
    setAutoScroll(false);
  }, [setAutoScroll]);

  // 滚动到顶部
  const scrollToTop = useCallback(() => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollToIndex({
      index: 0,
      align: 'start',
      behavior: 'smooth',
    });
    setAutoScroll(false);
  }, [setAutoScroll]);

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    if (!virtuosoRef.current) return;
    virtuosoRef.current.scrollTo({
      top: Number.MAX_SAFE_INTEGER,
      behavior: 'smooth',
    });
    setAutoScroll(true);
  }, [setAutoScroll]);

  // 消息滚动操作集合
  const scrollActions = useMemo<MessageScrollActions>(() => ({
    scrollToMessage,
    scrollToTop,
    scrollToBottom,
  }), [scrollToMessage, scrollToTop, scrollToBottom]);

  // 消息操作
  // 重新生成：直连 kernel（委托该会话 store 的 regenerateResponse，内部含流式守卫）。
  // 此前 messageActions 只构造 onEdit，AssistantBubble 的 onRegenerate 分支永远不渲染，
  // 后端链路就绪的能力从未暴露到 UI（审计 5.5）。按显式 sessionId 调用，
  // 多开格中的后台会话也能在格内重新生成。
  const handleRegenerateMessage = useCallback((messageId: string) => {
    void getKernel().then((kernel) => kernel.regenerate(sessionId, messageId))
  }, [sessionId]);

  // 编辑入口守卫：流式中进入编辑态后，发送会被 store 静默拒绝并清空输入（审计 5.4）。
  // 在入口拦截并提示，避免用户白改一通后丢失。ChatInput 侧还有第二道发送时守卫。
  const handleEditGuarded = useCallback((messageId: string, content: string) => {
    if (scrollIsStreaming) {
      useToastStore.getState().warning('回复进行中，暂不能编辑消息，请等回复结束')
      return
    }
    onEditMessage?.(messageId, content)
  }, [onEditMessage, scrollIsStreaming]);

  const messageActions = useMemo<MessageActions | undefined>(() => {
    return { onEdit: handleEditGuarded, onRegenerate: handleRegenerateMessage };
  }, [handleEditGuarded, handleRegenerateMessage]);

  // Scroller 包装：向上滚动=用户主动离开，通知锚点模式停止跟随；
  // onScroll 采样距底维护「落点裁决」（恢复跟随 / 流式中离开），滚动条拖动、
  // 触摸、键盘等无 wheel 事件的滚动也能被识别。
  // onKeyDown 键盘上拉（PageUp/Home/ArrowUp）兜底。
  // （组件内自持，稳定引用避免 Virtuoso 重渲染时整树卸载）
  // react-virtuoso 会给 Scroller 传 ref（内部 scrollerRef），须 forwardRef 转发，
  // 否则 virtuoso 拿不到 DOM（scrollerRef.current=null → 渲染崩溃）。
  const Scroller = useMemo(() => {
    const Scroller = forwardRef<HTMLDivElement, ComponentProps<'div'>>(
      ({ onScroll: _ignoredScroll, onWheel: _ignoredWheel, ...props }, ref) => (
        <div
          {...props}
          ref={(node) => {
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as MutableRefObject<HTMLDivElement | null>).current = node;
            setScrollerRef(node);
          }}
          onWheel={handleWheel}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
        />
      )
    );
    Scroller.displayName = 'AutoScrollScroller';
    return Scroller;
  }, [handleWheel, handleScroll, handleKeyDown, setScrollerRef]);

  return (
    <ChatScrollContext.Provider value={{ suspendFollow }}>
      <div className="h-full w-full relative">
        {/* 灵动岛：顶部居中浮动进度指示器，per-session（多窗口各自独立） */}
        <DynamicIsland sessionId={sessionId} />

        <Virtuoso
          ref={virtuosoRef}
          style={{ height: '100%' }}
          data={displayMessages}
          itemContent={(index, item) => {
            return renderChatMessage(item, index, scrollActions, messageActions, collapseMode);
          }}
          components={{
            // 空态用 EmptyPlaceholder 承接，避免 isEmpty 三元分支导致 Virtuoso 整树卸载重建
            EmptyPlaceholder: EmptyState,
            // Scroller 包装：向上滚动=用户主动离开，通知锚点模式停止跟随
            Scroller: Scroller,
            Footer: () => (
              <>
                {/* PENDING 状态：在用户消息下方显示 Polaris 旋转图标 + 轮播文案 */}
                {isPending && (
                  <ThinkingOrb isPending={isPending} compact={true} />
                )}
                <div style={FOOTER_SPACER_STYLE} />
              </>
            ),
          }}
          followOutput={followOutput}
          atBottomStateChange={handleAtBottomStateChange}
          atBottomThreshold={BOTTOM_ANCHOR_EPSILON_PX}
          rangeChanged={handleRangeChange}
          increaseViewportBy={VIEWPORT_EXTENSION}
          initialTopMostItemIndex={isEmpty ? 0 : restoreIndex}
        />

        {/* 回到底部常驻按钮（批 6，审计 5.11）：脱离跟随时显示——此前唯一入口埋在
            ChatNavigator 悬浮面板底部（需 hover 展开），且单轮会话完全不渲染导航，
            可发现性差。showNewIndicator=流式中且脱离跟随（有新内容正在生成）。 */}
        {!isEmpty && !autoScroll && (
          <ScrollToBottomButton
            onClick={scrollToBottom}
            showNewIndicator={scrollIsStreaming}
          />
        )}

        {/* 对话导航时间线 */}
        {!isEmpty && conversationRounds.length > 1 && (
          <ChatNavigator
            variant="timeline"
            rounds={conversationRounds}
            currentRoundIndex={currentRoundIndex}
            onScrollToBottom={scrollToBottom}
            onScrollToRound={scrollToRound}
          />
        )}

      </div>
    </ChatScrollContext.Provider>
  );
});
