/**
 * 派发任务服务
 *
 * 处理 polaris-dispatch MCP（dispatch_task 工具）发起的会话间任务委派：
 * 后端 ask_listener 收到 dispatch 帧后 emit `dispatch-task-request`，本服务
 * 监听该事件并：
 *   1. 创建静默后台会话（dispatch-{depth}-{id}，不抢占当前 Tab）
 *   2. 通过 start_chat 驱动引擎执行任务（复用 scheduler 的执行路径）
 *   3. 通过 eventRouter 把事件路由到该会话 Store（后台胶囊/完成通知复用现有机制）
 *   4. 维护 dispatchStore（来源会话内联卡片的数据源）+ 节流回报最新动态
 *   5. 会话结束时向后端回报状态与结果摘要，并把报告入队待注入来源会话
 *
 * 引擎与工作区默认继承来源会话，派发方也可在工具参数中显式指定。
 */

import { listen, invoke } from '@/services/transport'
import { getEventRouter } from '@/services/eventRouter'
import { sessionStoreManager } from '@/stores/conversationStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useConfigStore } from '@/stores/configStore'
import { useToastStore } from '@/stores/toastStore'
import { useDispatchStore } from '@/stores/dispatchStore'
import { parseEventToLog } from '@/stores/schedulerStoreUtils'
import { resolveEffectiveProfileId } from '@/stores/conversationStore/conversationStoreUtils'
import { getActiveModelProfile } from '@/stores/modelProfileStore'
import type { AIEvent } from '@/ai-runtime'
import type { ChatMessage } from '@/types/chat'
import { createLogger } from '@/utils/logger'
import i18n from '@/i18n'

const log = createLogger('DispatchTask')

/** 最新动态回报到后端注册表的最小间隔（卡片本地更新不受此限制） */
const ACTIVITY_REPORT_INTERVAL_MS = 3000

/** dispatch-task-request 事件负载（与 ask_listener::emit_dispatch_request_event 对齐） */
export interface DispatchTaskRequestEvent {
  dispatchId: string
  /** 目标会话 ID，格式 dispatch-{depth}-{shortid} */
  sessionId: string
  /** 来源会话 ID（可能为空字符串） */
  sourceSessionId?: string | null
  prompt: string
  title?: string | null
  workDir?: string | null
  engineId?: string | null
  /** P2：listener 按 role/provider 解析后的下发字段 */
  role?: string | null
  modelProfileId?: string | null
  model?: string | null
  appendSystemPrompt?: string | null
  permissionMode?: string | null
}

/** dispatch-task-continue 事件负载（续派） */
export interface DispatchTaskContinueEvent {
  dispatchId: string
  sessionId: string
  prompt: string
}

/** 回报执行状态到后端注册表（失败仅记日志，不影响会话运行） */
async function reportStatus(
  dispatchId: string,
  status: 'running' | 'completed' | 'failed',
  extra?: { summary?: string; latestActivity?: string; conversationId?: string }
): Promise<void> {
  try {
    await invoke('dispatch_report_status', {
      dispatchId,
      status,
      summary: extra?.summary,
      latestActivity: extra?.latestActivity,
      conversationId: extra?.conversationId,
    })
  } catch (e) {
    log.warn('回报派发状态失败', { dispatchId, status, error: String(e) })
  }
}

/** 从会话消息中提取最后一条助手回复文本，作为结果摘要 */
function extractSummary(sessionId: string): string | undefined {
  const store = sessionStoreManager.getState().stores.get(sessionId)
  if (!store) return undefined
  const messages: ChatMessage[] = store.getState().messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type !== 'assistant') continue
    if (typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content
    }
    const text = (msg.blocks || [])
      .filter((b): b is { type: 'text'; content: string } => b.type === 'text')
      .map((b) => b.content)
      .join('\n')
      .trim()
    if (text) return text
  }
  return undefined
}

/** 从 AI 事件提取单行"最新动作"摘要（仅工具边界，text delta 不产生动态） */
function extractActivity(event: Record<string, unknown>): string | undefined {
  const type = event.type as string | undefined
  if (type !== 'tool_call_start' && type !== 'tool_call_end') return undefined
  const entry = parseEventToLog(event)
  return entry?.content
}

/** 解析派发会话的工作区：显式 workDir > 来源会话工作区 > 当前工作区 */
function resolveWorkspace(event: DispatchTaskRequestEvent): {
  workDir: string | undefined
  workspaceId: string | undefined
} {
  if (event.workDir && event.workDir.trim()) {
    return { workDir: event.workDir.trim(), workspaceId: undefined }
  }

  const workspaceState = useWorkspaceStore.getState()
  const sourceSessionId = event.sourceSessionId || ''
  const sourceMeta = sessionStoreManager.getState().sessionMetadata.get(sourceSessionId)
  if (sourceMeta?.workspaceId) {
    const workspace = workspaceState.workspaces.find((w) => w.id === sourceMeta.workspaceId)
    if (workspace) {
      return { workDir: workspace.path, workspaceId: workspace.id }
    }
  }

  const current = workspaceState.getCurrentWorkspace()
  return { workDir: current?.path, workspaceId: current?.id }
}

/** 解析派发会话的引擎：显式 engineId > 来源会话引擎（createSession 内部再兜底全局默认） */
function resolveEngineId(event: DispatchTaskRequestEvent): string | undefined {
  if (event.engineId && event.engineId.trim()) {
    return event.engineId.trim()
  }
  const sourceSessionId = event.sourceSessionId || ''
  return sessionStoreManager.getState().sessionMetadata.get(sourceSessionId)?.engineId
}

/**
 * 解析派发会话的模型 Profile：
 * - "official" 哨兵（显式官方端点）→ 不传 Profile
 * - 显式 id → 直接使用（后端 role/provider 解析产物）
 * - 未指定 → 继承来源会话绑定，降级全局激活 Profile
 * - mimo 引擎不支持 Profile，强制官方端点
 */
function resolveModelProfileId(
  event: DispatchTaskRequestEvent,
  engineId: string | undefined
): string | undefined {
  if (engineId?.startsWith('mimo')) return undefined
  if (event.modelProfileId === 'official') return undefined
  if (event.modelProfileId) return event.modelProfileId
  const sourceSessionId = event.sourceSessionId || ''
  const sourceMeta = sessionStoreManager.getState().sessionMetadata.get(sourceSessionId)
  return resolveEffectiveProfileId(
    sourceMeta?.modelProfileId,
    undefined,
    getActiveModelProfile()?.id
  )
}

/**
 * 为派发会话挂载事件路由 handler（首次派发与续派共用）。
 *
 * 职责：事件转发到会话 Store、维护 dispatchStore 动态、节流回报后端、
 * session_end/error 时回报终态 + 报告入队 + 自注销。
 */
export function attachDispatchSessionHandler(dispatchId: string, sessionId: string): () => void {
  const router = getEventRouter()
  let lastActivityReportAt = 0

  const unsubscribe = router.register(sessionId, (payload: unknown) => {
    const aiEvent = payload as AIEvent

    sessionStoreManager.getState().dispatchEvent({
      ...aiEvent,
      _routeSessionId: sessionId,
    } as AIEvent & { _routeSessionId: string })

    const dispatchStore = useDispatchStore.getState()

    // 最新动态：本地即时更新，后端节流回报
    const activity = extractActivity(aiEvent as unknown as Record<string, unknown>)
    if (activity) {
      dispatchStore.updateTask(dispatchId, { latestActivity: activity })
      const now = Date.now()
      if (now - lastActivityReportAt >= ACTIVITY_REPORT_INTERVAL_MS) {
        lastActivityReportAt = now
        void reportStatus(dispatchId, 'running', { latestActivity: activity })
      }
    }

    if (aiEvent.type === 'session_end') {
      // reason 正常为 'completed' | 'aborted'；中断/异常结束都视为未完成
      const reason = (aiEvent as { reason?: string }).reason
      const failed = reason !== undefined && reason !== 'completed'
      const summary = extractSummary(sessionId)
      const status = failed ? 'failed' : 'completed'
      dispatchStore.finishTask(dispatchId, status, summary, failed ? reason : undefined)
      void reportStatus(dispatchId, status, { summary })
      unsubscribe()
    } else if (aiEvent.type === 'error') {
      const summary = extractSummary(sessionId)
      const errorText = (aiEvent as { error?: string; message?: string }).error
        || (aiEvent as { message?: string }).message
      dispatchStore.finishTask(dispatchId, 'failed', summary, errorText)
      void reportStatus(dispatchId, 'failed', { summary })
      unsubscribe()
    }
  })

  return unsubscribe
}

/** 处理单个派发请求：创建静默会话 → 注册事件路由 → 启动引擎 → 回报状态 */
export async function handleDispatchTaskRequest(
  event: DispatchTaskRequestEvent,
  options?: { skipPolicyCheck?: boolean }
): Promise<void> {
  const { dispatchId, sessionId, prompt } = event
  if (!dispatchId || !sessionId || !prompt?.trim()) {
    log.warn('派发请求缺少必要字段，忽略', { dispatchId, sessionId })
    return
  }

  const title = event.title?.trim() || i18n.t('chat:dispatch.defaultTitle', '派发任务')

  // 派发策略：ask 模式下每次 AI 派发需用户确认（用户手动派发跳过）
  if (!options?.skipPolicyCheck && getDispatchPolicy() === 'ask') {
    const allowed = window.confirm(
      i18n.t('chat:dispatch.confirmMessage', {
        defaultValue: 'AI 请求派发后台任务「{{title}}」，是否允许执行？',
        title,
        interpolation: { escapeValue: false },
      })
    )
    if (!allowed) {
      log.info('用户拒绝派发', { dispatchId })
      void reportStatus(dispatchId, 'failed', {
        summary: i18n.t('chat:dispatch.userDeclined', '用户拒绝了本次派发'),
      })
      return
    }
  }

  const { workDir, workspaceId } = resolveWorkspace(event)
  const engineId = resolveEngineId(event)

  log.info('收到派发请求', { dispatchId, sessionId, title, workDir, engineId, role: event.role })

  const manager = sessionStoreManager.getState()

  // 静默创建后台会话（不抢占当前 Tab）；加入 background 列表以获得
  // 完成 Toast/通知（dispatchEvent 的 session_end 分支）与 LRU 驱逐保护
  manager.createSession({
    id: sessionId,
    type: workspaceId ? 'project' : 'free',
    workspaceId,
    title,
    engineId,
    silentMode: true,
  })
  sessionStoreManager.getState().addToBackground(sessionId)

  useDispatchStore.getState().upsertTask({
    dispatchId,
    sessionId,
    sourceSessionId: event.sourceSessionId || '',
    title,
    status: 'pending',
    engineId,
    model: event.model || undefined,
    role: event.role || undefined,
    workDir,
    startedAt: Date.now(),
  })

  const router = getEventRouter()
  await router.initialize()
  const unsubscribe = attachDispatchSessionHandler(dispatchId, sessionId)

  try {
    const conversationId = await invoke<string>('start_chat', {
      message: prompt,
      options: {
        workDir,
        contextId: sessionId,
        engineId,
        enableMcpTools: true,
        modelProfileId: resolveModelProfileId(event, engineId),
        model: event.model || undefined,
        appendSystemPrompt: event.appendSystemPrompt || undefined,
        permissionMode: event.permissionMode || undefined,
      },
    })
    log.info('派发会话已启动', { dispatchId, sessionId, conversationId })
    useDispatchStore.getState().updateTask(dispatchId, { status: 'running' })
    void reportStatus(dispatchId, 'running', { conversationId })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log.error('派发会话启动失败', e instanceof Error ? e : new Error(message), { dispatchId })
    unsubscribe()
    useDispatchStore.getState().finishTask(dispatchId, 'failed', message, message)
    void reportStatus(dispatchId, 'failed', { summary: message })
  }
}

/** 读取派发策略（auto | ask），配置缺失按 auto */
function getDispatchPolicy(): 'auto' | 'ask' {
  try {
    const config = useConfigStore.getState().config as
      | { dispatch?: { policy?: string } }
      | null
    return config?.dispatch?.policy === 'ask' ? 'ask' : 'auto'
  } catch {
    return 'auto'
  }
}

/**
 * 安装派发请求监听（App 级常驻，useAppEvents 中调用）
 * 返回清理函数。
 */
export function initDispatchTaskListener(): () => void {
  const unlistenRequest = listen<DispatchTaskRequestEvent>(
    'dispatch-task-request',
    (event) => {
      void handleDispatchTaskRequest(event)
    }
  )

  // AI 侧续派（continue_dispatched_task 工具）：backend 已置 running 并携带
  // 注册表里的 conversationId（会话被驱逐/重启后的恢复凭据）
  const unlistenContinue = listen<DispatchTaskContinueEvent & { conversationId?: string | null }>(
    'dispatch-task-continue',
    (event) => {
      void (async () => {
        const dispatchStore = useDispatchStore.getState()
        // 本地无视图（应用重启）：从事件负载合成最小视图，让续派与卡片可用
        if (!dispatchStore.getTask(event.dispatchId)) {
          dispatchStore.upsertTask({
            dispatchId: event.dispatchId,
            sessionId: event.sessionId,
            sourceSessionId: '',
            title: event.sessionId,
            status: 'completed',
            startedAt: Date.now(),
          })
        }
        const ok = await continueDispatchedTask(event.dispatchId, event.prompt, {
          conversationId: event.conversationId || undefined,
        })
        if (!ok) {
          void reportStatus(event.dispatchId, 'failed', {
            summary: '续派失败：后台会话不可恢复（conversationId 缺失或任务执行中）',
          })
        }
      })()
    }
  )

  return () => {
    unlistenRequest.then((unlisten) => unlisten())
    unlistenContinue.then((unlisten) => unlisten())
  }
}

// ============================================================================
// 用户手动派发（/dispatch 斜杠命令）
// ============================================================================

export interface ParsedDispatchCommand {
  role?: string
  prompt: string
}

/**
 * 解析 /dispatch 命令文本。语法：`/dispatch [@角色] 任务内容`
 * 非 /dispatch 命令返回 null；命令格式但缺任务内容返回 prompt 为空串。
 */
export function parseDispatchSlashCommand(text: string): ParsedDispatchCommand | null {
  if (!text.startsWith('/dispatch')) return null
  const rest = text.slice('/dispatch'.length)
  // 必须是命令边界（结尾或空白），避免误吞 /dispatchxxx
  if (rest && !/^\s/.test(rest)) return null

  let remaining = rest.trim()
  let role: string | undefined
  if (remaining.startsWith('@')) {
    const spaceIdx = remaining.search(/\s/)
    if (spaceIdx > 0) {
      role = remaining.slice(1, spaceIdx)
      remaining = remaining.slice(spaceIdx).trim()
    } else {
      role = remaining.slice(1)
      remaining = ''
    }
  }
  return { role: role || undefined, prompt: remaining }
}

/**
 * 用户手动派发：调后端注册（共享深度/并发/role 解析）→ 本地直接执行。
 * 后端命令不 emit 事件，避免与 dispatch-task-request 监听器双执行。
 * 返回 true 表示派发已受理。
 */
export async function dispatchFromUser(parsed: ParsedDispatchCommand): Promise<boolean> {
  const toast = useToastStore.getState()
  if (!parsed.prompt.trim()) {
    toast.info(
      i18n.t('chat:dispatch.usageTitle', '用法'),
      i18n.t('chat:dispatch.usageDetail', '/dispatch [@角色] 任务内容')
    )
    return false
  }

  const sourceSessionId = sessionStoreManager.getState().activeSessionId || ''
  try {
    const task = await invoke<DispatchTaskRequestEvent>('dispatch_create_task', {
      prompt: parsed.prompt,
      role: parsed.role,
      sourceSessionId,
    })
    // DispatchedTask（serde camelCase）与 DispatchTaskRequestEvent 字段兼容
    await handleDispatchTaskRequest(task, { skipPolicyCheck: true })
    toast.info(
      i18n.t('chat:dispatch.dispatchedTitle', '已派发'),
      i18n.t('chat:dispatch.dispatchedDetail', {
        defaultValue: '任务「{{title}}」已在后台会话执行',
        title: task.title || parsed.prompt.slice(0, 24),
        interpolation: { escapeValue: false },
      })
    )
    return true
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    toast.error(i18n.t('chat:dispatch.dispatchFailed', '派发失败'), message)
    return false
  }
}

// ============================================================================
// 卡片动作（DispatchTaskCard 调用，保持卡片为哑组件）
// ============================================================================

/** 打开派发会话（静默转可见并切换） */
export function openDispatchSession(sessionId: string): void {
  sessionStoreManager.getState().makeSessionVisible(sessionId)
}

/** 中断执行中的派发任务 */
export async function interruptDispatchedTask(dispatchId: string): Promise<void> {
  const task = useDispatchStore.getState().getTask(dispatchId)
  if (!task) return
  const store = sessionStoreManager.getState().stores.get(task.sessionId)
  const conversationId = store?.getState().conversationId
  if (!conversationId) {
    log.warn('中断失败：派发会话无 conversationId', { dispatchId })
    return
  }
  const engineId = sessionStoreManager.getState().sessionMetadata.get(task.sessionId)?.engineId
  try {
    await invoke('interrupt_chat', { sessionId: conversationId, engineId })
    log.info('派发任务已中断', { dispatchId })
  } catch (e) {
    log.error('中断派发任务失败', e instanceof Error ? e : new Error(String(e)), { dispatchId })
  }
}

/**
 * 对已结束的派发任务追加指令（同一后台会话，上下文保留）。
 * 卡片"追加指令"与 AI 侧 continue_dispatched_task 共用此路径。
 * 返回 false 表示无法续派（会话丢失/仍在执行）。
 */
export async function continueDispatchedTask(
  dispatchId: string,
  prompt: string,
  options?: { conversationId?: string }
): Promise<boolean> {
  const trimmed = prompt.trim()
  if (!trimmed) return false

  const dispatchStore = useDispatchStore.getState()
  const task = dispatchStore.getTask(dispatchId)
  if (!task) {
    log.warn('续派失败：本地无任务视图', { dispatchId })
    return false
  }
  if (task.status === 'running' || task.status === 'pending') {
    log.warn('续派拒绝：任务仍在执行', { dispatchId })
    return false
  }

  const manager = sessionStoreManager.getState()
  let store = manager.stores.get(task.sessionId)
  let conversationId = store?.getState().conversationId || options?.conversationId

  // 恢复路径：会话被 LRU 驱逐/应用重启后凭注册表 conversationId 重建静默会话
  if (!store && conversationId) {
    manager.createSession({
      id: task.sessionId,
      type: 'free',
      title: task.title,
      engineId: task.engineId,
      silentMode: true,
    })
    store = sessionStoreManager.getState().stores.get(task.sessionId)
    store?.setState({ conversationId })
    log.info('派发会话已恢复（历史未加载）', { dispatchId, sessionId: task.sessionId })
  }

  if (!store || !conversationId) {
    log.warn('续派失败：会话与 conversationId 均不可用', { dispatchId })
    return false
  }

  sessionStoreManager.getState().addToBackground(task.sessionId)
  useDispatchStore.getState().updateTask(dispatchId, {
    status: 'running',
    endedAt: undefined,
    latestActivity: undefined,
    error: undefined,
  })
  const unsubscribe = attachDispatchSessionHandler(dispatchId, task.sessionId)

  try {
    await invoke('continue_chat', {
      sessionId: conversationId,
      message: trimmed,
      options: {
        workDir: task.workDir,
        contextId: task.sessionId,
        engineId: task.engineId,
        enableMcpTools: true,
      },
    })
    void reportStatus(dispatchId, 'running', { conversationId })
    log.info('派发任务续派成功', { dispatchId })
    return true
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log.error('续派失败', e instanceof Error ? e : new Error(message), { dispatchId })
    unsubscribe()
    useDispatchStore.getState().finishTask(dispatchId, 'failed', message, message)
    void reportStatus(dispatchId, 'failed', { summary: message })
    return false
  }
}

/**
 * 一键交办：把派发结果作为用户消息发给来源会话的 AI 处理。
 * 返回 false 表示来源会话不可用或正在流式输出。
 */
export async function handOffResultToSource(dispatchId: string): Promise<boolean> {
  const task = useDispatchStore.getState().getTask(dispatchId)
  if (!task?.sourceSessionId) return false
  const store = sessionStoreManager.getState().stores.get(task.sourceSessionId)
  if (!store || store.getState().isStreaming) return false

  const statusText = task.status === 'completed'
    ? i18n.t('chat:dispatch.reportDone', '已完成')
    : i18n.t('chat:dispatch.reportFailed', '失败')
  const message = i18n.t('chat:dispatch.handOffMessage', {
    defaultValue: '后台派发任务「{{title}}」{{status}}，请处理其结果：\n{{summary}}',
    title: task.title,
    status: statusText,
    summary: task.summary || task.error || '',
    interpolation: { escapeValue: false },
  })

  // 报告已随消息显式带出，移除本任务的待注入报告避免重复
  useDispatchStore.getState().removeReport(task.sourceSessionId, dispatchId)
  sessionStoreManager.getState().makeSessionVisible(task.sourceSessionId)
  await store.getState().sendMessage(message)
  return true
}
