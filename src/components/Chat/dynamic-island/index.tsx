/**
 * 灵动岛（Dynamic Island）进度浮层
 *
 * 状态机：hidden → compact → expanded → collapsed（已完成降级）→ hidden
 *
 * I1 阶段：岛组件骨架 + compact 折叠态。
 * - 订阅 useRuntimeSummary 派生运行态
 * - hidden：无运行态时不渲染
 * - compact：单行胶囊，运行中活动优先轮播（3s 一换，hover 暂停）
 * - expanded/collapsed：I2/I3 阶段实现
 *
 * 挂载点：EnhancedChatMessages.tsx 消息区容器顶部居中 absolute。
 * per-session：接收 sessionId，订阅对应 session store。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { clsx } from 'clsx';
import { useRuntimeSummary, formatDuration, type CompactSlide } from './useRuntimeSummary';
import { DynamicIslandExpanded } from './DynamicIslandExpanded';
import './DynamicIsland.css';

export interface DynamicIslandProps {
  /** 会话 ID（null = 活跃会话） */
  sessionId?: string | null;
  /** 定位跳转回调：滚动到 blockIndex 对应消息并高亮 */
  onLocate?: (blockIndex: number) => void;
}

/** 轮播间隔 */
const CAROUSEL_INTERVAL = 3000;
/** collapsed 退场停留 */
const COLLAPSED_HOLD = 5000;

export function DynamicIsland({ sessionId = null, onLocate }: DynamicIslandProps) {
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

  const { hasRunning, hasFailed, slides, cards, doneCount } = summary;

  // 判断是否处于 collapsed（已完成降级）态：无运行中、无失败、有已完成卡片
  const isCollapsed = !hasRunning && !hasFailed && doneCount > 0;
  // 是否完全空闲
  const isIdle = !hasRunning && !hasFailed && doneCount === 0;

  // 重置轮播索引当 slides 变化
  useEffect(() => {
    setCarouselIdx(0);
  }, [slides.length]);

  // 轮播定时器
  useEffect(() => {
    if (expanded || slides.length <= 1 || hoverRef.current) {
      // 展开或 hover 时暂停
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
  }, [expanded, slides.length, carouselIdx]);

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
    } else if (hasRunning) {
      // 恢复运行态时取消退场
      setCollapsedExiting(false);
    }
    return () => {
      if (collapsedTimerRef.current) {
        clearTimeout(collapsedTimerRef.current);
        collapsedTimerRef.current = null;
      }
    };
  }, [isCollapsed, expanded, hasRunning]);

  // 切换展开
  const toggleExpanded = useCallback(() => {
    setExpanded(prev => !prev);
  }, []);

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

  // 定位跳转
  const handleLocate = useCallback((blockIndex: number) => {
    setExpanded(false);
    if (blockIndex >= 0 && onLocate) {
      // 延迟一帧让面板收起后再滚动
      requestAnimationFrame(() => onLocate(blockIndex));
    }
  }, [onLocate]);

  // 空闲：不渲染
  if (isIdle) return null;

  // 状态点颜色
  const dotClass = hasFailed
    ? 'island-dot-fail'
    : isCollapsed
      ? 'island-dot-done'
      : 'island-dot-running';

  // 当前轮播段
  const activeSlide = slides[carouselIdx] || slides[0];

  // 已完成卡片（折叠到底部）
  const runningCards = cards.filter(c => c.running && !c.failed);
  const failedCards = cards.filter(c => c.failed);
  const doneCards = cards.filter(c => !c.running && !c.failed);

  return (
    <div
      ref={islandRef}
      className={clsx(
        'island-root',
        expanded && 'island-expanded',
        isCollapsed && !expanded && 'island-collapsed',
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

        {/* collapsed 降级态：显示完成记录条 */}
        {isCollapsed && !expanded ? (
          <div className="island-collapsed-bar">
            <span className="island-check">✓</span>
            <span className="island-collapsed-text">完成 · {doneCount} 项</span>
            <span className="island-time island-time-done">{formatDuration(summary.elapsedMs)}</span>
          </div>
        ) : (
          <>
            <div className="island-main">
              <Carousel slide={activeSlide} />
            </div>
            <span className="island-time">{formatDuration(summary.elapsedMs)}</span>
          </>
        )}

        <span className={clsx('island-chev', expanded && 'island-chev-open')}>▾</span>
      </div>

      {/* 展开态面板 */}
      {expanded && (
        <DynamicIslandExpanded
          runningCards={runningCards}
          failedCards={failedCards}
          doneCards={doneCards}
          doneGroupOpen={doneGroupOpen}
          onToggleDoneGroup={() => setDoneGroupOpen(prev => !prev)}
          onLocate={handleLocate}
          onClose={() => setExpanded(false)}
          elapsedMs={summary.elapsedMs}
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
      <span className="island-seg-label">{slide.label}</span>
      {slide.value && <span className="island-seg-val">{slide.value}</span>}
      {slide.barPercent != null && (
        <span className="island-tiny-bar">
          <i style={{ width: `${slide.barPercent}%` }} />
        </span>
      )}
    </span>
  );
}
