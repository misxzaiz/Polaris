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
 * 流式中途贴底增强（2026-09-23 实测补漏，2026-10-15 升级）：
 *  Virtuoso 的 followOutput 只在「atBottom 翻转」时触发一次，内容一次性大幅增长
 *  （长回复单 commit +几千 px）会把 atBottom 打翻为 false，之后 followOutput 不再
 *  跟随，视口停在中间直到流式结束才被结束补偿拉回。实测轨迹里 gap 一度涨到
 *  5476px（见 memory/message-autoscroll-anchor-mode.md）。
 *  这里用 ResizeObserver 监听 scroller 内容高度：流式期间只要跟随态且距底超过
 *  streamCompensateThreshold（视口一屏高）才 rAF 合并补偿贴底一次——正常跟随由
 *  Virtuoso followOutput 每 token 贴底主导，RO 仅在 Virtuoso 明显跟丢（剧变甩开
 *  超过一屏）时兜底介入，避免与 Virtuoso 双滚动竞争造成滚动跳动。
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

/** 流式补偿贴底的下限阈值（px）：距底超过该值与「视口高度」的较大者才触发补偿。
 *  2026-10-15 升级：正常流式跟随由 Virtuoso followOutput 主导（每 token 自动贴底），
 *  若 RO 仍在固定 40px 就补偿，会与 Virtuoso 的双滚动在同帧争抢视口 → 滚动跳动。
 *  故阈值取「一屏高」（Virtuoso 明显没跟上/跟丢）才兜底补偿，消除竞争。 */
const STREAM_COMPENSATE_OFFSET = 40;

/** 程序化滚动保护窗口（ms）：compensateScroll / scrollToIndex 触发 scrollTop 变化的
 *  那一段时间内，忽略 handleScroll 的采样，避免把"我们自己贴底"误判为"用户上拉离开"。 */
const PROGRAMMATIC_SCROLL_GUARD_MS = 220;

/** 流式结束后仍允许 ResizeObserver 补偿贴底一次的窗口（ms）。
 *  内容最后一次测量常常在 isStreaming 翻 false 之后到达，此窗口内允许补偿一次，
 *  避免用户停在略高于底部的位置。 */
const STREAM_END_COMPENSATE_WINDOW_MS = 1000;

/** 离开态恢复跟随的「离开距离」下限阈值（px）。
 *  用户上拉查看历史后再拉回底部，离开期间的距底峰值必然较大；
 *  被动回弹/微小下滑造成的峰值很小。以「距底峰值 > 阈值」判定主动回底。 */
const MIN_RESTORE_GAP_PX = 80;

/** 恢复阈值相对视口高度的比例：threshold = MAX(MIN_RESTORE_GAP_PX, clientHeight × 该值)。
 *  取半屏——用户上拉超过半屏再回底，视为明确的主动往返；半屏内的起伏视为抖动。 */
const RESTORE_GAP_VIEWPORT_RATIO = 0.5;

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
  /** 开启交互豁免窗口（默认 350ms）：卡片展开/折叠、chips 筛选等内部交互导致的
   *  列表高度变化不驱动滚动跟随/补偿/恢复，避免消息位置闪动。 */
  suspendFollow: (ms?: number) => void;
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

  // 离开态期间的「距底峰值」（px）：用户上拉离开底部后持续累计，直到恢复跟随清零。
  // 方向 A 的判定依据——只有离开超过阈值（MIN_RESTORE_GAP_PX / 半屏）再回底，
  // 才视为「主动往返」而恢复跟随；峰值小的触底是抖动，保持离开不被拉走。
  const leavePeakDistRef = useRef(0);

  // 交互豁免窗口：卡片内展开/筛选导致的列表高度变化不驱动滚动跟随。
  // 由 suspendFollow(ms) 开启；窗口内 followOutput / RO 补偿 / compensateScroll /
  // atBottom 翻转均被抑制，避免「点 chips 后消息位置闪动」。
  const suspendUntilRef = useRef(0);

  // 是否处于交互豁免窗口内
  const isSuspended = useCallback(() => {
    return performance.now() < suspendUntilRef.current;
  }, []);

  /** 恢复跟随所需的离开距离阈值（px）：
   *  取固定下限与「半屏」的较大者，视口极小（迷你格子）时退化为固定下限。 */
  const restoreGapThreshold = useCallback(() => {
    const vh = scrollerElRef.current?.clientHeight ?? 0;
    return Math.max(MIN_RESTORE_GAP_PX, vh * RESTORE_GAP_VIEWPORT_RATIO);
  }, []);

  /** 流式中途补偿所需的最小距底（px）：距底超过「视口一屏高」才兜底补偿贴底。
   *  正常跟随由 Virtuoso followOutput 主导，这里仅在 Virtuoso 明显跟丢（距底超一屏）
   *  时才介入，避免与 Virtuoso 双滚动竞争造成跳动。迷你格子时退化为固定下限。 */
  const streamCompensateThreshold = useCallback(() => {
    const vh = scrollerElRef.current?.clientHeight ?? 0;
    return Math.max(STREAM_COMPENSATE_OFFSET, vh);
  }, []);

  // 开启交互豁免窗口：卡片展开/折叠、chips 筛选等内部交互导致列表高度变化时调用，
  // 窗口内不跟随、不补偿、不恢复 autoScroll，用户视角位置保持不动。
  const suspendFollow = useCallback((ms = 350) => {
    suspendUntilRef.current = performance.now() + ms;
  }, []);

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
    if (v) leavePeakDistRef.current = 0; // 显式恢复跟随 → 离开峰值清零
    setAutoScrollState(v);
  }, []);

  /**
   * atBottom 状态翻转处理。
   *  - 翻转为 true：恢复跟随（用户回到底部 / 内容增高后贴底）。
   *  - 翻转为 false：非流式时视为用户离开，停止跟随；流式期间忽略——内容剧变
   *    导致的瞬时离底不应误判为用户离开（由 handleWheel 处理真正的主动离开）。
   */
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    if (firstAtBottomCallbackRef.current) {
      firstAtBottomCallbackRef.current = false;
      return;
    }
    if (atBottom) {
      // 交互豁免窗口内：高度变化翻转 atBottom 不应恢复跟随（避免点 chips 后拉回）
      if (isSuspended()) return;
      // 方向 A 修复（2026-10-15）：区分「主动回底」与「被动触底」——
      //   · 跟随态：atBottom=true 保持跟随（内容增长贴底是正常的），峰值本为 0。
      //   · 离开态：仅当离开期间的距底峰值 ≥ 阈值（用户确实上拉查看过历史、
      //     主动拉回底部）才恢复跟随；峰值小的触底（原位微小下滑/惯性回弹/滚动条
      //     释放）视为抖动，保持离开，避免下一个流式 token 把视口划走。
      // 峰值在判定后统一消费清零（无论恢复与否），下一个离开周期重新累计。
      if (stateRef.current.autoScroll) {
        leavePeakDistRef.current = 0;
        setAutoScrollState(true);
      } else if (leavePeakDistRef.current >= restoreGapThreshold()) {
        setAutoScrollState(true);
        leavePeakDistRef.current = 0;
      } else {
        // 离开态、峰值不足（被动触底）：不恢复，但消费本次触底重置峰值
        leavePeakDistRef.current = 0;
      }
    } else if (!isStreaming) {
      // 非流式：离开底部=用户主动（内容不再增长），停止跟随
      setAutoScrollState(false);
    }
    // 流式且 atBottom=false：忽略，靠 followOutput + wheel + 流式补偿维持正确跟随
  }, [isStreaming, restoreGapThreshold]);

  /**
   * 用户主动滚动中断：向上滚动 = 用户去读历史/长内容，停止跟随。
   * 绑定到 Virtuoso Scroller 的 onWheel。
   */
  const handleWheel = useCallback((e: { deltaY: number }) => {
    if (e.deltaY < 0) {
      setAutoScrollState(false);
    }
  }, []);

  /**
   * 滚动事件采样：覆盖键盘/触摸板/程序化滚动，同时维护方向 A 的离开峰值。
   *  - 保护窗口内：跳过（我们自己触发的 scrollTop 变化）。
   *  - 距底超阈值：累计「自上次 atBottom 事件以来的离开峰值」（取最大）。
   *    注意：回底（距底≤阈值）**不清零**——Virtuoso 的 scroll 事件先于 atBottom
   *    翻转触发，若在此清零，恢复判定读到 0 会误判。峰值统一在 atBottom 判定时消费。
   *  - 流式中距底超阈值：视为用户主动向上，停止跟随。
   *  - 非流式的主动离开由 handleAtBottomStateChange（atBottom→false）判定，
   *    这里不设 false，避免键盘/触摸板噪声误停（保持原语义）。
   */
  const handleScroll = useCallback(() => {
    if (performance.now() < programmaticUntilRef.current) return;
    const scroller = scrollerElRef.current;
    if (!scroller) return;
    const distFromBottom = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    // 离开区（距底超阈值）累计离开峰值（方向 A 的主动往返判据）。
    // 回底区（≤阈值）不干预，峰值统一在 atBottom 判定时消费清零
    // （避免 scroll 先于 atBottom 触发的竞态）。
    if (distFromBottom > AUTO_SCROLL_THRESHOLD && distFromBottom > leavePeakDistRef.current) {
      leavePeakDistRef.current = distFromBottom;
    }
    // 流式下「显著离开」（距底超过恢复阈值，即离开超过半屏上）才停止跟随：
    // 覆盖滚动条拖动/触摸板快速上滑等无 wheel 事件的离开；浅层滚动（跟随态下
    // Virtuoso 自动滚底的中间帧距底短暂超4px，但远未到半屏）不误停，交回
    // handleWheel / handleAtBottomStateChange 精确判定。
    if (stateRef.current.isStreaming && distFromBottom > restoreGapThreshold()) {
      setAutoScrollState(false);
    }
  }, [restoreGapThreshold]);

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

  /** 强制回到底部并恢复跟随（显式入口：ScrollToBottomButton 等）。清理离开峰值。 */
  const scrollToBottom = useCallback(() => {
    leavePeakDistRef.current = 0;
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
    // 交互豁免窗口内：卡片内部交互导致的高度变化不补偿贴底
    if (!autoScroll || isSuspended()) return false;
    const ref = virtuosoRef.current;
    if (!ref) return false;
    scheduleCompensate();
    return true;
  }, [autoScroll, virtuosoRef, scheduleCompensate, isSuspended]);

  /**
   * 流式中途补偿触发：ResizeObserver 回调。
   * 距底超过 streamCompensateThreshold()（视口一屏高）时才兜底补偿，
   * 正常跟随由 Virtuoso followOutput 每 token 贴底，这里只在 Virtuoso 明显
   * 跟丢（长回复剧变把视口甩开超过一屏）时介入，避免双滚动竞争造成的跳动。
   * 流式结束补偿窗口内也允许补偿一次，避免最终测量延迟导致停在略高于底部的位置。
   */
  const handleListResize = useCallback(() => {
    const { autoScroll: follow, isStreaming: streaming } = stateRef.current;
    const scroller = scrollerElRef.current;
    // 交互豁免窗口内：卡片展开/折叠导致的尺寸变化不驱动补偿贴底
    if (!follow || !scroller || isSuspended()) return;
    const allowCompensate = streaming || streamingEndPendingRef.current;
    if (!allowCompensate) return;
    const distFromBottom = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    if (distFromBottom > streamCompensateThreshold()) {
      // 一次性闸门：补偿后关闭，避免流式结束后内容继续增长反复拉回
      if (!streaming) streamingEndPendingRef.current = false;
      scheduleCompensate();
    }
  }, [scheduleCompensate, streamCompensateThreshold]);

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
    // 交互豁免窗口内：卡片展开/筛选的高度变化不触发 smooth 跟随（避免消息位置闪动）
    if (isSuspended()) return false;
    if (isStreaming) return true;
    return isAtBottom ? 'smooth' : false;
  }, [autoScroll, isStreaming, isSuspended]);

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
    suspendFollow,
  };
}
