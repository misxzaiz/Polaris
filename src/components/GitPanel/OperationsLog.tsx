/**
 * OperationsLog（操作流水）折叠区
 *
 * FR-P2-4 · GitKraken Activity Log 等价：展示 cap.git 写动作留痕
 * （时间 + 操作名 + 耗时 + 来源 + 成败），最新在上，会话内滚动上限 50 条。
 *
 * 数据：
 * - 初始拉取：GitPanel 在生效仓库变化时调 getOperations
 * - 实时增量：operationsSubscriber 消费 git-operation 事件 prepend 到分片
 * - 本组件只读展示分片（operationsByWs[workspacePath]），并提供「清空」入口
 *
 * UI（对齐 prototype `#activity` 形态，主题 token 复用）：
 * - 折叠头部：图标 + 「操作流水」 + 计数 + 清空按钮
 * - 列表：时间(灰) + label + 耗时(右对齐) + ok 红绿点
 * - 空态：「暂无操作记录」
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useToastStore } from '@/stores/toastStore'

interface OperationsLogProps {
  /** 多仓库模式下生效的仓库路径（子仓库） */
  workspacePath?: string
}

/** HH:MM:SS 时间格式化（unix 秒） */
function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toTimeString().slice(0, 8)
}

/** 耗时展示：<1000ms 显示「xxx ms」，≥1s 显示「x.xs」 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const OK_COLOR = 'bg-emerald-500'
const FAIL_COLOR = 'bg-red-500'

export function OperationsLog({ workspacePath }: OperationsLogProps) {
  const { t } = useTranslation('git')
  const [open, setOpen] = useState(false)

  const operations = useGitStore((s) =>
    workspacePath ? s.operationsByWs?.[workspacePath] ?? [] : s.operations ?? []
  )
  const clearOperations = useGitStore((s) => s.clearOperations)
  const toast = useToastStore()

  const handleClear = async () => {
    if (!workspacePath) return
    try {
      await clearOperations(workspacePath)
      toast.success(t('operations.cleared'))
    } catch (err) {
      toast.error(t('operations.clearFailed'), String(err instanceof Error ? err.message : err))
    }
  }

  return (
    <div className="border-t border-border-subtle">
      {/* 折叠头部 */}
      <div className="flex items-center gap-2 px-3 py-2 select-none">
        <button
          type="button"
          className="flex items-center gap-2 flex-1 min-w-0 text-left hover:bg-background-hover rounded px-1 py-0.5 transition-colors"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown size={14} className="text-text-tertiary shrink-0" /> : <ChevronRight size={14} className="text-text-tertiary shrink-0" />}
          <Activity size={14} className="text-text-tertiary shrink-0" />
          <span className="text-xs font-medium text-text-secondary truncate">
            {t('operations.title')}
          </span>
          {operations.length > 0 && (
            <span className="text-[10px] text-text-tertiary bg-background-hover rounded-full px-1.5 py-0.5 shrink-0">
              {operations.length}
            </span>
          )}
        </button>
        {open && operations.length > 0 && (
          <button
            type="button"
            onClick={handleClear}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded shrink-0 transition-colors"
            title={t('operations.clearTitle')}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {open && (
        <div className="px-2 pb-2 max-h-48 overflow-y-auto">
          {operations.length === 0 ? (
            <div className="px-2 py-3 text-xs text-text-tertiary text-center">
              {t('operations.empty')}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {operations.map((op, i) => (
                <li
                  key={`${op.ts}-${op.action}-${i}`}
                  className="flex items-center gap-2 px-2 py-1 rounded hover:bg-background-hover"
                  title={`${op.action} · ${op.durationMs}ms · ${op.source}`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${op.ok ? OK_COLOR : FAIL_COLOR}`}
                  />
                  <span className="text-[10px] text-text-tertiary font-mono shrink-0">
                    {formatTime(op.ts)}
                  </span>
                  <span className="text-xs text-text-primary truncate flex-1">{op.label}</span>
                  <span className="text-[10px] text-text-tertiary font-mono shrink-0">
                    {formatDuration(op.durationMs)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}