/**
 * Codex 原生历史服务
 *
 * 读取后端从 ~/.codex/sessions 聚合出的会话历史。
 */

import { generateUUID } from '@/utils/uuid'
import { invoke } from '../services/tauri'
import type { AssistantChatMessage, ChatMessage, SystemChatMessage, UserChatMessage } from '../types'
import type { PagedResult, SessionMetaResponse } from './claudeCodeHistoryService'
import { createLogger } from '../utils/logger'

const log = createLogger('CodexHistoryService')

export interface HistoryMessageResponse {
  messageId?: string
  role: string
  content: string
  timestamp?: string
}

export class CodexHistoryService {
  async listSessionsPaged(options: {
    page?: number
    pageSize?: number
    workDir?: string | null
  }): Promise<PagedResult<SessionMetaResponse>> {
    try {
      return await invoke<PagedResult<SessionMetaResponse>>('list_sessions', {
        engineId: 'codex',
        page: options.page ?? 1,
        pageSize: options.pageSize ?? 20,
        workDir: options.workDir ?? null,
      })
    } catch (e) {
      log.error('列出 Codex 会话失败:', e instanceof Error ? e : new Error(String(e)))
      return { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 }
    }
  }

  async getSessionHistory(sessionId: string): Promise<HistoryMessageResponse[]> {
    try {
      const result = await invoke<PagedResult<HistoryMessageResponse>>('get_session_history', {
        sessionId,
        engineId: 'codex',
        page: 1,
        pageSize: 100000,
      })
      return result.items
    } catch (e) {
      log.error('获取 Codex 会话历史失败:', e instanceof Error ? e : new Error(String(e)))
      return []
    }
  }

  convertToChatMessages(messages: HistoryMessageResponse[]): ChatMessage[] {
    return messages
      .filter(message => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
      .map(message => {
        const timestamp = message.timestamp || new Date().toISOString()

        if (message.role === 'user') {
          return {
            id: generateUUID(),
            type: 'user',
            content: message.content,
            timestamp,
          } as UserChatMessage
        }

        if (message.role === 'assistant') {
          return {
            id: generateUUID(),
            type: 'assistant',
            blocks: [{ type: 'text', content: message.content }],
            timestamp,
            isStreaming: false,
            engineId: 'codex',
          } as AssistantChatMessage
        }

        return {
          id: generateUUID(),
          type: 'system',
          content: message.content,
          timestamp,
        } as SystemChatMessage
      })
  }
}

let globalService: CodexHistoryService | null = null

export function getCodexHistoryService(): CodexHistoryService {
  if (!globalService) {
    globalService = new CodexHistoryService()
  }
  return globalService
}
