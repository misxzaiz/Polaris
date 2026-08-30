/**
 * 灵动岛运行态摘要 - 从 session store 派生
 *
 * v2 按「紧急度分层」组织：
 *   1. 需要你（urgent）：permission_request / question / plan_mode 待处理
 *   2. 正在运行（running）：task / agent / workflow
 *   3. 已完成（done）：折叠分组
 *   4. 上下文水位（water）：usageStats 派生底部条
 *
 * 定位能力已移除（v2 用户反馈：悬浮岛无需定位，展开直接看具体信息）。
 *
 * 多窗口：岛是 per-session 的，本 hook 接收 sessionId，
 * 订阅对应 session store（与 SessionMessagesView 同构）。
 */

import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { sessionStoreManager, useActiveSessionId } from '@/stores/conversationStore/sessionStoreManager';
import type { ConversationState, ConversationStoreInstance } from '@/stores/conversationStore/types';
import type { UsageStats } from '@/stores/conversationStore/types';
import type {
  AgentRunBlock,
  ContentBlock,
  PermissionRequestBlock,
  PlanModeBlock,
  QuestionBlock,
  TaskBoardBlock,
  ThinkingBlock,
  ToolCallBlock,
} from '@/types';
import { parseWorkflowResult } from '../tool-calls/workflowParsers';

/** 运行态类型 */
export type RuntimeKind = 'task' | 'agent' | 'workflow' | 'progress';

/** 需要你（urgent）类型 */
export type UrgentKind = 'permission' | 'question' | 'plan';

/** 任务清单行状态 */
export type TaskRowStatus = 'done' | 'active' | 'pending' | 'blocked';

/** 任务清单行（task 卡展开后直接列出，替代 v1 的「只看数量」） */
export interface TaskRow {
  id: string;
  /** 展示文案（activeForm || subject） */
  label: string;
  status: TaskRowStatus;
}

/** 需要你（urgent）卡片 */
export interface UrgentCard {
  kind: UrgentKind;
  /** 块 id（操作透传 key） */
  id: string;
  /** 会话 id（审批 / 答案提交目标） */
  sessionId: string;
  /** 标题 */
  summary: string;
  /** 详情正文 */
  detail: string;
  /** 子项数（question 多题 / permission 多工具；仅 >1 时展示） */
  count?: number;
}

/** 运行态卡片（展开态用，无定位字段） */
export interface RuntimeCard {
  kind: RuntimeKind;
  /** 运行中还是已完成 */
  running: boolean;
  /** 是否有失败 */
  failed: boolean;
  /** 主标题（任务卡：任务板；agent：类型名） */
  summary: string;
  /** 副信息 meta（如 "4/10 · 2 运行"、"2m 31s"） */
  meta?: string;
  /** 详情文案 */
  detail: string;
  /** 原始输出（已完成卡展开查看，workflow/agent 的 output） */
  output?: string;
  /** 进度百分比 0-100（可选） */
  percent?: number;
  /** 任务清单（仅 task 卡） */
  items?: TaskRow[];
  /** 折叠态轮播段（仅运行中卡；null 则不轮播该卡） */
  slide?: CompactSlide | null;
  /** 聚合计数（同类完成卡合并） */
  count?: number;
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

/** 上下文水位条 */
export interface ContextWater {
  /** 已用 token（input + cacheCreation + cacheRead） */
  used: number;
  /** 上下文窗口大小 */
  window: number;
  /** 0-100；window 缺失（0）时为 null，仅显示数字 */
  percent: number | null;
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
  /** 需要你（最优先级，常驻） */
  urgent: UrgentCard[];
  /** 上下文水位（null = 无用量数据） */
  water: ContextWater | null;
  /** 折叠态轮播段（仅运行中，3s 一换） */
  slides: CompactSlide[];
  /** 展开态卡片（运行中在上，已完成在下） */
  cards: RuntimeCard[];
  /** run 持续时长（ms），取最早运行中块的 startedAt */
  elapsedMs: number;
  /** 兜底进度文案（无任何块时） */
  progressMessage: string | null;
  /** AI 思考文本（最后一个 thinking block.content，流式累积） */
  thinking: string | null;
}

const EMPTY_SUMMARY: RuntimeSummary = {
  hasRunning: false,
  hasFailed: false,
  isInterrupting: false,
  runningCount: 0,
  doneCount: 0,
  urgent: [],
  water: null,
  slides: [],
  cards: [],
  elapsedMs: 0,
  progressMessage: null,
  thinking: null,
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

/** 格式化 token 数 → "12.4k" / "89" */
export function formatTokens(n: number): string {
  if (!n || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** 派生需要你（urgent）卡片 */
function deriveUrgent(blocks: ContentBlock[]): UrgentCard[] {
  const urgent: UrgentCard[] = [];

  for (const block of blocks) {
    // 权限请求：待处理才显示
    if (block.type === 'permission_request') {
      const pr = block as PermissionRequestBlock;
      if (pr.status !== 'pending') continue;
      const pendingDenials = (pr.denials || []).filter(d => !d.status || d.status === 'pending');
      const toolName = pendingDenials[0]?.toolName;
      urgent.push({
        kind: 'permission',
        id: pr.id,
        sessionId: pr.sessionId,
        summary: toolName ? `需要授权 · ${truncate(toolName, 24)}` : '需要授权',
        detail: pendingDenials[0]?.reason || (pendingDenials.length > 0 ? '工具调用等待批准' : '等待批准'),
        count: pendingDenials.length > 1 ? pendingDenials.length : undefined,
      });
      continue;
    }

    // 提问：待回答才显示
    if (block.type === 'question') {
      const q = block as QuestionBlock;
      if (q.status !== 'pending' || q.declined) continue;
      const first = q.questions?.[0];
      urgent.push({
        kind: 'question',
        id: q.id,
        sessionId: q.sessionId || '',
        summary: first?.header || q.header || '提问',
        detail: first?.question || q.header || '等待回答',
        count: (q.questions?.length || 1) > 1 ? q.questions?.length : undefined,
      });
      continue;
    }

    // 计划审批：pending_approval 才显示
    if (block.type === 'plan_mode') {
      const pm = block as PlanModeBlock;
      if (pm.status !== 'pending_approval') continue;
      urgent.push({
        kind: 'plan',
        id: pm.id,
        sessionId: pm.sessionId,
        summary: '等待审批 · 执行计划',
        detail: pm.title || pm.description || '计划等待批准后执行',
      });
    }
  }

  return urgent;
}

/** 派生上下文水位条 */
function deriveWater(usageStats: UsageStats | null): ContextWater | null {
  if (!usageStats) return null;
  const used = (usageStats.input || 0) + (usageStats.cacheCreation || 0) + (usageStats.cacheRead || 0);
  const window = usageStats.contextWindow || 0;
  return {
    used,
    window,
    percent: window > 0 ? Math.min(100, Math.round((used / window) * 100)) : null,
  };
}

/**
 * 派生 AI 思考文本（Minimal 跑马灯态数据源）。
 * 取最后一个 thinking block 的 content（appendThinkingBlock 流式累积）。
 */
function deriveThinking(blocks: ContentBlock[]): string | null {
  if (!blocks || blocks.length === 0) return null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'thinking') {
      return (blocks[i] as ThinkingBlock).content || null;
    }
  }
  return null;
}

/**
 * 从 workflow 工具调用的 input 防御式提取任务描述。
 * 不臆测单一字段名：尝试 prompt/command/task/description/goal/query，
 * 全部缺失则回退 null（由调用方决定回退文案）。
 */
function deriveWorkflowLabel(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const fields = ['prompt', 'command', 'task', 'description', 'goal', 'query', 'message'];
  for (const f of fields) {
    const v = input[f];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * 从 workflow 工具调用的 output 解析可展示详情。
 * 复用 workflowParsers.parseWorkflowResult，零臆测字段名。
 */
function deriveWorkflowDetail(output: string | undefined, running: boolean, failed: boolean): string {
  if (failed) return '工作流出错';
  if (running) return 'Workflow 执行中';
  if (!output) return '已完成';
  const parsed = parseWorkflowResult(output);
  if (parsed.kind === 'generic' && parsed.data.summary) {
    return truncate(parsed.data.summary, 48);
  }
  if (parsed.kind === 'generic' && parsed.data.workflowProgress?.length) {
    const first = parsed.data.workflowProgress[0];
    const label = first.label || first.phaseTitle || first.resultPreview;
    if (label) return truncate(label, 48);
  }
  return '已完成';
}

/** 任务清单行状态 → 展示状态 */
function taskRowStatus(status: TaskBoardBlock['items'][number]['status']): TaskRowStatus {
  switch (status) {
    case 'completed': return 'done';
    case 'in_progress': return 'active';
    case 'blocked': return 'blocked';
    default: return 'pending';
  }
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
  usageStats: UsageStats | null = null,
): RuntimeSummary {
  const water = deriveWater(usageStats);
  const urgent = deriveUrgent(blocks || []);
  const thinking = deriveThinking(blocks || []);

  if (!blocks || blocks.length === 0) {
    if (!progressMessage) return { ...EMPTY_SUMMARY, isInterrupting, urgent, water, thinking };
    const card: RuntimeCard = {
      kind: 'progress',
      running: true,
      failed: false,
      summary: truncate(progressMessage, 48),
      detail: progressMessage,
      slide: { kind: 'progress', label: '进度', value: truncate(progressMessage, 32) },
    };
    return {
      ...EMPTY_SUMMARY,
      isInterrupting,
      urgent,
      water,
      thinking,
      hasRunning: true,
      runningCount: 1,
      slides: [card.slide!],
      cards: [card],
      elapsedMs: 0,
      progressMessage,
    };
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
      const meta = `${completed}/${total}${inProgress > 0 ? ` · ${inProgress} 运行` : ''}${blocked > 0 ? ` · ${blocked} 阻塞` : ''}`;
      const items: TaskRow[] = tb.items.map(it => ({
        id: it.id,
        label: truncate(it.activeForm || it.subject, 36),
        status: taskRowStatus(it.status),
      }));
      cards.push({
        kind: 'task',
        running,
        failed: blocked > 0 && inProgress === 0,
        summary: '任务板',
        meta,
        detail: activeLabel ? truncate(activeLabel, 28) : `${completed}/${total} 已完成`,
        percent,
        items,
        slide: running
          ? {
              kind: 'task',
              label: '任务',
              // 进行中任务文案塞进轮播，岛上可滚动展示当前任务内容
              value: activeLabel ? `${truncate(activeLabel, 32)} · ${completed}/${total}` : `${completed}/${total}`,
              barPercent: percent,
            }
          : null,
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
      const meta = failed
        ? '失败'
        : done
          ? `完成 · ${ar.duration ? formatDuration(ar.duration) : ''}`
          : ar.duration ? formatDuration(ar.duration) : '运行中';
      const detail = failed
        ? truncate(ar.error || '运行出错', 48)
        : ar.progressMessage
          ? truncate(ar.progressMessage, 48)
          : toolTotal > 0
            ? `${toolDone}/${toolTotal} 工具完成`
            : ar.agentType;
      const percent = ar.progressPercent != null
        ? ar.progressPercent
        : toolTotal > 0 ? Math.round((toolDone / toolTotal) * 100) : undefined;
      // summary 优先用 progressMessage（更友好），回退 agentType
      const agentLabel = ar.progressMessage || ar.agentType;
      const isDone = done || failed;
      cards.push({
        kind: 'agent',
        running: running && !failed,
        failed,
        summary: truncate(agentLabel, 24),
        meta,
        detail,
        output: isDone ? ar.output : undefined,
        percent,
        slide: running && !failed
          ? { kind: 'agent', label: truncate(agentLabel, 20), value: meta, barPercent: percent }
          : null,
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
      const meta = failed ? '失败' : done ? '完成' : '运行中';
      // summary 从 input 防御式提取任务描述，回退 'Workflow'
      const wfLabel = deriveWorkflowLabel(tc.input);
      const summary = wfLabel ? `Workflow · ${truncate(wfLabel, 24)}` : 'Workflow';
      // detail 从 output 解析（复用 workflowParsers），回退状态文案
      const detail = deriveWorkflowDetail(tc.output, running, failed);
      cards.push({
        kind: 'workflow',
        running: running && !failed,
        failed,
        summary,
        meta,
        detail,
        output: done ? tc.output : undefined,
        slide: running && !failed
          ? { kind: 'workflow', label: summary, value: '运行中' }
          : null,
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
      kind: 'progress',
      running: true,
      failed: false,
      summary: truncate(progressMessage, 48),
      detail: progressMessage,
      slide: { kind: 'progress', label: '进度', value: truncate(progressMessage, 32) },
    });
  }

  const runningCards = cards.filter(c => c.running && !c.failed);
  const failedCards = cards.filter(c => c.failed);
  const rawDoneCards = cards.filter(c => !c.running && !c.failed);
  const hasRunning = runningCards.length > 0;
  const hasFailed = failedCards.length > 0;

  // 已完成同类卡聚合：同 kind+summary 合并，detail 累积 + count
  const doneCards: RuntimeCard[] = [];
  const doneGroupMap = new Map<string, number>();
  for (const c of rawDoneCards) {
    const key = `${c.kind}:${c.summary}`;
    const idx = doneGroupMap.get(key);
    if (idx === undefined) {
      doneGroupMap.set(key, doneCards.length);
      doneCards.push({ ...c, count: 1 });
    } else {
      const prev = doneCards[idx];
      prev.count = (prev.count || 1) + 1;
      // 累积详情：合并多张卡的 detail/output
      if (c.detail && c.detail !== prev.detail) {
        prev.detail = prev.detail ? `${prev.detail}\n${c.detail}` : c.detail;
      }
      if (c.output && c.output !== prev.output) {
        prev.output = prev.output ? `${prev.output}\n---\n${c.output}` : c.output;
      }
    }
  }

  // 折叠态轮播段：仅运行中（非失败），直接复用卡上的 slide
  const slides: CompactSlide[] = runningCards
    .map(c => c.slide)
    .filter((s): s is CompactSlide => !!s);

  // 展开态排序：失败置顶 → 运行中 → 已完成折叠（由渲染层分组）
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
    urgent,
    water,
    slides,
    cards: orderedCards,
    elapsedMs,
    progressMessage,
    thinking,
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
    const usage = state.usageStats;
    // now 用 tick（稳定），而非 Date.now()
    const now = tickStartRef.current;
    const next = deriveRuntimeSummary(blocks, pm, now, interrupting, usage);
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
  if (a.thinking !== b.thinking) return false;
  if (a.slides.length !== b.slides.length) return false;
  if (a.cards.length !== b.cards.length) return false;
  if (a.urgent.length !== b.urgent.length) return false;
  if (a.water?.used !== b.water?.used) return false;
  if (a.water?.window !== b.water?.window) return false;
  // urgent 内容比较
  for (let i = 0; i < a.urgent.length; i++) {
    const ua = a.urgent[i];
    const ub = b.urgent[i];
    if (!ua || !ub) return false;
    if (ua.kind !== ub.kind) return false;
    if (ua.id !== ub.id) return false;
    if (ua.summary !== ub.summary) return false;
    if (ua.detail !== ub.detail) return false;
    if (ua.count !== ub.count) return false;
  }
  // slides 内容比较
  for (let i = 0; i < a.slides.length; i++) {
    if (a.slides[i].label !== b.slides[i].label) return false;
    if (a.slides[i].value !== b.slides[i].value) return false;
    if (a.slides[i].barPercent !== b.slides[i].barPercent) return false;
  }
  // cards 关键字段比较
  for (let i = 0; i < a.cards.length; i++) {
    const ca = a.cards[i];
    const cb = b.cards[i];
    if (!ca || !cb) return false;
    if (ca.running !== cb.running) return false;
    if (ca.failed !== cb.failed) return false;
    if (ca.summary !== cb.summary) return false;
    if (ca.meta !== cb.meta) return false;
    if (ca.detail !== cb.detail) return false;
    if (ca.percent !== cb.percent) return false;
    if (ca.count !== cb.count) return false;
    if (ca.output !== cb.output) return false;
    if ((ca.items?.length || 0) !== (cb.items?.length || 0)) return false;
    if (ca.items) {
      for (let j = 0; j < ca.items.length; j++) {
        if (ca.items[j].id !== cb.items?.[j]?.id) return false;
        if (ca.items[j].label !== cb.items?.[j]?.label) return false;
        if (ca.items[j].status !== cb.items?.[j]?.status) return false;
      }
    }
  }
  return true;
}

// 暴露给 useActiveSession 同构访问（保留 store 实例类型引用）
export type { ConversationStoreInstance };
