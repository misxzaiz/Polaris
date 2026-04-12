import { sessionStoreManager } from '../../stores/conversationStore'
import type { ClaudeCodeSessionType, ClaudeCodeSessionState } from '../types'

/**
 * Claude Code 会话管理器
 *
 * 负责：
 * 1. 创建和管理多个 Claude Code 会话
 * 2. 复用现有 SessionStoreManager 架构
 * 3. 事件路由到正确的会话
 */
export class ClaudeCodeSessionManager {
  private sessions: Map<string, ClaudeCodeSessionState> = new Map()

  /**
   * 创建新的 Claude Code 会话
   */
  createSession(type: ClaudeCodeSessionType, label?: string): string {
    // primary 会话使用固定 ID
    const sessionId = type === 'primary' ? 'primary' : `${type}-${Date.now()}`
    const displayLabel = label || this.getDefaultLabel(type)

    // 复用现有 SessionStoreManager 创建会话
    sessionStoreManager.getState().createSession({
      id: sessionId,
      type: 'free',
      title: displayLabel,
      silentMode: type === 'background',
    })

    // 记录会话状态
    const sessionState: ClaudeCodeSessionState = {
      id: sessionId,
      type,
      status: 'idle',
      label: displayLabel,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      events: [],
    }

    this.sessions.set(sessionId, sessionState)

    console.log(`[ClaudeCodeSessionManager] 创建会话: ${sessionId} (${type})`)

    return sessionId
  }

  /**
   * 获取会话状态
   */
  getSession(sessionId: string): ClaudeCodeSessionState | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * 获取所有会话
   */
  getAllSessions(): ClaudeCodeSessionState[] {
    return Array.from(this.sessions.values())
  }

  /**
   * 获取运行中的会话
   */
  getRunningSessions(): ClaudeCodeSessionState[] {
    return Array.from(this.sessions.values()).filter(s => s.status === 'running')
  }

  /**
   * 在指定会话中执行任务
   */
  async executeInSession(sessionId: string, prompt: string, workspacePath?: string): Promise<void> {
    const sessionState = this.sessions.get(sessionId)
    if (!sessionState) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // 更新状态
    sessionState.status = 'running'
    sessionState.lastActiveAt = Date.now()

    // 获取 ConversationStore 并发送消息
    const store = sessionStoreManager.getState().getStore(sessionId)
    if (!store) {
      throw new Error(`ConversationStore not found for session: ${sessionId}`)
    }

    await store.sendMessage(prompt, workspacePath)
  }

  /**
   * 中断指定会话
   */
  async abortSession(sessionId: string): Promise<void> {
    await sessionStoreManager.getState().interruptSession(sessionId)

    const sessionState = this.sessions.get(sessionId)
    if (sessionState) {
      sessionState.status = 'idle'
    }
  }

  /**
   * 中断所有运行中的会话
   */
  async abortAllSessions(): Promise<void> {
    const runningSessions = this.getRunningSessions()
    await Promise.all(runningSessions.map(s => this.abortSession(s.id)))
  }

  /**
   * 更新会话状态
   */
  updateSessionStatus(sessionId: string, status: ClaudeCodeSessionState['status']): void {
    const sessionState = this.sessions.get(sessionId)
    if (sessionState) {
      sessionState.status = status
      sessionState.lastActiveAt = Date.now()
    }
  }

  /**
   * 添加执行事件
   */
  addEvent(sessionId: string, event: ClaudeCodeSessionState['events'][0]): void {
    const sessionState = this.sessions.get(sessionId)
    if (sessionState) {
      sessionState.events.push(event)
      sessionState.lastActiveAt = Date.now()
    }
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): void {
    // 不删除 primary 会话
    if (sessionId === 'primary') {
      return
    }

    sessionStoreManager.getState().deleteSession(sessionId)
    this.sessions.delete(sessionId)

    console.log(`[ClaudeCodeSessionManager] 删除会话: ${sessionId}`)
  }

  /**
   * 清理已完成的非主会话
   */
  cleanupCompletedSessions(): void {
    const toDelete: string[] = []

    this.sessions.forEach((state, id) => {
      if (id !== 'primary' && (state.status === 'completed' || state.status === 'error')) {
        toDelete.push(id)
      }
    })

    toDelete.forEach(id => this.deleteSession(id))
  }

  /**
   * 获取默认标签
   */
  private getDefaultLabel(type: ClaudeCodeSessionType): string {
    const labels: Record<ClaudeCodeSessionType, string> = {
      primary: '主会话',
      analysis: '分析任务',
      background: '后台任务',
    }
    return labels[type]
  }
}

/**
 * 全局单例
 */
let managerInstance: ClaudeCodeSessionManager | null = null

export function getClaudeCodeSessionManager(): ClaudeCodeSessionManager {
  if (!managerInstance) {
    managerInstance = new ClaudeCodeSessionManager()
  }
  return managerInstance
}

export function resetClaudeCodeSessionManager(): void {
  if (managerInstance) {
    managerInstance = null
  }
}
