/**
 * Workflow 通用卡片 - 非攻坚 workflow 的完成态展示
 *
 * 当 parseWorkflowResult 命中 generic kind 时,chatBlocks 路由到本卡片。
 * 展示:summary 摘要 / agent 统计 / 产物列表 / workflowProgress agent 列表。
 * 运行中(block.status=pending/running)显示运行中态,完成后解析 output。
 *
 * 降级:解析失败(由 chatBlocks 已判定 kind==='none' 不路由到本卡片)。
 */

import { memo, useState } from 'react';
import { clsx } from 'clsx';
import {
  Workflow as WorkflowIcon,
  Loader2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Activity,
  FileText,
  Cpu,
  Coins,
} from 'lucide-react';
import type { ToolCallBlock } from '@/types';
import type { WorkflowGenericOutput } from './workflowParsers';

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function AgentRow({ agent }: { agent: NonNullable<WorkflowGenericOutput['workflowProgress']>[number] }) {
  const stateLabel = agent.state || (agent.error ? 'error' : 'completed');
  const stateColor = agent.error ? 'text-red-500' :
    stateLabel === 'completed' ? 'text-green-500' :
    stateLabel === 'running' || stateLabel === '运行中' ? 'text-blue-500' :
    'text-gray-400';
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <Cpu size={10} className="text-text-muted shrink-0" />
      <span className="truncate flex-1 min-w-0">{agent.label || agent.type}</span>
      {agent.phaseTitle && (
        <span className="text-text-muted truncate max-w-[30%]">{agent.phaseTitle}</span>
      )}
      {agent.tokens != null && (
        <span className="text-text-muted shrink-0">{Math.round(agent.tokens / 1000)}k</span>
      )}
      {agent.durationMs != null && (
        <span className="text-text-muted shrink-0">{formatDuration(agent.durationMs)}</span>
      )}
      <span className={clsx('shrink-0', stateColor)}>{stateLabel}</span>
    </div>
  );
}

export const WorkflowCard = memo(function WorkflowCard({
  block,
  data,
}: {
  block: ToolCallBlock;
  data: WorkflowGenericOutput;
}) {
  const [agentsExpanded, setAgentsExpanded] = useState(true);
  const [logsExpanded, setLogsExpanded] = useState(false);

  const isRunning = block.status === 'running' || block.status === 'pending';
  const agents = data.workflowProgress ?? [];
  const logs = data.logs ?? [];
  const artifacts = data.artifacts ?? [];

  const StatusIcon = isRunning ? Loader2 : CheckCircle2;
  const summary = data.summary || (isRunning ? '工作流运行中…' : '工作流已完成');

  return (
    <div className={clsx(
      'my-2 rounded-lg border overflow-hidden',
      isRunning ? 'border-primary/30 bg-primary/[0.03]' : 'border-border-subtle/30 bg-surface/[0.3]'
    )}>
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle/30">
        <WorkflowIcon size={16} className={clsx('text-primary', isRunning && 'animate-spin')} />
        <span className="font-medium text-sm">Workflow</span>
        <StatusIcon size={14} className="ml-auto" />
        <span className="text-xs font-medium">
          {isRunning ? '运行中' : '已完成'}
        </span>
      </div>

      {/* 摘要 */}
      <div className="px-3 py-2 text-sm">
        <div className="flex items-start gap-2">
          <FileText size={13} className="text-text-muted mt-0.5 shrink-0" />
          <span className="line-clamp-3 text-text-primary">{summary}</span>
        </div>
      </div>

      {/* 统计条 */}
      {(data.agentCount != null || data.totalTokens != null || data.totalToolCalls != null) && (
        <div className="flex items-center gap-3 px-3 py-1.5 text-xs text-text-muted border-t border-border-subtle/20 bg-surface/30">
          {data.agentCount != null && (
            <span className="flex items-center gap-1"><Activity size={11} /> {data.agentCount} agents</span>
          )}
          {data.totalTokens != null && (
            <span className="flex items-center gap-1"><Coins size={11} /> {Math.round(data.totalTokens / 1000)}k tokens</span>
          )}
          {data.totalToolCalls != null && (
            <span className="flex items-center gap-1"><Cpu size={11} /> {data.totalToolCalls} 工具调用</span>
          )}
        </div>
      )}

      {/* 产物列表 */}
      {artifacts.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border-subtle/20">
          <div className="text-xs text-text-muted mb-1 flex items-center gap-1">
            <FileText size={11} /> 产物({artifacts.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {artifacts.map((a, i) => (
              <span key={i} className="text-xs bg-surface/50 px-1.5 py-0.5 rounded truncate max-w-[200px]">
                {a}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* agent 列表 */}
      {agents.length > 0 && (
        <div className="border-t border-border-subtle/20">
          <button
            onClick={() => setAgentsExpanded(v => !v)}
            className="flex items-center gap-1 w-full px-3 py-1.5 text-xs font-medium text-text-muted hover:bg-surface/30"
          >
            {agentsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Agents({agents.length})
          </button>
          {agentsExpanded && (
            <div className="px-3 pb-2 max-h-48 overflow-y-auto">
              {agents.map((a, i) => <AgentRow key={i} agent={a} />)}
            </div>
          )}
        </div>
      )}

      {/* 日志 */}
      {logs.length > 0 && (
        <div className="border-t border-border-subtle/20">
          <button
            onClick={() => setLogsExpanded(v => !v)}
            className="flex items-center gap-1 w-full px-3 py-1.5 text-xs font-medium text-text-muted hover:bg-surface/30"
          >
            {logsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            日志({logs.length})
          </button>
          {logsExpanded && (
            <div className="px-3 pb-2 max-h-64 overflow-y-auto space-y-0.5">
              {logs.map((l, i) => (
                <div key={i} className="text-xs text-text-muted font-mono truncate">
                  {l.length > 120 ? l.slice(0, 120) + '…' : l}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
