/**
 * AI 标题生成服务
 *
 * 在首轮助手回复流式结束后，用 AI 为会话生成简洁标题，替换本地截断占位。
 * 复用 promptOptimizeService 的一次性静默会话模式（kind='title-generation'，
 * silentMode 不进列表、不切焦点），经 oneTimeSystemPrompt 注入标题约束，
 * 订阅该会话流式状态，轮次结束后取全文回填源会话标题。
 *
 * 触发：sendMessage 首轮用户消息后启动；订阅源会话等 isStreaming 从 true 回落 false，
 * 取首条助手文本作为标题生成输入。
 *
 * 引擎解析优先级：辅助引擎（config.auxiliaryEngine）> 主引擎。
 * 失败/超时静默回退本地截断标题，不阻塞主流程。
 */

import { useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import i18n from 'i18next'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { pickLatestAssistantText } from '@/services/assistantTextUtils'
import { createLogger } from '@/utils/logger'
import type { EngineId } from '@/types'
import type { ConversationStore, ConversationStoreInstance, SendMessageOptions } from '@/stores/conversationStore/types'

const log = createLogger('TitleGeneration')

/** 单轮标题生成的超时兜底 */
const TITLE_TIMEOUT_MS = 60_000

/**
 * 标题生成器约束（经 oneTimeSystemPrompt 注入，不进消息流）。
 * 要求 ≤16 字符、跟随用户语言、只输出标题本身。
 */
export const TITLE_GENERATION_SYSTEM_PROMPT = `You generate a concise session title based on the conversation.
Rules:
1. Title MUST be at most 16 characters (Chinese counts each character).
2. Use the same language as the user's first message (Chinese stays Chinese, English stays English).
3. Capture the core intent or topic, not a full sentence.
4. Do NOT end with a period or ellipsis.
5. Do NOT use code fences or quotes.
6. Output ONLY the title text — no explanations, no preamble.`

/** 每个源会话的进行中标题生成清理函数 */
const activeRuns = new Map<string, () => void>()

/** 截断兜底标题长度（与本地 generateTitleFromMessage 对齐） */
const FALLBACK_MAX_TITLE = 16

/**
 * 本地截断兜底标题（AI 失败时使用）。
 * 与 conversationStoreUtils.generateTitleFromMessage 保持一致，确保回退行为不回归。
 */
function fallbackTitle(text: string): string {
  const clean = text.replace(/\n/g, ' ').trim()
  return clean.length <= FALLBACK_MAX_TITLE ? clean : clean.slice(0, FALLBACK_MAX_TITLE) + '...'
}

export interface RunTitleGenerationOptions {
  /** 源会话 ID（标题回填目标） */
  sourceSessionId: string
  /** 源会话关联的工作区（可选；缺省时创建 free 类型标题会话） */
  workspaceId?: string
  workspacePath?: string
  /** 标题生成用引擎（辅助引擎优先；空 = 源会话引擎 */
  engineId: EngineId
  /** 供应商 Profile（可选） */
  modelProfileId?: string
  /** 具体模型（可选） */
  model?: string
}

/**
 * 触发 AI 标题生成。
 *
 * 流程：
 * 1. 订阅源会话，等 isStreaming 从 true 回落 false（首轮助手回复结束）。
 * 2. 取首条助手文本，创建一次性静默标题生成会话。
 * 3. 订阅标题会话流式状态，轮次结束后取全文回填源会话标题。
 * 4. 失败/超时静默回退本地截断标题。
 *
 * 防御：
 * - 同源会话已有进行中标题生成 → 跳过。
 * - 源会话标题已是 AI 生成（非截断占位） → 跳过。
 *   注：调用方在首轮用户消息后调用，此时标题为本地截断占位，故 always 触发。
 */
export async function runTitleGeneration(options: RunTitleGenerationOptions): Promise<void> {
  const { sourceSessionId, workspaceId, workspacePath, engineId, modelProfileId, model } = options

  const manager = sessionStoreManager.getState()
  const srcStore = manager.stores.get(sourceSessionId)
  if (!srcStore) {
    log.warn('源会话不存在，跳过标题生成', { sourceSessionId })
    return
  }

  // 防御：清理同源会话的旧标题生成
  activeRuns.get(sourceSessionId)?.()

  let finished = false
  const cleanupFns: Array<() => void> = []
  const cleanup = () => {
    cleanupFns.forEach((fn) => {
      try {
        fn()
      } catch {
        // 清理失败不影响主流程
      }
    })
    cleanupFns.length = 0
    if (activeRuns.get(sourceSessionId) === abort) activeRuns.delete(sourceSessionId)
  }

  const abort = () => {
    finished = true
    cleanup()
  }
  activeRuns.set(sourceSessionId, abort)

  /**
   * 等待源会话首轮流式结束（isStreaming true → false）。
   * 超时 30s 后放弃（源会话可能已失败/中断）。
   */
  const waitForFirstReplyEnd = (): Promise<string | null> => {
    return new Promise((resolve) => {
      const waitTimeout = setTimeout(() => {
        resolve(null)
      }, 30_000)

      let sawStreaming = srcStore.getState().isStreaming
      const unsubscribe = srcStore.subscribe((state) => {
        if (finished) {
          unsubscribe()
          clearTimeout(waitTimeout)
          resolve(null)
          return
        }
        if (state.isStreaming) {
          sawStreaming = true
          return
        }
        if (sawStreaming) {
          // 首轮流式结束，取首条助手文本
          unsubscribe()
          clearTimeout(waitTimeout)
          const text = pickLatestAssistantText(state)
          resolve(text || null)
          return
        }
        // 从未进入流式（源会话失败）
        if (state.error) {
          unsubscribe()
          clearTimeout(waitTimeout)
          resolve(null)
        }
      })
      cleanupFns.push(() => {
        unsubscribe()
        clearTimeout(waitTimeout)
      })
    })
  }

  const firstReplyText = await waitForFirstReplyEnd()
  if (finished || !firstReplyText || !firstReplyText.trim()) {
    // 流式未结束或空回复，放弃 AI 标题（本地截断已由调用方设置）
    cleanup()
    return
  }

  // 创建一次性静默标题生成会话
  const titleSessionId = manager.createSession({
    type: workspaceId ? 'project' : 'free',
    workspaceId,
    contextWorkspaceIds: workspaceId ? [workspaceId] : [],
    workspaceLocked: Boolean(workspaceId),
    engineId,
    modelProfileId: modelProfileId || undefined,
    model: model || undefined,
    title: i18n.t('chat:titleGeneration.sessionTitle', '生成标题'),
    silentMode: true,
    kind: 'title-generation',
  })

  const titleStore = sessionStoreManager.getState().stores.get(titleSessionId)
  if (!titleStore) {
    cleanup()
    return
  }

  let titleFinished = false
  const settle = (title: string | null) => {
    if (titleFinished) return
    titleFinished = true
    cleanup()
    if (title && title.trim()) {
      const trimmed = title.trim().replace(/^["'`]|["'`]$/g, '').slice(0, FALLBACK_MAX_TITLE + 8)
      sessionStoreManager.getState().updateSessionTitle(sourceSessionId, trimmed)
      log.info('AI 标题生成完成', { sourceSessionId, titleSessionId, title: trimmed })
    }
    // 失败/空：保留本地截断标题，不报错
  }

  // 订阅标题会话流式状态
  let sawTitleStreaming = titleStore.getState().isStreaming
  const unsubscribeTitle = titleStore.subscribe((state) => {
    if (titleFinished) return
    if (state.isStreaming) {
      sawTitleStreaming = true
      return
    }
    if (sawTitleStreaming) {
      const text = pickLatestAssistantText(state)
      if (state.error && !text.trim()) {
        settle(null)
      } else {
        settle(text)
      }
      return
    }
    if (state.error) {
      settle(null)
    }
  })
  cleanupFns.push(unsubscribeTitle)

  // 超时兜底
  const timer = setTimeout(() => {
    void titleStore
      .getState()
      .interrupt()
      .catch(() => undefined)
    settle(null)
  }, TITLE_TIMEOUT_MS)
  cleanupFns.push(() => clearTimeout(timer))

  const userMessage = i18n.t(
    'chat:titleGeneration.instruction',
    '请为以下对话生成一个不超过 16 字符的标题（跟随用户语言），只输出标题本身：\n\n{{content}}'
  ).replace('{{content}}', firstReplyText.slice(0, 800))

  const sendOptions: SendMessageOptions = {
    oneTimeSystemPrompt: TITLE_GENERATION_SYSTEM_PROMPT,
    // 静默会话不可见，强制 bypass 防挂起
    runtimeOverride: { permissionMode: 'bypassPermissions' },
  }

  try {
    await titleStore.getState().sendMessage(userMessage, workspacePath, undefined, sendOptions)
  } catch (e) {
    log.warn('标题生成会话发送失败', { sourceSessionId, titleSessionId, error: String(e) })
    settle(null)
  }
}

/**
 * 取消进行中的标题生成。
 */
export function cancelTitleGeneration(sourceSessionId: string): void {
  activeRuns.get(sourceSessionId)?.()
}

/**
 * 生成失败兜底：返回本地截断标题。
 * 供调用方在 AI 标题未启动 / 失败时使用，与历史行为一致。
 */
export function localFallbackTitle(text: string): string {
  return fallbackTitle(text)
}

const EMPTY_PREVIEW = ''

/**
 * 订阅标题生成会话的流式输出（调试用，普通流程不需要）。
 */
export function useTitleGenerationPreview(titleSessionId: string | null): string {
  const stores = useStore(sessionStoreManager, (state) => state.stores)
  const store: ConversationStoreInstance | null = titleSessionId
    ? (stores.get(titleSessionId) ?? null)
    : null

  const getSnapshot = () => {
    if (!store) return EMPTY_PREVIEW
    return pickLatestAssistantText(store.getState())
  }

  return useSyncExternalStore(
    (onChange) => (store ? store.subscribe(onChange) : sessionStoreManager.subscribe(onChange)),
    getSnapshot,
    () => EMPTY_PREVIEW
  )
}

export type { ConversationStore, ConversationStoreInstance }
