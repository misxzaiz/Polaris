/**
 * FR-P2-4 · 操作流水订阅
 *
 * 消费后端 `git-operation` 事件（cap.git 写动作收口 emit），实时 prepend 到
 * 对应 ws 的 operations 分片：
 * - 事件载荷 = GitOperationEntry（时间 + 操作名 + 耗时 + 来源 + 成败）
 * - 最新置顶，超上限 50 保留最旧丢弃（与后端 ring buffer 同语义）
 * - 分片 keyed 写（对齐 P1.5 sharded 约定），双面板/多仓互不覆盖
 *
 * 边界（见 plans/git-panel-p2-operations-spec.md §六）：
 * - 读动作（get_status/get_log）不产生流水；本订阅只处理 git-operation 事件
 * - 不做磁盘持久化（会话内滚动，跨会话审计归 reflog / undo 快照）
 */

import { listen } from '@/services/transport'
import { useGitStore } from '@/stores/gitStore'
import { createLogger } from '@/utils/logger'
import type { GitOperationEntry } from '@/types/git'

/** transport.listen 返回的取消监听函数 */
type UnlistenFn = () => void

/** 操作流水上限（与后端 OPERATIONS_MAX 一致，prepend 时本地也裁剪） */
const OPERATIONS_MAX = 50

/**
 * C9 序列操作活动窗口：这些写动作（rebase/merge/cherry-pick/revert 及其续行）
 * 完成后仍有"后续 checkout 链"继续改写工作区与 .git，窗口内自动刷新放宽防抖。
 */
const SEQUENCE_ACTIONS: ReadonlySet<string> = new Set([
  'rebase_branch',
  'rebase_abort',
  'rebase_continue',
  'merge_branch',
  'cherry_pick',
  'cherry_pick_abort',
  'cherry_pick_continue',
  'revert',
  'revert_abort',
  'revert_continue',
])

/** 活动窗口时长（ms）：对齐 master-plan「rebase 中刷新预算放宽 ≤3s」 */
export const SEQUENCE_SUPPRESS_MS = 3000

const log = createLogger('GitOperationsSubscriber')

/** 把条目插入分片最前（新→旧），裁剪到上限 */
function prependOperation(
  current: GitOperationEntry[] | undefined,
  entry: GitOperationEntry
): GitOperationEntry[] {
  const next = [entry, ...(current ?? [])]
  return next.slice(0, OPERATIONS_MAX)
}

/**
 * 订阅 git-operation → prepend 到 operations 分片。
 * @param getEffectiveWs 每次事件到达时读取当前生效仓库路径（含子仓库选择），null 时不写 mirror 域
 * @returns 清理函数（取消监听）
 */
export function initOperationsSubscriber(getEffectiveWs: () => string | null): () => void {
  let unlisten: UnlistenFn | null = null
  let disposed = false

  const onOperation = (event: GitOperationEntry) => {
    if (disposed) return
    const { wsPath } = event
    if (!wsPath) {
      log.warn('git-operation 载荷缺少 wsPath，跳过', { wsPath })
      return
    }

    const state = useGitStore.getState()
    const cur = state.operationsByWs?.[wsPath] ?? []
    const next = prependOperation(cur, event)
    const patch: Partial<ReturnType<typeof useGitStore.getState>> = {
      operationsByWs: {
        ...(state.operationsByWs ?? {}),
        [wsPath]: next,
      },
    }
    // 事件 ws 恰为当前生效仓库 → 同步 mirror 域，面板直接读 operations 即可
    if (getEffectiveWs() === wsPath) {
      patch.operations = next
    }
    useGitStore.setState(patch as never)

    // C9：序列动作 → 延长该 ws 的活动窗口（自动刷新放宽防抖）
    if (SEQUENCE_ACTIONS.has(event.action)) {
      const curUntil = useGitStore.getState().sequenceActivityUntilByWs?.[wsPath] ?? 0
      const nextUntil = event.ts * 1000 + SEQUENCE_SUPPRESS_MS
      if (nextUntil > curUntil) {
        useGitStore.setState({
          sequenceActivityUntilByWs: {
            ...(useGitStore.getState().sequenceActivityUntilByWs ?? {}),
            [wsPath]: nextUntil,
          },
        } as never)
      }
    }
  }

  listen<GitOperationEntry>('git-operation', onOperation).then((fn) => {
    if (disposed) {
      fn()
      return
    }
    unlisten = fn
  })

  return () => {
    disposed = true
    unlisten?.()
    unlisten = null
  }
}