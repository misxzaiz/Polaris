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
 *
 * 跟随权语义（对齐 temp/ZCode timelineScrollAnchor.ts 范式，2026-10-16 重构）：
 *  following（本 hook 的 autoScroll）表达的是「用户滚动权」，不是瞬时几何快照：
 *  只有真实用户滚动输入（wheel 向上 / 触摸上移 / 键盘 PageUp·Home·ArrowUp /
 *  滚动条拖动）才能改变它；程序化贴底与 ResizeObserver 补偿产生的 scroll 事件
 *  只更新几何账目，不得反向夺回或授予滚动权。
 *  - 恢复跟随的规则不是「离开距离达到阈值」，而是「用户滚回到距底 ≤ ε 的贴底区」
 *    —— 用户把滚轮/手指/滚动条带到底部附近即视为主动回底，立即恢复跟随。
 *    此前「半屏峰值 gating」（2026-10-15 方向 A）在用户小幅上拉再回底时违反直觉
 *    （小幅离开不恢复，用户疑惑「我回到底了为什么不跟随」），被回滚（b30401aa）。
 *  - scroll 事件滞后对账：scroll 事件在滚动发生后下一渲染帧才派发。若用户上滚之后、
 *    scroll 事件派发之前恰好落进一个内容高度变化的 React commit（流式 delta /
 *    ResizeObserver 测高修正），贴底动作会拿着过期的跟随态把 scrollTop 拽回底部。
 *    与 ZCode 的 lastObservedScrollTopRef 同理，这里在贴底前用「commit 时刻的实时
 *    scrollTop」对账「最近一次已账目的 scrollTop」，上滚已发生但事件未到 → 判为
 *    未观察向上滚动，不得贴底。
 *
 * 流式中途贴底增强（2026-09-23 实测补漏）：
 *  Virtuoso 的 followOutput 只在「atBottom 翻转」时触发一次，内容一次性大幅增长
 *  （长回复单 commit +几千 px）会把 atBottom 打翻为 false，之后 followOutput 不再
 *  跟随，视口停在中间直到流式结束才被结束补偿拉回。实测轨迹里 gap 一度涨到
 *  5476px（见 memory/message-autoscroll-anchor-mode.md）。
 *  这里用 ResizeObserver 监听 scroller 内容高度：流式期间只要跟随态且距底超过
 *  视口高度级别就 rAF 合并补偿贴底一次——不依赖 Virtuoso 内部状态机，每次内容
 *  增长都能把新输出实时带回可视区。
 *
 * 配合组件使用：
 *  - Virtuoso 的 atBottomThreshold 传 BOTTOM_ANCHOR_EPSILON_PX（与恢复判定同一容差）
 *  - Virtuoso 的 Scroller 组件把 onWheel/onScroll/onKeyDown 接到对应 handler，
 *    并把 div 的 ref 接到 setScrollerRef
 *  - Virtuoso 的 followOutput 传 followOutput，atBottomStateChange 传 handleAtBottomStateChange
 *  - isStreaming 翻转结束时调用 compensateScroll()
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

/**
 * 离底恢复容差（px）：小于该距离视为「在底部」。对齐 ZCode BOTTOM_ANCHOR_EPSILON_PX=48，
 * 覆盖亚像素滚动与最后一行 padding，同时让「用户滚回到底部附近」即恢复跟随。
 * 同时传给 Virtuoso atBottomThreshold：让 Virtuoso 的 atBottom 判定与恢复判定使用
 * 同一容差，避免「handleScroll 恢复跟随但 Virtuoso atBottom=false」的抖动空窗。
 */
export const BOTTOM_ANCHOR_EPSILON_PX = 48;

/** 流式期间距底超过该值就触发补偿贴底（px）的下限。
 *  实际阈值 = max(该下限, 视口高度)：Virtuoso 自动滚底的中间帧距底短暂超过 4px，
 *  但远未到一屏，用视口高度作闸门可避免内容仅微增/自动滚底中间帧就抖动补偿。 */
const STREAM_COMPENSATE_OFFSET = 40;

/** 程序化滚动保护窗口（ms）：compensateScroll / scrollToIndex 触发 scrollTop 变化的
 *  那一段时间内，忽略 handleScroll 的采样，避免把"我们自己贴底"误判为"用户上拉离开"。 */
const PROGRAMMATIC_SCROLL_GUARD_MS = 220;

/** 流式结束后仍允许 ResizeObserver 补偿贴底一次的窗口（ms）。
 *  内容最后一次测量常常在 isStreaming 翻 false 之后到达，此窗口内允许补偿一次，
 *  避免用户停在略高于底部的位置。 */
const STREAM_END_COMPENSATE_WINDOW_MS = 1000;

/** 未观察滚动的判定容差（px）：小于该值的 scrollTop 回退视为亚像素抖动，不算用户上滚。
 *  对齐 ZCode UNOBSERVED_SCROLL_EPSILON_PX=2。 */
const UNOBSERVED_SCROLL_EPSILON_PX = 2;

/** 流式中「真离开」距底阈值（px）：距底超过该值才解除跟随。
 *  取视口高度级别（下限 STREAM_COMPENSATE_OFFSET）：用户要跨出当前视口才视为
 *  明确离开阅读区；微调滚动（距底几十 px）交给恢复分支（≤48px）兜住，不误停。 */
function streamLeaveThreshold(scroller: HTMLElement): number {
  return Math.max(STREAM_COMPENSATE_OFFSET, scroller.clientHeight);
}

export interface MessageAutoScroll {
  autoScroll: boolean;
  /** 与 react-virtuoso FollowOutputScalarType 一致：boolean(true=立即) | 'auto' | 'smooth' */
  followOutput: (isAtBottom: boolean) => boolean | 'auto' | 'smooth';
  handleAtBottomStateChange: (atBottom: boolean) => void;
  /** 绑定到 Virtuoso Scroller 的 onWheel：向上滚动=用户主动离开，停止跟随 */
  handleWheel: (e: { deltaY: number }) => void;
  /** 绑定到 Virtuoso Scroller 的 onScroll：滚动事件账目 + 落点裁决（仅用户来源改变跟随态） */
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

  // 跟随态镜像，供异步回调（handleScroll / ResizeObserver）读取当前值
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;

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

  // 交互豁免窗口：卡片内展开/筛选导致的列表高度变化不驱动滚动跟随。
  // 由 suspendFollow(ms) 开启；窗口内 followOutput / RO 补偿 / compensateScroll /
  // atBottom 翻转均被抑制，避免「点 chips 后消息位置闪动」。
  const suspendUntilRef = useRef(0);

  // 组件「已账目」的 scrollTop：scroll 事件读取值或组件自身程序化写入（贴底）后的
  // 回读值。ResizeObserver 补偿贴底前拿它对账「未观察滚动」（滚动已发生、scroll 事件
  // 未派发），防止过期跟随态把用户/测试的上滚拽回底部。对齐 ZCode lastObservedScrollTopRef。
  const lastObservedScrollTopRef = useRef(0);

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

  // 是否处于交互豁免窗口内
  const isSuspended = useCallback(() => {
    return performance.now() < suspendUntilRef.current;
  }, []);

  // 开启交互豁免窗口：卡片展开/折叠、chips 筛选等内部交互导致列表高度变化时调用，
  // 窗口内不跟随、不补偿、不恢复 autoScroll，用户视角位置保持不动。
  const suspendFollow = useCallback((ms = 350) => {
    suspendUntilRef.current = performance.now() + ms;
  }, []);

  const setAutoScroll = useCallback((v: boolean) => {
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
      // 恢复跟随规则（ZCode 范式）：用户滚回到「距底 ≤ ε」的贴底区即恢复。
      // 不区分「主动回底 / 被动触底」——用户回到底部附近就是对滚动权的明确归还。
      // （此前半屏峰值 gating 因小幅上拉再回底不恢复被回滚。）
      setAutoScrollState(true);
    } else if (!isStreaming) {
      // 非流式：离开底部=用户主动（内容不再增长），停止跟随
      setAutoScrollState(false);
    }
    // 流式且 atBottom=false：忽略，靠 followOutput + wheel + 流式补偿维持正确跟随
  }, [isStreaming, isSuspended]);

  /**
   * 用户主动滚动中断：向上滚动 = 用户去读历史/长内容，停止跟随。
   * 绑定到 Virtuoso Scroller 的 onWheel。
   */
  const handleWheel = useCallback((e: { deltaY: number }) => {
    // wheel 的 deltaY 与 scrollTop 同向：负值阅读更早内容（离开底部），停止跟随；
    // 正值靠近底部，不在此处置为离开（落点裁决交给 onScroll / atBottom）。
    if (e.deltaY < 0) {
      setAutoScrollState(false);
    }
  }, []);

  /**
   * 滚动事件账目 + 落点裁决。
   *  - 程序化保护窗口内：跳过采样（我们自己触发的 scrollTop 变化，绝不据此改跟随）。
   *  - 记录 lastObservedScrollTop（scroll 事件即「已账目」）。
   *  - 恢复分支：距底 ≤ BOTTOM_ANCHOR_EPSILON_PX → 恢复跟随（scroll 事件先于
   *    atBottom 翻转触发，在此先恢复可消除 scroll→atBottom 空窗）。
   *  - 离开分支（仅流式中）：距底 > 视口高度级别（streamLeaveThreshold）→ 解除跟随。
   *    流式中 atBottom=false 被忽略（内容增长可能瞬时离底），wheel 路径已由
   *    handleWheel；这里覆盖滚动条拖动 / 触摸 / 键盘等无 wheel 事件的真实离开，
   *    同时避免 Virtuoso 自动贴底（followOutput=true）的中间帧把 autoScroll 误停——
   *    离开阈值取「视口高度」而非 48px，自动贴底中间帧的距底几乎不会超过一屏。
   *    非流式不在 handleScroll 解除：Virtuoso 'smooth' 跟随的中间帧距底会瞬时超 ε，
   *    会被误读为用户离开（ZCode 因此贴底用 instant）；非流式离开由
   *    atBottomStateChange(false) 兜底，不依赖本分支。
   */
  const handleScroll = useCallback(() => {
    const scroller = scrollerElRef.current;
    if (!scroller) return;
    if (performance.now() < programmaticUntilRef.current) return;
    lastObservedScrollTopRef.current = scroller.scrollTop;
    const distFromBottom =
      scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    if (distFromBottom <= BOTTOM_ANCHOR_EPSILON_PX) {
      // 用户滚回贴底区：恢复跟随（即使 atBottom 事件尚未派发）。
      setAutoScrollState(true);
    } else if (
      stateRef.current.isStreaming &&
      autoScrollRef.current &&
      distFromBottom > streamLeaveThreshold(scroller)
    ) {
      // 流式中真用户滚动离开（滚动条/触摸/键盘，跨视口）：解除跟随。
      setAutoScrollState(false);
    }
  }, []);

  /**
   * 键盘上拉检测：PageUp / Home / ArrowUp 视为用户主动向上浏览，停止跟随。
   * 输入框内的光标键（contentEditable）不属于列表滚动，忽略。
   */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      return;
    }
    if (e.key === 'PageUp' || e.key === 'Home' || e.key === 'ArrowUp') {
      setAutoScrollState(false);
    }
  }, []);

  /** 贴底动作：跟随态下直接贴底。调用前由调用方保证跟随态。
   *  贴底是程序化滚动：进入保护窗口，后续 scroll 事件不被误判为用户离开；
   *  并回读钳制后的落点入账 lastObservedScrollTop（浏览器会把 scrollTop 钳到
   *  最大可滚动距离）。 */
  const doScrollToBottom = useCallback((behavior: 'auto' | 'smooth') => {
    const cur = virtuosoRef.current;
    if (!cur) return;
    programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_GUARD_MS;
    cur.scrollToIndex({
      index: 'LAST' as never,
      align: 'end',
      behavior,
    });
    const scroller = scrollerElRef.current;
    if (scroller) {
      lastObservedScrollTopRef.current = scroller.scrollTop;
    }
  }, [virtuosoRef]);

  /** 强制回到底部并恢复跟随（显式入口：ScrollToBottomButton 等）。 */
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
      doScrollToBottom(stateRef.current.isStreaming ? 'auto' : 'smooth');
    });
  }, [doScrollToBottom]);

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
   * 距底超过「视口高度级别」（下限 STREAM_COMPENSATE_OFFSET）时才补偿，微增/自动
   * 滚底中间帧不抖动。仅在跟随态 + 流式中生效。流式结束补偿窗口内也允许补偿一次，
   * 避免最终测量延迟导致停在略高于底部的位置。
   */
  const handleListResize = useCallback(() => {
    const { autoScroll: follow, isStreaming: streaming } = stateRef.current;
    const scroller = scrollerElRef.current;
    // 交互豁免窗口内：卡片展开/折叠导致的尺寸变化不驱动补偿贴底
    if (!follow || !scroller || isSuspended()) return;
    const allowCompensate = streaming || streamingEndPendingRef.current;
    if (!allowCompensate) return;
    const distFromBottom =
      scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    // 阈值取「视口高度级别」：对齐 dcbb4c10 性能项，避免内容仅微增/自动滚底中间帧抖动
    if (distFromBottom > Math.max(STREAM_COMPENSATE_OFFSET, scroller.clientHeight)) {
      // 贴底前对账「未观察滚动」：用户上滚后、scroll 事件派发前，本回调可能读到
      // 过期跟随态 + 距底仍小。滚动已实际发生（scrollTop 低于已账目值）则不得贴底，
      // 否则把用户刚上拉查看的历史拽回底部（对齐 ZCode reconcileFollowingForContentAnchor）。
      const scrolledUp =
        scroller.scrollTop < lastObservedScrollTopRef.current - UNOBSERVED_SCROLL_EPSILON_PX;
      if (scrolledUp) {
        // 上滚已发生但事件未入账：视为用户离开，不再跟随补偿
        if (streaming) setAutoScrollState(false);
        return;
      }
      // 一次性闸门：补偿后关闭，避免流式结束后内容继续增长反复拉回
      if (!streaming) streamingEndPendingRef.current = false;
      scheduleCompensate();
    }
  }, [scheduleCompensate, isSuspended]);

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
