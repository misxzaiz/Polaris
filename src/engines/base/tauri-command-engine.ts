/**
 * TauriCommandEngine - Tauri 命令型引擎公共基类
 *
 * 适用于通过 Tauri invoke 命令与后端进程通信的引擎（如 Claude Code、Codex）。
 * 子类只需提供 id、name、capabilities、sessionFactory 和 sessionIdPrefix。
 */

import type { AIEngine, AISession, AISessionConfig, EngineCapabilities } from '@/ai-runtime'

export abstract class TauriCommandEngine implements AIEngine {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly capabilities: EngineCapabilities

  /** 子类提供会话工厂 */
  protected abstract sessionFactory(sessionId: string, config?: AISessionConfig): AISession

  /** 子类提供会话 ID 前缀（如 'claude'、'codex'） */
  protected abstract get sessionIdPrefix(): string

  private sessions = new Map<string, AISession>()
  private sessionCounter = 0

  createSession(config?: AISessionConfig): AISession {
    const sessionId = `${this.sessionIdPrefix}-${Date.now()}-${++this.sessionCounter}`
    const session = this.sessionFactory(sessionId, config)

    // 清理已销毁的会话
    session.onEvent((event) => {
      if (event.type === 'session_end') {
        setTimeout(() => {
          if (session.status === 'idle') {
            this.sessions.delete(sessionId)
          }
        }, 5000)
      }
    })

    this.sessions.set(sessionId, session)
    return session
  }

  async isAvailable(): Promise<boolean> {
    return true
  }

  async initialize(): Promise<boolean> {
    return true
  }

  cleanup(): void {
    this.sessions.forEach((s) => s.dispose())
    this.sessions.clear()
  }

  get activeSessionCount(): number {
    let count = 0
    this.sessions.forEach((s) => {
      if (s.status === 'running') count++
    })
    return count
  }

  getSessions(): AISession[] {
    return Array.from(this.sessions.values())
  }
}