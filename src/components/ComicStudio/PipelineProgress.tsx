/**
 * PipelineProgress — 管线进度展示
 *
 * 显示管线各阶段的执行状态和整体进度。
 */

import {
  CheckCircle2,
  Loader2,
  XCircle,
  Circle,
  Clock,
  AlertTriangle,
} from 'lucide-react'
import { useComicStudioStore } from '@/stores/comicStudioStore'
import type { PipelinePhaseInfo } from '@/ai-runtime'

const PHASE_LABELS: Record<string, string> = {
  script: '剧本创作',
  character: '角色设计',
  storyboard: '分镜绘制',
  animation: '漫剧动效',
  finalize: '合成输出',
}

/** 阶段状态图标 */
function PhaseIcon({ status }: { status: PipelinePhaseInfo['status'] }) {
  const iconClass = 'w-4 h-4'

  switch (status) {
    case 'completed':
      return <CheckCircle2 className={`${iconClass} text-green-400`} />
    case 'in_progress':
      return <Loader2 className={`${iconClass} text-blue-400 animate-spin`} />
    case 'failed':
      return <XCircle className={`${iconClass} text-red-400`} />
    default:
      return <Circle className={`${iconClass} text-text-tertiary`} />
  }
}

export function PipelineProgress() {
  const phases = useComicStudioStore((s) => s.phases)
  const overallProgress = useComicStudioStore((s) => s.overallProgress)
  const pipelineStatus = useComicStudioStore((s) => s.pipelineStatus)
  const activePhase = useComicStudioStore((s) => s.activePhase)

  const statusLabel = {
    idle: '就绪',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    aborted: '已中止',
  }[pipelineStatus]

  const statusColor = {
    idle: 'text-text-secondary',
    running: 'text-blue-400',
    completed: 'text-green-400',
    failed: 'text-red-400',
    aborted: 'text-yellow-400',
  }[pipelineStatus]

  return (
    <div className="px-4 py-3 bg-background-surface border-b border-border shrink-0">
      {/* 整体进度条 */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 h-1.5 bg-background-elevated rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              pipelineStatus === 'failed'
                ? 'bg-red-400'
                : pipelineStatus === 'completed'
                  ? 'bg-green-400'
                  : 'bg-primary'
            }`}
            style={{ width: `${overallProgress}%` }}
          />
        </div>
        <span className={`text-xs font-medium ${statusColor}`}>
          {overallProgress}%
        </span>
        <span className={`text-xs ${statusColor}`}>{statusLabel}</span>
      </div>

      {/* 阶段列表 */}
      <div className="flex items-center gap-2">
        {phases.length === 0 && pipelineStatus === 'idle' && (
          <span className="text-xs text-text-tertiary flex items-center gap-1">
            <Clock className="w-3 h-3" />
            等待启动...
          </span>
        )}

        {phases.map((phase, idx) => (
          <div key={phase.phase} className="flex items-center gap-1.5">
            {idx > 0 && (
              <div className="w-3 h-px bg-border" />
            )}
            <div
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
                phase.phase === activePhase
                  ? 'bg-primary/10 text-primary'
                  : 'text-text-secondary'
              }`}
            >
              <PhaseIcon status={phase.status} />
              <span>{PHASE_LABELS[phase.phase] || phase.phase}</span>
              {phase.progress > 0 && phase.progress < 100 && (
                <span className="text-text-tertiary">{phase.progress}%</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 失败错误横幅 */}
      {pipelineStatus === 'failed' && (
        <div className="mt-3 flex items-start gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-md">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-px" />
          <div className="text-xs text-red-400 leading-relaxed">
            {phases.find(p => p.status === 'failed')?.message || '管线执行失败'}
          </div>
        </div>
      )}

      {/* 当前阶段消息 */}
      {activePhase && (
        <div className="mt-2 text-xs text-text-tertiary truncate">
          {phases.find((p) => p.phase === activePhase)?.message}
        </div>
      )}
    </div>
  )
}
