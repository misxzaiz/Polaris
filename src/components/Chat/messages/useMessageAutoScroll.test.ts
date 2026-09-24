/**
 * useMessageAutoScroll - 锚点模式自动滚动 hook 测试
 *
 * 覆盖两类核心逻辑：
 *  1. followOutput / handleAtBottomStateChange / handleWheel 的跟随状态机
 *  2. 流式中途贴底增强：ResizeObserver 监听内容高度，跟随态+流式中+距底超阈值
 *     → 调度 scrollToIndex('LAST')（本次 bug 修复的关键路径）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import { useRef } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import { useMessageAutoScroll, AUTO_SCROLL_THRESHOLD } from './useMessageAutoScroll';

// ============================================================
// 全局 mock
// ============================================================

/** jsdom 无 ResizeObserver，用可控 mock：记录实例供测试触发回调 */
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  callback: ResizeObserverCallback;
  observed: Element[] = [];
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
    MockResizeObserver.instances.push(this);
  }
  observe(el: Element) { this.observed.push(el); }
  unobserve() {}
  disconnect() { this.observed = []; }
  /** 测试辅助：触发一次回调 */
  fire() { this.callback([], this as unknown as ResizeObserver); }
}

/** rAF 立即执行，让补偿滚动同步完成（确定性断言） */
const rafMock = vi.fn((cb: FrameRequestCallback) => {
  cb(0);
  return 1;
});
const cafMock = vi.fn(() => {});

beforeEach(() => {
  MockResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  vi.stubGlobal('requestAnimationFrame', rafMock);
  vi.stubGlobal('cancelAnimationFrame', cafMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================================================
// 工具函数
// ============================================================

/** 构造一个带可控 scroll 尺寸的 div */
function makeScroller(opts: { scrollHeight?: number; scrollTop?: number; clientHeight?: number } = {}) {
  const div = document.createElement('div');
  const { scrollHeight = 500, scrollTop = 0, clientHeight = 100 } = opts;
  Object.defineProperty(div, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(div, 'scrollTop', { value: scrollTop, configurable: true, writable: true });
  Object.defineProperty(div, 'clientHeight', { value: clientHeight, configurable: true });
  // firstElementChild 给 ResizeObserver 观察
  const list = document.createElement('div');
  div.appendChild(list);
  return div;
}

/** 构造可注入 Virtuoso 的 ref（含 spy 的 scrollToIndex/scrollTo） */
function makeVirtuosoRef() {
  const ref: RefObject<VirtuosoHandle | null> = {
    current: {
      scrollToIndex: vi.fn(),
      scrollTo: vi.fn(),
    },
  };
  return ref;
}

/** 拿到测试期间创建的最后一个 ResizeObserver */
function lastRo() {
  const ro = MockResizeObserver.instances.at(-1);
  expect(ro).toBeDefined();
  return ro!;
}

// ============================================================
// 测试
// ============================================================

describe('useMessageAutoScroll', () => {
  describe('followOutput 状态机', () => {
    it('流式 + 跟随态 → true（立即贴底，内容向上生长不中断）', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));
      expect(result.current.followOutput(true)).toBe(true);
      expect(result.current.followOutput(false)).toBe(true);
    });

    it('非流式 + 跟随态 + 贴底 → smooth', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      expect(result.current.followOutput(true)).toBe('smooth');
    });

    it('非流式 + 跟随态 + 离开底部 → false', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      expect(result.current.followOutput(false)).toBe(false);
    });

    it('非跟随态 → 一律 false（用户已离开，绝不被拉回）', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));
      act(() => result.current.setAutoScroll(false));
      expect(result.current.followOutput(true)).toBe(false);
      expect(result.current.followOutput(false)).toBe(false);
    });
  });

  describe('handleAtBottomStateChange', () => {
    it('首帧回调忽略（冷启动测量误差防护）', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref));
      act(() => result.current.handleAtBottomStateChange(false));
      // 首帧被忽略，autoScroll 保持初始值 true
      expect(result.current.autoScroll).toBe(true);
    });

    it('翻转为 true → 恢复跟随', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      // 先消费首帧
      act(() => result.current.handleAtBottomStateChange(false));
      act(() => result.current.handleAtBottomStateChange(false));
      expect(result.current.autoScroll).toBe(false);
      act(() => result.current.handleAtBottomStateChange(true));
      expect(result.current.autoScroll).toBe(true);
    });

    it('非流式翻转为 false → 停止跟随（用户主动离开）', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      act(() => result.current.handleAtBottomStateChange(false)); // 消费首帧
      act(() => result.current.handleAtBottomStateChange(false));
      expect(result.current.autoScroll).toBe(false);
    });

    it('流式翻转为 false → 忽略（内容增长不误判为用户离开）', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));
      act(() => result.current.handleAtBottomStateChange(false)); // 消费首帧
      act(() => result.current.handleAtBottomStateChange(false));
      expect(result.current.autoScroll).toBe(true);
    });
  });

  describe('handleWheel', () => {
    it('向上滚动（deltaY<0）→ 停止跟随', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref));
      act(() => result.current.handleWheel({ deltaY: -1 }));
      expect(result.current.autoScroll).toBe(false);
    });

    it('向下滚动（deltaY>0）→ 不停止跟随', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref));
      act(() => result.current.handleWheel({ deltaY: 1 }));
      expect(result.current.autoScroll).toBe(true);
    });
  });

  // ============================================================
  // 流式中途贴底增强（本次 bug 修复）
  // ============================================================
  describe('流式中途贴底增强', () => {
    it('跟随态 + 流式中 + 距底超阈值 → 自动贴底（scrollToIndex LAST）', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));

      // 距底 = scrollHeight - (scrollTop + clientHeight) = 500 - (0 + 100) = 400 > 40
      const scroller = makeScroller({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
      act(() => result.current.setScrollerRef(scroller));

      // 内容高度变化触发 ResizeObserver
      act(() => lastRo().fire());

      expect(ref.current?.scrollToIndex).toHaveBeenCalledWith({
        index: 'LAST',
        align: 'end',
        behavior: 'auto',
      });
    });

    it('用户上滑离开后 → 不再自动贴底', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));
      const scroller = makeScroller({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
      act(() => result.current.setScrollerRef(scroller));

      // 用户向上滚动 → 停止跟随
      act(() => result.current.handleWheel({ deltaY: -1 }));

      // 内容继续增长触发 observer
      act(() => lastRo().fire());

      expect(ref.current?.scrollToIndex).not.toHaveBeenCalled();
    });

    it('非流式 → 内容增长不自动贴底（避免误拉）', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      const scroller = makeScroller({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
      act(() => result.current.setScrollerRef(scroller));

      act(() => lastRo().fire());

      expect(ref.current?.scrollToIndex).not.toHaveBeenCalled();
    });

    it('流式中途但距底未超阈值 → 不贴底（微增不抖动）', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));
      // 距底 = 120 - (100 + 5) = 15 < 40，不触发
      const scroller = makeScroller({ scrollHeight: 120, scrollTop: 100, clientHeight: 5 });
      act(() => result.current.setScrollerRef(scroller));

      act(() => lastRo().fire());

      expect(ref.current?.scrollToIndex).not.toHaveBeenCalled();
    });

    it('跟随态 + 流式中 + 距底超阈值 → 连续触发时 rAF 合并只滚一次', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));
      const scroller = makeScroller({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
      act(() => result.current.setScrollerRef(scroller));

      // 连续两次 observer 触发（模拟每 token 高度变化）
      act(() => lastRo().fire());
      act(() => lastRo().fire());

      // rAF 合并：scheduleCompensate 在 rAF 未执行前防重入
      expect(ref.current?.scrollToIndex).toHaveBeenCalledTimes(1);
    });

    it('流式结束后仍处跟随态 → compensateScroll 补偿贴底（smooth）', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      act(() => result.current.compensateScroll());
      expect(ref.current?.scrollToIndex).toHaveBeenCalledWith({
        index: 'LAST',
        align: 'end',
        behavior: 'smooth',
      });
    });

    it('卸载时清理 observer，不再触发', () => {
      const ref = makeVirtuosoRef();
      const { result, unmount } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));
      const scroller = makeScroller({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
      act(() => result.current.setScrollerRef(scroller));

      const ro = lastRo();
      const disconnectSpy = vi.spyOn(ro, 'disconnect');
      unmount();

      expect(disconnectSpy).toHaveBeenCalled();
    });
  });
});
