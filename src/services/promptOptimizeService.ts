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
 *
 * 多轮迭代：每轮独立一次性静默会话（不跨会话污染），service 内部链式调用——
 * 下一轮 sourceText 恒为上一轮 AI 结果（非用户手改），中间轮走
 * continuePromptOptimize（跳过冲突检测），末轮走 completePromptOptimize。
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
import type { ConversationStore, ConversationStoreInstance, OptimizeDirection, PromptOptimizeMode, SendMessageOptions } from '@/stores/conversationStore/types'

const log = createLogger('PromptOptimize')

/** 优化配置记忆 key（引擎 + 模式 + 供应商 + 模型 + 方向 + 轮次，单一 JSON 对象） */
const OPTIMIZE_CONFIG_STORAGE_KEY = 'polaris.promptOptimize.config'

/** 单轮优化的超时兜底 */
const QUICK_TIMEOUT_MS = 180_000
/** 深度模式放开工具，多轮往返，超时上调 */
const DEEP_TIMEOUT_MS = 330_000

/** 多轮迭代硬上限（防烧 token） */
const MAX_ITERATIONS = 5

/**
 * 快速模式优化器约束（经 oneTimeSystemPrompt 注入，不进消息流）。
 * 要求保留原意图/语言/特殊标记，只输出优化后的提示词本身，禁用工具。
 */
export const PROMPT_OPTIMIZE_SYSTEM_PROMPT = `You are a prompt optimization assistant. The user gives you a draft prompt they intend to send to an AI coding assistant. Rewrite it to be clearer, more specific, and better structured, while strictly preserving:
1. The user's original intent and scope — never add requirements or drop existing ones
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

/**
 * 方向 → system prompt 追加指令映射。
 * structured 为默认方向，不追加（基础 prompt 已含结构化要求）；
 * 其余方向在基础 prompt 末尾追加一句方向指令，不替换基础约束。
 * custom 与预设互斥（UI 单选），custom 选中即覆盖预设方向。
 */
export const DIRECTION_INSTRUCTIONS: Record<Exclude<OptimizeDirection, 'custom'>, string> = {
  structured: '',
  convergent: '\n\n优化方向：精炼。压缩冗余表述与重复信息，保留全部原始意图与特殊标记，使提示词更短更准。不要新增需求。',
  divergent: '\n\n优化方向：发散。在严格保留原意图与范围内，补充 2~3 个互补的角度/可能解法/边界场景供下游 AI 选择，但不要改变用户要解决的核心问题。',
  elaborate: '\n\n优化方向：扩写。补全缺失的上下文、隐含假设、验收标准与预期输出形态，使下游 AI 无歧义执行；不新增用户未表达的需求。',
}

/** 自定义方向指令的字符上限（超出截断提示，防注入过长） */
const CUSTOM_DIRECTION_MAX = 200

/** 优化配置（持久化到 localStorage 的偏好） */
export interface PromptOptimizeConfig {
  engineId: EngineId
  mode: PromptOptimizeMode
  /** 供应商 Profile；'' 或缺省 = 官方 API */
  modelProfileId?: string
  model?: string
  /** 优化方向（缺省 = structured） */
  direction?: OptimizeDirection
  /** 自定义方向指令原文（direction === 'custom' 时使用） */
  customDirectionText?: string
  /** 迭代轮次（1=单轮，2~5=多轮；缺省=1） */
  iterations?: number
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
      direction: normalizeDirection(parsed.direction),
      customDirectionText: typeof parsed.customDirectionText === 'string' ? parsed.customDirectionText : undefined,
      iterations: normalizeIterations(parsed.iterations),
    }
  } catch {
    return fallback
  }
}

function normalizeDirection(d: unknown): OptimizeDirection | undefined {
  if (d === 'structured' || d === 'convergent' || d === 'divergent' || d === 'elaborate' || d === 'custom') {
    return d
  }
  return undefined
}

function normalizeIterations(n: unknown): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
  const i = Math.floor(n)
  if (i < 1 || i > MAX_ITERATIONS) return undefined
  return i
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
  /** 优化方向（缺省 = structured） */
  direction?: OptimizeDirection
  /** 自定义方向指令原文（direction === 'custom' 时必填非空） */
  customDirectionText?: string
  /** 迭代轮次（1=单轮，2~5=多轮；缺省=1） */
  iterations?: number
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
 * 构造优化器 system prompt：基础 prompt + 方向指令（custom 时拼用户指令）。
 * structured 默认方向不追加；custom 与预设互斥（custom 覆盖预设）。
 */
function buildSystemPrompt(
  basePrompt: string,
  direction: OptimizeDirection,
  customDirectionText?: string,
): string {
  if (direction === 'custom') {
    const trimmed = (customDirectionText ?? '').trim()
    const clipped = trimmed.length > CUSTOM_DIRECTION_MAX ? `${trimmed.slice(0, CUSTOM_DIRECTION_MAX)}…` : trimmed
    return `${basePrompt}\n\n优化方向（用户指定）：${clipped}。在不违背上述基础约束的前提下，按此方向润色。`
  }
  return `${basePrompt}${DIRECTION_INSTRUCTIONS[direction] ?? ''}`
}

/**
 * 执行单轮优化，返回该轮结果（成功 {ok,text} / 失败 {error}）。
 * Promise 在轮次流式结束（isStreaming 回落）或超时/失败后才 resolve，
 * 故多轮迭代循环 `await` 本函数可保证"上一轮完全收口后再开始下一轮"。
 * 单轮与多轮均基于此：单轮/末轮由 service 调 completePromptOptimize；
 * 多轮中间轮由 service 调 continuePromptOptimize。
 *
 * @param abortSignal 已取消则不再 settle（resolve 一个失败结果，由循环跳出）
 */
function executeSingleRound(opts: {
  srcStore: ConversationStore
  sourceSessionId: string
  workspaceId?: string
  workspacePath?: string
  engineId: EngineId
  modelProfileId?: string
  model?: string
  mode: PromptOptimizeMode
  direction: OptimizeDirection
  customDirectionText?: string
  iteration: number
  totalIterations: number
  sourceText: string
  abortSignal: { aborted: boolean }
}): Promise<{ ok: true; text: string } | { ok: false; error: string | null }> {
  return new Promise((resolve) => {
    const {
      srcStore, sourceSessionId, workspaceId, workspacePath, engineId,
      modelProfileId, model, mode, direction, customDirectionText,
      iteration, totalIterations, sourceText, abortSignal,
    } = opts
    const isDeep = mode === 'deep'
    const manager = sessionStoreManager.getState()

    const settle = (r: { ok: true; text: string } | { ok: false; error: string | null }) => {
      if (abortSignal.aborted) {
        resolve({ ok: false, error: null })
        return
      }
      resolve(r)
    }

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
    settle({ ok: false, error: i18n.t('chat:promptOptimize.errorCreateSession', '优化会话创建失败') })
    return
  }

  // 登记 running 状态（每轮 begin；多轮中间轮 service 已先调 continue 切 idle 再 begin）
  srcStore.getState().beginPromptOptimize(sourceText, {
    engineId,
    model,
    mode,
    direction,
    customDirection: direction === 'custom' ? customDirectionText : undefined,
    iteration,
    totalIterations,
    optimizeSessionId,
  })

  let finished = false
  const cleanupFns: Array<() => void> = []
  const cleanup = () => {
    cleanupFns.forEach((fn) => { try { fn() } catch { /* noop */ } })
    cleanupFns.length = 0
  }

  const finish = (r: { ok: true; text: string } | { ok: false; error: string | null }) => {
    if (finished) return
    finished = true
    cleanup()
    settle(r)
  }

  // 完成检测：isStreaming 从 true 回落 false 视为轮次结束；
  // 从未进入流式却出现 error（如引擎启动失败）也按失败收口。
  let sawStreaming = optStore.getState().isStreaming
  const unsubscribe = optStore.subscribe((state) => {
    if (finished) return
    if (state.isStreaming) { sawStreaming = true; return }
    if (sawStreaming) {
      const text = pickLatestAssistantText(state)
      if (state.error && !text.trim()) {
        finish({ ok: false, error: state.error })
      } else {
        finish({ ok: true, text })
      }
      return
    }
    if (state.error) finish({ ok: false, error: state.error })
  })
  cleanupFns.push(unsubscribe)

  // 超时兜底：中断优化会话并报错（原文无损，可重试）。深度模式放开工具，超时上调。
  const timer = setTimeout(() => {
    void optStore.getState().interrupt().catch(() => undefined)
    finish({ ok: false, error: i18n.t('chat:promptOptimize.errorTimeout', '优化超时，请重试') })
  }, isDeep ? DEEP_TIMEOUT_MS : QUICK_TIMEOUT_MS)
  cleanupFns.push(() => clearTimeout(timer))

  // 深度模式：附带源会话近 N 轮对话摘要作为 <recent_context>（轻量，零 IO）
  const recentContext = isDeep ? buildRecentContext(srcStore.getState()) : ''
  const instructionPrefix = isDeep
    ? i18n.t(
      'chat:promptOptimize.deepInstructionPrefix',
      '请结合项目上下文优化以下提示词（仅重写，不新增需求，不要执行或回答它）。你可以用 Read/Grep/Glob 阅读项目约定文件与草稿提到的文件。只输出优化后的提示词本身：',
    )
    : i18n.t(
      'chat:promptOptimize.instructionPrefix',
      '请优化以下提示词（仅重写，不要执行或回答它），只输出优化后的提示词本身：',
    )
  const roundPrefix = totalIterations > 1
    ? i18n.t('chat:promptOptimize.roundPrefix', {
      defaultValue: '（第 {{cur}}/{{total}} 轮，以上一轮优化结果为基础继续按既定方向润色，不要回退已有改进，不要执行/回答提示词本身）',
      cur: iteration,
      total: totalIterations,
    })
    : ''
  const userMessage =
    (roundPrefix ? `${roundPrefix}\n` : '') +
    instructionPrefix +
    (recentContext ? `\n\n<recent_context>\n${recentContext}\n</recent_context>` : '') +
    `\n\n<original_prompt>\n${sourceText}\n</original_prompt>`

  const baseSystemPrompt = isDeep ? PROMPT_OPTIMIZE_DEEP_SYSTEM_PROMPT : PROMPT_OPTIMIZE_SYSTEM_PROMPT
  const systemPrompt = buildSystemPrompt(baseSystemPrompt, direction, customDirectionText)

  const sendOptions: SendMessageOptions = isDeep
    ? {
      oneTimeSystemPrompt: systemPrompt,
      allowedTools: DEEP_ALLOWED_TOOLS,
      // 静默会话不可见，任何交互式权限等待都会永久挂起 —— 强制 bypass
      runtimeOverride: { permissionMode: 'bypassPermissions' },
    }
    : { oneTimeSystemPrompt: systemPrompt }

  void (async () => {
    try {
      await optStore.getState().sendMessage(userMessage, workspacePath, undefined, sendOptions)
      // sendMessage resolve 仅表示发送完成，流式完成由 store.subscribe 的 finish 负责；
      // 此处无需额外处理，Promise 由 finish 的 settle resolve。
    } catch (e) {
      finish({ ok: false, error: String(e) })
    }
  })()
  })
}

/**
 * 触发提示词优化（单轮或多轮迭代）。
 *
 * 单轮：executeSingleRound → completePromptOptimize（末轮冲突检测）。
 * 多轮：链式 executeSingleRound，中间轮 continuePromptOptimize（跳过冲突，
 * 下一轮基线恒为上一轮 AI 结果），末轮 completePromptOptimize。
 * 中途取消（abortSignal.aborted）：立即停止后续轮，已完成版本保留。
 * 任一轮失败即终止迭代，已成功版本保留，胶囊转错误态可重试。
 *
 * 前置要求（由调用方保证）：sourceText 非空且已同步到源会话 inputDraft；
 * 源会话当前没有进行中的优化（promptOptimize.status !== 'running'）。
 */
export async function runPromptOptimize(options: RunPromptOptimizeOptions): Promise<void> {
  const {
    sourceSessionId, workspaceId, workspacePath, engineId, modelProfileId, model, sourceText,
    direction, customDirectionText,
  } = options
  const mode: PromptOptimizeMode = options.mode === 'deep' ? 'deep' : 'quick'
  const dir: OptimizeDirection = direction ?? 'structured'
  const iterations = Math.max(1, Math.min(MAX_ITERATIONS, options.iterations ?? 1))

  const manager = sessionStoreManager.getState()
  const srcStore = manager.stores.get(sourceSessionId)
  if (!srcStore) {
    log.warn('源会话不存在，忽略优化请求', { sourceSessionId })
    return
  }

  // 防御：清理同源会话的旧订阅（UI 已禁用重复触发）
  activeRuns.get(sourceSessionId)?.()

  const abort = { aborted: false }
  activeRuns.set(sourceSessionId, () => { abort.aborted = true })

  log.info('开始提示词优化', {
    sourceSessionId, engineId, mode, direction: dir,
    iterations, sourceLength: sourceText.length,
  })

  let currentText = sourceText
  for (let i = 1; i <= iterations; i++) {
    if (abort.aborted) {
      log.info('迭代被取消，停止后续轮', { sourceSessionId, atIteration: i })
      break
    }

    const isLast = i === iterations
    // eslint-disable-next-line no-await-in-loop -- 迭代链天然串行，每轮依赖上一轮结果；
    // executeSingleRound 返回的 Promise 在该轮流式结束（isStreaming 回落）后才 resolve，
    // 故 await 可保证"上一轮完全收口（已入栈/已 fail）后再开始下一轮"，无竞态。
    const result = await executeSingleRound({
      srcStore,
      sourceSessionId,
      workspaceId,
      workspacePath,
      engineId,
      modelProfileId,
      model,
      mode,
      direction: dir,
      customDirectionText,
      iteration: i,
      totalIterations: iterations,
      sourceText: currentText,
      abortSignal: abort,
    })

    if (abort.aborted) break
    const src = srcStore.getState()
    if (result.ok) {
      if (isLast) {
        src.completePromptOptimize(result.text)
        log.info('提示词优化完成', { sourceSessionId, resultLength: result.text.length, iteration: i })
      } else {
        src.continuePromptOptimize(result.text)
        log.info('迭代轮完成', { sourceSessionId, iteration: i, of: iterations, resultLength: result.text.length })
      }
    } else {
      src.failPromptOptimize(result.error)
      log.warn('提示词优化失败', { sourceSessionId, atIteration: i, error: result.error })
      break // 任一轮失败即终止迭代，已成功版本保留
    }

    // 上一轮成功且非末轮：取最新入栈版本作为下一轮 sourceText
    if (isLast) break
    if (abort.aborted) break
    const po = srcStore.getState().promptOptimize
    if (po.status !== 'idle' || po.error) {
      // 上一轮失败/取消：终止迭代
      break
    }
    const lastVersion = po.history[po.cursor]
    if (!lastVersion || !lastVersion.text.trim()) break
    currentText = lastVersion.text
  }

  if (activeRuns.get(sourceSessionId) === abort) {
    activeRuns.delete(sourceSessionId)
  }
}

/**
 * 取消进行中的优化：中断优化会话、停止订阅，源会话状态回 idle（版本栈保留）。
 * 多轮迭代中途取消：设置 abort flag，后续轮不再执行；已成功版本入栈保留。
 */
export function cancelPromptOptimize(sourceSessionId: string): void {
  const manager = sessionStoreManager.getState()
  const srcStore = manager.stores.get(sourceSessionId)
  const po = srcStore?.getState().promptOptimize

  // 先设 abort flag，停止链式迭代与超时/settle
  activeRuns.get(sourceSessionId)?.()

  if (po?.optimizeSessionId) {
    const optStore = manager.stores.get(po.optimizeSessionId)
    void optStore?.getState().interrupt().catch(() => undefined)
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
    [store],
  )

  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_PREVIEW)
}
