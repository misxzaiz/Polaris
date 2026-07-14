/**
 * CompactHandoffProgress - 压缩交接后台进度胶囊
 *
 * 后台压缩期间常驻右下角，显示当前阶段并可取消。压缩不阻塞界面，
 * 用户可自由切换查看其他对话；完成后由 toast 通知（点击进入新会话）。
 */

import { useTranslation } from 'react-i18next'
import { Loader2, X } from 'lucide-react'
import { useCompactHandoffStore } from '@/stores/compactHandoffStore'
import type { CompactHandoffStage } from '@/services/contextCompactHandoff'

const STAGE_KEYS: Record<CompactHandoffStage, string> = {
  loading: 'compactHandoff.stageLoading',
  packing: 'compactHandoff.stagePacking',
  compacting: 'compactHandoff.stageCompacting',
  creating: 'compactHandoff.stageCreating',
}

export function CompactHandoffProgress() {
  const { t } = useTranslation('chat')
  const task = useCompactHandoffStore((s) => s.task)
  const cancel = useCompactHandoffStore((s) => s.cancel)

  if (!task) return null

  return (
    <div className="fixed bottom-4 right-4 z-40 flex items-center gap-2 pl-3 pr-2 py-2 rounded-full bg-background-elevated border border-border shadow-lg max-w-[320px]">
      <Loader2 size={14} className="animate-spin text-primary shrink-0" />
      <div className="flex flex-col min-w-0">
        <span className="text-xs font-medium text-text-primary truncate">
          {t('compactHandoff.progressTitle', { title: task.sourceTitle })}
        </span>
        <span className="text-[10px] text-text-tertiary truncate">
          {t(STAGE_KEYS[task.stage])}
        </span>
      </div>
      <button
        onClick={cancel}
        className="p-1 rounded-full text-text-tertiary hover:text-danger hover:bg-background-hover shrink-0"
        title={t('compactHandoff.cancelRun')}
      >
        <X size={14} />
      </button>
    </div>
  )
}

export default CompactHandoffProgress
