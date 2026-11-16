/**
 * sessionDirectory 薄 store（ai-chat-plugin-extraction-spec P3.d / §7）
 *
 * 宿主 chrome（SessionTabs/SessionTab/WorkspaceMenu/CreateSessionModal/
 * SessionDeleteConfirm/NotificationCenterPanel/QuickSwitchPanel/model-desk）
 * 的会话只读消费面：只含元数据/activeId/流式摘要，由 sessionStoreManager
 * （插件域权威）订阅投影；写动作（切换/删除/新建）经 cap.session /
 * cap.ai.chat 总线或 manager actions 委托，本 store 不新增写路径。
 *
 * 单写者：sessionStoreManager（插件域）。本文件只做「读投影 + 动作委托」。
 */
import { useSyncExternalStore } from 'react'
import type { SessionMetadata } from '@/types'

// P6：会话状态单写者（sessionStoreManager）随对话域迁入 chat-desk 插件；
// 宿主经 __POLARIS_APP_CORE__.stores.sessionStoreManager 反向桥动态读取投影。
// 插件未挂载时返回 undefined（chrome 侧降级为空投影）。
type ManagerLike = {
  getState: () => {
    sessionMetadata: Map<string, SessionMetadata>
    activeSessionId: string | null
    stores: Map<string, { getState: () => { isStreaming: boolean } }>
    switchSession: (...a: unknown[]) => unknown
    deleteSession: (...a: unknown[]) => unknown
    updateSessionTitle: (...a: unknown[]) => unknown
    updateSessionWorkspace?: (...a: unknown[]) => unknown
    addContextWorkspace?: (...a: unknown[]) => unknown
    removeContextWorkspace?: (...a: unknown[]) => unknown
    createSession?: (...a: unknown[]) => string
    createSessionFromHistory?: (...a: unknown[]) => string
  }
  subscribe: (cb: () => void) => () => void
}

function manager(): ManagerLike | undefined {
  return (window as unknown as {
    __POLARIS_APP_CORE__?: { stores?: { sessionStoreManager?: ManagerLike } }
  }).__POLARIS_APP_CORE__?.stores?.sessionStoreManager
}

export interface SessionDirectoryState {
  /** 会话元数据列表（id/title/engineId/workspaceId/createdAt…） */
  sessions: SessionMetadata[]
  /** 元数据 Map（id → metadata，兼容宿主既有读取习惯） */
  metadataMap: Map<string, SessionMetadata>
  /** 活跃会话 id（宿主导航态） */
  activeSessionId: string | null
  /** 流式摘要：sessionId → isStreaming */
  streamingMap: Record<string, boolean>
}

let state: SessionDirectoryState = {
  sessions: [],
  metadataMap: new Map(),
  activeSessionId: null,
  streamingMap: {},
}

const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function setState(patch: Partial<SessionDirectoryState>) {
  state = { ...state, ...patch }
  emit()
}

// ── 投影：订阅插件域权威 store，裁剪出 chrome 所需切片 ──
const unsubscribers: Array<() => void> = []
let projected = false
let retryTimer: ReturnType<typeof setTimeout> | null = null

export function ensureProjected(): void {
  if (projected) return
  const mgr = manager()
  if (!mgr) {
    // 插件面板未挂载（反向桥未注册）：保持空投影，挂载后重试。
    // 面板加载是异步 Blob import，晚于 chrome 首渲染；500ms 轮询至注册成功。
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null
        ensureProjected()
      }, 500)
    }
    return
  }
  projected = true
  const project = () => {
    const s = mgr.getState()
    const sessions = s.sessionMetadata ? Array.from(s.sessionMetadata.values()) : []
    const streamingMap: Record<string, boolean> = {}
    for (const m of sessions) {
      const st = s.stores.get(m.id)
      streamingMap[m.id] = st ? st.getState().isStreaming : false
    }
    setState({
      sessions,
      metadataMap: s.sessionMetadata ?? new Map(),
      activeSessionId: s.activeSessionId,
      streamingMap,
    })
  }
  unsubscribers.push(mgr.subscribe(project))
  project()
}

// ── React 订阅面 ──
function useDirectory<T>(selector: (s: SessionDirectoryState) => T): T {
  ensureProjected()
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => selector(state),
    () => selector(state),
  )
}

export function useSessionDirectorySessions(): SessionMetadata[] {
  return useDirectory((s) => s.sessions)
}

export function useSessionDirectoryActiveId(): string | null {
  return useDirectory((s) => s.activeSessionId)
}

export function useSessionDirectoryStreaming(sessionId: string | null): boolean {
  return useDirectory((s) => (sessionId ? s.streamingMap[sessionId] ?? false : false))
}

// ── 非 hook 读取（chrome 命令式场景）──
export function getSessionDirectorySnapshot(): SessionDirectoryState {
  ensureProjected()
  return state
}

// ── 动作委托（不新增写路径：转投插件域 manager / 总线）──
export function switchSession(sessionId: string): void {
  manager()?.getState().switchSession(sessionId)
}

export function deleteSession(sessionId: string): void {
  manager()?.getState().deleteSession(sessionId)
}

export function updateSessionTitle(sessionId: string, title: string): void {
  manager()?.getState().updateSessionTitle(sessionId, title)
}

export function updateSessionWorkspace(...args: unknown[]): void {
  const fn = manager()?.getState().updateSessionWorkspace
  if (typeof fn === 'function') fn(...args)
}

export function addContextWorkspace(...args: unknown[]): void {
  const fn = manager()?.getState().addContextWorkspace
  if (typeof fn === 'function') fn(...args)
}

export function removeContextWorkspace(...args: unknown[]): void {
  const fn = manager()?.getState().removeContextWorkspace
  if (typeof fn === 'function') fn(...args)
}

export function createSession(...args: unknown[]): string {
  const fn = manager()?.getState().createSession
  return typeof fn === 'function' ? (fn(...args) as string) : ''
}

export function createSessionFromHistory(...args: unknown[]): string {
  const fn = manager()?.getState().createSessionFromHistory
  return typeof fn === 'function' ? (fn(...args) as string) : ''
}

// ── chrome 会话 hooks（P6：替代 conversationStore 的 useSessionMetadataList 等）──
export function useActiveSessionId(): string | null {
  ensureProjected()
  return useSyncExternalStore(
    (cb) => {
      ensureProjected()
      const mgr = manager()
      if (!mgr) return () => undefined
      return mgr.subscribe(cb)
    },
    () => manager()?.getState().activeSessionId ?? null,
    () => null,
  )
}

export function useSessionManagerActions(): {
  switchSession: (id: string) => void
  deleteSession: (id: string) => void
  createSession: (...a: unknown[]) => string
  createSessionFromHistory: (...a: unknown[]) => string
  renameSession: (id: string, title: string) => void
  updateSessionModelProfile?: (...a: unknown[]) => unknown
  updateSessionProfileMode?: (...a: unknown[]) => unknown
} {
  ensureProjected()
  const getState = () => manager()?.getState()
  return {
    switchSession: (id: string) => getState()?.switchSession(id),
    deleteSession: (id: string) => getState()?.deleteSession(id),
    createSession: (...a: unknown[]) => {
      const fn = getState()?.createSession
      return typeof fn === 'function' ? (fn(...a) as string) : ''
    },
    createSessionFromHistory: (...a: unknown[]) => {
      const fn = getState()?.createSessionFromHistory
      return typeof fn === 'function' ? (fn(...a) as string) : ''
    },
    renameSession: (id: string, title: string) => getState()?.updateSessionTitle(id, title),
    updateSessionModelProfile: (...a: unknown[]) =>
      (getState() as unknown as Record<string, (...x: unknown[]) => unknown>).updateSessionModelProfile?.(...a),
    updateSessionProfileMode: (...a: unknown[]) =>
      (getState() as unknown as Record<string, (...x: unknown[]) => unknown>).updateSessionProfileMode?.(...a),
  }
}
