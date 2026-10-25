/**
 * ChatNavigator 组件测试
 *
 * 覆盖悬停闪动修复（plans/chat-navigator-hover-flicker-fix.md）的关键行为：
 * - 悬停意图确认：hover 250ms 后才展开，快速掠过（<250ms 即离开）不弹；click 立即切换
 * - 定位/动画分离：animate-dialog-in 元素不携带定位 transform（translateY(-50%) 在
 *   外层 wrapper），动画 keyframes 不再覆盖居中定位导致面板跳位（闪动主因回归护栏）
 * - 零死区：timeline 面板 right:10px 与触发条 hover 区（right 2–10px）相接，
 *   从触发条移入面板不触发 150ms 回收
 * - 常规回收：离开触发条与面板 150ms 后关闭；点击轮次跳转并收起
 *
 * react-i18next 已在 src/test/setup.ts 全局 mock，t() 返回 key 本身。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ChatNavigator } from './ChatNavigator';
import type { ConversationRound } from '@/utils/conversationRounds';
import type { UserChatMessage } from '@/types';

function makeRounds(n: number): ConversationRound[] {
  return Array.from({ length: n }, (_, i) => ({
    roundIndex: i,
    userMessage: {
      id: `u-${i}`,
      type: 'user',
      content: `用户消息 ${i}`,
      timestamp: `2026-10-25T10:0${i}:00Z`,
    } satisfies UserChatMessage,
    userSummary: `round-user-${i}`,
    assistantSummary: `助手回复 ${i}`,
    hasTools: false,
    timestamp: `10:0${i}`,
    messageIndices: [i * 2],
  }));
}

function renderNavigator(props: Partial<React.ComponentProps<typeof ChatNavigator>> = {}) {
  const onScrollToRound = vi.fn();
  const onScrollToBottom = vi.fn();
  const utils = render(
    <ChatNavigator
      variant="timeline"
      rounds={makeRounds(3)}
      currentRoundIndex={0}
      onScrollToRound={onScrollToRound}
      onScrollToBottom={onScrollToBottom}
      {...props}
    />
  );
  return { ...utils, onScrollToRound, onScrollToBottom };
}

/** 触发条列容器（onMouseEnter/onClick 挂这层；圆点是它的子元素） */
const getTrigger = () => screen.getByTitle('round-user-0').parentElement as HTMLElement;

/** 定位内层面板（动画层，maxHeight 70vh）与其外层定位 wrapper */
function getPanelLayers() {
  const title = screen.getByText('navigator.title');
  let inner = title.parentElement as HTMLElement | null;
  while (inner && inner.style.maxHeight !== '70vh') {
    inner = inner.parentElement;
  }
  if (!inner) throw new Error('未找到内层面板（maxHeight: 70vh）');
  const wrapper = inner.parentElement as HTMLElement;
  return { inner, wrapper };
}

// jsdom 未实现 scrollIntoView，面板展开时 useEffect 会调用（滚动当前轮次到可视区）
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ChatNavigator 悬停展开时序', () => {
  it('hover 250ms 后才展开（悬停意图确认）', () => {
    renderNavigator();
    fireEvent.mouseEnter(getTrigger());
    expect(screen.queryByText('navigator.title')).toBeNull();

    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByText('navigator.title')).toBeInTheDocument();
  });

  it('快速掠过（<250ms 即离开）不弹面板', () => {
    renderNavigator();
    fireEvent.mouseEnter(getTrigger());
    act(() => vi.advanceTimersByTime(100));
    fireEvent.mouseLeave(getTrigger());
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByText('navigator.title')).toBeNull();
  });

  it('click 触发条立即展开（不等待意图延迟）', () => {
    renderNavigator();
    fireEvent.click(getTrigger());
    expect(screen.getByText('navigator.title')).toBeInTheDocument();
  });
});

describe('ChatNavigator 定位/动画分离（闪动主因回归护栏）', () => {
  it('animate-dialog-in 元素不携带定位 transform，居中定位在未动画的 wrapper 上', () => {
    renderNavigator();
    fireEvent.click(getTrigger());

    const { inner, wrapper } = getPanelLayers();
    expect(inner).toHaveClass('animate-dialog-in');
    // 动画层带 inline transform 会被 dialog-in keyframes 覆盖，动画结束回落时跳位
    expect(inner.style.transform).toBe('');
    expect(wrapper.style.transform).toBe('translateY(-50%)');
    expect(wrapper.className).not.toContain('animate-dialog-in');
  });

  it('timeline 面板右缘与触发条零死区相接（right:10px）', () => {
    renderNavigator();
    fireEvent.click(getTrigger());

    const { wrapper } = getPanelLayers();
    expect(wrapper.style.right).toBe('10px');
  });
});

describe('ChatNavigator 面板悬停保持与回收', () => {
  it('从触发条移入面板不中途回收（零死区）', () => {
    renderNavigator();
    fireEvent.mouseEnter(getTrigger());
    act(() => vi.advanceTimersByTime(250));
    const { wrapper } = getPanelLayers();

    fireEvent.mouseLeave(getTrigger());
    fireEvent.mouseEnter(wrapper);
    act(() => vi.advanceTimersByTime(300)); // > HIDE_DELAY(150ms)
    expect(screen.getByText('navigator.title')).toBeInTheDocument();
  });

  it('离开触发条与面板 150ms 后关闭', () => {
    renderNavigator();
    fireEvent.mouseEnter(getTrigger());
    act(() => vi.advanceTimersByTime(250));
    const { wrapper } = getPanelLayers();

    fireEvent.mouseLeave(getTrigger());
    fireEvent.mouseEnter(wrapper);
    fireEvent.mouseLeave(wrapper);
    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByText('navigator.title')).toBeNull();
  });

  it('点击轮次项触发 onScrollToRound 并收起面板', () => {
    const { onScrollToRound } = renderNavigator();
    fireEvent.click(getTrigger());

    fireEvent.click(screen.getByText('round-user-1'));
    expect(onScrollToRound).toHaveBeenCalledWith(1);
    expect(screen.queryByText('navigator.title')).toBeNull();
  });

  it('无轮次且无扩展槽时不渲染', () => {
    const { container } = renderNavigator({ rounds: [] });
    expect(container.innerHTML).toBe('');
  });
});
