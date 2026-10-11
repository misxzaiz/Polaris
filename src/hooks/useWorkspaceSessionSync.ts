/**
 * useWorkspaceSessionSync — 本地会话 ∪ 远端桶投影 的合并派生 hook（S3 补全）
 *
 * 背景：S3 会话索引广播把「其他浏览器/窗口创建的会话」实时同步进
 * workspaceSession 桶投影，但主界面会话列表（multiSessionIds / sessionStoreManager）
 * 是完全本端的内存态，不消费桶 → 表现为「两个浏览器会话列表不同步」。
 *
 * 本 hook 打通最后一环，同时严格守住「避免同一会话多窗口重复打开」：
 * - 本地会话（sessionStoreManager.sessionMetadata）原样展示，是主视图；
 * - 桶投影里「本地无 store 实例」的会话 = 远端会话，只作为可恢复条目出现，
 *   绝不自动进 multiSessionIds（本端视口），用户显式点击才按需恢复。
 *
 * 这样：两个浏览器都能看到彼此创建的会话（列表可见），但各自打开的
 * 视口（multiSessionIds）互不污染，同一会话不会因同步而重复开格子。
 */

import { useMemo } from 'react'
import { useStore } from 'zustand'
import { deleteSessionFromIndex } from '@/services/sessionIndexService'
import {
  sessionStoreManager,
  useSessionMetadataList,
} from '@/stores/conversationStore/sessionStoreManager'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useViewStore } from '@/stores/index'
import {
  workspaceSessionSlice,
  resolveWorkspaceKeyFromPath,
  FREE_WORKSPACE_KEY,
} from '@/stores/workspaceSession'
import type { SessionMetadata } from '@/stores/conversationStore/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('WorkspaceSessionSync')

/** 远端会话条目：由桶投影构造的「可恢复会话」元数据 */
export interface RemoteSessionRef {
  sessionId: string
  title: string
  engineId?: string
  workspaceId?: string
  status: 'idle' | 'running' | 'error' | 'none' | string
  updatedAt?: string
  createdAt?: string
  /** 幂等去重身份：后端投影的 sessionId 即权威 ID */
  id: string
  remote: true
}

export type MergedSession = SessionMetadata | RemoteSessionRef

/**
 * 从当前工作区 id 解析桶 key（与 sessionStoreManager.createSession 的
 * resolveSessionWorkspaceKey 同规则）：free 桶 = '__free__'；有 path 时按 path 解析。
 * 供 useMergedSessionList 派生稳定的 bucketKey。
 */
function resolveCurrentBucketKey(currentWsId: string | null | undefined): string {
  const wsStore = useWorkspaceStore.getState()
  const current = wsStore.workspaces.find((w) => w.id === currentWsId)
  return current?.path ? resolveWorkspaceKeyFromPath(current.path) : FREE_WORKSPACE_KEY
}

/**
 * 从桶投影派生「远端可恢复会话列表」（纯函数，便于单测）。
 *
 * 规则（按排除优先级）：
 * - 本端视口 multiSessionIds（本窗口打开过的历史会话）⇒ 排除——
 *   本窗口引用过的会话即使当前无活跃 store 实例，也绝不是「其他窗口」的会话；
 * - 本端有 store 实例 或 在 localSessions ⇒ 排除（本地为准，避免重复条目）；
 * - 桶已认领（bucket.sessions 含该 id，本端创建）⇒ 排除；
 * - 其余 = 远端会话，构造为 RemoteSessionRef。
 */
export function deriveRemoteSessions(
  bucketMetadata: ReadonlyMap<string, SessionMetadata> | null | undefined,
  localStores: ReadonlyMap<string, unknown> | ReadonlySet<string>,
  localSessions: readonly SessionMetadata[],
  localViewIds?: ReadonlySet<string> | readonly string[],
  claimedIds?: ReadonlySet<string>,
): RemoteSessionRef[] {
  if (!bucketMetadata) return []
  const localById = new Set(localSessions.map((m) => m.id))
  const viewSet = localViewIds
    ? localViewIds instanceof Set
      ? (localViewIds as ReadonlySet<string>)
      : new Set(localViewIds as readonly string[])
    : undefined
  const remote: RemoteSessionRef[] = []
  for (const [sessionId, meta] of bucketMetadata) {
    if (localStores.has(sessionId) || localById.has(sessionId)) continue
    if (viewSet?.has(sessionId)) continue
    if (claimedIds?.has(sessionId)) continue
    remote.push({
      sessionId,
      id: sessionId,
      title: meta.title || '远端会话',
      engineId: meta.engineId ?? undefined,
      workspaceId: meta.workspaceId ?? undefined,
      status: meta.status ?? 'none',
      updatedAt: meta.updatedAt,
      createdAt: meta.createdAt,
      remote: true,
    })
  }
  return remote
}

/**
 * 合并本地会话 + 远端桶投影。
 *
 * 规则：
 * - 本地会话（sessionStoreManager.sessionMetadata）优先，全部展示；
 * - 桶投影里「本地无 store 实例」的会话 → 构造为远端可恢复条目；
 * - 同 id 去重（桶投影若已有本地实例，跳过，避免重复条目）。
 */
export function useMergedSessionList(): {
  merged: MergedSession[]
  remote: RemoteSessionRef[]
} {
  // 订阅本地会话 + 当前工作区 id + 当前桶投影 size 变化（任一变化重新派生）
  const localSessions = useSessionMetadataList()
  const currentWsId = useWorkspaceStore((s) => s.currentWorkspaceId)
  const multiSessionIds = useViewStore((s) => s.multiSessionIds)

  const bucketKey = useMemo(() => resolveCurrentBucketKey(currentWsId), [currentWsId])

  // 订阅桶投影 Map 引用（每次 upsert/remove 都 new Map 替换引用，
  // 捕捉「新增/删除/元数据更新」全部变化；null 表示桶尚未建立）
  const bucketMetadata = useStore(
    workspaceSessionSlice,
    (s) => s.buckets.get(bucketKey)?.sessionMetadata ?? null,
  )

  const merged = useMemo(() => {
    // 每次桶投影变化时重新读取完整桶（Map 引用变化即触发）
    const bucket = workspaceSessionSlice.getState().getBucket(bucketKey)
    const bucketMeta = bucket?.sessionMetadata ?? bucketMetadata
    const localStores = sessionStoreManager.getState().stores

    // 本端认领集合（registerSession 写入 sessions Map = 本端创建的会话）
    const claimedIds = bucket
      ? new Set(Array.from(bucket.sessions.keys()).filter((k) => k !== null))
      : undefined
    const remote = deriveRemoteSessions(
      bucketMeta,
      localStores,
      localSessions,
      multiSessionIds,
      claimedIds,
    )
    // deriveRemoteSessions 已排除全部本地实例，remote 与 localSessions 天然无 id 冲突
    const list: MergedSession[] = [...localSessions, ...remote]

    return { merged: list, remote }
    // multiSessionIds 参与派生（本端视口排除规则），引用变化时需重算
  }, [localSessions, bucketMetadata, bucketKey, multiSessionIds])

  return merged
}

/**
 * 按需恢复一个远端会话：调用 historyService 从后端加载其完整消息，
 * 恢复成本地会话（createSessionFromHistory，生成新 sessionId），并入本地多窗口视口。
 *
 * 恢复成功后会从当前工作区桶投影移除该远端条目——原 sessionId 已被本端接管，
 * 避免用户重复点击「恢复」造成重复会话（对齐「避免同一会话开多个窗口」约束）。
 *
 * 返回新会话 id；失败返回 null（由调用方提示）。
 */
export async function materializeRemoteSession(
  sessionId: string,
  engineId?: string,
  titleHint?: string,
): Promise<string | null> {
  try {
    const { historyService } = await import('@/services/historyService')
    const ok = await historyService.restoreFromHistory(
      sessionId,
      engineId,
      undefined,
      undefined,
      titleHint,
    )
    if (!ok) {
      log.warn('远端会话恢复失败（无消息可加载）', { sessionId })
      return null
    }
    // restoreFromHistory 内部已 addToMultiView；此处返回最新活跃会话（新建的本地会话）
    const newActive = sessionStoreManager.getState().activeSessionId
    // 从当前工作区桶投影移除该远端条目 —— 原 sessionId 已被本端以新会话接管
    const bucketKey = resolveCurrentBucketKey(useWorkspaceStore.getState().currentWorkspaceId)
    if (bucketKey) {
      workspaceSessionSlice.getState().unregisterSession(bucketKey, sessionId)
      // 同步删除后端 session_index 记录：否则旧 id 会被下一轮快照/增量拉回桶，
      // 导致「已恢复」的条目重新出现在其他窗口的远端列表，重复点击可产生重复会话。
      void deleteSessionFromIndex(bucketKey, sessionId).catch((e) => {
        log.warn('删除远端会话后端索引失败', { sessionId, error: String(e) })
      })
    }
    log.info('远端会话已恢复', { sessionId, newActive })
    return newActive
  } catch (e) {
    log.warn('远端会话恢复异常', { sessionId, error: String(e) })
    return null
  }
}

/** 判断合并条目是否为远端会话 */
export function isRemoteSession(m: MergedSession): m is RemoteSessionRef {
  return (m as RemoteSessionRef).remote === true
}