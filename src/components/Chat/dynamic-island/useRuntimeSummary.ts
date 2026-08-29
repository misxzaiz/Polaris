/**
 * 灵动岛运行态摘要 - 从 session store 派生
 *
 * 数据源全部现成（无后端改动）：
 * - 任务板进度：currentMessage.blocks 中最新 task_board 块
 * - Agent 运行态：最新 agent_run 块（status=running）
 * - Workflow 阶段：最新 workflow 工具块（status=running/pending）
 * - 兜底文案：store.progressMessage
 * - run 时长：活动块 startedAt 至今（前端计时）
 *
 * 多窗口：岛是 per-session 的，本 hook 接收 sessionId，
 * 订阅对应 session store（与 SessionMessagesView 同构）。
 */

import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { sessionStoreManager, useActiveSessionId } from '@/stores/conversationStore/sessionStoreManager';
import type { ConversationState, ConversationStoreInstance } from '@/stores/conversationStore/types';
import type {
  AgentRunBlock,
  ContentBlock,
  TaskBoardBlock,
  ToolCallBlock,
} from '@/types';

/** 运行态类型 */
export type RuntimeKind = 'task' | 'agent' | 'workflow' | 'progress';

/** 运行态卡片（展开态用） */
export interface RuntimeCard {
  /** 块在 currentMessage.blocks 中的索引（定位跳转用） */
  blockIndex: number;
  kind: RuntimeKind;
  /** 运行中还是已完成 */
  running: boolean;
  /** 是否有失败 */
  failed: boolean;
  /** 摘要文案 */
  summary: string;
  /** 详情文案 */
  detail: string;
  /** 进度百分比 0-100（可选） */
  percent?: number;
  /** 活动块 id（定位高亮 key） */
  blockId: string;
}

/** 折叠态轮播段 */
export interface CompactSlide {
  kind: RuntimeKind;
  /** HTML 文本（已截断） */
  label: string;
  value: string;
  /** 微型进度条百分比（可选） */
  barPercent?: number;
}

/** 运行态摘要 */
export interface RuntimeSummary {
  /** 是否有运行中活动 */
  hasRunning: boolean;
  /** 是否有失败 */
  hasFailed: boolean;
  /** 用户主动中断中 */
  isInterrupting: boolean;
  /** 运行中卡片数 */
  runningCount: number;
  /** 已完成卡片数 */
  doneCount: number;
  /** 折叠态轮播段（仅运行中，3s 一换） */
  slides: CompactSlide[];
  /** 展开态卡片（运行中在上，已完成在下） */
  cards: RuntimeCard[];
  /** run 持续时长（ms），取最早运行中块的 startedAt */
  elapsedMs: number;
  /** 兜底进度文案（无任何块时） */
  progressMessage: string | null;
}

const EMPTY_SUMMARY: RuntimeSummary = {
  hasRunning: false,
  hasFailed: false,
  isInterrupting: false,
  runningCount: 0,
  doneCount: 0,
  slides: [],
  cards: [],
  elapsedMs: 0,
  progressMessage: null,
};

const WORKFLOW_TOOL_NAME = 'workflow';

/** 截断到 max 字符，超出加 … */
function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 格式化时长 ms → "2m 31s" / "42s" */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * 从 currentMessage.blocks 派生运行态摘要。
 * 纯函数，便于测试与 memo。
 */
export function deriveRuntimeSummary(
  blocks: ContentBlock[],
  progressMessage: string | null,
  now: number,
  isInterrupting: boolean = false,
): RuntimeSummary {
  if (!blocks || blocks.length === 0) {
    return progressMessage
      ? { ...EMPTY_SUMMARY, isInterrupting, progressMessage, hasRunning: true, runningCount: 1, slides: [{ kind: 'progress', label: '进度', value: truncate(progressMessage, 32) }], cards: [{ blockIndex: -1, kind: 'progress', running: true, failed: false, summary: truncate(progressMessage, 48), detail: progressMessage, blockId: '__progress__' }], elapsedMs: 0 }
      : { ...EMPTY_SUMMARY, isInterrupting };
  }

  const cards: RuntimeCard[] = [];
  let earliestRunningStartedAt: number | null = null;

  // 扫描所有块，收集运行态卡片
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // TaskBoard
    if (block.type === 'task_board') {
      const tb = block as TaskBoardBlock;
      const total = tb.total || tb.items.length;
      const completed = tb.completed || 0;
      const inProgress = tb.inProgress || 0;
      const blocked = tb.blocked || 0;
      const running = inProgress > 0 || (completed < total && total > 0);
      const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
      // 当前进行中项
      const activeItem = tb.items.find(it => it.status === 'in_progress') || tb.items.find(it => it.status === 'blocked');
      const activeLabel = activeItem?.activeForm || activeItem?.subject;
      const detail = activeLabel
        ? `${activeItem?.status === 'blocked' ? '⛔' : '◐'} ${truncate(activeLabel, 28)} ← #${activeItem?.id}`
        : `${completed}/${total} 已完成`;
      cards.push({
        blockIndex: i,
        kind: 'task',
        running,
        failed: blocked > 0 && inProgress === 0,
        summary: `${completed}/${total}${inProgress > 0 ? ` · ${inProgress} 运行` : ''}${blocked > 0 ? ` · ${blocked} 阻塞` : ''}`,
        detail,
        percent,
        blockId: tb.id,
      });
      if (running && tb.updatedAt) {
        const ts = new Date(tb.updatedAt).getTime();
        if (!Number.isNaN(ts) && (earliestRunningStartedAt === null || ts < earliestRunningStartedAt)) {
          earliestRunningStartedAt = ts;
        }
      }
      continue;
    }

    // AgentRun
    if (block.type === 'agent_run') {
      const ar = block as AgentRunBlock;
      const running = ar.status === 'running' || ar.status === 'pending';
      const failed = ar.status === 'error';
      const done = ar.status === 'success' || ar.status === 'canceled';
      const toolTotal = ar.toolCalls?.length || 0;
      const toolDone = ar.toolCalls?.filter(t => t.status === 'completed').length || 0;
      const summary = failed
        ? `失败 · ${ar.duration ? formatDuration(ar.duration) : ''}`
        : done
          ? `完成 · ${ar.duration ? formatDuration(ar.duration) : ''}`
          : `${ar.duration ? formatDuration(ar.duration) : '运行中'}${toolTotal > 0 ? ` · ${toolDone}/${toolTotal} 工具` : ''}`;
      const detail = failed
        ? truncate(ar.error || '运行出错', 48)
        : ar.progressMessage
          ? truncate(ar.progressMessage, 48)
          : toolTotal > 0
            ? `${toolDone}/${toolTotal} 工具完成`
            : ar.agentType;
      cards.push({
        blockIndex: i,
        kind: 'agent',
        running: running && !failed,
        failed,
        summary,
        detail,
        percent: toolTotal > 0 ? Math.round((toolDone / toolTotal) * 100) : undefined,
        blockId: ar.id,
      });
      if (running && !failed && ar.startedAt) {
        const ts = new Date(ar.startedAt).getTime();
        if (!Number.isNaN(ts) && (earliestRunningStartedAt === null || ts < earliestRunningStartedAt)) {
          earliestRunningStartedAt = ts;
        }
      }
      continue;
    }

    // Workflow 工具块
    if (block.type === 'tool_call') {
      const tc = block as ToolCallBlock;
      if (tc.name.toLowerCase() !== WORKFLOW_TOOL_NAME) continue;
      const running = tc.status === 'running' || tc.status === 'pending';
      const failed = tc.status === 'failed';
      const done = tc.status === 'completed';
      const summary = failed
        ? '失败'
        : done
          ? '完成'
          : '运行中';
      const detail = failed
        ? truncate(tc.error || '工作流出错', 48)
        : running
          ? `${tc.name} 运行中`
          : '已完成';
      cards.push({
        blockIndex: i,
        kind: 'workflow',
        running: running && !failed,
        failed,
        summary,
        detail,
        blockId: tc.id,
      });
      if (running && !failed && tc.startedAt) {
        const ts = new Date(tc.startedAt).getTime();
        if (!Number.isNaN(ts) && (earliestRunningStartedAt === null || ts < earliestRunningStartedAt)) {
          earliestRunningStartedAt = ts;
        }
      }
      continue;
    }
  }

  // 兜底 progressMessage（仅当没有任何运行态卡片时作为独立卡片）
  if (cards.length === 0 && progressMessage) {
    cards.push({
      blockIndex: -1,
      kind: 'progress',
      running: true,
      failed: false,
      summary: truncate(progressMessage, 48),
      detail: progressMessage,
      blockId: '__progress__',
    });
  }

  const runningCards = cards.filter(c => c.running && !c.failed);
  const failedCards = cards.filter(c => c.failed);
  const doneCards = cards.filter(c => !c.running && !c.failed);
  const hasRunning = runningCards.length > 0;
  const hasFailed = failedCards.length > 0;

  // 折叠态轮播段：仅运行中（非失败）
  const slides: CompactSlide[] = runningCards.map(c => {
    if (c.kind === 'task') {
      const tb = blocks[c.blockIndex] as TaskBoardBlock;
      const total = tb.total || tb.items.length;
      const completed = tb.completed || 0;
      const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
      return { kind: 'task', label: '任务', value: `${completed}/${total}`, barPercent: percent };
    }
    if (c.kind === 'agent') {
      const ar = blocks[c.blockIndex] as AgentRunBlock;
      return { kind: 'agent', label: `◈ ${truncate(ar.agentType, 20)}`, value: c.summary };
    }
    if (c.kind === 'workflow') {
      return { kind: 'workflow', label: '⚙ workflow', value: c.summary };
    }
    return { kind: 'progress', label: truncate(c.detail, 24), value: '' };
  });

  // 展开态排序：失败置顶 → 运行中（按开始时间倒序，最新在上）→ 已完成折叠
  // 这里保持失败+运行中在上，已完成在下的顺序，由渲染层分组
  const orderedCards = [...failedCards, ...runningCards, ...doneCards];

  const elapsedMs = earliestRunningStartedAt !== null
    ? Math.max(0, now - earliestRunningStartedAt)
    : 0;

  return {
    hasRunning,
    hasFailed,
    isInterrupting,
    runningCount: runningCards.length,
    doneCount: doneCards.length,
    slides,
    cards: orderedCards,
    elapsedMs,
    progressMessage,
  };
}

// ============================================================================
// React Hook
// ============================================================================

/**
 * 订阅指定 session store 的运行态摘要。
 * - sessionId 为 null 时订阅活跃会话
 * - 与 SessionMessagesView 同构，多窗口各自独立
 *
 * 计时策略：elapsedMs 由独立的 1s tick state 驱动，不放进 getSnapshot，
 * 避免 Date.now() 导致快照引用每次都变 → useSyncExternalStore 循环重渲染。
 */
export function useRuntimeSummary(sessionId: string | null): RuntimeSummary {
  const activeId = useActiveSessionId();
  const targetId = sessionId ?? activeId;
  const stores = useStore(sessionStoreManager, (state) => state.stores);
  const store = targetId ? stores.get(targetId) : null;

  // 1s tick：驱动 elapsedMs 更新（仅当有运行中活动时才计时）
  const [tick, setTick] = useState(0);
  const tickStartRef = useRef<number>(0);
  tickStartRef.current = tick;

  // getSnapshot 必须纯净：不能调 Date.now()（否则引用每次都变 → 循环重渲染）
  const cachedRef = useRef<RuntimeSummary>(EMPTY_SUMMARY);
  const cachedStoreRef = useRef<typeof store>(null);

  const getSnapshot = () => {
    if (!store) {
      cachedRef.current = EMPTY_SUMMARY;
      return EMPTY_SUMMARY;
    }
    const state = store.getState() as ConversationState;
    const blocks = state.currentMessage?.blocks ?? [];
    const pm = state.progressMessage;
    const interrupting = !!state.isInterrupting;
    // now 用 tick（稳定），而非 Date.now()
    const now = tickStartRef.current;
    const next = deriveRuntimeSummary(blocks, pm, now, interrupting);
    if (
      cachedStoreRef.current === store &&
      shallowEqualSummary(cachedRef.current, next)
    ) {
      return cachedRef.current;
    }
    cachedStoreRef.current = store;
    cachedRef.current = next;
    return next;
  };

  const subscribe = (onChange: () => void) => {
    if (!store) return sessionStoreManager.subscribe(onChange);
    return store.subscribe(onChange);
  };

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const summary = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SUMMARY);

  // 计时 effect：仅当有运行中活动时，每秒推进 tick
  useEffect(() => {
    if (!summary.hasRunning && !summary.isInterrupting) return;
    const timer = setInterval(() => {
      setTick(t => (t === 0 ? Date.now() : t + 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [summary.hasRunning, summary.isInterrupting]);

  // 运行态开始时记录起始 tick
  useEffect(() => {
    if (summary.hasRunning && tickStartRef.current === 0) {
      setTick(Date.now());
    }
  }, [summary.hasRunning]);

  return summary;
}

/** 浅比较两个摘要（避免每次 store 变动都重渲染） */
function shallowEqualSummary(a: RuntimeSummary, b: RuntimeSummary): boolean {
  if (a.hasRunning !== b.hasRunning) return false;
  if (a.hasFailed !== b.hasFailed) return false;
  if (a.isInterrupting !== b.isInterrupting) return false;
  if (a.runningCount !== b.runningCount) return false;
  if (a.doneCount !== b.doneCount) return false;
  if (a.elapsedMs !== b.elapsedMs) return false;
  if (a.progressMessage !== b.progressMessage) return false;
  if (a.slides.length !== b.slides.length) return false;
  if (a.cards.length !== b.cards.length) return false;
  // slides 内容比较
  for (let i = 0; i < a.slides.length; i++) {
    if (a.slides[i].label !== b.slides[i].label) return false;
    if (a.slides[i].value !== b.slides[i].value) return false;
    if (a.slides[i].barPercent !== b.slides[i].barPercent) return false;
  }
  // cards 关键字段比较
  for (let i = 0; i < a.cards.length; i++) {
    if (a.cards[i].running !== b.cards[i].running) return false;
    if (a.cards[i].failed !== b.cards[i].failed) return false;
    if (a.cards[i].summary !== b.cards[i].summary) return false;
    if (a.cards[i].detail !== b.cards[i].detail) return false;
    if (a.cards[i].percent !== b.cards[i].percent) return false;
  }
  return true;
}

// 暴露给 useActiveSession 同构访问（保留 store 实例类型引用）
export type { ConversationStoreInstance };
