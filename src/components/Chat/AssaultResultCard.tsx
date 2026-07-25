/**
 * 硬问题攻坚结果卡片 - 来源会话内联渲染
 *
 * 工具消息渲染层按 toolName 替换:workflow 工具块渲染为本卡片
 * (chatBlocks/index.tsx 接线)。从 tool_result JSON 解析攻坚结果:
 * 方法族注册表、轮次时间线、survivor/needsHumanReview、STATE_SNAPSHOT。
 *
 * 数据源限制:workflow 是 Claude Code SDK 内置工具,运行中 log() 不实时
 * 到达前端(仅完成后作为 tool_result 一次性输出)。故本卡片为"完成态展示",
 * 运行中展示靠 block.status(工具自身 pending/running 态),完成后解析 output。
 *
 * 降级:解析失败走 ToolCallBlockRenderer。
 */

import { memo, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import {
  Target,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  XCircle,
  ChevronDown,
  ChevronRight,
  Flame,
  Ban,
  Unlock,
  Activity,
} from 'lucide-react';
import type { ToolCallBlock } from '@/types';
import { ToolCallBlockRenderer } from './chatBlocks/ToolCallBlockRenderer';

// ---------- 类型 ----------
interface FamilySnapshot {
  key: string;
  blocked?: boolean;
  attempts?: number;
  lastNewMechanism?: string | null;
}

interface AssaultResult {
  status: 'solved' | 'open';
  family?: string;
  artifacts?: string[];
  acceptanceArtifact?: string;
  rounds?: number;
  strongest?: string;
  gap?: string;
  needsHumanReview?: boolean;
  note?: string;
}

interface WorkflowProgressAgent {
  type: string;
  label?: string;
  phaseTitle?: string;
  state?: string;
  tokens?: number;
  durationMs?: number;
  error?: string;
  resultPreview?: string;
}

interface WorkflowOutput {
  summary?: string;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  logs?: string[];
  result?: AssaultResult;
  workflowProgress?: WorkflowProgressAgent[];
}

// ---------- 解析 ----------
function parseWorkflowOutput(output?: string): WorkflowOutput | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output);
    // 兼容:SDK 可能嵌套在 text/output 字段(字符串)
    const candidate =
      typeof parsed === 'string' ? JSON.parse(parsed) :
      typeof parsed?.text === 'string' ? JSON.parse(parsed.text) :
      typeof parsed?.output === 'string' ? JSON.parse(parsed.output) :
      parsed;
    if (candidate && (candidate.result || candidate.logs || candidate.workflowProgress)) {
      return candidate as WorkflowOutput;
    }
    // 兼容:result 直接是顶层对象
    if (candidate && typeof candidate === 'object' && (candidate as AssaultResult).status) {
      return { result: candidate as AssaultResult };
    }
    return null;
  } catch {
    return null;
  }
}

/** 从 logs 提取结构化事件 */
interface TimelineEvent {
  round: number;
  type: 'round_start' | 'blocked' | 'unlocked' | 'survivor' | 'refuted' | 'snapshot' | 'synth' | 'info';
  text: string;
  family?: string;
}

function extractTimelineEvents(logs: string[] = []): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let currentRound = 0;
  for (const raw of logs) {
    const m = raw.match(/^Round (\d+)/);
    if (m) currentRound = parseInt(m[1], 10);
    if (raw.startsWith('Round ') && raw.includes('active:')) {
      events.push({ round: currentRound, type: 'round_start', text: raw });
    } else if (raw.startsWith('family ') && raw.includes(' blocked')) {
      events.push({ round: currentRound, type: 'blocked', text: raw, family: raw.split(' ')[1] });
    } else if (raw.startsWith('family ') && raw.includes('解锁')) {
      events.push({ round: currentRound, type: 'unlocked', text: raw, family: raw.split(' ')[1] });
    } else if (raw.startsWith('SURVIVOR')) {
      events.push({ round: currentRound, type: 'survivor', text: raw });
    } else if (raw.startsWith('REFUTED')) {
      events.push({ round: currentRound, type: 'refuted', text: raw });
    } else if (raw.startsWith('STATE_SNAPSHOT')) {
      events.push({ round: currentRound, type: 'snapshot', text: raw.slice('STATE_SNAPSHOT '.length) });
    } else if (raw.startsWith('Synth')) {
      events.push({ round: currentRound, type: 'synth', text: raw });
    } else if (raw.startsWith('findings') || raw.startsWith('candidates') || raw.startsWith('Round ') && raw.includes('done')) {
      events.push({ round: currentRound, type: 'info', text: raw });
    }
  }
  return events;
}

function parseSnapshot(jsonText: string): FamilySnapshot[] {
  try {
    return JSON.parse(jsonText) as FamilySnapshot[];
  } catch {
    return [];
  }
}

// ---------- 渲染 ----------
const STATUS_ICON = {
  solved: CheckCircle2,
  open: AlertTriangle,
} as const;

const STATUS_STYLE = {
  solved: 'border-success/30 bg-success/[0.04] text-success',
  open: 'border-warning/30 bg-warning/[0.04] text-warning',
} as const;

export const AssaultResultCard = memo(function AssaultResultCard({ block }: { block: ToolCallBlock }) {
  const wf = useMemo(() => parseWorkflowOutput(block.output), [block.output]);
  const [familiesExpanded, setFamiliesExpanded] = useState(true);
  const [timelineExpanded, setTimelineExpanded] = useState(true);

  // 降级:解析失败走通用工具块
  if (!wf) {
    return <ToolCallBlockRenderer block={block} />;
  }

  const result = wf.result;
  const isRunning = block.status === 'running' || block.status === 'pending';
  const isSolved = result?.status === 'solved';
  const needsReview = result?.needsHumanReview === true;

  // 最新快照:从 logs 找最后一个 STATE_SNAPSHOT
  const events = useMemo(() => extractTimelineEvents(wf.logs || []), [wf.logs]);
  const lastSnapshot = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'snapshot') return parseSnapshot(events[i].text);
    }
    return [];
  }, [events]);

  const survivors = events.filter((e) => e.type === 'survivor');
  const refuted = events.filter((e) => e.type === 'refuted');
  const blockedFamilies = lastSnapshot.filter((f) => f.blocked);
  const maxRound = events.reduce((m, e) => Math.max(m, e.round), 0);

  const StatusIcon = isRunning ? Loader2 : (isSolved ? STATUS_ICON.solved : STATUS_ICON.open);
  const statusStyle = isSolved ? STATUS_STYLE.solved : STATUS_STYLE.open;

  return (
    <div className={clsx('my-2 rounded-lg border', isRunning ? 'border-primary/30 bg-primary/[0.03]' : statusStyle, 'overflow-hidden')}>
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle/30">
        <Target size={16} className={isRunning ? 'text-primary animate-spin' : ''} />
        <span className="font-medium text-sm">硬问题攻坚</span>
        <StatusIcon size={14} className="ml-auto" />
        <span className="text-xs font-medium">
          {isRunning ? '运行中' : isSolved ? '已收敛' : '未收敛'}
        </span>
        {maxRound > 0 && (
          <span className="text-xs text-text-muted">Round {maxRound}</span>
        )}
        {needsReview && (
          <span className="flex items-center gap-1 text-xs text-warning bg-warning/15 px-1.5 py-0.5 rounded">
            <ShieldCheck size={11} /> 需人工复核
          </span>
        )}
      </div>

      {/* 结果摘要 */}
      {result && (
        <div className="px-3 py-2 space-y-2 text-sm">
          {isSolved && result.family && (
            <div className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-success mt-0.5 shrink-0" />
              <div className="min-w-0">
                <span className="text-text-muted text-xs">survivor 方法族:</span>
                <span className="ml-1 font-medium">{result.family}</span>
              </div>
            </div>
          )}
          {!isSolved && result.strongest && (
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} className="text-warning mt-0.5 shrink-0" />
              <div className="min-w-0">
                <span className="text-text-muted text-xs">最强已证:</span>
                <span className="ml-1 line-clamp-2">{result.strongest}</span>
              </div>
            </div>
          )}
          {result.gap && (
            <div className="flex items-start gap-2">
              <span className="text-text-muted text-xs mt-0.5 shrink-0">缺口:</span>
              <span className="line-clamp-2 text-xs">{result.gap}</span>
            </div>
          )}
          {result.acceptanceArtifact && (
            <AcceptanceArtifact text={result.acceptanceArtifact} />
          )}
        </div>
      )}

      {/* 统计条 */}
      {(wf.totalTokens || wf.agentCount) && (
        <div className="flex items-center gap-3 px-3 py-1.5 text-xs text-text-muted border-t border-border-subtle/20 bg-surface/30">
          {wf.agentCount != null && (
            <span className="flex items-center gap-1"><Activity size={11} /> {wf.agentCount} agents</span>
          )}
          {wf.totalTokens != null && (
            <span>{Math.round(wf.totalTokens / 1000)}k tokens</span>
          )}
          {survivors.length > 0 && (
            <span className="flex items-center gap-1 text-success"><CheckCircle2 size={11} /> {survivors.length} survivor</span>
          )}
          {refuted.length > 0 && (
            <span className="flex items-center gap-1 text-error"><XCircle size={11} /> {refuted.length} refuted</span>
          )}
          {blockedFamilies.length > 0 && (
            <span className="flex items-center gap-1"><Ban size={11} /> {blockedFamilies.length} blocked</span>
          )}
        </div>
      )}

      {/* 方法族注册表 */}
      {lastSnapshot.length > 0 && (
        <div className="border-t border-border-subtle/20">
          <button
            onClick={() => setFamiliesExpanded((v) => !v)}
            className="flex items-center gap-1 w-full px-3 py-1.5 text-xs font-medium text-text-muted hover:bg-surface/30"
          >
            {familiesExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            方法族注册表({lastSnapshot.length})
          </button>
          {familiesExpanded && (
            <div className="px-3 pb-2 grid grid-cols-2 gap-1.5">
              {lastSnapshot.map((f) => (
                <div
                  key={f.key}
                  className={clsx(
                    'flex items-center gap-1.5 px-2 py-1 rounded text-xs',
                    f.blocked ? 'bg-error/10 text-text-muted' : 'bg-surface/50'
                  )}
                >
                  {f.blocked ? <Ban size={10} className="text-error" /> : <Flame size={10} className="text-primary" />}
                  <span className="truncate">{f.key}</span>
                  {f.attempts != null && f.attempts > 0 && (
                    <span className="text-text-muted ml-auto">×{f.attempts}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 时间线 */}
      {events.length > 0 && (
        <div className="border-t border-border-subtle/20">
          <button
            onClick={() => setTimelineExpanded((v) => !v)}
            className="flex items-center gap-1 w-full px-3 py-1.5 text-xs font-medium text-text-muted hover:bg-surface/30"
          >
            {timelineExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            攻坚时间线({events.length} 事件)
          </button>
          {timelineExpanded && (
            <div className="px-3 pb-2 max-h-64 overflow-y-auto">
              {events.map((e, i) => (
                <TimelineEntry key={i} event={e} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 人工复核提示 */}
      {needsReview && (
        <div className="px-3 py-2 border-t border-warning/20 bg-warning/[0.06] text-xs text-warning">
          <div className="flex items-start gap-1.5">
            <ShieldCheck size={12} className="mt-0.5 shrink-0" />
            <span>高风险结论(voteThreshold≥3),建议派主审人工复核对抗审计。</span>
          </div>
        </div>
      )}
    </div>
  );
});

// ---------- 子组件 ----------
function TimelineEntry({ event }: { event: TimelineEvent }) {
  const icons = {
    round_start: ChevronRight,
    blocked: Ban,
    unlocked: Unlock,
    survivor: CheckCircle2,
    refuted: XCircle,
    snapshot: Activity,
    synth: Flame,
    info: ChevronRight,
  } as const;
  const Icon = icons[event.type];
  const colors = {
    round_start: 'text-primary',
    blocked: 'text-error',
    unlocked: 'text-success',
    survivor: 'text-success',
    refuted: 'text-error',
    snapshot: 'text-text-muted',
    synth: 'text-warning',
    info: 'text-text-muted',
  } as const;

  return (
    <div className="flex items-start gap-1.5 py-0.5 text-xs">
      <Icon size={11} className={clsx('mt-0.5 shrink-0', colors[event.type])} />
      <span className="text-text-muted">R{event.round}</span>
      <span className={clsx('truncate', event.type === 'survivor' && 'text-success font-medium')}>
        {event.text.length > 100 ? event.text.slice(0, 100) + '…' : event.text}
      </span>
    </div>
  );
}

function AcceptanceArtifact({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isCode = text.includes('```') || /\n/.test(text);
  return (
    <div className="mt-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-xs text-primary hover:underline"
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        验收件(可执行 PoC)
      </button>
      {expanded && (
        <pre className="mt-1 p-2 bg-base/60 rounded text-xs overflow-x-auto whitespace-pre-wrap break-all max-h-48">
          {text}
        </pre>
      )}
      {isCode && !expanded && null}
    </div>
  );
}
