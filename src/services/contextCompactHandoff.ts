/**
 * 压缩交接（Compact Handoff）
 *
 * 把一个上下文已膨胀的会话「压缩成结构化交接简报，并在新会话中继续」的一键编排：
 *
 * 1. 加载源会话完整原文（loadConversationMessages，按引擎分流，不受前端压缩影响）
 * 2. packToFile 全文落盘到 .polaris-handoff/ —— 作为回溯存档（简报负责"精"，存档负责"全"）
 * 3. 创建静默压缩会话，驱动指定 agent 阅读存档文件并产出简报
 *    （agent 通过 Read 工具自行分段读取，天然规避「原文超模型窗口」的死锁）
 * 4. 提取简报文本，销毁压缩会话
 * 5. 创建新工作会话，简报 + 回溯引用预填输入框（可编辑，用户确认后作为首条消息发出）
 *
 * 三个角色：源会话（被压缩）/ 压缩会话（静默，agent+profile+model 可选）/ 新会话（继续工作）。
 * 压缩会话经 SendMessageOptions.runtimeOverride 指定 agent，不污染全局状态栏配置。
 */

import i18n from 'i18next'
import { createLogger } from '@/utils/logger'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { packToFile } from './conversationPackager'
import { loadConversationMessages } from './sessionHandoff'
import { isAssistantMessage } from '@/types/chat'
import type { ConversationStoreInstance } from '@/stores/conversationStore/createConversationStore'
import { normalizeEngineId } from '@/utils/engineDisplay'

const log = createLogger('ContextCompactHandoff')

/** 压缩会话最长等待时间：超时视为失败并中断（阅读长存档 + 产出简报可能较久） */
const COMPACT_TIMEOUT_MS = 15 * 60 * 1000

export type CompactHandoffStage = 'loading' | 'packing' | 'compacting' | 'creating'

export interface CompactHandoffParams {
  /** 源会话 ID */
  sessionId: string
  /** 压缩会话配置 */
  compact: {
    /** 用哪个 AI 引擎来压缩（claude-code / codex / simple-ai / mimo；空 = 沿用源会话引擎） */
    engineId?: string
    /** 压缩会话绑定的模型 Profile（空 = 跟随全局默认） */
    modelProfileId?: string
    /** 压缩会话绑定的模型（空 = 跟随默认） */
    model?: string
    /** 简报产出要求（可编辑部分；文件阅读指令由本服务自动前置） */
    instruction: string
  }
  /** 新工作会话配置 */
  newSession: {
    /** 新会话使用哪个 AI 引擎（空 = 沿用源会话引擎） */
    engineId?: string
  }
  /** 阶段回调（驱动面板进度展示） */
  onStage?: (stage: CompactHandoffStage) => void
  /** 取消信号：中断压缩会话并清理 */
  signal?: AbortSignal
}

export interface CompactHandoffResult {
  ok: boolean
  newSessionId?: string
  /** 最终简报全文（含回溯引用）；供任务 store / 通知回显 */
  briefing?: string
  error?: string
}

/** 默认简报产出要求（面板预填，用户可编辑） */
export function getDefaultCompactInstruction(): string {
  return i18n.t('chat:compactHandoff.defaultInstruction')
}

/**
 * 执行压缩交接。返回后新会话已激活、简报已预填输入框。
 */
export async function compactAndHandoff(params: CompactHandoffParams): Promise<CompactHandoffResult> {
  const { sessionId, compact, newSession, onStage, signal } = params
  const manager = sessionStoreManager.getState()
  const meta = manager.sessionMetadata.get(sessionId)
  const store = manager.stores.get(sessionId)?.getState()

  if (!meta || !store) {
    return { ok: false, error: i18n.t('chat:handoff.reasonNoSession') }
  }
  const workspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === meta.workspaceId)
  if (!workspace?.path) {
    return { ok: false, error: i18n.t('chat:handoff.reasonNoWorkspace') }
  }

  const sourceEngineId = normalizeEngineId(meta.engineId)
  const conversationId = store.conversationId ?? ''
  let compactSessionId: string | null = null

  try {
    // 1. 加载源会话完整原文
    onStage?.('loading')
    const fallbackMessages = [...store.getPersistableMessages(), ...(store.archivedMessages ?? [])]
    const messages = await loadConversationMessages(sourceEngineId, conversationId, fallbackMessages)
    if (messages.length === 0) {
      return { ok: false, error: i18n.t('chat:handoff.emptyContent') }
    }
    throwIfAborted(signal)

    // 2. 全文落盘（回溯存档 + 压缩 agent 的阅读来源）
    onStage?.('packing')
    const { fileRef } = await packToFile(messages, meta.title, conversationId || sessionId, workspace.path)
    log.info('压缩交接：源会话已存档', { absPath: fileRef.absPath, messageCount: messages.length })
    throwIfAborted(signal)

    // 3. 静默压缩会话：驱动所选引擎阅读存档并产出简报
    onStage?.('compacting')
    compactSessionId = sessionStoreManager.getState().createSession({
      type: 'project',
      workspaceId: meta.workspaceId!,
      title: i18n.t('chat:compactHandoff.compactSessionTitle', { title: meta.title }),
      engineId: normalizeEngineId(compact.engineId || sourceEngineId),
      silentMode: true,
      modelProfileId: compact.modelProfileId || undefined,
      model: compact.model || undefined,
    })
    const compactStore = sessionStoreManager.getState().stores.get(compactSessionId)
    if (!compactStore) {
      return { ok: false, error: i18n.t('chat:compactHandoff.failCreateCompactSession') }
    }

    // 文件阅读指令固定前置（存档可能很大，明确允许分段多次读取），
    // 产出要求（instruction）来自面板，用户可编辑。
    const prompt = `${i18n.t('chat:compactHandoff.readInstruction', { ref: `@${fileRef.relPath}` })}\n\n${compact.instruction}`
    await compactStore.getState().sendMessage(prompt, workspace.path, undefined, {
      // 静默会话不可见，任何交互式权限等待都会永久挂起 —— 强制 bypass
      runtimeOverride: {
        permissionMode: 'bypassPermissions',
      },
    })
    if (compactStore.getState().error) {
      return { ok: false, error: compactStore.getState().error ?? i18n.t('chat:compactHandoff.failToast') }
    }

    await waitForIdle(compactStore, signal)

    const stateAfter = compactStore.getState()
    if (stateAfter.error) {
      return { ok: false, error: stateAfter.error }
    }
    const briefingRaw = extractLastAssistantText(compactStore)
    const briefing = sanitizeBriefing(briefingRaw)
    if (!briefing) {
      return { ok: false, error: i18n.t('chat:compactHandoff.emptyBriefing') }
    }

    // 4. 压缩会话用完即毁
    sessionStoreManager.getState().deleteSession(compactSessionId)
    compactSessionId = null
    throwIfAborted(signal)

    // 5. 新工作会话：简报作为「待发送上下文」挂到新会话（不塞输入框），
    //    输入框留给用户写自己的话；发送时简报作为一次性系统上下文随之带出。
    onStage?.('creating')
    const newSessionId = sessionStoreManager.getState().createSession({
      type: 'project',
      workspaceId: meta.workspaceId!,
      title: i18n.t('chat:compactHandoff.newSessionTitle', { title: meta.title }),
      engineId: normalizeEngineId(newSession.engineId || sourceEngineId),
    })

    const backtrack = i18n.t('chat:compactHandoff.backtrackNote', {
      ref: `@${fileRef.relPath}`,
      title: meta.title,
    })
    const fullBriefing = `${briefing}\n\n${backtrack}`
    sessionStoreManager.getState().stores.get(newSessionId)?.getState()
      .setPendingBriefing(fullBriefing)

    log.info('压缩交接完成', { sourceSessionId: sessionId, newSessionId, briefingLength: briefing.length })
    return { ok: true, newSessionId, briefing: fullBriefing }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    log.error('压缩交接失败', err, { sessionId })
    return { ok: false, error: err.message }
  } finally {
    // 任何路径（失败/取消）都不留下静默压缩会话
    if (compactSessionId) {
      const leftover = sessionStoreManager.getState().stores.get(compactSessionId)
      if (leftover?.getState().isStreaming) {
        void leftover.getState().interrupt()
      }
      sessionStoreManager.getState().deleteSession(compactSessionId)
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error(i18n.t('chat:compactHandoff.cancelled'))
  }
}

/**
 * 等待压缩会话流式结束（isStreaming 下降沿）。
 * 支持取消（中断会话）与超时兜底。
 */
function waitForIdle(store: ConversationStoreInstance, signal?: AbortSignal): Promise<void> {
  if (!store.getState().isStreaming) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {}
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      void store.getState().interrupt()
      reject(new Error(i18n.t('chat:compactHandoff.cancelled')))
    }

    unsubscribe = store.subscribe((state) => {
      if (!state.isStreaming) {
        cleanup()
        resolve()
      }
    })
    timer = setTimeout(() => {
      cleanup()
      void store.getState().interrupt()
      reject(new Error(i18n.t('chat:compactHandoff.timeout')))
    }, COMPACT_TIMEOUT_MS)
    signal?.addEventListener('abort', onAbort)

    // 订阅建立前已经结束的竞态兜底
    if (!store.getState().isStreaming) {
      cleanup()
      resolve()
    }
  })
}

/** 提取压缩会话最后一条 assistant 消息的全部文本块（即简报正文） */
function extractLastAssistantText(store: ConversationStoreInstance): string {
  const { messages } = store.getState()
  const lastAssistant = [...messages].reverse().find(isAssistantMessage)
  if (!lastAssistant?.blocks) return ''
  return lastAssistant.blocks
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.content)
    .join('\n\n')
    .trim()
}

/**
 * 简报后处理：去除模型爱加的开场白/结束语（提示词已硬约束，这里是兜底）。
 *
 * - 若正文含 markdown 标题（## / #），截掉第一个标题之前的所有内容
 *   （开场白如「以下是我的分析结果：」一定在首个 `## 任务目标` 之前）
 * - 去除包裹整段的 ```markdown fenced 代码块外壳
 * - 首尾空白归一
 */
export function sanitizeBriefing(raw: string): string {
  let text = raw.trim()
  if (!text) return ''

  // 剥除整体 fenced code 外壳（```markdown ... ``` 或 ``` ... ```）
  const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/)
  if (fenced) text = fenced[1].trim()

  // 截到第一个 markdown 标题（去掉标题前的开场白）
  const headingIdx = text.search(/^#{1,3}\s+/m)
  if (headingIdx > 0) {
    text = text.slice(headingIdx).trim()
  }
  return text
}
