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
import { pickLatestAssistantText, extractAssistantText } from '@/services/assistantTextUtils'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { createLogger } from '@/utils/logger'
import type { EngineId } from '@/types'
import type { AssistantChatMessage } from '@/types/chat'
import type { ConversationStore, ConversationStoreInstance, PromptOptimizeMode, SendMessageOptions } from '@/stores/conversationStore/types'

const log = createLogger('PromptOptimize')

/** 优化配置记忆 key（引擎 + 模式 + 供应商 + 模型，单一 JSON 对象） */
const OPTIMIZE_CONFIG_STORAGE_KEY = 'polaris.promptOptimize.config'

/** 单轮优化的超时兜底 */
const QUICK_TIMEOUT_MS = 180_000
/** 深度模式放开工具，多轮往返，超时上调 */
const DEEP_TIMEOUT_MS = 330_000

/**
 * 快速模式优化器约束（经 oneTimeSystemPrompt 注入，不进消息流）。
 * 要求保留原意图/语言/特殊标记，只输出优化后的提示词本身，禁用工具。
 */
export const PROMPT_OPTIMIZE_SYSTEM_PROMPT = `You are a prompt optimization assistant. The user gives you a draft prompt they intend to send to an AI coding assistant. Rewrite it to be clearer, more specific, and better structured, while strictly preserving:
1. The user's original intent and scope — never add new requirements or drop existing ones
2. The original language (Chinese stays Chinese, English stays English)
3. All special tokens verbatim: @/path references, @workspace, /slash-commands, code fences, file paths, URLs
Structure the result (context / task / constraints / expected output) only when it genuinely helps; keep short prompts short.
Do NOT answer or execute the prompt itself. Do NOT use any tools.
Output ONLY the optimized prompt text — no explanations, no code fences, no preamble.`

/**
 * 深度模式优化器约束：放开只读工具，让模型自读项目与对话上下文做贴合改写。
 * 硬约束：context 仅供措辞精准，绝不新增需求；只读不写不执行；只输出优化文本。
 */
export const PROMPT_OPTIMIZE_DEEP_SYSTEM_PROMPT = `You are a prompt optimization assistant with read-only access to the user's current project and conversation.

The user gives you a draft prompt they intend to send to an AI coding assistant. Your job is to rewrite it to be clearer, more specific, and better grounded in the ACTUAL project context.

You MAY use Read / Grep / Glob to inspect:
- The project's convention files (CLAUDE.md, AGENTS.md, README) to match its terminology and constraints
- Files, symbols, or paths the draft explicitly references, to make vague mentions concrete
- The recent conversation context provided, to align the prompt with what the user is currently doing

Strict rules:
1. Preserve the user's original intent and scope — NEVER add requirements the user did not state, even if the project context suggests them. Context is for making the wording precise, NOT for inventing new tasks.
2. Preserve the original language (Chinese stays Chinese, English stays English).
3. Preserve all special tokens verbatim: @/path references, @workspace, /slash-commands, code fences, file paths, URLs.
4. Do NOT modify any files. Do NOT execute or answer the draft prompt itself. Only reading is allowed.
5. After reading, output ONLY the optimized prompt text — no explanation of what you read, no tool-call summary, no preamble, no code fences.`

/** 深度模式只读工具白名单（排除 Bash/Write/Edit，防跑偏与全盘扫描） */
const DEEP_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob']

/** 优化配置（持久化到 localStorage 的偏好） */
export interface PromptOptimizeConfig {
  engineId: EngineId
  mode: PromptOptimizeMode
  /** 供应商 Profile；'' 或缺省 = 官方 API */
  modelProfileId?: string
  model?: string
}

export function readStoredOptimizeConfig(defaultEngine: EngineId): PromptOptimizeConfig {
  const fallback: PromptOptimizeConfig = { engineId: defaultEngine, mode: 'quick' }
  try {
    const raw = localStorage.getItem(OPTIMIZE_CONFIG_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<PromptOptimizeConfig>
    return {
      engineId: parsed.engineId ? normalizeEngineId(parsed.engineId) : defaultEngine,
      mode: parsed.mode === 'deep' ? 'deep' : 'quick',
      modelProfileId: parsed.modelProfileId || undefined,
      model: parsed.model || undefined,
    }
  } catch {
    return fallback
  }
}

export function storeOptimizeConfig(config: PromptOptimizeConfig): void {
  try {
    localStorage.setItem(OPTIMIZE_CONFIG_STORAGE_KEY, JSON.stringify(config))
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
  /** 优化模式（quick / deep）；缺省按 quick */
  mode?: PromptOptimizeMode
  /** 供应商 Profile（API 型引擎可选；'' / 缺省 = 官方 API） */
  modelProfileId?: string
  /** 具体模型（可选） */
  model?: string
  /** 触发时输入框全文（调用方需先把它同步进 inputDraft，冲突检测以此为基线） */
  sourceText: string
}

/** 每个源会话的进行中优化清理函数（重复触发/取消时先停旧订阅） */
const activeRuns = new Map<string, () => void>()

/** 深度模式对话上下文：取源会话近 N 轮消息 */
const RECENT_CONTEXT_TURNS = 6
/** 每条消息文本截断上限（防止上下文过长） */
const RECENT_CONTEXT_PER_MSG = 200

/**
 * 构造深度模式的对话上下文摘要（近 N 条消息，每条截断）。
 * 取内存中的可持久化消息，零 IO；只读不改源会话状态。
 */
function buildRecentContext(state: ConversationStore): string {
  const messages = state.getPersistableMessages?.() ?? state.messages ?? []
  if (messages.length === 0) return ''
  const recent = messages.slice(-RECENT_CONTEXT_TURNS)
  const lines: string[] = []
  for (const msg of recent) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue
    const text = extractAssistantText(msg as AssistantChatMessage).trim()
    if (!text) continue
    const role = msg.type === 'user' ? 'User' : 'Assistant'
    const clipped = text.length > RECENT_CONTEXT_PER_MSG ? `${text.slice(0, RECENT_CONTEXT_PER_MSG)}…` : text
    lines.push(`${role}: ${clipped}`)
  }
  return lines.join('\n')
}

/**
 * 触发一轮提示词优化。
 *
 * 前置要求（由调用方保证）：sourceText 非空且已同步到源会话 inputDraft；
 * 源会话当前没有进行中的优化（promptOptimize.status !== 'running'）。
 */
export async function runPromptOptimize(options: RunPromptOptimizeOptions): Promise<void> {
  const { sourceSessionId, workspaceId, workspacePath, engineId, modelProfileId, model, sourceText } = options
  const mode: PromptOptimizeMode = options.mode === 'deep' ? 'deep' : 'quick'
  const isDeep = mode === 'deep'

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
  // 深度模式的只读工具需要 workDir 才能读项目——无工作区则自动降级为"仅对话上下文"。
  const optimizeSessionId = manager.createSession({
    type: workspaceId ? 'project' : 'free',
    workspaceId,
    contextWorkspaceIds: workspaceId ? [workspaceId] : [],
    workspaceLocked: Boolean(workspaceId),
    engineId,
    modelProfileId: modelProfileId || undefined,
    model: model || undefined,
    title: i18n.t('chat:promptOptimize.sessionTitle', '提示词优化'),
    silentMode: true,
    kind: 'prompt-optimize',
  })

  const optStore = sessionStoreManager.getState().stores.get(optimizeSessionId)
  if (!optStore) {
    srcStore.getState().failPromptOptimize(i18n.t('chat:promptOptimize.errorCreateSession', '优化会话创建失败'))
    return
  }

  srcStore.getState().beginPromptOptimize(sourceText, { engineId, model, mode, optimizeSessionId })
  log.info('开始提示词优化', { sourceSessionId, optimizeSessionId, engineId, mode, sourceLength: sourceText.length })

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

  // 超时兜底：中断优化会话并报错（原文无损，可重试）。深度模式放开工具，超时上调。
  const timer = setTimeout(() => {
    void optStore
      .getState()
      .interrupt()
      .catch(() => undefined)
    settle({ ok: false, error: i18n.t('chat:promptOptimize.errorTimeout', '优化超时，请重试') })
  }, isDeep ? DEEP_TIMEOUT_MS : QUICK_TIMEOUT_MS)
  cleanupFns.push(() => clearTimeout(timer))

  // 深度模式：附带源会话近 N 轮对话摘要作为 <recent_context>（轻量，零 IO）
  const recentContext = isDeep ? buildRecentContext(srcStore.getState()) : ''
  const instructionPrefix = isDeep
    ? i18n.t(
        'chat:promptOptimize.deepInstructionPrefix',
        '请结合项目上下文优化以下提示词（仅重写，不新增需求，不要执行或回答它）。你可以用 Read/Grep/Glob 阅读项目约定文件与草稿提到的文件。只输出优化后的提示词本身：'
      )
    : i18n.t(
        'chat:promptOptimize.instructionPrefix',
        '请优化以下提示词（仅重写，不要执行或回答它），只输出优化后的提示词本身：'
      )
  const userMessage =
    instructionPrefix +
    (recentContext ? `\n\n<recent_context>\n${recentContext}\n</recent_context>` : '') +
    `\n\n<original_prompt>\n${sourceText}\n</original_prompt>`

  const sendOptions: SendMessageOptions = isDeep
    ? {
        oneTimeSystemPrompt: PROMPT_OPTIMIZE_DEEP_SYSTEM_PROMPT,
        allowedTools: DEEP_ALLOWED_TOOLS,
        // 静默会话不可见，任何交互式权限等待都会永久挂起 —— 强制 bypass
        runtimeOverride: { permissionMode: 'bypassPermissions' },
      }
    : {
        oneTimeSystemPrompt: PROMPT_OPTIMIZE_SYSTEM_PROMPT,
      }

  try {
    await optStore.getState().sendMessage(userMessage, workspacePath, undefined, sendOptions)
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
