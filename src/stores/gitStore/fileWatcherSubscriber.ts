/**
 * FR-P2-2 · File-Watcher 自动 Status 刷新订阅
 *
 * 消费后端 `file-system-change` 事件，防抖刷新 Git 面板当前生效仓库的 status：
 * - 复用 statusSlice 的 refreshStatusDebounced（per-path seq 丢弃乱序，防抖窗口内至多一次）
 * - 流式抑抖：AI 会话流式期间暂停自动刷新；流式结束（下降沿）后补刷一次
 *
 * 边界（见 plans/git-panel-p2-watcher-spec.md §四）：
 * - 不改后端协议；沿用 FsChangeEvent.affectedDirs
 * - 不做路径级过滤（status 是轻操作且已 debounce）
 * - 不启动自己的 watcher（沿用 FileExplorer 的 startFileWatcher，performance.fileWatcher 控制）
 * - .git 被后端 IGNORED_DIRS 忽略，故 git 自身写 index 不会触发本订阅；触发源是工作区文件被外部修改
 */

import { listen } from '@/services/transport'
import { kernelSessionIsStreaming, subscribeKernelSessionState } from '@/session-v2/hooks/useKernelSessionState'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { useGitStore } from '@/stores/gitStore'
import { createLogger } from '@/utils/logger'
import type { FsChangeEvent } from '@/types'

/** transport.listen 返回的取消监听函数 */
type UnlistenFn = () => void

const log = createLogger('GitStatusWatcher')

/** 自动刷新防抖窗口（ms）。后端 watcher 已攒批，这里再做一层防抖 */
const DEBOUNCE_MS = 800

/**
 * 订阅 file-system-change，防抖刷新 Git 面板当前生效仓库的 status。
 * @param getEffectivePath 每次事件到达时读取最新生效仓库路径（含子仓库选择），null 时不刷
 * @returns 清理函数（取消监听 + 清防抖 timer + 清待补刷标记）
 */
export function initGitStatusWatcher(getEffectivePath: () => string | null): () => void {
  let unlisten: UnlistenFn | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  // 流式期间收到的事件记下「待补刷」；下降沿时补刷一次
  let pendingRefresh = false
  // 当前订阅的活动会话（避免重复订阅/泄漏）
  let subscribedSessionId: string | null = null
  let unsubStreaming: (() => void) | null = null
  let disposed = false

  const clearDebounce = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }

  const clearStreamingSub = () => {
    unsubStreaming?.()
    unsubStreaming = null
    subscribedSessionId = null
  }

  /** 非流式时执行刷新（防抖窗口内合并多次事件） */
  const refreshNowDebounced = () => {
    const path = getEffectivePath()
    if (!path) return
    clearDebounce()
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      log.debug('file-system-change 防抖到期，自动刷新 status', { path })
      // 刷新动作本体：防抖到期后执行一次。若此刻已流式（事件排队期间流式起来了），让位给下降沿补刷
      void useGitStore.getState().refreshStatus(path)
    }, DEBOUNCE_MS)
  }

  /** 立即补刷一次（流式下降沿用），不走防抖 */
  const refreshImmediately = () => {
    const path = getEffectivePath()
    if (!path) return
    pendingRefresh = false
    void useGitStore.getState().refreshStatus(path)
  }

  /** 订阅活动会话的流式下降沿；会话变化时先解绑旧的再绑新的 */
  const ensureStreamingSubscription = () => {
    const activeId = sessionStoreManager.getState().activeSessionId
    if (activeId === subscribedSessionId) return
    clearStreamingSub()
    if (!activeId) return
    subscribedSessionId = activeId
    unsubStreaming = subscribeKernelSessionState(activeId, (state) => {
      if (disposed) return
      // running → idle/error 下降沿：若期间有事件待补刷，补刷一次
      if (!state.isStreaming && pendingRefresh) {
        refreshImmediately()
      }
    })
  }

  const onFileSystemChange = (event: FsChangeEvent) => {
    if (disposed) return
    const { affectedDirs } = event
    if (!affectedDirs || affectedDirs.length === 0) return
    const path = getEffectivePath()
    if (!path) return

    ensureStreamingSubscription()

    // 一次性查询当前活动会话是否流式：流式中只标记待补刷，不触发刷新
    void kernelSessionIsStreaming(sessionStoreManager.getState().activeSessionId).then((streaming) => {
      if (disposed) return
      if (streaming) {
        log.debug('file-system-change 到达但 AI 流式中，标记待补刷', { path, dirs: affectedDirs.length })
        pendingRefresh = true
        return
      }
      // 非流式：若已有待补刷标记（刚离开流式但下降沿订阅可能还没到），一并清掉
      pendingRefresh = false
      refreshNowDebounced()
    })
  }

  // 订阅后端文件系统事件
  listen<FsChangeEvent>('file-system-change', onFileSystemChange).then((fn) => {
    if (disposed) {
      fn()
      return
    }
    unlisten = fn
  })

  return () => {
    disposed = true
    clearDebounce()
    clearStreamingSub()
    unlisten?.()
    unlisten = null
  }
}
