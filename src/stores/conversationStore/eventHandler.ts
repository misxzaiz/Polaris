/**
 * AI 事件处理器
 *
 * 处理单个会话的 AI 事件，所有事件都应该已经包含 sessionId
 */

import { generateUUID } from '@/utils/uuid'
import { createLogger } from '@/utils/logger'
import type { AIEvent } from '@/ai-runtime'
import { isEditTool, extractEditDiff } from '@/utils/diffExtractor'
import { parseApplyPatch } from '@/utils/patchParser'
import {
  extractHtmlCandidate,
  guessTitle,
  splitAroundHtml,
  findLastTextBlockIndex,
} from '@/utils/htmlCardDetect'
import type {
  PluginCardBlock,
  ChatMessage,
  TaskBoardItem,
  ToolCallBlock,
  ContentBlock,
  ArtifactPreviewBlock,
} from '@/types'
import { chatCardRegistry } from '@/plugin-system/chatCardRegistry'
import type { ConversationStore } from './types'
import { voiceNotificationService } from '@/services/voiceNotificationService'
import { sessionStoreManager } from './sessionStoreManager'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useCliInfoStore } from '@/stores/cliInfoStore'
import { dialogStorageService } from '@/services/dialogStorage'
import { consumeCapUiDispatch } from '@/services/uiDispatchService'
import { getTracker, resetTracker } from '@/services/streamRateTracker'
import { useSessionConfig } from '@/stores/sessionConfigStore'

const log = createLogger('EventHandler')

/**
 * HTML 卡片渲染当前是否开启（会话级开关 @sessionConfigStore.htmlCardRender，默认关）。
 *
 * 开启时：session_end 对本轮回复的最后一段 text 做 HTML 检测，命中则替换为
 * artifact_preview 块（inlineToBody 直出，复用现有 ArtifactPreviewRenderer 渲染）。
 * 关闭时：检测层完全不参与，行为与既有完全一致。
 */
function isHtmlCardRenderEnabled(): boolean {
  return useSessionConfig.getState().config.htmlCardRender ?? false
}

/**
 * 记录一个流式增量到速率跟踪器，并按节流返回快照。
 *
 * tracker 实例按 sessionId 缓存（模块级 Map，不进 store 状态）；
 * 只有 tracker 判定需要刷新时才 set，避免每 token 一次 store 更新打断渲染。
 * `text` 为增量文本，内部按中英文差异化启发式估算 token 数。
 */
function pushStreamDelta(
  state: ConversationStore,
  set: (partial: Partial<ConversationStore>) => void,
  at: number | undefined,
  text: string,
): void {
  if (!at || !text) return
  const tracker = getTracker(state.sessionId)
  if (tracker.recordDelta(at, text)) {
    set({ streamRate: tracker.snapshot(at) })
  }
}

/** 记录流末 provider 精确输出 token（校正平均速率），需要时刷新快照 */
function pushProviderUsage(
  state: ConversationStore,
  set: (partial: Partial<ConversationStore>) => void,
  outputTokens: number | undefined,
): void {
  const tracker = getTracker(state.sessionId)
  if (!outputTokens || outputTokens <= 0 || tracker.isEmpty()) return
  if (tracker.markProviderUsage(outputTokens)) {
    set({ streamRate: tracker.snapshot() })
  }
}

/**
 * 无 callId 时的工具块回退目标：当前消息中最后一个仍 running 的工具块。
 * 部分引擎（流式 no-callId）只同时存在一个活动工具，tool_call_end / tool_call_update
 * 不携带 callId 时按「最后活动工具」配对；无 running 块时返回空串（与旧行为一致，不更新）。
 */
function fallbackRunningToolId(currentMessage: ConversationStore['currentMessage']): string {
  if (!currentMessage?.blocks) return ''
  for (let i = currentMessage.blocks.length - 1; i >= 0; i--) {
    const b = currentMessage.blocks[i]
    if (b.type === 'tool_call' && b.status === 'running') return b.id
  }
  return ''
}

/**
 * 将本轮回复最后一段文本中的自包含 HTML 提取为卡片块（MVP-A）。
 *
 * 命中时把该 text block 拆为 前文 + artifact_preview + 后文，两侧文字保留；
 * 未命中返回 null（调用方保持原文本渲染）。
 *
 * 返回新的 blocks 数组；无变化时返回 null。
 */
function extractHtmlCardBlocks(blocks: ContentBlock[]): ContentBlock[] | null {
  const lastTextIdx = findLastTextBlockIndex(blocks)
  if (lastTextIdx < 0) return null

  const textBlock = blocks[lastTextIdx]
  // text 块保证非空（findLastTextBlockIndex 已过滤），直接取 content
  const content = (textBlock as Extract<ContentBlock, { type: 'text' }>).content
  const html = extractHtmlCandidate(content)
  if (!html) return null

  const { before, after } = splitAroundHtml(content)
  const newBlocks = blocks.slice(0, lastTextIdx)
  if (before.trim()) newBlocks.push({ type: 'text', content: before })
  newBlocks.push({
    type: 'artifact_preview',
    previewId: generateUUID(),
    title: guessTitle(html),
    contentType: 'html',
    html,
    // AI 输出的完整 HTML 是回复的核心产物 → 正文直出，不进补充卡片
    inlineToBody: true,
  } satisfies ArtifactPreviewBlock)
  if (after.trim()) newBlocks.push({ type: 'text', content: after })

  log.info('[HtmlCard] 检测到完整 HTML，替换为卡片', {
    title: guessTitle(html),
    htmlLen: html.length,
    beforeLen: before.length,
    afterLen: after.length,
  })
  return newBlocks
}

/** 判定是否为任务板工具（TaskCreate/TaskUpdate/TaskList/TaskGet）。
 *  TaskStop/TaskOutput 排除:实测其 task_id 是后台 shell id 空间(如 'b8wcfdfju'),
 *  与任务板数字 id 无关,应保持普通工具块渲染。 */
function isTaskBoardTool(toolName: string): boolean {
  const n = toolName.toLowerCase()
  return n === 'taskcreate' || n === 'taskupdate' || n === 'tasklist' || n === 'taskget'
}

/** 判定是否为交互型工具（ask/form 家族）：后端会独立 emit `question`/`form`
 *  chat-event 渲染专用卡片（AskQuestionCard / FormCard），tool_call 块只会造成
 *  "工具卡 + 交互卡"双面板冗余。命中后跳过普通 tool_call 块的创建与更新。 */
function isInteractiveTool(toolName: string): boolean {
  const n = toolName.toLowerCase()
  return n.includes('ask_user_question') || n.includes('askuserquestion') || n === 'form' || n.includes('__form')
}

/** 判定是否为总线派发工具。
 *
 * 两个 MCP server 都能让 AI 调 cap.ui.*：
 * - `polaris-bus` 暴露 `bus_dispatch`（工具名 `mcp__polaris-bus__bus_dispatch`），
 *   走本进程总线，白名单含 cap.ui.theme / cap.ui.chat / cap.ui.input。
 * - `polaris-dispatch` 暴露 `cap_dispatch`（工具名 `mcp__polaris-dispatch__cap_dispatch`），
 *   走主进程总线，可触达全部 cap.*。
 *
 * 两者参数形状一致 `{ target, payload }`，前端统一按 cap.ui.* 消费。
 * 历史只认 bus_dispatch 导致 cap_dispatch 路径双重断链：能调到 cap.ui.theme
 * 的工具名不被识别，被识别的工具又调不到 cap.ui.theme（bus 侧未注册）。
 * 兼容裸名防引擎变体漂移。 */
function isBusDispatchTool(toolName: string): boolean {
  const n = toolName.toLowerCase()
  return n.endsWith('bus_dispatch') || n.endsWith('cap_dispatch')
}

/** 从 TaskCreate 输入解析任务项(无 id,流式路径延迟到 tool_call_end 用 output 回传 taskId) */
function parseTaskCreateItem(args: Record<string, unknown>): { subject: string; activeForm?: string; description?: string } | null {
  const subject = args.subject as string | undefined
  if (!subject) return null
  return {
    subject,
    activeForm: args.activeForm as string | undefined,
    description: args.description as string | undefined,
  }
}

/** 从 TaskCreate 的 tool_result output 提取真实 taskId。
 *  实测形状为纯文本 "Task #1 created successfully: <subject>"(非 JSON),
 *  从 #(\d+) 提取数字 taskId;TaskUpdate 的 input.taskId 也是该数字字符串。 */
function extractTaskIdFromOutput(output: string): string | null {
  const m = output.match(/#\s*(\d+)/)
  return m ? m[1] : null
}

/** 从 TaskList 输出解析任务项快照。
 *  实测形状为纯文本多行 "#1 [completed] 标题"(非 JSON,939 转录实测 JSON.parse 14/14 全失败),
 *  按行正则提取;TaskUpdate 还会下发 deleted 状态(实测 11 次),对应剔除该项。 */
function parseTaskListOutput(output: string): TaskBoardItem[] | null {
  if (!output) return null
  const items: TaskBoardItem[] = []
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*#\s*(\d+)\s*\[([A-Za-z_]+)\]\s*(.*)$/)
    if (!m) continue
    const rawStatus = m[2]
    let status: TaskBoardItem['status'] = 'pending'
    if (rawStatus === 'completed' || rawStatus === 'in_progress' || rawStatus === 'blocked' || rawStatus === 'stopped') {
      status = rawStatus
    } else if (rawStatus === 'deleted') {
      continue // 已删除项不入板
    }
    const subject = m[3].trim()
    if (!subject) continue
    items.push({ id: m[1], subject, status })
  }
  return items.length > 0 ? items : null
}

/** 会话实际模型集合去重合并（保序）。中转站动态路由时逐轮可能不同（如 glm-5.2 → deepseek-v4-flash） */
function mergeActualModels(
  list: string[] | undefined,
  model: string | undefined,
): string[] | undefined {
  if (!model) return list
  if (list?.includes(model)) return list
  return [...(list ?? []), model]
}

/**
 * 缓存命中率（成本口径 B：cacheRead / (input + cacheRead)），跨域统一口径。
 * 分母为 0 时为 0（无请求数据）；仅在调用方有命中数据时才对外展示。
 */
function computeCacheHitRate(input: number, cacheRead: number): number {
  const denom = input + cacheRead
  return denom > 0 ? cacheRead / denom : 0
}

/**
 * Code Mode 载体判定：blockInput 里带 `tools["server"].tool(...)` 形态的 code
 * 字段（opencode execute 载体工具的唯一形状，普通工具输入不含内嵌 MCP 调用）。
 */
const CODE_MODE_CODE_RE = /\btools\[\s*["'][^"']+["']\s*\]\s*\./

function isCodeModeCarrierInput(blockInput: unknown): blockInput is { code: string } {
  if (!blockInput || typeof blockInput !== 'object') return false
  const code = (blockInput as { code?: unknown }).code
  return typeof code === 'string' && CODE_MODE_CODE_RE.test(code)
}

/**
 * artifact 识别口径：与 PrdPreviewCard.tsx 的 isPreviewArtifact 对齐
 * （artifactType 标记优先；缺标记时按 html+previewId 双字段识别）。
 */
function isArtifactLike(obj: unknown): obj is Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const o = obj as Record<string, unknown>
  return (
    o.artifactType === 'polaris.preview' ||
    (typeof o.html === 'string' && typeof o.previewId === 'string')
  )
}

/**
 * opencode Code Mode artifact 拆包（尽力而为）。
 *
 * 背景：Code Mode 下 tool_call_end.result 是模型代码的 return 值（无 MCP
 * structuredContent 信封）。裸 `return tools[…].preview_html(…)` 时返回值即
 * artifact 本体；聚合返回（多调用 / Promise.allSettled 展开）时 artifact
 * 包在返回对象的一层成员里。这里在返回值自身 + 一层成员（含数组元素、
 * allSettled 的 .value 信封）中回溯第一个 artifact-like 值。
 *
 * 边界：仅一层遍历不递归；未命中返回原解析结果（与无拆包行为一致）。
 */
function unwrapCodeModeArtifact(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed
  if (isArtifactLike(parsed)) return parsed

  const members: unknown[] = []
  if (Array.isArray(parsed)) members.push(...parsed)
  else {
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) members.push(...v)
      else members.push(v)
    }
  }

  for (const m of members) {
    if (isArtifactLike(m)) return m
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      const value = (m as Record<string, unknown>).value
      if (isArtifactLike(value)) return value // Promise.allSettled 形态
    }
  }
  return parsed
}

/**
 * 解析 MCP 工具结果为插件卡片数据。
 *
 * 优先级：
 * 1. structuredContent（MCP 标准结构化结果，如 PRD 预览的 artifact）
 * 2. 字符串结果中的 fenced ```json 块
 * 3. 字符串结果直接 JSON.parse
 * 4. 原始值（字符串/对象）兜底
 * 5. opencode Code Mode 载体（blockInput 含内嵌 MCP 调用的 code）：
 *    在解析结果自身 + 一层成员中拆包 artifact-like 值（仅装饰返回值，不改 1-4 口径）。
 *
 * 解析失败不抛错，返回原始值由卡片组件自行防御。
 */
export function parseCardData(result: unknown, blockInput?: unknown): unknown {
  let parsed: unknown = result

  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>
    if (obj.structuredContent !== undefined) {
      return obj.structuredContent
    }
    parsed = result
  } else if (typeof result === 'string') {
    const fenced = result.match(/```json\s*([\s\S]*?)```/i)
    if (fenced?.[1]) {
      try {
        parsed = JSON.parse(fenced[1].trim())
      } catch {
        // 落到直接 parse
      }
    }
    if (parsed === result) {
      try {
        parsed = JSON.parse(result.trim())
      } catch {
        parsed = result
      }
    }
  }

  // opencode Code Mode 载体：return 值无 structuredContent 信封，尝试拆包 artifact。
  // 非 Code Mode 输入（blockInput 无 code）不进此分支，行为与旧版一致。
  if (isCodeModeCarrierInput(blockInput)) {
    return unwrapCodeModeArtifact(parsed)
  }
  return parsed
}

/**
 * 处理单个会话的 AI 事件
 */
export function handleAIEvent(
  event: AIEvent,
  set: (partial: Partial<ConversationStore>) => void,
  get: () => ConversationStore,
): void {
  const state = get()

  switch (event.type) {
    case 'session_start':
      // 新一轮起点：重置速率跟踪器（计时基准 = session_start 到达时刻）
      resetTracker(state.sessionId, event.receivedAtMs)
      set({
        conversationId: event.sessionId,
        isStreaming: true,
        error: null,
        promptSuggestion: null,
        streamRate: null,
      })
      // 如果事件携带了 engineId，更新会话元数据，确保后续回复使用正确引擎
      if (event.engineId && state.sessionId) {
        const managerState = sessionStoreManager.getState()
        const currentMeta = managerState.sessionMetadata.get(state.sessionId)
        if (currentMeta && currentMeta.engineId !== event.engineId) {
          const newMeta = { ...currentMeta, engineId: event.engineId as any }
          const newMetadata = new Map(managerState.sessionMetadata)
          newMetadata.set(state.sessionId, newMeta)
          sessionStoreManager.setState({ sessionMetadata: newMetadata })
          log.info('会话引擎已更新', { sessionId: state.sessionId, engineId: event.engineId })
        }
      }
      log.info('Session started', { sessionId: event.sessionId })
      break

    case 'session_end': {
      // 标记本轮结束并刷新最终快照（平均速率在此完成 provider 精确值校正）
      const rateTracker = getTracker(state.sessionId)
      rateTracker.markEnd(event.receivedAtMs)
      const finalRate = rateTracker.isEmpty() ? null : rateTracker.snapshot(event.receivedAtMs)

      // HTML 卡片渲染（会话级开关）：结束时对本轮回复做 HTML 卡片检测，命中则把
      // 最后一段 text 替换为 artifact_preview 块（inlineToBody 直出）。必须在
      // finishMessage() 之前,因为 currentMessage 在 finish 后即归档、blocks 不可再改。
      if (isHtmlCardRenderEnabled() && state.currentMessage) {
        const newBlocks = extractHtmlCardBlocks(state.currentMessage.blocks)
        if (newBlocks) {
          state.updateCurrentAssistantMessage(newBlocks)
        }
      }

      state.finishMessage()
      set({
        isStreaming: false,
        progressMessage: null,
        streamRate: finalRate,
      })

      // 归档（轮末整体覆写 JSONL）：内容最完整（富块/附件/表单卡片），
      // 也是历史列表与恢复的数据源。客户端中途关闭时前端不在场，
      // 由后端 turn_persist 兜底把本轮补进归档（只追加比归档更新的消息）。
      saveDialog(get, set)

      // 兜底：后端标记 reason=error 但未单独发 error 事件时（或 error 事件丢失），
      // 给一个可见提示，避免"静默中断无错误信息"。
      // 正常路径下 error 事件先到达，state.error 已被填充原文，此条件不触发。
      // 排除用户主动中断（isInterrupting），避免误报"异常退出"。
      if (event.reason === 'error' && !get().error) {
        if (get().isInterrupting) {
          // 用户主动中断：静默，不显示"异常退出"提示
          log.info('Session end after user interrupt, suppressed error display')
        } else {
          set({ error: 'errors:appError.ai' })
        }
      }

      // 清除主动中断标志（无论什么 reason，session_end 到达即说明本轮结束）
      if (get().isInterrupting) {
        set({ isInterrupting: false })
      }

      // 待发送队列：本轮回复结束 → 自动发送下一条（幂等，内部会检查 isStreaming / 队列空）
      // 防御：历史 mock 未注入队列动作时跳过，避免破坏既有测试
      if (typeof get().dispatchNextPending === 'function') {
        void get().dispatchNextPending()
      }

      log.info('Session ended', {
        sessionId: state.sessionId,
        reason: event.reason,
        isStreaming: false,
      })
      break
    }

    case 'token':
      pushStreamDelta(state, set, event.receivedAtMs, event.value)
      state.appendTextBlock(event.value)
      break

    case 'thinking':
      // thinking 也计入 output_tokens，需参与速率计算
      pushStreamDelta(state, set, event.receivedAtMs, event.content)
      state.appendThinkingBlock(event.content)
      break

    case 'assistant_message':
      // 仅增量计入；isDelta=false 的整块补发与 token/增量重复，会重复计数
      if (event.isDelta) pushStreamDelta(state, set, event.receivedAtMs, event.content)
      state.appendTextBlock(event.content)
      break

    case 'tool_call_start': {
      const toolName = event.tool
      const callId = event.callId || generateUUID()
      // cap.ui 控制界面消费：AI 经 bus_dispatch 调 cap.ui.theme / cap.ui.chat 时，
      // 立即把参数映射到前端 store（themeStore / configStore），界面即时生效。
      // 独立于工具卡渲染（工具块照常创建，展示调用轨迹）。
      if (isBusDispatchTool(toolName)) {
        const { consumed, message } = consumeCapUiDispatch(event.args as Record<string, unknown> | undefined)
        if (consumed) {
          log.info('cap.ui consumed', { tool: toolName, message })
        }
      }
      // 交互型工具（ask/form）→ 由 question/form chat-event 渲染专用卡片，
      // 不创建普通 tool_call block（避免与 AskQuestionCard/FormCard 双面板并存）
      if (isInteractiveTool(toolName)) {
        break
      }
      // Task 家族工具 → 路由到任务板（不创建普通 tool_call block）
      if (isTaskBoardTool(toolName) && event.args) {
        const boardId = state.ensureTaskBoard(callId)
        const lower = toolName.toLowerCase()
        if (lower === 'taskcreate') {
          // TaskCreate 的真实 taskId 由系统分配,在 tool_result output 回传(纯文本 "Task #N"),
          // 此时拿不到 id。先缓存到队列,tool_call_end 用 output 解析 id 后 flush 入板。
          const item = parseTaskCreateItem(event.args)
          if (item) state.queueTaskCreate(boardId, item)
        } else if (lower === 'taskupdate') {
          // TaskUpdate: 从 args 提取 taskId + status，幂等 patch
          const taskId = (event.args.taskId || event.args.task_id) as string | undefined
          const status = event.args.status as TaskBoardItem['status'] | undefined
          if (taskId) {
            state.patchTaskBoardItem(boardId, String(taskId), {
              ...(status ? { status } : {}),
              ...(event.args.subject ? { subject: String(event.args.subject) } : {}),
              ...(event.args.activeForm ? { activeForm: String(event.args.activeForm) } : {}),
            })
          }
        }
        // TaskList 在 tool_call_end 用 output 快照校准
        break
      }
      state.appendToolCallBlock(callId, toolName, event.args)
      break
    }

    case 'tool_call_end': {
      // 无 callId（部分引擎流式事件不携带）→ 回退到当前消息最后一个 running 工具块，
      // 与 tool_call_start 前端生成 UUID 建块对应，保证工具卡能正常收尾。
      // 显式 callId 优先（含 '' 表示确实无块可更新）。
      const callId = event.callId
        ? String(event.callId)
        : fallbackRunningToolId(state.currentMessage)
      // 交互型工具（ask/form）→ 无普通 tool_call block，跳过更新
      // （question/form 卡由 question_answered / form-* 事件驱动状态）
      if (isInteractiveTool(event.tool)) {
        break
      }
      // event.result 经 Rust IPC 传递后已是 JS string，直接使用；
      // 仅当 result 为对象时才 JSON.stringify
      const output = typeof event.result === 'string'
        ? event.result
        : (event.result ? JSON.stringify(event.result, null, 2) : undefined)
      // Task 家族工具 → 更新任务板（不创建普通 tool_call block）
      // TaskList: 用 output 快照校准看板;TaskGet/Output/Stop 仅标记完成(板已存在)
      if (isTaskBoardTool(event.tool)) {
        const { activeTaskBoardId } = get()
        const lower = event.tool.toLowerCase()
        if (activeTaskBoardId && output) {
          if (lower === 'tasklist') {
            // TaskList: 用 output 快照校准看板
            const snapshot = parseTaskListOutput(output)
            if (snapshot) state.syncTaskBoardFromList(activeTaskBoardId, snapshot)
          } else if (lower === 'taskcreate') {
            // TaskCreate: tool_result 回传真实 taskId(纯文本 "Task #N")，flush 入板
            const taskId = extractTaskIdFromOutput(output)
            state.flushTaskCreate(activeTaskBoardId, taskId)
          }
        }
        break
      }

      state.updateToolCallBlock(
        callId,
        event.success ? 'completed' : 'failed',
        output,
      )
      // cap.bash 后台任务透传（bash 工具 async 任务）：回填 taskId 到工具块，
      // 前端可在「运行中」直接停止 / 打开管理面板关联。
      if (event.taskId) {
        state.updateToolCallTaskId(callId, String(event.taskId))
      }

      // 插件自定义卡片（result 模式）：按工具名查注册表，命中则追加独立卡片。
      // 与工具调用卡并存（双卡模式）。interaction 模式由独立的 plugin_card 事件驱动。
      // opencode Code Mode 适配：MCP 调用包在 execute 载体工具内，直接按名匹配
      // 必 miss → resolve 会读 block.input.code 里的内嵌 MCP 调用再查注册表。
      if (event.success) {
        const { currentMessage: cardMsg, toolBlockMap: cardMap } = get()
        const cardBlockIdx = cardMsg ? cardMap.get(callId) : undefined
        const cardBlockInput =
          cardBlockIdx !== undefined && cardMsg
            ? (cardMsg.blocks[cardBlockIdx] as ToolCallBlock | undefined)?.input
            : undefined
        const resolved = chatCardRegistry.resolveWithKey(event.tool, cardBlockInput)
        if (resolved && resolved.entry.mode === 'result') {
          const cardBlock: PluginCardBlock = {
            type: 'plugin_card',
            id: callId,
            pluginId: resolved.entry.pluginId,
            cardId: resolved.entry.cardId,
            toolName: event.tool,
            // Code Mode 载体（execute）解析后的真实注册表 key —— 宿主 load/match 依赖
            cardKey: resolved.key,
            mode: 'result',
            status: 'ready',
            data: parseCardData(event.result, cardBlockInput),
            createdAt: new Date().toISOString(),
          }
          state.appendPluginCardBlock(cardBlock)
        }
      }

      // Edit 工具：提取 diff 数据写入 block
      const { currentMessage, toolBlockMap } = get()
      const blockIdx = currentMessage ? toolBlockMap.get(callId) : undefined
      if (blockIdx !== undefined && currentMessage) {
        const block = currentMessage.blocks[blockIdx]
        if (block?.type === 'tool_call' && isEditTool(block.name)) {
          const diff = extractEditDiff(block)
          if (diff) {
            state.updateToolCallBlockDiff(callId, diff)
          }
        }
        // apply_patch 工具：解析补丁信封，写入 patchData
        if (block?.type === 'tool_call' && block.name === 'apply_patch') {
          const patchInput = block.input?.input as string
          if (patchInput) {
            const parsed = parseApplyPatch(patchInput)
            if (parsed && parsed.files.length > 0) {
              state.updateToolCallBlockPatch(callId, parsed.files)
            }
          }
        }
      }
      break
    }

    case 'progress': {
      const msg = event.message || null
      // 工具结束态 progress（✅/❌ 前缀）只用于更新工具卡状态，
      // 不应作为 progressMessage 残留——否则工具完成后岛仍转圈显示已完成文案。
      // 仅真正"进行中"的进度（🔧 前缀 / 无状态前缀）才进 progressMessage。
      const isTerminal = msg && (msg.startsWith('✅') || msg.startsWith('❌'))
      if (isTerminal) {
        // 终态文案：若 progressMessage 恰好是同工具的 🔧 文案，清掉它
        const prev = get().progressMessage
        if (prev && prev.startsWith('🔧')) {
          // 提取工具名比较（🔧 Glob → 与 ✅ Glob 同名则清空）
          const prevName = prev.replace(/^🔧\s*/, '').trim()
          const termName = msg!.replace(/^[✅❌]\s*/, '').trim()
          if (prevName === termName || termName.startsWith(prevName)) {
            set({ progressMessage: null })
          }
        }
        break
      }
      set({ progressMessage: msg })
      break
    }

    case 'error':
      if (get().isInterrupting) {
        // 用户主动中断后，后端硬杀进程会触发 fallback error + session_end(reason=error)。
        // 这是用户期望行为，不显示错误、不做语音提醒，静默交给 session_end 收尾。
        break
      }
      set({
        error: event.error,
        isStreaming: false,
      })
      // currentMessage 不清空：消息固化由随后的 session_end handler 的 finishMessage()
      // 统一负责。此前在 error handler 里直接置 null 会导致流式输出被丢弃（中断时
      // error 和 session_end 同序到达，error 先清空后 finishMessage 空跑，消息消失）。
      // 语音提醒：错误提醒
      voiceNotificationService.notifyError()
      break

    case 'result':
      // 结果事件通常在 session_end 之后，忽略
      break

    case 'user_message': {
      // 多设备同步：消费后端广播的 user_message 事件，使 B 设备能看到 A 发送的用户消息。
      //
      // 幂等去重（A 设备本机已 addMessage，广播回来的同一消息不能重复渲染）：
      // 优先用 clientMessageId 精确匹配——sendMessage 生成的消息 id 经后端透传回来，
      // 命中本机已有消息即为本机回显。ID 判重不受消息内容归一化影响
      // （后端会对 content 做工作区引用展开、系统提示拼接等改写，字符串比对不可靠），
      // 也不受时序影响（不必依赖"最后一条 user 消息"）。
      // clientMessageId 缺失时回退 content 比对，兼容未透传 ID 的引擎。
      const content = (event as { content?: string }).content
      if (!content) break

      const clientId = (event as { clientMessageId?: string }).clientMessageId
      const existing = state.messages
      // content 回退比对仅在**本机会话运行期**启用（isStreaming=true）：
      // 本机 sendMessage 发起的回显必然发生在自己会话 streaming 期间；而空闲状态
      // （B 设备 / 看板）收到内容相同但确实是新消息的 user_message 时不比对 content，
      // 直接追加——避免"同内容两条独立消息被 content 误判为回显而吞掉"。
      const isLocalEcho = clientId
        ? existing.some((m) => m.id === clientId)
        : state.isStreaming && [...existing].reverse()
            .find((m) => m.type === 'user')
            ?.content === content

      if (isLocalEcho) {
        // 本机已存在这条消息（A 设备自己发的）→ 跳过，不重复渲染
        break
      }

      // B 设备：本机没有这条 user 消息 → 追加渲染。
      // 用 clientId 作为消息 id，保证多设备间消息标识一致（便于后续跨设备对齐）。
      state.addMessage({
        id: clientId || generateUUID(),
        type: 'user',
        content,
        timestamp: new Date().toISOString(),
      })
      break
    }

    case 'plan_start':
      // PlanStartEvent only has sessionId and planId, use plan_content for full data
      state.appendPlanModeBlock(
        event.planId,
        event.sessionId,
        undefined, // title from plan_content event
        undefined,  // description from plan_content event
      )
      break

    case 'plan_content':
      // Full plan content including title, description, stages
      state.updatePlanModeBlock(
        event.planId,
        {
          title: event.title,
          description: event.description,
          stages: event.stages,
          status: event.status,
        },
      )
      break

    case 'plan_stage_update':
      state.updatePlanStageStatus(
        event.planId,
        event.stageId,
        event.status,
        event.tasks,
      )
      break

    case 'plan_approval_request':
      state.appendPermissionRequestBlock(
        event.planId,
        event.sessionId,
        [], // approval denials
      )
      break

    case 'plan_approval_result':
      state.updatePermissionRequestBlock(
        event.planId,
        event.approved ? 'approved' : 'denied',
      )
      break

    case 'plan_end':
      state.setActivePlan(null)
      break

    case 'agent_run_start':
      state.appendAgentRunBlock(
        event.taskId,
        event.agentType,
        event.capabilities,
      )
      break

    case 'agent_run_end':
      state.updateAgentRunBlock(event.taskId, {
        status: event.success ? 'success' : 'error',
        output: event.result,
        completedAt: new Date().toISOString(),
      })
      state.setActiveTask(null)
      break

    case 'permission_request':
      state.appendPermissionRequestBlock(
        `perm-${Date.now()}`, // generate a unique request ID
        event.sessionId,
        event.denials,
      )
      break

    case 'hook': {
      // Hook 可视化（克制）：仅在 hook 执行失败时用进度行提示，
      // 避免高频 hook（PreToolUse/PostToolUse）刷屏；成功/开始仅记录日志。
      // 完整 hook 时间线可后续做独立面板消费此事件。
      if (event.phase === 'completed' && event.outcome && event.outcome !== 'success') {
        set({ progressMessage: `🪝 ${event.hookEvent || event.hookName}: ${event.outcome}` })
      } else {
        log.debug('Hook event', {
          hookName: event.hookName,
          phase: event.phase,
          outcome: event.outcome,
        })
      }
      break
    }

    case 'prompt_suggestion':
      // 下一步提示建议：保存到 store，由输入框渲染为可点击气泡。
      // 仅保留最近一条；空字符串视为清除。
      set({ promptSuggestion: event.suggestion?.trim() ? event.suggestion : null })
      break

    case 'cli_init':
      // CLI 会话初始化：把动态能力数据（工具/MCP/skill/模型/斜杠命令）同步到全局 store，
      // 供输入框命令建议、状态栏等消费。每轮对话（每次 CLI 进程启动）都会刷新。
      useCliInfoStore.getState().updateFromInit({
        sessionId: event.sessionId,
        tools: event.tools,
        mcpServers: event.mcpServers,
        agents: event.agents,
        skills: event.skills,
        model: event.model ?? undefined,
        claudeCodeVersion: event.claudeCodeVersion ?? undefined,
        slashCommands: event.slashCommands,
      })
      // run 边界：复位 usage 双口径状态机（turn 快照标记 + 本 run 已计贡献）。
      // 复位必须在这里而非 cumulative 消费时——单 run 可能输出多条 result
      //（后台子代理 task-notification 续跑），详见 UsageStats.turnSnapshotSeen 注释。
      if (state.usageStats) {
        set({
          usageStats: {
            ...state.usageStats,
            turnSnapshotSeen: false,
            runContribution: null,
          },
        })
      }
      break

    case 'context_compacted':
      // 上下文压缩完成（/compact 或 autoCompact）：插入分隔条块，
      // 标记此处之前的上下文已被摘要压缩。
      state.appendContextCompactBlock(event.trigger, event.preTokens, event.postTokens)
      set({ progressMessage: null })
      break

    case 'usage': {
      // token 用量双口径分流（详见 UsageStats 注释）：
      // - turn（message_delta 单轮快照）：只刷新水位三元组，与 CLI /context 一致；
      //   同一 run 内每轮覆盖一次，水位随流式实时更新。
      // - cumulative（result 累计）/ 缺省（SimpleAI）：更新成本与明细组、
      //   累加会话总量；仅当本 run 未收到过 turn 快照时才兜底覆盖水位
      //   （防多轮累计虚高污染）。turnSnapshotSeen 在 run 启动（cli_init）时复位，
      //   而非在此消费——单 run 可能有多条 result（task-notification 续跑）。
      // - 同 run 多条 result 的 sessionTotals/totalOutput 用 runContribution 幂等替换
      //   （modelUsage 是进程累计，后到覆盖先到，直接累加会重复计数）。
      // 实际模型（actualModel）随两类事件更新：响应侧 message.model，逐轮可变。
      const prev = state.usageStats
      // 流末 provider 精确输出 token → 校正平均速率（仅在比值合理时替换启发式估计）
      pushProviderUsage(state, set, event.outputTokens)
      if (event.scope === 'turn') {
        set({
          usageStats: {
            ...(prev ?? { output: 0, totalOutput: 0 }),
            input: event.inputTokens,
            cacheCreation: event.cacheCreationInputTokens ?? 0,
            cacheRead: event.cacheReadInputTokens ?? 0,
            contextWindow: event.contextWindow ?? prev?.contextWindow,
            actualModel: event.actualModel ?? prev?.actualModel,
            actualModels: mergeActualModels(prev?.actualModels, event.actualModel),
            contextSource: 'turn',
            turnSnapshotSeen: true,
          },
        })
      } else {
        // 本 run 已有 turn 快照 → 水位保持快照值；否则用累计值兜底
        const snap = prev?.turnSnapshotSeen ? prev : null
        // 本 run 成本：顶层 total_cost_usd 权威，退化到 modelUsage 逐项求和
        const runCost =
          event.totalCostUsd ??
          Object.values(event.modelUsage ?? {}).reduce((s, m) => s + (m.costUsd ?? 0), 0)
        const prevTotals = prev?.sessionTotals
        // 同 run 幂等替换：先回退本 run 已计入的贡献再加本条 result 的值。
        // 仅 scope='cumulative'（Claude，有 cli_init run 边界）参与；scope 缺省引擎
        // 无边界信号，rc 恒为 null（不写入），维持逐事件累加旧语义。
        const rc = event.scope === 'cumulative' ? prev?.runContribution : null
        const contribution = {
          input: event.inputTokens,
          cacheCreation: event.cacheCreationInputTokens ?? 0,
          cacheRead: event.cacheReadInputTokens ?? 0,
          output: event.outputTokens,
          costUsd: runCost,
        }
        set({
          usageStats: {
            input: snap ? snap.input : event.inputTokens,
            cacheCreation: snap ? snap.cacheCreation : (event.cacheCreationInputTokens ?? 0),
            cacheRead: snap ? snap.cacheRead : (event.cacheReadInputTokens ?? 0),
            output: event.outputTokens,
            reasoning: event.reasoningOutputTokens,
            contextWindow: event.contextWindow ?? prev?.contextWindow,
            totalOutput: (prev?.totalOutput ?? 0) - (rc?.output ?? 0) + event.outputTokens,
            modelUsage: event.modelUsage,
            rawPayload: event.rawPayload,
            actualModel: event.actualModel ?? prev?.actualModel,
            actualModels: mergeActualModels(prev?.actualModels, event.actualModel),
            sessionTotals: {
              input: (prevTotals?.input ?? 0) - (rc?.input ?? 0) + contribution.input,
              cacheCreation:
                (prevTotals?.cacheCreation ?? 0) - (rc?.cacheCreation ?? 0) + contribution.cacheCreation,
              cacheRead: (prevTotals?.cacheRead ?? 0) - (rc?.cacheRead ?? 0) + contribution.cacheRead,
              output: (prevTotals?.output ?? 0) - (rc?.output ?? 0) + contribution.output,
              costUsd: (prevTotals?.costUsd ?? 0) - (rc?.costUsd ?? 0) + contribution.costUsd,
              runs: (prevTotals?.runs ?? 0) + (rc ? 0 : 1),
              // 成本口径 B：cacheRead / (input + cacheRead)，跨域统一
              cacheHitRate: computeCacheHitRate(
                (prevTotals?.input ?? 0) - (rc?.input ?? 0) + contribution.input,
                (prevTotals?.cacheRead ?? 0) - (rc?.cacheRead ?? 0) + contribution.cacheRead,
              ),
            },
            contextSource: snap ? snap.contextSource : 'cumulative',
            turnSnapshotSeen: prev?.turnSnapshotSeen ?? false,
            runContribution: event.scope === 'cumulative' ? contribution : null,
          },
        })
      }
      break
    }

    // permission_result is handled via plan_approval_result
    // there is no separate permission_result event type

    case 'question': {
      // 新版事件携带 questions[] 全集；老路径仅有顶层 header/options 等字段，
      // 这里做向后兼容：缺 questions[] 时用首题摘要合成。
      const questions = event.questions && event.questions.length > 0
        ? event.questions.map(q => ({
            question: q.question,
            header: q.header,
            multiSelect: q.multiSelect,
            options: q.options,
            allowCustomInput: q.allowCustomInput,
          }))
        : [{
            question: event.header,
            header: event.categoryLabel || '',
            multiSelect: event.multiSelect,
            options: event.options,
            allowCustomInput: event.allowCustomInput,
          }]
      state.appendQuestionBlock(event.questionId, event.sessionId, questions)
      break
    }

    case 'question_answered': {
      // 新版携带 answers[] 数组；老路径只有顶层 selected/customInput
      if (event.declined) {
        // decline-all 场景：无逐题答案，仅切换 declined 与 status
        state.updateQuestionBlock(event.questionId, {
          declined: true,
        })
      } else if (event.answers && event.answers.length > 0) {
        state.updateQuestionBlock(event.questionId, {
          answers: event.answers,
          declined: false,
        })
      } else {
        // 老路径 fallback：仅顶层 selected/customInput
        state.updateQuestionBlock(event.questionId, {
          answers: [{
            selected: event.selected || [],
            customInput: event.customInput,
          }],
          declined: false,
        })
      }
      break
    }

    case 'plugin_card': {
      const block: PluginCardBlock = {
        type: 'plugin_card',
        id: event.interactionId,
        pluginId: event.pluginId,
        cardId: event.cardId,
        toolName: event.toolName,
        mode: 'interaction',
        status: 'pending',
        data: event.payload,
        sessionId: event.sessionId,
        createdAt: new Date().toISOString(),
      }
      state.appendPluginCardBlock(block)
      break
    }

    case 'plugin_card_answered':
      state.updatePluginCardBlock(event.interactionId, {
        status: event.declined ? 'declined' : 'answered',
        response: event.result,
      })
      break

    case 'form': {
      // form 工具拉起：schema 驱动面板。read=none 时服务端只回执字段名，
      // 前端不持有原始值，仅渲染控件（值由用户提交时直达服务端）。
      state.appendFormBlock({
        type: 'form',
        id: event.formId,
        sessionId: event.sessionId,
        title: event.title,
        read: event.read ?? 'full',
        target: event.target,
        action: event.action,
        mode: event.mode ?? 'dispatch',
        style: event.style,
        template: event.template,
        fields: (event.fields ?? []).map((f) => ({
          name: f.name,
          type: f.type ?? 'string',
          label: f.label,
          placeholder: f.placeholder,
          options: f.options,
          required: f.required,
          default: f.default,
          secret: f.secret,
          hidden: f.hidden,
          help: f.help,
          col: f.col,
        })),
        status: 'pending',
        createdAt: new Date().toISOString(),
      })
      break
    }

    case 'form-answered':
      // 服务端回执落回表单块（ok/receipt），FormCard 据此切换提交态
      state.updateFormBlock(event.formId, {
        status: 'submitted',
        ok: event.ok,
        receipt: event.receipt,
      })
      break

    case 'form-skipped': {
      // 用户跳过 / 超时自动跳过：表单块置 skipped，控件禁用。
      // reason=timeout 时可能表单已因提交被取走 → 幂等忽略（找不到 block 不报错）。
      const reasonText =
        event.reason === 'timeout'
          ? '表单等待超时，已自动跳过'
          : '用户已跳过该表单'
      state.updateFormBlock(event.formId, {
        status: 'skipped',
        ok: false,
        receipt: reasonText,
      })
      break
    }

    // Task 事件 - 由 TaskStore 处理，不在 ConversationStore 范围内
    case 'task_metadata':
    case 'task_progress':
    case 'task_completed':
    case 'task_canceled':
      break

    case 'tool_call_update': {
      // 流式工具中间输出（如 Bash 长命令逐行返回）
      const callId = event.callId || ''
      if (callId) {
        state.updateToolCallBlock(callId, 'running', event.output)
      }
      break
    }

    // Todo 事件 - 由 TodoStore 处理，不在 ConversationStore 范围内
    case 'todo_created':
    case 'todo_updated':
    case 'todo_deleted':
    case 'todo_execution_started':
    case 'todo_execution_progress':
    case 'todo_execution_completed':
      break

    default: {
      // 穷尽性检查：如果所有 AIEvent 类型都已处理，此处应为 never
      const _exhaustive: never = event
      log.warn('Unhandled event type', { type: (_exhaustive as { type: string }).type })
    }
  }
}

/**
 * 提取会话保存所需的元数据（标题/引擎/工作区），saveDialog 与增量 flush 共用。
 */
function buildDialogMetaInput(state: ConversationStore, messages: ChatMessage[]): {
  engineId: ReturnType<typeof normalizeEngineId>
  title: string
  workspaceId: string | null
  workspacePath: string | null
  tokenUsage?: import('@/services/dialogStorage').TokenUsageSummary
} {
  const metadata = sessionStoreManager.getState().sessionMetadata.get(state.sessionId)
  const engineId = normalizeEngineId(metadata?.engineId)

  // 标题：优先首条用户消息，其次 metadata.title
  const firstUserMessage = messages.find((m) => m.type === 'user')
  let title = metadata?.title || '新会话'
  if (firstUserMessage && 'content' in firstUserMessage && firstUserMessage.content) {
    title = (firstUserMessage.content as string).slice(0, 50)
  }

  // 工作区路径（用于按项目过滤 / 恢复时定位工作区）
  let workspacePath: string | null = null
  if (metadata?.workspaceId) {
    const ws = useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === metadata.workspaceId)
    workspacePath = ws?.path ?? null
  }

  // 会话级 token 用量（从 usageStats.sessionTotals 提取）
  // 注意：sessionTotals 是跨 run 正确累计的（幂等替换），但 modelUsage 仅保留
  // 末次 cumulative 事件覆盖值（多 run 会话时 modelBreakdown 会漏计），因此
  // modelBreakdown 仅在单 run 会话（totals.runs === 1）时写入，多 run 跳过。
  const totals = state.usageStats?.sessionTotals
  let tokenUsage: import('@/services/dialogStorage').TokenUsageSummary | undefined
  if (totals && totals.runs > 0) {
    // 按模型维度的用量（仅单 run 会话写入，多 run 时 modelUsage 非累计值）
    const modelUsage = state.usageStats?.modelUsage
    let modelBreakdown: Record<string, {
      input: number
      output: number
      cacheCreation: number
      cacheRead: number
      costUsd: number
    }> | undefined
    if (modelUsage && Object.keys(modelUsage).length > 0 && totals.runs <= 1) {
      modelBreakdown = {}
      for (const [model, m] of Object.entries(modelUsage)) {
        modelBreakdown[model] = {
          input: m.inputTokens,
          output: m.outputTokens,
          cacheCreation: m.cacheCreationInputTokens ?? 0,
          cacheRead: m.cacheReadInputTokens ?? 0,
          costUsd: m.costUsd ?? 0,
        }
      }
    }
    tokenUsage = {
      input: totals.input,
      output: totals.output,
      cacheCreation: totals.cacheCreation,
      cacheRead: totals.cacheRead,
      costUsd: totals.costUsd,
      cacheHitRate: totals.cacheHitRate,
      modelBreakdown,
    }
  }

  return { engineId, title, workspaceId: metadata?.workspaceId ?? null, workspacePath, tokenUsage }
}

/**
 * 保存会话到自有 JSONL 存储（轮末规整）
 *
 * 在 session_end 时整体覆写该会话文件（一个会话一个 .jsonl）。
 * 整存整取 → 幂等、保序、不重复；配合三道保护不丢内容：
 * 1. getPersistableMessages 用内存快照/磁盘缓存恢复压缩态；
 * 2. saveConversation 合并保护：仍为压缩态的消息不覆盖磁盘完整版；
 * 3. 分页恢复的会话保留磁盘前缀（窗口外的更早消息）。
 */
async function saveDialog(get: GetState, set: SetState): Promise<void> {
  try {
    const state = get()
    const { conversationId } = state
    if (!conversationId) return
    // store 中离屏消息可能已被压缩，持久化前必须恢复为完整态，
    // 否则压缩态（output 清空 / content 截断）会被写入 JSONL 永久丢失内容。
    const messages = state.getPersistableMessages()
    if (messages.length === 0) return

    const metaInput = buildDialogMetaInput(state, messages)
    const paging = state.historyPaging
    const baseSeq = paging?.earliestSeq ?? 0

    const { prefixCount } = await dialogStorageService.saveConversation({
      externalId: conversationId,
      ...metaInput,
      messages,
      baseSeq,
      prefixSourceExternalId: paging?.sourceId,
    })

    // 覆写后磁盘 seq 已重排为 [0..prefixCount+N)：校正水位与分页游标（前缀已自包含 → sourceId 指回自身）
    const cur = get()
    if (cur.conversationId === conversationId) {
      set({
        // 水位 = 本次实际落盘的条数（保存期间新到的消息留给下次 flush）
        persistedSeq: Math.min(messages.length, cur.messages.length),
        persistedConversationId: conversationId,
        historyPaging:
          prefixCount > 0
            ? { earliestSeq: prefixCount, hasMore: true, sourceId: conversationId }
            : null,
      })
    }

    log.info('会话已保存到 JSONL', { conversationId, messageCount: messages.length })
  } catch (e) {
    log.error('保存会话到 JSONL 失败', e instanceof Error ? e : new Error(String(e)))
  }
}

export type GetState = () => ConversationStore
export type SetState = (partial: Partial<ConversationStore>) => void
