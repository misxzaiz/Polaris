/**
 * 冲突合并器宿主（P3 FR-P3-1：全局挂载入口）
 *
 * 读取 gitStore 的 `mergerOpen`（{ wsPath, file? }）+ 对应 `sequenceStatesByWs`，
 * 渲染 `ConflictMergerDialog`。任何入口（冲突文件行 / graph 冲突节点 / 合并结果提示）
 * 只需 `openMerger(wsPath, file?)` 即可弹出。
 *
 * 数据缺失（sequence 未拉取）时自动触发 `getConflictState` 补齐。
 */

import { useEffect } from 'react'
import { useGitStore } from '@/stores/gitStore/index'
import { ConflictMergerDialog } from './ConflictMergerDialog'

export function ConflictMergerDialogHost() {
  const mergerOpen = useGitStore((s) => s.mergerOpen)
  const sequenceStatesByWs = useGitStore((s) => s.sequenceStatesByWs)
  const getConflictState = useGitStore((s) => s.getConflictState)
  const closeMerger = useGitStore((s) => s.closeMerger)
  const refreshStatus = useGitStore((s) => s.refreshStatus)

  const wsPath = mergerOpen?.wsPath ?? null
  const sequence = wsPath ? sequenceStatesByWs?.[wsPath] : undefined

  // 打开时若 sequence 未拉取/已过期，自动补齐（保持对话框数据新鲜）
  useEffect(() => {
    if (!wsPath) return
    if (!sequence) {
      getConflictState(wsPath)
    }
  }, [wsPath, sequence, getConflictState])

  if (!mergerOpen || !wsPath || !sequence) return null

  return (
    <ConflictMergerDialog
      workspacePath={wsPath}
      sequence={sequence}
      onClose={closeMerger}
      onRefresh={async () => {
        if (mergerOpen) {
          await getConflictState(wsPath)
          await refreshStatus(wsPath)
        }
      }}
    />
  )
}