/**
 * useMessageAutoScroll - 聊天消息列表的「锚点模式」自动滚动 hook
 *
 * 解决的问题：react-virtuoso 的 followOutput 事件驱动单次滚动 + atBottomThreshold=150
 * 模糊判定，导致 AI 长回复「高度一次性剧变」时被误判/或停在长消息中间不再贴底
 * （官方 issue #1105 亦确认该 bug）。
 *
 * 锚点模式核心思路（对应 PRD 交互原型 v2）：
 *  - 消灭「150px 死区」：atBottomThreshold 收敛到接近默认的 4px，贴底判定精确。
 *  - followOutput 改用回调形式精确决策：
 *      · 流式期间 + 跟随态   → 返回 true（立即贴底，内容向上生长不中断）；
 *      · 非流式 + 跟随态     → 贴底时 'smooth'，离开则不滚；
 *      · autoScroll=false     → 一律 false（用户已离开，不再拉回）。
 *  - 只有用户主动滚动才停止跟随：handleWheel 检测向上滚动→停；内容高度增长
 *    产生的 atBottom 翻转在流式期间被忽略，不误判为用户离开。
 *  - 流式结束补偿：内容测量完成后主动贴底一次，避免停在旧估算高度的中间。
 *
 * 流式中途贴底增强（2026-09-23 实测补漏）：
 *  Virtuoso 的 followOutput 只在「atBottom 翻转」时触发一次，内容一次性大幅增长
 *  （长回复单 commit +几千 px）会把 atBottom 打翻为 false，之后 followOutput 不再
 *  跟随，视口停在中间直到流式结束才被结束补偿拉回。实测轨迹里 gap 一度涨到
 *  5476px（见 memory/message-autoscroll-anchor-mode.md）。
 *  这里用 ResizeObserver 监听 scroller 内容高度：流式期间只要跟随态且距底超过
 *  AUTO_SCROLL_THRESHOLD 就 rAF 合并补偿贴底一次——不依赖 Virtuoso 内部状态机，
 *  每次内容增长都能把新输出实时带回可视区。
 *
 * 配合组件使用：
 *  - Virtuoso 的 atBottomThreshold 传 AUTO_SCROLL_THRESHOLD
 *  - Virtuoso 的 Scroller 组件把 onWheel 接到 handleWheel，并把 div 的 ref 接到 setScrollerRef
 *  - Virtuoso 的 followOutput 传 followOutput，atBottomStateChange 传 handleAtBottomStateChange
 *  - isStreaming 翻转结束时调用 compensateScroll()
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

/** 贴底判定阈值：锚点模式下收敛到接近 Virtuoso 默认（4px），消灭 150px 死区 */
export const AUTO_SCROLL_THRESHOLD = 4;

/** 流式期间距底超过该值就触发补偿贴底（px）。取视口高度级别，避免内容仅微增就抖动。 */
const STREAM_COMPENSATE_OFFSET = 40;

/** 程序化滚动保护窗口（ms）：compensateScroll / scrollToIndex 触发 scrollTop 变化的
 *  那一段时间内，忽略 handleScroll 的采样，避免把"我们自己贴底"误判为"用户上拉离开"。 */
const PROGRAMMATIC_SCROLL_GUARD_MS = 220;

/** 流式结束后仍允许 ResizeObserver 补偿贴底一次的窗口（ms）。
 *  内容最后一次测量常常在 isStreaming 翻 false 之后到达，此窗口内允许补偿一次，
 *  避免用户停在略高于底部的位置。 */
const STREAM_END_COMPENSATE_WINDOW_MS = 1000;

export interface MessageAutoScroll {
  autoScroll: boolean;
  /** 与 react-virtuoso FollowOutputScalarType 一致：boolean(true=立即) | 'auto' | 'smooth' */
  followOutput: (isAtBottom: boolean) => boolean | 'auto' | 'smooth';
  handleAtBottomStateChange: (atBottom: boolean) => void;
  /** 绑定到 Virtuoso Scroller 的 onWheel：向上滚动=用户主动离开，停止跟随 */
  handleWheel: (e: { deltaY: number }) => void;
  /** 绑定到 Virtuoso Scroller 的 onScroll：兜底捕获键盘/触摸/程序化滚动，仅流式中且
   *  在程序化滚动保护窗口之外才判定为"用户主动离开"。 */
  handleScroll: () => void;
  /** 绑定到容器 keydown：PageUp/Home/ArrowUp 视为用户主动离开，停止跟随。 */
  handleKeyDown: (e: React.KeyboardEvent) => void;
  scrollToBottom: () => void;
  setAutoScroll: (v: boolean) => void;
  /** 内容测量完成后调用一次，若仍处跟随态则补偿贴底滚动 */
  compensateScroll: () => boolean;
  /** 绑定到 Virtuoso Scroller div 的 ref：拿到滚动容器，供流式期间 ResizeObserver 监听 */
  setScrollerRef: (ref: HTMLElement | null) => void;
}

export function useMessageAutoScroll(
  virtuosoRef: React.RefObject<VirtuosoHandle | null>,
  opts: { isStreaming?: boolean; initialAutoScroll?: boolean } = {}
): MessageAutoScroll {
  const { isStreaming, initialAutoScroll } = opts;
  const [autoScroll, setAutoScrollState] = useState(initialAutoScroll ?? true);

  // 首帧忽略标记：Virtuoso 冷启动测量完成后的第一次 atBottomStateChange 可能因
  // 估算高度误差误判，忽略挂载后的第一次回调，之后的回调才是用户真实滚动行为。
  const firstAtBottomCallbackRef = useRef(true);

  // 补偿滚动 rAF 合并：内容高频更新（流式每 token）时不重复滚动。
  const compensateRafRef = useRef<number | null>(null);
  const compensatePendingRef = useRef(false);

  // 程序化滚动保护窗口：scheduleCompensate / scrollToBottom 触发的 scrollTop 变化不
  // 应被视为"用户主动离开"。补偿窗口结束时清一次。
  const programmaticUntilRef = useRef(0);

  // 流式结束补偿窗口：isStreaming 翻 false 后的短暂时间内允许 ResizeObserver 补偿
  // 一次（最终测量往往滞后于 isStreaming 翻转）。窗口结束置 false。
  const streamingEndPendingRef = useRef(false);

  // ===== 流式中途贴底增强：scroller DOM + ResizeObserver =====
  // Virtuoso 的 followOutput 在内容大幅增长后（atBottom 翻 false）就不再跟随，
  // 这里直接观察内容高度变化，不依赖 Virtuoso 内部状态机。
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const listElRef = useRef<HTMLElement | null>(null);
  const listRoRef = useRef<ResizeObserver | null>(null);
  const listMutationRef = useRef<MutationObserver | null>(null);
  // 镜像最新状态供异步 observer 回调读取（回调闭包不能依赖过期 state）
  const stateRef = useRef({ autoScroll, isStreaming: !!isStreaming });
  stateRef.current.autoScroll = autoScroll;
  stateRef.current.isStreaming = !!isStreaming;

  const setAutoScroll = useCallback((v: boolean) => {
    console.log('[AutoScroll:setAutoScroll]', v, new Error('stack').stack?.split('\n')[2]?.trim());
    setAutoScrollState(v);
  }, []);

  /**
   * atBottom 状态翻转处理。
   *  - 翻转为 true：恢复跟随（用户回到底部 / 内容增高后贴底）。
   *  - 翻转为 false：非流式时视为用户离开，停止跟随；流式期间忽略——内容剧变
   *    导致的瞬时离底不应误判为用户离开（由 handleWheel 处理真正的主动离开）。
   */
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    console.log('[AutoScroll:atBottomStateChange]', { atBottom, isStreaming, autoScroll: stateRef.current.autoScroll });
    if (firstAtBottomCallbackRef.current) {
      firstAtBottomCallbackRef.current = false;
      return;
    }
    if (atBottom) {
      setAutoScrollState(true);
    } else if (!isStreaming) {
      // 非流式：离开底部=用户主动（内容不再增长），停止跟随
      console.log('[AutoScroll:atBottomStateChange] 非流式且离底，停止跟随');
      setAutoScrollState(false);
    }
    // 流式且 atBottom=false：忽略，靠 followOutput + wheel + 流式补偿维持正确跟随
  }, [isStreaming]);

  /**
   * 用户主动滚动中断：向上滚动 = 用户去读历史/长内容，停止跟随。
   * 绑定到 Virtuoso Scroller 的 onWheel。
   */
  const handleWheel = useCallback((e: { deltaY: number }) => {
    if (e.deltaY < 0) {
      console.log('[AutoScroll:handleWheel] 检测到向上滚动，停止跟随', { deltaY: e.deltaY });
      setAutoScrollState(false);
    }
  }, []);

  /**
   * 滚动事件兜底检测：wheel 事件无法覆盖键盘 PageUp / 触摸板 / 触控屏 / 程序化跳转。
   * 通过采样 scrollTop 变化方向 + 距底阈值联合判定：
   *   - 保护窗口内：跳过（我们自己触发的 scrollTop 变化）
   *   - 非流式：跳过（非流式的"离开底部"由 handleAtBottomStateChange 兜底）
   *   - 流式中 + scrollTop 变小 + 距底超过阈值 → 用户主动向上，停止跟随
   */
  const handleScroll = useCallback(() => {
    const { isStreaming: streaming } = stateRef.current;
    if (!streaming) return; // 非流式交给 handleAtBottomStateChange
    if (performance.now() < programmaticUntilRef.current) return;
    const scroller = scrollerElRef.current;
    if (!scroller) return;
    const distFromBottom = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    if (distFromBottom <= AUTO_SCROLL_THRESHOLD) return;
    setAutoScrollState(false);
  }, []);

  /**
   * 键盘上拉检测：PageUp / Home / ArrowUp 视为用户主动向上浏览，停止跟随。
   * 仅在流式期间生效，其他时间由 handleAtBottomStateChange 处理。
   */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!stateRef.current.isStreaming) return;
    if (e.key === 'PageUp' || e.key === 'Home' || e.key === 'ArrowUp') {
      setAutoScrollState(false);
    }
  }, []);

  /** 强制回到底部并恢复跟随 */
  const scrollToBottom = useCallback(() => {
    if (virtuosoRef.current) {
      virtuosoRef.current.scrollTo({
        top: Number.MAX_SAFE_INTEGER,
        behavior: 'smooth',
      });
    }
    setAutoScrollState(true);
  }, [virtuosoRef]);

  /**
   * 内部：无条件调度一次贴底滚动（rAF 合并）。
   * 不检查 autoScroll —— 调用方负责判断跟随态。
   */
  const scheduleCompensate = useCallback(() => {
    if (compensateRafRef.current !== null) return; // 已调度
    compensatePendingRef.current = true;
    compensateRafRef.current = requestAnimationFrame(() => {
      compensateRafRef.current = null;
      if (!compensatePendingRef.current) return;
      compensatePendingRef.current = false;
      // 打开保护窗口：接下来的 scrollTop 变化来自我们自己的 scrollToIndex
      programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_GUARD_MS;
      const cur = virtuosoRef.current;
      if (cur) {
        cur.scrollToIndex({
          index: 'LAST' as never,
          align: 'end',
          behavior: stateRef.current.isStreaming ? 'auto' : 'smooth',
        });
      }
    });
  }, [virtuosoRef]);

  // 侦听 isStreaming 下降沿：打开一次性的补偿窗口（仅 true→false 边沿）
  const prevIsStreamingRef = useRef(!!isStreaming);
  useEffect(() => {
    const prev = prevIsStreamingRef.current;
    prevIsStreamingRef.current = !!isStreaming;
    if (isStreaming) {
      streamingEndPendingRef.current = false;
      return;
    }
    // 仅在从流式翻转到非流式时开启窗口；初始挂载 / 一直是 false 都不触发
    if (prev !== true) return;
    // 刚结束流式：给 ResizeObserver 最后一次补偿的机会（最终测量通常滞后几十 ms）
    streamingEndPendingRef.current = true;
    const timer = setTimeout(() => {
      streamingEndPendingRef.current = false;
    }, STREAM_END_COMPENSATE_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [isStreaming]);

  /**
   * 补偿滚动：内容测量完成后，若仍处跟随态，主动贴底一次。
   * 返回是否执行/调度了补偿。rAF 合并高频调用。
   */
  const compensateScroll = useCallback((): boolean => {
    if (!autoScroll) return false;
    const ref = virtuosoRef.current;
    if (!ref) return false;
    scheduleCompensate();
    return true;
  }, [autoScroll, virtuosoRef, scheduleCompensate]);

  /**
   * 流式中途补偿触发：ResizeObserver 回调。
   * 距底超过 STREAM_COMPENSATE_OFFSET 时（内容暴增把视口甩开）才补偿，
   * 微增不抖动。仅在跟随态 + 流式中生效。
   * 流式结束补偿窗口内也允许补偿一次，避免最终测量延迟导致停在略高于底部的位置。
   */
  const handleListResize = useCallback(() => {
    const { autoScroll: follow, isStreaming: streaming } = stateRef.current;
    const scroller = scrollerElRef.current;
    if (!follow || !scroller) return;
    const allowCompensate = streaming || streamingEndPendingRef.current;
    if (!allowCompensate) return;
    const distFromBottom = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    if (distFromBottom > STREAM_COMPENSATE_OFFSET) {
      // 一次性闸门：补偿后关闭，避免流式结束后内容继续增长反复拉回
      if (!streaming) streamingEndPendingRef.current = false;
      scheduleCompensate();
    }
  }, [scheduleCompensate]);

  /**
   * 绑定 scroller DOM：拿到滚动容器后，观察其列表子容器高度。
   * Virtuoso 虚拟列表的子节点可能重建，用 MutationObserver 重新绑定。
   */
  const setScrollerRef = useCallback((ref: HTMLElement | null) => {
    scrollerElRef.current = ref;
    // 清理旧的 observer
    listRoRef.current?.disconnect();
    listMutationRef.current?.disconnect();
    listRoRef.current = null;
    listMutationRef.current = null;
    listElRef.current = null;
    if (!ref) return;

    const attachToList = () => {
      const list = ref.firstElementChild as HTMLElement | null;
      if (list === listElRef.current) return; // 已绑定
      listElRef.current = list;
      listRoRef.current?.disconnect();
      listRoRef.current = null;
      if (list) {
        const ro = new ResizeObserver(handleListResize);
        ro.observe(list);
        listRoRef.current = ro;
      }
    };
    attachToList();
    // 子节点重建（Virtuoso prepend/append 虚拟列表）时重新绑定
    const mo = new MutationObserver(() => {
      const list = ref.firstElementChild as HTMLElement | null;
      if (list !== listElRef.current) attachToList();
    });
    mo.observe(ref, { childList: true });
    listMutationRef.current = mo;
  }, [handleListResize]);

  /**
   * followOutput 回调：精确控制跟随时机。
   *  - 跟随态 + 流式   → true（auto 立即贴底，内容向上生长不中断）
   *  - 跟随态 + 非流式 → 贴底时 'smooth'，离开则不滚
   *  - 非跟随态        → false（用户已离开，绝不被拉回）
   */
  const followOutput = useCallback<MessageAutoScroll['followOutput']>((isAtBottom) => {
    if (!autoScroll) return false;
    if (isStreaming) return true;
    return isAtBottom ? 'smooth' : false;
  }, [autoScroll, isStreaming]);

  // 卸载时清理 rAF + observers
  useEffect(() => {
    return () => {
      if (compensateRafRef.current !== null) {
        cancelAnimationFrame(compensateRafRef.current);
        compensateRafRef.current = null;
      }
      compensatePendingRef.current = false;
      listRoRef.current?.disconnect();
      listMutationRef.current?.disconnect();
      listRoRef.current = null;
      listMutationRef.current = null;
      listElRef.current = null;
      scrollerElRef.current = null;
    };
  }, []);

  return {
    autoScroll,
    followOutput,
    handleAtBottomStateChange,
    handleWheel,
    handleScroll,
    handleKeyDown,
    scrollToBottom,
    setAutoScroll,
    compensateScroll,
    setScrollerRef,
  };
}
