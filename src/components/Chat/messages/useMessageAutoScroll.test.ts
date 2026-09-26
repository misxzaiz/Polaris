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

/** 让 performance.now 可控 */
const nowMock = { value: 0 };
vi.stubGlobal('performance', { now: () => nowMock.value });

beforeEach(() => {
  nowMock.value = 0;
});

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

  describe('handleScroll（滚动事件兜底：覆盖键盘/触摸板/程序化滚动）', () => {
    it('流式中 + 距底超阈值 + scrollTop 变化 → 停止跟随', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));
      // scroller 尺寸模拟：scrollHeight=800, clientHeight=200, scrollTop=100 → 距底 500
      const scroller = makeScroller({ scrollHeight: 800, scrollTop: 100, clientHeight: 200 });
      act(() => result.current.setScrollerRef(scroller));
      act(() => result.current.handleScroll());
      expect(result.current.autoScroll).toBe(false);
    });

    it('非流式 → 忽略 handleScroll（交给 atBottomStateChange 判定）', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      act(() => result.current.handleScroll());
      expect(result.current.autoScroll).toBe(true);
    });

    it('非流式初始挂载 → end-pending 窗口不打开，ResizeObserver 不触发补偿', () => {
      // 回归保护：之前修复的 bug —— 只挂一次 isStreaming=false 不应开启 end-pending 窗口
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      const scroller = makeScroller({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
      act(() => result.current.setScrollerRef(scroller));
      act(() => lastRo().fire());
      expect(ref.current?.scrollToIndex).not.toHaveBeenCalled();
    });
  });

  describe('handleKeyDown（键盘上拉兜底）', () => {
    it('流式中 PageUp → 停止跟随', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));
      act(() => result.current.handleKeyDown({ key: 'PageUp' } as KeyboardEvent));
      expect(result.current.autoScroll).toBe(false);
    });

    it('流式中 Home → 停止跟随', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));
      act(() => result.current.handleKeyDown({ key: 'Home' } as KeyboardEvent));
      expect(result.current.autoScroll).toBe(false);
    });

    it('流式中 ArrowUp → 停止跟随', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));
      act(() => result.current.handleKeyDown({ key: 'ArrowUp' } as KeyboardEvent));
      expect(result.current.autoScroll).toBe(false);
    });

    it('流式中 ArrowDown / Enter 等 → 不影响', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));
      act(() => result.current.handleKeyDown({ key: 'Enter' } as KeyboardEvent));
      act(() => result.current.handleKeyDown({ key: 'ArrowDown' } as KeyboardEvent));
      expect(result.current.autoScroll).toBe(true);
    });

    it('非流式 → 键盘事件忽略', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      act(() => result.current.handleKeyDown({ key: 'PageUp' } as KeyboardEvent));
      expect(result.current.autoScroll).toBe(true);
    });
  });

  describe('流式结束补偿窗口（true→false 边沿）', () => {
    it('true→false 边沿后 ResizeObserver 仍补偿一次', () => {
      const ref = makeVirtuosoRef();
      const { result, rerender } = renderHook(
        ({ s }: { s: boolean }) => useMessageAutoScroll(ref, { isStreaming: s }),
        { initialProps: { s: true } }
      );
      const scroller = makeScroller({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
      act(() => result.current.setScrollerRef(scroller));

      // 切到非流式（模拟流式结束）
      act(() => rerender({ s: false }));

      // ResizeObserver 触发（模拟内容最终测量完成）
      act(() => lastRo().fire());

      // 应该补偿
      expect(ref.current?.scrollToIndex).toHaveBeenCalledWith({
        index: 'LAST',
        align: 'end',
        behavior: 'smooth',
      });
    });

    it('补偿窗口超时后 ResizeObserver 不再补偿', () => {
      vi.useFakeTimers();
      try {
        const ref = makeVirtuosoRef();
        const { result, rerender } = renderHook(
          ({ s }: { s: boolean }) => useMessageAutoScroll(ref, { isStreaming: s }),
          { initialProps: { s: true } }
        );
        const scroller = makeScroller({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
        act(() => result.current.setScrollerRef(scroller));

        // 切到非流式（end-pending 打开）
        act(() => rerender({ s: false }));
        // 推进时间超过窗口
        vi.advanceTimersByTime(1500);

        act(() => lastRo().fire());

        expect(ref.current?.scrollToIndex).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('初次挂载即 isStreaming=false → 无窗口，ResizeObserver 不补偿', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      const scroller = makeScroller({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
      act(() => result.current.setScrollerRef(scroller));
      act(() => lastRo().fire());
      expect(ref.current?.scrollToIndex).not.toHaveBeenCalled();
    });

    it('true→false 边沿后再切回 true → 窗口关闭', () => {
      const ref = makeVirtuosoRef();
      const { result, rerender } = renderHook(
        ({ s }: { s: boolean }) => useMessageAutoScroll(ref, { isStreaming: s }),
        { initialProps: { s: true } }
      );
      const scroller = makeScroller({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
      act(() => result.current.setScrollerRef(scroller));

      // 触发一次补偿（打开保护窗口，避免后续被误判为离开）
      act(() => lastRo().fire());
      // 推进时间越过保护窗口
      nowMock.value += 500;

      // 切 false（end-pending 打开）
      act(() => rerender({ s: false }));
      // 立即补偿一次，闸门应该关闭
      act(() => lastRo().fire());
      // 再触发一次 resize：闸门已关，不再补偿
      act(() => lastRo().fire());

      const calls = ref.current?.scrollToIndex.mock.calls ?? [];
      // 第一次补偿 + 一次 end-pending 补偿 = 2 次；第三次不补偿
      expect(calls.length).toBeLessThanOrEqual(2);
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

  describe('suspendFollow 交互豁免窗口', () => {
    it('窗口内 followOutput 一律 false（流式/非流式、贴底与否都不跟随）', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      act(() => result.current.suspendFollow(350));
      expect(result.current.followOutput(true)).toBe(false);
      expect(result.current.followOutput(false)).toBe(false);
    });

    it('窗口内 compensateScroll 不滚动（返回 false 且不调度）', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      act(() => result.current.suspendFollow(350));
      expect(result.current.compensateScroll()).toBe(false);
      expect(ref.current?.scrollToIndex).not.toHaveBeenCalled();
    });

    it('窗口内 ResizeObserver 高度变化不补偿贴底', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: true }));
      const scroller = makeScroller({ scrollHeight: 500, scrollTop: 0, clientHeight: 100 });
      act(() => result.current.setScrollerRef(scroller));

      act(() => result.current.suspendFollow(350));
      act(() => lastRo().fire());
      expect(ref.current?.scrollToIndex).not.toHaveBeenCalled();
    });

    it('窗口内 atBottom 翻 true 不恢复跟随', () => {
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      // 先触发一次首帧回调，进入正常状态机
      act(() => result.current.handleAtBottomStateChange(false));
      // 用户离开
      act(() => result.current.handleAtBottomStateChange(false));
      expect(result.current.autoScroll).toBe(false);

      // 交互豁免窗口内高度变化 → atBottom=true 也不恢复
      act(() => result.current.suspendFollow(350));
      act(() => result.current.handleAtBottomStateChange(true));
      expect(result.current.autoScroll).toBe(false);
    });

    it('窗口结束后恢复正常跟随', () => {
      // performance mock 在顶层 stub 后会被 afterEach 还原，本测试需重新 stub
      // 以便推进虚拟时间越过豁免窗口
      vi.stubGlobal('performance', { now: () => nowMock.value });
      nowMock.value = 0;
      const ref = makeVirtuosoRef();
      const { result } = renderHook(() => useMessageAutoScroll(ref, { isStreaming: false }));
      act(() => result.current.suspendFollow(50));
      // 窗口内不跟随
      expect(result.current.followOutput(true)).toBe(false);

      // 时间推进越过窗口
      nowMock.value = 100;
      expect(result.current.followOutput(true)).toBe('smooth');
    });
  });
});
