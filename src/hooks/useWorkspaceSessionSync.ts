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
  /** 实时预览：流式期间远端会话的最新消息文本（来自本端投影 store） */
  preview?: string
  /** 是否正在流式（另一端正在生成回复） */
  streaming?: boolean
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
  // 订阅投影 store 流式 tick：远端起流式期间，投影 store 内部 currentMessage 变化
  // 不会改变 stores Map 引用，只有 tick 递增能让下方 useMemo 重算、刷新实时预览。
  const streamingTick = useStore(sessionStoreManager, (s) => s.streamingTick)
  // 响应式订阅 stores Map 引用（新建/删除会话时重算远端列表），
  // 不用 getState() 是因为它在依赖数组里是非响应式读取。
  const stores = useStore(sessionStoreManager, (s) => s.stores)
  const sessionMetadata = useStore(sessionStoreManager, (s) => s.sessionMetadata)

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

    // 本端「真实」store 集合：排除 silent 投影 store（dispatchEvent 自动创建的
    // 远端消费视图）。投影 store 只是为「未打开会话」提供实时预览的临时载体，
    // 不算本端打开的会话 —— 远端条目必须继续出现在「其他窗口的会话」列表。
    const realLocalStores = new Set<string>()
    for (const [id] of stores) {
      if (sessionMetadata.get(id)?.silentMode !== true) realLocalStores.add(id)
    }

    // 本端认领集合（registerSession 写入 sessions Map = 本端创建的会话）
    const claimedIds = bucket
      ? new Set(Array.from(bucket.sessions.keys()).filter((k) => k !== null))
      : undefined
    const remote = deriveRemoteSessions(
      bucketMeta,
      realLocalStores,
      localSessions,
      multiSessionIds,
      claimedIds,
    )
    // 实时预览增强：远端条目若本端存在 silent 投影 store（dispatchEvent 自动创建
    // 的「远端消费视图」），从中读取最新消息文本与其流式状态，作为条目的实时预览。
    // 这样用户无需点击即可看到远端会话的最新动态；投影 store 结束时条目恢复无预览。
    const withPreview = remote.map((ref) => {
      const projected = stores.get(ref.sessionId)?.getState()
      if (!projected) return ref
      // 流式中的内容在 currentMessage（未完成），完成后才入 messages。
      // 预览优先取进行中的 currentMessage；否则回退到最后一条已完成消息。
      const current = projected.currentMessage
      const last = current ?? projected.messages[projected.messages.length - 1]
      const preview = last
        ? typeof last === 'object' && last && 'blocks' in last
          ? last.blocks
              .filter((b) => b.type === 'text')
              .map((b) => ('content' in b ? String(b.content) : ''))
              .join('')
              .slice(0, 120)
          : String((last as { content?: unknown }).content ?? '').slice(0, 120)
        : ''
      return {
        ...ref,
        ...(preview ? { preview } : {}),
        streaming: projected.isStreaming,
      }
    })
    // deriveRemoteSessions 已排除全部本地实例，remote 与 localSessions 天然无 id 冲突
    // 但 localSessions 含 silent 投影 store（它们在 sessionMetadata 里），需过滤：
    // 投影 store 只为远端条目提供实时预览，不应作为本端会话出现在合并列表。
    const list: MergedSession[] = [
      ...localSessions.filter((m) => {
        const meta = sessionMetadata.get(m.id)
        return meta?.silentMode !== true
      }),
      ...withPreview,
    ]

    // streamingTick 是订阅信号：值变化即触发本 useMemo 重算（刷新投影 store 的实时预览），
    // 读一次以让依赖显式（消除 exhaustive-deps 对"未使用依赖"的警告）。
    void streamingTick

    return { merged: list, remote: withPreview }
    // multiSessionIds 参与派生（本端视口排除规则），引用变化时需重算
  }, [localSessions, bucketMetadata, bucketKey, multiSessionIds, stores, sessionMetadata, streamingTick])

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