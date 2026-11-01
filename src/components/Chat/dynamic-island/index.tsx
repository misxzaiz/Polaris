/**
 * 灵动岛（Dynamic Island）v2 —— 会话运行态中枢
 *
 * 状态机：hidden → compact → expanded → collapsed（已完成降级，5s）→ resident（常驻）
 *
 * v3 变更（常驻变更汇总，plans/dynamic-island-change-summary-plan.md）：
 * - 空闲不再卸载：渲染「就绪 + 变更段」常驻胶囊，随时可见本次会话改了什么
 * - compact 新增右侧常驻变更段：文件数 / +N −M / 后台任务数（数据源 changeSummary.ts）
 * - collapsed 完成态停留 5s 后转为常驻形态（不再淡出隐藏）
 *
 * v2 变更（用户反馈驱动）：
 * - 贴顶小形态（top:0 只留底部圆角，compact 28px），背景亮两档与暗背景形成反差
 * - 移除定位跳转：展开即详情，不再滚动消息流
 * - 紧急度分层：需要你（urgent）→ 运行中 / 失败 → 已完成（折叠）→ 底部水位条
 * - urgent 卡内联审批（批准 / 拒绝 / 跳过），无需回到消息流
 * - 全部图标使用 lucide-react，无 emoji
 * - 任务板展开直接显示任务清单 items
 *
 * 挂载点：SessionMessagesView.tsx 消息区容器顶部居中 absolute。
 * per-session：接收 sessionId，订阅对应 session store。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, Square, TriangleAlert, CircleCheck, FileDiff, Terminal } from 'lucide-react';
import { useRuntimeSummary, formatDuration, type CompactSlide, type UrgentCard } from './useRuntimeSummary';
import { DynamicIslandExpanded } from './DynamicIslandExpanded';
import type { SessionChangeSummary } from './changeSummary';
import { findStoreByConversationId } from '@/stores/conversationStore/sessionStoreManager';
import { useToastStore } from '@/stores/toastStore';
import { aiChatDispatch } from '@/services/aiChatDispatch'
import type { PermissionRequestBlock, QuestionBlock } from '@/types/chat';
import './DynamicIsland.css';

export interface DynamicIslandProps {
  /** 会话 ID（null = 活跃会话） */
  sessionId?: string | null;
}

/** 轮播间隔 */
const CAROUSEL_INTERVAL = 3000;
/** collapsed 退场停留 */
const COLLAPSED_HOLD = 5000;

export function DynamicIsland({ sessionId = null }: DynamicIslandProps) {
  const summary = useRuntimeSummary(sessionId);
  const [expanded, setExpanded] = useState(false);
  const [doneGroupOpen, setDoneGroupOpen] = useState(false);

  // 轮播
  const [carouselIdx, setCarouselIdx] = useState(0);
  const carouselTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverRef = useRef(false);

  // collapsed 退场状态
  const [collapsedExiting, setCollapsedExiting] = useState(false);
  const collapsedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { hasRunning, hasFailed, isInterrupting, slides, cards, doneCount, urgent, thinking, changeSummary } = summary;

  // 判断是否处于 collapsed（已完成降级）态：无运行中、无失败、无 urgent、有已完成卡片
  const isCollapsed = !hasRunning && !hasFailed && !isInterrupting && urgent.length === 0 && doneCount > 0;
  // 是否完全空闲（urgent 常驻可见；中断态保持可见 1s）
  const isIdle = urgent.length === 0 && !hasRunning && !hasFailed && !isInterrupting && doneCount === 0;
  // Minimal 思考态：有 thinking block 文本，且无运行卡片、无 urgent、未中断
  // 思考时 blocks 里有 thinking block（content 流式累积），但无 task/agent 卡片 → hasRunning=false、slides=[]
  // Minimal 态正是补这个缺口，接 deriveThinking 数据源
  const isThinking = !!thinking && !hasRunning && urgent.length === 0 && !isInterrupting;
  // v3 常驻：空闲（或 collapsed 停留结束）不再卸载，渲染「就绪 + 变更段」常驻胶囊
  const isResident = isIdle || collapsedExiting;

  // 重置轮播索引当 slides 变化
  useEffect(() => {
    setCarouselIdx(0);
  }, [slides.length]);

  // 轮播定时器
  useEffect(() => {
    if (expanded || slides.length <= 1 || hoverRef.current || urgent.length > 0 || isThinking) {
      // 展开、hover、存在 urgent 或思考态时暂停
      if (carouselTimerRef.current) {
        clearTimeout(carouselTimerRef.current);
        carouselTimerRef.current = null;
      }
      return;
    }
    carouselTimerRef.current = setTimeout(() => {
      setCarouselIdx(prev => (prev + 1) % slides.length);
    }, CAROUSEL_INTERVAL);
    return () => {
      if (carouselTimerRef.current) {
        clearTimeout(carouselTimerRef.current);
        carouselTimerRef.current = null;
      }
    };
  }, [expanded, slides.length, carouselIdx, urgent.length, isThinking]);

  // collapsed 收尾：进入 collapsed 态后停留 5s，无新活动则转为常驻形态
  // （v3 常驻变更：不再淡出隐藏——空闲时岛仍渲染「就绪 + 变更段」胶囊）
  useEffect(() => {
    if (collapsedTimerRef.current) {
      clearTimeout(collapsedTimerRef.current);
      collapsedTimerRef.current = null;
    }
    if (isCollapsed && !expanded) {
      setCollapsedExiting(false);
      collapsedTimerRef.current = setTimeout(() => {
        // 转为常驻形态（isResident 分支渲染）
        setCollapsedExiting(true);
      }, COLLAPSED_HOLD);
    } else if (hasRunning || urgent.length > 0) {
      // 恢复运行态或出现 urgent 时取消收尾
      setCollapsedExiting(false);
    }
    return () => {
      if (collapsedTimerRef.current) {
        clearTimeout(collapsedTimerRef.current);
        collapsedTimerRef.current = null;
      }
    };
  }, [isCollapsed, expanded, hasRunning, urgent.length]);

  // 切换展开
  const toggleExpanded = useCallback(() => {
    setExpanded(prev => !prev);
  }, []);

  // 流式中断：显示「已中断」1s 后收起
  useEffect(() => {
    if (!isInterrupting) return;
    setExpanded(false);
    const t = setTimeout(() => {
      // 1s 后若仍无运行中活动则自然收起（交由 collapsed/idle 状态机）
    }, 1000);
    return () => clearTimeout(t);
  }, [isInterrupting]);

  // 点击外部收起
  const islandRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const handleClick = (e: MouseEvent) => {
      if (islandRef.current && !islandRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [expanded]);

  // Esc 收起
  useEffect(() => {
    if (!expanded) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [expanded]);

  // ===== urgent 内联决策（权限 / 计划 / 提问） =====
  const handleUrgentDecision = useCallback((card: UrgentCard, approved: boolean) => {
    void (async () => {
      try {
        const store = findStoreByConversationId(card.sessionId);
        if (!store) return;
        const blocks = store.currentMessage?.blocks ?? [];
        const block = blocks.find(b => 'id' in b && b.id === card.id);
        if (!block) return;

        // 工具权限：先 continueChat（可失败），成功后再落库决策
        if (card.kind === 'permission' && block.type === 'permission_request') {
          const pr = block as PermissionRequestBlock;
          const toolNames = [...new Set((pr.denials ?? []).map(d => d.toolName))];
          await store.continueChat(
            approved ? `[已授权] ${toolNames.join(', ')}` : '[权限确认] 用户拒绝了操作',
            approved && toolNames.length > 0 ? toolNames : undefined,
          );
          store.resolvePermissionRequest(
            pr.id,
            pr.denials.map(() => ({ status: approved ? ('approved' as const) : ('denied' as const) })),
          );
          if (approved && toolNames.length > 0) store.addSessionAllowedTools(toolNames);
          return;
        }

        // 计划审批
        if (card.kind === 'plan' && block.type === 'plan_mode') {
          await store.continueChat(
            approved ? '[已授权] 计划已批准，请继续执行。' : '[权限确认] 用户拒绝了操作',
            undefined,
          );
          return;
        }

        // 提问：跳过（默认 declined）
        if (card.kind === 'question' && block.type === 'question') {
          const q = block as QuestionBlock;
          await aiChatDispatch({ action: 'answer_question',
            sessionId: q.sessionId || card.sessionId,
            callId: q.id,
            answer: { answers: [], declined: !approved },
          });
        }
      } catch (error) {
        // 决策失败：消息流中的卡片保持 pending（可去卡片重试），但此前完全静默、
        // 用户以为点了没反应（审计 5.6）。这里给最小可见反馈。
        useToastStore.getState().error(
          '快捷决策失败，请在消息卡片中重试',
          error instanceof Error ? error.message : String(error)
        );
      }
    })();
  }, []);

  // Minimal 跑马灯：思考文本滚动时长按文本长度算（替代固定 3s 轮播）
  // 必须在 early return 之前调用，否则 isIdle 切换会导致 hook 数量不一致
  const marqueeRef = useRef<HTMLSpanElement>(null);
  const [marqueeScroll, setMarqueeScroll] = useState(true);
  // 节流 scrollWidth 读取：思考文本每 token 变长，若每次同步读 scrollWidth（强制 reflow）
  // + setState，高频卡顿。改为 200ms 节流，视觉无感知但 reflow 频率降一个数量级。
  const marqueeMeasureRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const measure = () => {
      const el = marqueeRef.current;
      if (!el) return;
      if (el.scrollWidth <= el.clientWidth) {
        setMarqueeScroll(false);
      } else {
        setMarqueeScroll(true);
      }
    };
    // 首次立即测一次（进思考态时确立是否滚动），后续 token 变化节流
    measure();
    if (marqueeMeasureRef.current) clearTimeout(marqueeMeasureRef.current);
    marqueeMeasureRef.current = setTimeout(measure, 200);
    return () => {
      if (marqueeMeasureRef.current) {
        clearTimeout(marqueeMeasureRef.current);
        marqueeMeasureRef.current = null;
      }
    };
  }, [thinking]);
  // duration 固定：不再随文本长度变化。思考文本持续累积，duration 变化会重启动画
  // （CSS animation duration 改变 = 从 0% 重启），停在 translateX(100%) 第一帧位置——
  // 该位置文本在 mask 渐隐区外，视觉上「动效没了」。固定 16s 一轮，动画永不被打断。
  const marqueeDuration = 16;

  // v5 视觉升级：root 状态类驱动 --island-glow / --island-aura（玻璃光带 + 双波符号）
  // 优先级：urgent > fail > interrupt > done/resident > thinking > running > ready
  const stateClass = urgent.length > 0
    ? 'is-urgent'
    : hasFailed
      ? 'is-fail'
      : isInterrupting
        ? 'is-interrupt'
        : (isCollapsed || isResident)
          ? (doneCount > 0 ? 'is-done' : 'is-ready')
          : isThinking
            ? 'is-thinking'
            : hasRunning
              ? 'is-running'
              : 'is-ready';

  // 当前轮播段
  const activeSlide = slides[carouselIdx] || slides[0];

  // 展开面板卡片分组（urgent 单独传）
  const runningCards = cards.filter(c => c.running && !c.failed);
  const failedCards = cards.filter(c => c.failed);
  const doneCards = cards.filter(c => !c.running && !c.failed);

  // compact urgent 提示（多条时取第一条）
  const firstUrgent = urgent[0];

  return (
    <div
      ref={islandRef}
      className={clsx(
        'island-root',
        stateClass,
        expanded && 'island-expanded',
        isCollapsed && !expanded && 'island-collapsed',
        isThinking && !expanded && 'island-minimal',
      )}
    >
      {/* 折叠态 */}
      <div
        className="island-compact"
        onClick={toggleExpanded}
        onMouseEnter={() => { hoverRef.current = true; }}
        onMouseLeave={() => { hoverRef.current = false; }}
      >
        {/* v5 双波符号：核心点 + 扩散波（状态色由 root 状态类驱动） */}
        <span className="island-sym">
          <span className="island-dot" />
          <span className="island-wave" />
        </span>

        {/* Minimal 思考跑马灯：思考文本右→左滚动 */}
        {isThinking && !expanded ? (
          <div className="island-main island-marquee-wrap">
            <span className="island-marquee" ref={marqueeRef}>
              <span
                className={clsx('island-marquee-text', marqueeScroll && 'island-marquee-scroll')}
                style={{ animationDuration: `${marqueeDuration}s` }}
              >
                {thinking}
              </span>
            </span>
          </div>
        ) : urgent.length > 0 && !expanded ? (
          <div className="island-main">
            <span className="island-seg">
              <span className="island-seg-ico island-seg-ico-warn"><TriangleAlert /></span>
              <span className="island-seg-lbl">需要你</span>
              <span className="island-seg-val">{firstUrgent?.summary}</span>
              {urgent.length > 1 && <span className="island-seg-count">{urgent.length}</span>}
            </span>
          </div>
        ) : isInterrupting ? (
          <>
            <div className="island-main">
              <span className="island-seg">
                <span className="island-interrupt-ico"><Square /></span>
                <span>已中断</span>
              </span>
            </div>
          </>
        ) : isCollapsed && !collapsedExiting ? (
          <>
            <div className="island-main">
              <span className="island-seg">
                <span className="island-seg-ico island-seg-ico-done"><CircleCheck /></span>
                <span className="island-seg-lbl">完成 · {doneCount} 项</span>
              </span>
            </div>
          </>
        ) : isResident ? (
          <div className="island-main">
            <span className="island-seg">
              <span className="island-seg-ico island-seg-ico-done"><CircleCheck /></span>
              <span className="island-seg-lbl">就绪</span>
            </span>
          </div>
        ) : (
          <div className="island-main">
            <Carousel slide={activeSlide} />
          </div>
        )}

        {/* 时长：显示「当前/最近一轮」墙钟——进行中实时跳；会话结束后保持显示
            刚结束那轮的时长（lastTurnMs 退避），直到开启下一次对话。tooltip 解释语义。 */}
        {summary.currentTurnMs > 0 ? (
          <span
            className="island-time"
            title={`本轮回复 ${formatDuration(summary.currentTurnMs)} · 本次会话累计 ${formatDuration(summary.sessionTotalMs)}`}
          >
            {formatDuration(summary.currentTurnMs)}
          </span>
        ) : summary.sessionTotalMs > 0 ? (
          <span
            className="island-time"
            title={`本次会话累计对话时长：${formatDuration(summary.sessionTotalMs)}`}
          >
            {formatDuration(summary.sessionTotalMs)}
          </span>
        ) : null}

        {/* 会话变更段：常驻显示（v3）——文件数 / +N −M / 后台任务数 */}
        <ChangeDelta summary={changeSummary} />

        <span className={clsx('island-chev', expanded && 'island-chev-open')}>
          <ChevronDown />
        </span>
      </div>

      {/* 展开态面板 */}
      {expanded && (
        <DynamicIslandExpanded
          urgent={urgent}
          runningCards={runningCards}
          failedCards={failedCards}
          doneCards={doneCards}
          doneGroupOpen={doneGroupOpen}
          onToggleDoneGroup={() => setDoneGroupOpen(prev => !prev)}
          onClose={() => setExpanded(false)}
          elapsedMs={summary.elapsedMs}
          water={summary.water}
          onUrgentDecision={handleUrgentDecision}
          changeSummary={changeSummary}
          currentTurnMs={summary.currentTurnMs}
          sessionTotalMs={summary.sessionTotalMs}
        />
      )}
    </div>
  );
}

/** 折叠态轮播单段 */
function Carousel({ slide }: { slide: CompactSlide }) {
  if (!slide) {
    return <span className="island-muted">空闲</span>;
  }
  return (
    <span className="island-seg">
      <span className="island-seg-lbl">{slide.label}</span>
      {slide.value && <span className="island-seg-val">{slide.value}</span>}
      {slide.barPercent != null && (
        <span className="island-mini-bar">
          <i style={{ width: `${slide.barPercent}%` }} />
        </span>
      )}
    </span>
  );
}

/** 会话变更段：常驻显示本次会话的文件变更与后台任务计数（数据源 changeSummary.ts） */
function ChangeDelta({ summary }: { summary: SessionChangeSummary }) {
  if (summary.totalFiles === 0 && summary.backgroundTasks.length === 0) {
    return <span className="island-delta island-delta-empty">无变更</span>;
  }
  return (
    <span className="island-delta">
      <span className="island-delta-ico"><FileDiff /></span>
      <span className="island-delta-n">{summary.totalFiles} 文件</span>
      <span className="island-delta-add">+{summary.totalAdded}</span>
      <span className="island-delta-del">−{summary.totalRemoved}</span>
      {summary.runningBgCount > 0 && (
        <span className="island-delta-bg">
          <span className="island-delta-ico"><Terminal /></span>
          <span>{summary.runningBgCount}</span>
        </span>
      )}
    </span>
  );
}
