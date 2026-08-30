/**
 * 灵动岛（Dynamic Island）v2 —— 会话运行态中枢
 *
 * 状态机：hidden → compact → expanded → collapsed（已完成降级）→ hidden
 *
 * v2 变更（用户反馈驱动）：
 * - 贴顶小形态（top:0 只留底部圆角，compact 28px），背景亮两档与暗背景形成反差
 * - 移除定位跳转：展开即详情，不再滚动消息流
 * - 紧急度分层：需要你（urgent）→ 运行中 / 失败 → 已完成（折叠）→ 底部水位条
 * - urgent 卡内联审批（批准 / 拒绝 / 跳过），无需回到消息流
 * - 全部图标使用 lucide-react，无 emoji
 * - 任务板展开直接显示任务清单 items
 *
 * 挂载点：EnhancedChatMessages.tsx / SessionMessagesView.tsx 消息区容器顶部居中 absolute。
 * per-session：接收 sessionId，订阅对应 session store。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, Square, TriangleAlert, CircleCheck } from 'lucide-react';
import { useRuntimeSummary, formatDuration, type CompactSlide, type UrgentCard } from './useRuntimeSummary';
import { DynamicIslandExpanded } from './DynamicIslandExpanded';
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager';
import { invoke } from '@/services/tauri';
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

  const { hasRunning, hasFailed, isInterrupting, slides, cards, doneCount, urgent, thinking } = summary;

  // 判断是否处于 collapsed（已完成降级）态：无运行中、无失败、无 urgent、有已完成卡片
  const isCollapsed = !hasRunning && !hasFailed && !isInterrupting && urgent.length === 0 && doneCount > 0;
  // 是否完全空闲（urgent 常驻可见；中断态保持可见 1s）
  const isIdle = urgent.length === 0 && !hasRunning && !hasFailed && !isInterrupting && doneCount === 0;
  // Minimal 思考态：有 thinking block 文本，且无运行卡片、无 urgent、未中断
  // 思考时 blocks 里有 thinking block（content 流式累积），但无 task/agent 卡片 → hasRunning=false、slides=[]
  // Minimal 态正是补这个缺口，接 deriveThinking 数据源
  const isThinking = !!thinking && !hasRunning && urgent.length === 0 && !isInterrupting;

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

  // collapsed 退场：进入 collapsed 态后停留 5s，无交互则淡出
  useEffect(() => {
    if (collapsedTimerRef.current) {
      clearTimeout(collapsedTimerRef.current);
      collapsedTimerRef.current = null;
    }
    if (isCollapsed && !expanded) {
      setCollapsedExiting(false);
      collapsedTimerRef.current = setTimeout(() => {
        setCollapsedExiting(true);
        // 淡出动画后不渲染（交由 isIdle 自然卸载）
      }, COLLAPSED_HOLD);
    } else if (hasRunning || urgent.length > 0) {
      // 恢复运行态或出现 urgent 时取消退场
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
        const store = sessionStoreManager.getState().getStoreByConversationId(card.sessionId);
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
          await invoke('answer_question', {
            sessionId: q.sessionId || card.sessionId,
            callId: q.id,
            answer: { answers: [], declined: !approved },
          });
        }
      } catch {
        // 决策失败交由消息流兜底，此处静默
      }
    })();
  }, []);

  // Minimal 跑马灯：思考文本滚动时长按文本长度算（替代固定 3s 轮播）
  // 必须在 early return 之前调用，否则 isIdle 切换会导致 hook 数量不一致
  const marqueeRef = useRef<HTMLSpanElement>(null);
  const [marqueeScroll, setMarqueeScroll] = useState(true);
  useEffect(() => {
    const el = marqueeRef.current;
    if (!el) return;
    // 文本宽度 <= 视口宽度时不滚动
    if (el.scrollWidth <= el.clientWidth) {
      setMarqueeScroll(false);
    } else {
      setMarqueeScroll(true);
    }
  }, [thinking]);
  const marqueeDuration = thinking
    ? Math.max(6, Math.min(20, thinking.length / 8))
    : 14;

  // 空闲：不渲染
  if (isIdle) return null;

  // 状态点颜色：urgent 最优先 → 失败 → 已完成 → 运行中
  const dotClass = urgent.length > 0
    ? 'island-dot-warn'
    : hasFailed
      ? 'island-dot-fail'
      : isCollapsed
        ? 'island-dot-done'
        : isThinking
          ? 'island-dot-thinking'
          : 'island-dot-running';

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
        expanded && 'island-expanded',
        isCollapsed && !expanded && 'island-collapsed',
        isThinking && !expanded && 'island-minimal',
        collapsedExiting && 'island-exiting',
      )}
    >
      {/* 折叠态 */}
      <div
        className="island-compact"
        onClick={toggleExpanded}
        onMouseEnter={() => { hoverRef.current = true; }}
        onMouseLeave={() => { hoverRef.current = false; }}
      >
        <span className={clsx('island-dot', dotClass)} />

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
        ) : isCollapsed ? (
          <>
            <div className="island-main">
              <span className="island-seg">
                <span className="island-seg-ico island-seg-ico-done"><CircleCheck /></span>
                <span className="island-seg-lbl">完成 · {doneCount} 项</span>
              </span>
            </div>
            <span className="island-time">{formatDuration(summary.elapsedMs)}</span>
          </>
        ) : (
          <>
            <div className="island-main">
              <Carousel slide={activeSlide} />
            </div>
            <span className="island-time">{formatDuration(summary.elapsedMs)}</span>
          </>
        )}

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
