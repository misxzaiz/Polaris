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
import { waitKernelSessionStreamEnd } from '@/session-v2/hooks/useKernelSessionState'
import { isAssistantMessage } from '@/types/chat'
import type { ConversationStoreInstance } from '@/stores/conversationStore/createConversationStore'
import { normalizeEngineId } from '@/utils/engineDisplay'

const log = createLogger('ContextCompactHandoff')

/** 压缩会话最长等待时间：超时视为失败并中断（阅读长存档 + 产出简报可能较久） */
const COMPACT_TIMEOUT_MS = 15 * 60 * 1000

export type CompactHandoffStage = 'loading' | 'packing' | 'compacting' | 'creating'

/**
 * 交接产物去向：
 * - `newSession`：在 Polaris 内创建新会话，简报挂为 pendingBriefing（默认，原有行为）
 * - `copyPrompt`：不创建新会话，仅把简报组装成可复制文本经结果返回，
 *   便于交给任意其他 AI（不一定是 Polaris）继续实施
 */
export type HandoffMode = 'newSession' | 'copyPrompt'

export interface CompactHandoffParams {
  /** 源会话 ID */
  sessionId: string
  /** 交接产物去向，默认 newSession */
  mode?: HandoffMode
  /** 压缩会话配置 */
  compact: {
    /** 用哪个 AI 引擎来压缩（claude-code / simple-ai；空 = 沿用源会话引擎） */
    engineId?: string
    /** 压缩会话绑定的模型 Profile（空 = 跟随全局默认） */
    modelProfileId?: string
    /** 压缩会话绑定的模型（空 = 跟随默认） */
    model?: string
    /** 简报产出要求（可编辑部分；文件阅读指令由本服务自动前置） */
    instruction: string
  }
  /** 新工作会话配置（仅 mode=newSession 时必填） */
  newSession?: {
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
  const { sessionId, compact, onStage, signal } = params
  const mode: HandoffMode = params.mode ?? 'newSession'
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

    await waitForIdle(compactSessionId, signal)

    const stateAfter = compactStore.getState()
    if (stateAfter.error) {
      return { ok: false, error: stateAfter.error }
    }

    // 提取简报：优先读已归档的 messages；若 finishMessage 尚未把 currentMessage
    // 归档（waitForIdle 以 kernel state 下降沿为准，与 session_end → finishMessage
    // 是两条独立事件流，到达顺序无保证），兜底从 currentMessage 提取并主动 finish。
    // 根因：旧实现只读 messages，竞态窗口内 assistant 正文仍滞留在 currentMessage，
    // 直接报「未产出简报内容」（emptyBriefing）。
    let briefingRaw = extractLastAssistantText(compactStore)
    if (!briefingRaw) {
      const cur = compactStore.getState().currentMessage
      if (cur?.blocks?.length) {
        briefingRaw = cur.blocks
          .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
          .map((b) => b.content)
          .join('\n\n')
          .trim()
        log.info('压缩交接：简报正文滞留 currentMessage，已兜底提取（finishMessage 未及时归档）')
      }
    }
    const briefing = sanitizeBriefing(briefingRaw)
    if (!briefing) {
      return { ok: false, error: i18n.t('chat:compactHandoff.emptyBriefing') }
    }

    // 压缩会话用完即毁
    sessionStoreManager.getState().deleteSession(compactSessionId)
    compactSessionId = null
    throwIfAborted(signal)

    // mode=copyPrompt：不创建新会话，仅组装可复制文本返回。
    // 简报自带回溯引用（指向存档文件），便于用户交给任意 AI 继续实施。
    if (mode === 'copyPrompt') {
      const backtrack = i18n.t('chat:compactHandoff.backtrackNote', {
        ref: `@${fileRef.relPath}`,
        title: meta.title,
      })
      const fullBriefing = `${briefing}\n\n${backtrack}`
      log.info('压缩交接完成（copyPrompt 模式）', { sourceSessionId: sessionId, briefingLength: fullBriefing.length })
      return { ok: true, briefing: fullBriefing }
    }

    // mode=newSession（默认）：创建新工作会话，简报作为「待发送上下文」挂到新会话
    // （不塞输入框），输入框留给用户写自己的话；发送时简报作为一次性系统上下文带出。
    const newSession = params.newSession ?? {}
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

    log.info('压缩交接完成', { sourceSessionId: sessionId, newSessionId, briefingLength: fullBriefing.length })
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
 * 等待压缩会话流式结束（后端状态 running → idle 下降沿）。
 * 支持取消（中断会话）与超时兜底。
 *
 * requireRunEvidence（2026-11-06 空窗竞态修复）：sendMessage dispatch 返回后、
 * claude-code 等 CLI 引擎产出首个事件前有秒级空窗，后端 lifecycle 事件日志
 * 尚空（session_start 由首事件补写），此时查询得 idle 并非「已结束」而是
 * 「尚未开始」——必须先观测到 running 才认后续下降沿，否则空简报误报 +
 * finally 掐死刚起步的压缩运行。详见 plans/compact-handoff-pre-start-race-fix.md。
 */
function waitForIdle(sessionId: string, signal?: AbortSignal): Promise<void> {
  return waitKernelSessionStreamEnd(sessionId, {
    timeoutMs: COMPACT_TIMEOUT_MS,
    signal,
    requireRunEvidence: true,
  }).catch(async (err) => {
    // 超时/取消：中断压缩会话
    const store = sessionStoreManager.getState().stores.get(sessionId)
    if (store?.getState().isStreaming) {
      void store.getState().interrupt()
    }
    throw err instanceof Error ? err : new Error(String(err))
  })
}

/** 提取压缩会话最后一条 assistant 消息的全部文本块（即简报正文） */
function extractLastAssistantText(store: ConversationStoreInstance): string {
  const { messages, currentMessage } = store.getState()
  const lastAssistant = [...messages].reverse().find(isAssistantMessage)
  if (!lastAssistant?.blocks) {
    log.warn('extractLastAssistantText：messages 中无 assistant 消息', {
      messageCount: messages.length,
      hasCurrentMessage: !!currentMessage,
      currentBlocks: currentMessage?.blocks?.length ?? 0,
    })
    return ''
  }
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

  // 防御：后处理后若变空（如整体是空 fenced 块），回退原文，避免把有效简报杀成空
  if (!text) return raw.trim()
  return text
}
