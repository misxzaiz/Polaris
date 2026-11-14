/**
 * sessionDirectory 薄 store（ai-chat-plugin-extraction-spec P3.d / §7）
 *
 * 宿主 chrome（SessionTabs/SessionTab/WorkspaceMenu/CreateSessionModal/
 * SessionDeleteConfirm/NotificationCenterPanel/QuickSwitchPanel/ModelProviderTab）
 * 的会话只读消费面：只含元数据/activeId/流式摘要，由 sessionStoreManager
 * （插件域权威）订阅投影；写动作（切换/删除/新建）经 cap.session /
 * cap.ai.chat 总线或 manager actions 委托，本 store 不新增写路径。
 *
 * 单写者：sessionStoreManager（插件域）。本文件只做「读投影 + 动作委托」。
 */
import { useSyncExternalStore } from 'react'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import type { SessionMetadata } from '@/stores/conversationStore/types'

export interface SessionDirectoryState {
  /** 会话元数据列表（id/title/engineId/workspaceId/createdAt…） */
  sessions: SessionMetadata[]
  /** 活跃会话 id（宿主导航态） */
  activeSessionId: string | null
  /** 流式摘要：sessionId → isStreaming */
  streamingMap: Record<string, boolean>
}

let state: SessionDirectoryState = {
  sessions: [],
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
let unsubscribers: Array<() => void> = []
let projected = false

export function ensureProjected(): void {
  if (projected) return
  projected = true
  const project = () => {
    const s = sessionStoreManager.getState()
    const sessions = s.sessionMetadata ? Array.from(s.sessionMetadata.values()) : []
    const streamingMap: Record<string, boolean> = {}
    for (const m of sessions) {
      const st = s.stores.get(m.id)
      streamingMap[m.id] = st ? st.getState().isStreaming : false
    }
    setState({ sessions, activeSessionId: s.activeSessionId, streamingMap })
  }
  unsubscribers.push(sessionStoreManager.subscribe(project))
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
  sessionStoreManager.getState().switchSession(sessionId)
}

export function deleteSession(sessionId: string): void {
  sessionStoreManager.getState().deleteSession(sessionId)
}

export function updateSessionTitle(sessionId: string, title: string): void {
  sessionStoreManager.getState().updateSessionTitle(sessionId, title)
}

export function updateSessionWorkspace(...args: unknown[]): void {
  const fn = (sessionStoreManager.getState() as unknown as Record<string, (...a: unknown[]) => unknown>).updateSessionWorkspace
  if (typeof fn === 'function') fn(...args)
}

export function addContextWorkspace(...args: unknown[]): void {
  const fn = (sessionStoreManager.getState() as unknown as Record<string, (...a: unknown[]) => unknown>).addContextWorkspace
  if (typeof fn === 'function') fn(...args)
}

export function removeContextWorkspace(...args: unknown[]): void {
  const fn = (sessionStoreManager.getState() as unknown as Record<string, (...a: unknown[]) => unknown>).removeContextWorkspace
  if (typeof fn === 'function') fn(...args)
}

export function createSession(...args: unknown[]): string {
  return (sessionStoreManager.getState().createSession as (...a: unknown[]) => string)(...args)
}

export function createSessionFromHistory(...args: unknown[]): string {
  return (sessionStoreManager.getState().createSessionFromHistory as (...a: unknown[]) => string)(...args)
}
