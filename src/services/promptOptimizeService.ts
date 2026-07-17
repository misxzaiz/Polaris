/**
 * 提示词优化服务
 *
 * 把输入框草稿交给所选引擎优化：创建一次性静默会话（kind='prompt-optimize'，
 * silentMode 不进会话列表、不切换焦点），经 oneTimeSystemPrompt 注入优化器
 * 约束，订阅该会话流式状态，轮次结束后取全文回填源会话的版本栈
 * （beginPromptOptimize / completePromptOptimize / failPromptOptimize）。
 *
 * 通道决策见 docs/prompt-optimize-plan.md：沿用会话基建（同 commitMessageChat），
 * 不走 headless 一次性调用（旧路径存在超时/跑偏/静默兜底问题）。
 *
 * 优化会话不主动删除：eventRouter 对不存在的路由目标会自动重建可见会话，
 * 删除后若有迟到事件会冒出空会话；静默会话本就不可见，交由 LRU 驱逐回收。
 */

import { useCallback, useRef } from 'react'
import { useStore } from 'zustand'
import { useSyncExternalStore } from 'react'
import i18n from 'i18next'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { pickLatestAssistantText } from '@/services/assistantTextUtils'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { createLogger } from '@/utils/logger'
import type { EngineId } from '@/types'
import type { ConversationStoreInstance } from '@/stores/conversationStore/types'

const log = createLogger('PromptOptimize')

/** 上次所选优化引擎的记忆 key */
const OPTIMIZE_ENGINE_STORAGE_KEY = 'polaris.promptOptimize.engine'

/** 单轮优化的超时兜底（CLI 引擎冷启动 + 生成时间） */
const OPTIMIZE_TIMEOUT_MS = 180_000

/**
 * 优化器约束（经 oneTimeSystemPrompt 注入，不进消息流）。
 * 要求保留原意图/语言/特殊标记，只输出优化后的提示词本身。
 */
export const PROMPT_OPTIMIZE_SYSTEM_PROMPT = `You are a prompt optimization assistant. The user gives you a draft prompt they intend to send to an AI coding assistant. Rewrite it to be clearer, more specific, and better structured, while strictly preserving:
1. The user's original intent and scope — never add new requirements or drop existing ones
2. The original language (Chinese stays Chinese, English stays English)
3. All special tokens verbatim: @/path references, @workspace, /slash-commands, code fences, file paths, URLs
Structure the result (context / task / constraints / expected output) only when it genuinely helps; keep short prompts short.
Do NOT answer or execute the prompt itself. Do NOT use any tools.
Output ONLY the optimized prompt text — no explanations, no code fences, no preamble.`

export function readStoredOptimizeEngine(defaultEngine: EngineId): EngineId {
  try {
    const raw = localStorage.getItem(OPTIMIZE_ENGINE_STORAGE_KEY)
    if (raw) return normalizeEngineId(raw)
  } catch {
    // localStorage 不可用时静默回退
  }
  return defaultEngine
}

export function storeOptimizeEngine(engineId: EngineId): void {
  try {
    localStorage.setItem(OPTIMIZE_ENGINE_STORAGE_KEY, engineId)
  } catch {
    // localStorage 不可用时静默
  }
}

export interface RunPromptOptimizeOptions {
  /** 触发优化的会话（版本栈与结果回填目标） */
  sourceSessionId: string
  /** 优化会话关联的工作区（可选；缺省时创建 free 类型优化会话，与无工作区聊天一致） */
  workspaceId?: string
  workspacePath?: string
  engineId: EngineId
  /** 触发时输入框全文（调用方需先把它同步进 inputDraft，冲突检测以此为基线） */
  sourceText: string
}

/** 每个源会话的进行中优化清理函数（重复触发/取消时先停旧订阅） */
const activeRuns = new Map<string, () => void>()

/**
 * 触发一轮提示词优化。
 *
 * 前置要求（由调用方保证）：sourceText 非空且已同步到源会话 inputDraft；
 * 源会话当前没有进行中的优化（promptOptimize.status !== 'running'）。
 */
export async function runPromptOptimize(options: RunPromptOptimizeOptions): Promise<void> {
  const { sourceSessionId, workspaceId, workspacePath, engineId, sourceText } = options

  const manager = sessionStoreManager.getState()
  const srcStore = manager.stores.get(sourceSessionId)
  if (!srcStore) {
    log.warn('源会话不存在，忽略优化请求', { sourceSessionId })
    return
  }

  // 防御：清理同源会话的旧订阅（UI 已禁用重复触发）
  activeRuns.get(sourceSessionId)?.()

  // 一次性静默优化会话：不激活、不进列表；完成后交由 LRU 回收。
  // 无工作区时建 free 会话（sendMessage 的 workDir 解析链会自行兜底全局工作区）。
  const optimizeSessionId = manager.createSession({
    type: workspaceId ? 'project' : 'free',
    workspaceId,
    contextWorkspaceIds: workspaceId ? [workspaceId] : [],
    workspaceLocked: Boolean(workspaceId),
    engineId,
    title: i18n.t('chat:promptOptimize.sessionTitle', '提示词优化'),
    silentMode: true,
    kind: 'prompt-optimize',
  })

  const optStore = sessionStoreManager.getState().stores.get(optimizeSessionId)
  if (!optStore) {
    srcStore.getState().failPromptOptimize(i18n.t('chat:promptOptimize.errorCreateSession', '优化会话创建失败'))
    return
  }

  srcStore.getState().beginPromptOptimize(sourceText, { engineId, optimizeSessionId })
  log.info('开始提示词优化', { sourceSessionId, optimizeSessionId, engineId, sourceLength: sourceText.length })

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

  // 取消入口（cancelPromptOptimize 调用）：停订阅/计时器，不回写状态
  const abort = () => {
    finished = true
    cleanup()
  }
  activeRuns.set(sourceSessionId, abort)

  const settle = (result: { ok: true; text: string } | { ok: false; error: string | null }) => {
    if (finished) return
    finished = true
    cleanup()
    const src = srcStore.getState()
    if (result.ok) {
      src.completePromptOptimize(result.text)
      log.info('提示词优化完成', { sourceSessionId, optimizeSessionId, resultLength: result.text.length })
    } else {
      src.failPromptOptimize(result.error)
      log.warn('提示词优化失败', { sourceSessionId, optimizeSessionId, error: result.error })
    }
  }

  // 完成检测：isStreaming 从 true 回落 false 视为轮次结束；
  // 从未进入流式却出现 error（如引擎启动失败）也按失败收口。
  let sawStreaming = optStore.getState().isStreaming
  const unsubscribe = optStore.subscribe((state) => {
    if (finished) return
    if (state.isStreaming) {
      sawStreaming = true
      return
    }
    if (sawStreaming) {
      const text = pickLatestAssistantText(state)
      if (state.error && !text.trim()) {
        settle({ ok: false, error: state.error })
      } else {
        settle({ ok: true, text })
      }
      return
    }
    if (state.error) {
      settle({ ok: false, error: state.error })
    }
  })
  cleanupFns.push(unsubscribe)

  // 超时兜底：中断优化会话并报错（原文无损，可重试）
  const timer = setTimeout(() => {
    void optStore
      .getState()
      .interrupt()
      .catch(() => undefined)
    settle({ ok: false, error: i18n.t('chat:promptOptimize.errorTimeout', '优化超时，请重试') })
  }, OPTIMIZE_TIMEOUT_MS)
  cleanupFns.push(() => clearTimeout(timer))

  const userMessage =
    i18n.t('chat:promptOptimize.instructionPrefix', '请优化以下提示词（仅重写，不要执行或回答它），只输出优化后的提示词本身：') +
    `\n\n<original_prompt>\n${sourceText}\n</original_prompt>`

  try {
    await optStore.getState().sendMessage(userMessage, workspacePath, undefined, {
      oneTimeSystemPrompt: PROMPT_OPTIMIZE_SYSTEM_PROMPT,
    })
  } catch (e) {
    settle({ ok: false, error: String(e) })
  }
}

/**
 * 取消进行中的优化：中断优化会话、停止订阅，源会话状态回 idle（版本栈保留）。
 */
export function cancelPromptOptimize(sourceSessionId: string): void {
  const manager = sessionStoreManager.getState()
  const srcStore = manager.stores.get(sourceSessionId)
  const po = srcStore?.getState().promptOptimize

  activeRuns.get(sourceSessionId)?.()

  if (po?.optimizeSessionId) {
    const optStore = manager.stores.get(po.optimizeSessionId)
    void optStore
      ?.getState()
      .interrupt()
      .catch(() => undefined)
  }
  srcStore?.getState().failPromptOptimize(null)
  log.info('取消提示词优化', { sourceSessionId })
}

const EMPTY_PREVIEW: { text: string; isStreaming: boolean } = { text: '', isStreaming: false }

/**
 * 订阅优化会话的流式输出（进度胶囊实时预览）。
 *
 * 与 useCommitMessageSuggestion 同模式：直接订阅目标会话 store，
 * 流式中跟随 currentMessage，会话缺失（LRU 驱逐等）返回空快照。
 */
export function usePromptOptimizePreview(optimizeSessionId: string | null) {
  const stores = useStore(sessionStoreManager, (state) => state.stores)
  const store: ConversationStoreInstance | null = optimizeSessionId
    ? (stores.get(optimizeSessionId) ?? null)
    : null

  const cachedRef = useRef(EMPTY_PREVIEW)

  const getSnapshot = useCallback(() => {
    if (!store) return EMPTY_PREVIEW
    const state = store.getState()
    const next = { text: pickLatestAssistantText(state), isStreaming: state.isStreaming }
    if (cachedRef.current.text === next.text && cachedRef.current.isStreaming === next.isStreaming) {
      return cachedRef.current
    }
    cachedRef.current = next
    return next
  }, [store])

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!store) {
        // store 缺失时订阅 manager，等会话创建后重算
        return sessionStoreManager.subscribe(onChange)
      }
      return store.subscribe(onChange)
    },
    [store]
  )

  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_PREVIEW)
}
