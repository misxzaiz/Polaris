/**
 * ConversationPackager
 *
 * 把「源对话」打包成「目标引擎可消费的上下文产物」。设计首要约束：
 * 避免新会话初始上下文膨胀 —— 默认只注入摘要，全文落盘作回查库。
 *
 * 本模块为纯打包能力，不耦合 store：
 * - resolveTransferMode：根据源/目标引擎与体积决策模式（纯函数）
 * - estimateTokens：粗估对话 token 数（纯函数）
 * - packToFile：把消息序列化为 markdown 并落盘到 .polaris-handoff/（IO）
 *
 * 上层（sessionHandoff / @对话引用流）负责取消息、建会话、预填引导语，
 * 本模块只产出 ConversationPack / 文件引用。
 */

import { invoke } from '@/services/tauri'
import { joinPath } from '@/utils/path'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { messagesToMarkdown } from '@/utils/sessionExport'
import { createLogger } from '@/utils/logger'
import type { EngineId } from '@/types'
import type { ChatMessage } from '@/types/chat'
import type {
  TransferMode,
  TransferModeInput,
  PackToFileResult,
} from './types'

const log = createLogger('ConversationPackager')

/** 续接导出目录（相对工作区根），与 sessionHandoff 保持一致 */
const HANDOFF_DIR = '.polaris-handoff'

/**
 * 引擎 fork 能力矩阵
 *
 * 依据后端 src-tauri/src/ai/engine/*.rs：
 * - claude-code：--fork-session 真正支持（claude.rs:964-968）
 * - mimo：同样消费 fork_session_id（mimo.rs:679-682，与 claude 完全相同的 resume+fork 逻辑）
 * - codex / simple-ai：不消费 fork_session_id
 *
 * 注意：fork 仍受 sessionHandoff 的「必须有真实源 conversationId」守卫保护，
 *       若 mimo 会话无有效 CLI session id 会自动降级 summary，不丢能力也不崩。
 */
const ENGINE_FORK_CAPABILITY: Record<EngineId, boolean> = {
  'claude-code': true,
  codex: false,
  'simple-ai': false,
  mimo: true,
}

/** 源对话 token 阈值：低于此值走 full-file（本身小，直注无负担） */
const TOKEN_FULL_CAP = 3000
/** message-history 模式上限：simple-ai 目标且中等长度可直注（SimpleAI 无 compact，超限会撑爆） */
const TOKEN_MSG_HISTORY_CAP = 8000

/**
 * 决策：源→目标用哪种 transfer mode
 *
 * 优先级（以「上下文最小」为第一原则）：
 * 1. 同引擎 + 目标支持 fork → fork（引擎原生，不占额外上下文）
 * 2. 源较短 → full-file（本身小）
 * 3. 目标 simple-ai 且中等长度 → message-history（原生直注）
 * 4. 默认 → summary（只注入摘要，控制上下文体积）
 */
export function resolveTransferMode(input: TransferModeInput): TransferMode {
  const sourceId = normalizeEngineId(input.sourceEngineId)
  const targetId = normalizeEngineId(input.targetEngineId)
  const sameEngine = sourceId === targetId

  // 1. 同引擎 + 目标支持 fork → fork
  if (sameEngine && ENGINE_FORK_CAPABILITY[targetId]) {
    return 'fork'
  }
  // 2. 源较短 → full-file
  if (input.estimatedTokens < TOKEN_FULL_CAP) {
    return 'full-file'
  }
  // 3. 目标 simple-ai 且中等长度 → message-history
  if (targetId === 'simple-ai' && input.estimatedTokens < TOKEN_MSG_HISTORY_CAP) {
    return 'message-history'
  }
  // 4. 默认 → summary
  return 'summary'
}

/** 查询引擎是否支持 fork（供上层 UI 判断是否展示「fork 完整保留」提示） */
export function engineSupportsFork(engineId: EngineId | string | null | undefined): boolean {
  return ENGINE_FORK_CAPABILITY[normalizeEngineId(engineId)] ?? false
}

/**
 * 粗估对话 token 数（chars / 4，仅文本与工具输出计入）
 *
 * 用于模式决策阈值，不需要精确 —— 精确计数由引擎侧完成。
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (m.type === 'user' || m.type === 'system') {
      if (typeof m.content === 'string') chars += m.content.length
    } else if (m.type === 'assistant' && m.blocks) {
      for (const b of m.blocks) {
        if (b.type === 'text' && typeof b.content === 'string') {
          chars += b.content.length
        } else if (b.type === 'tool_call' && typeof b.output === 'string') {
          chars += b.output.length
        }
      }
    }
  }
  return Math.ceil(chars / 4)
}

/** 清理文件名中的非法字符，并限制长度 */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, '_').trim()
  return (cleaned || 'session').slice(0, 60)
}

/**
 * 把消息序列化为 markdown 并落盘到工作区 .polaris-handoff/
 *
 * PR1 仅暴露此文件打包能力；PR2 的 pack() 会在此基础上根据 mode 编排
 * （summary 模式额外跑总结，message-history 模式直注，fork 模式不落盘）。
 *
 * @param messages 源对话消息（已加载、已补盖 engineId）
 * @param title    源会话标题（用于文件名与文档标题）
 * @param idSeed   文件名后缀种子（通常取 conversationId/itemId 前 8 位，避免重名）
 * @param workspacePath 工作区绝对路径
 */
export async function packToFile(
  messages: ChatMessage[],
  title: string,
  idSeed: string,
  workspacePath: string,
): Promise<PackToFileResult> {
  const markdown = messagesToMarkdown(messages, { title })
  const fileName = `${sanitizeFileName(title)}-${idSeed.slice(0, 8)}.md`
  const relPath = `${HANDOFF_DIR}/${fileName}`
  const absPath = joinPath(workspacePath, relPath)

  await invoke('create_file', { path: absPath, content: markdown })
  log.info('对话已打包落盘', { absPath, messageCount: messages.length })

  return {
    fileRef: {
      absPath,
      relPath,
      tokenEstimate: estimateTokens(messages),
    },
    markdown,
  }
}

/**
 * 把消息序列化为「精简摘要」并落盘到工作区 .polaris-handoff/
 *
 * summary 模式专用：丢工具输出、截断 assistant 文本，只保留用户意图与助手要点，
 * 把任意长度的对话压缩到 ~1-2k token，避免新会话初始上下文膨胀。
 * 纯本地结构化提取，无 LLM 调用，无摘要质量风险。
 *
 * 文件名带 `-summary` 后缀，与 full-file 产物区分。
 */
export async function packToSummary(
  messages: ChatMessage[],
  title: string,
  idSeed: string,
  workspacePath: string,
): Promise<PackToFileResult> {
  const markdown = messagesToMarkdown(messages, { title, compact: true })
  const fileName = `${sanitizeFileName(title)}-${idSeed.slice(0, 8)}-summary.md`
  const relPath = `${HANDOFF_DIR}/${fileName}`
  const absPath = joinPath(workspacePath, relPath)

  await invoke('create_file', { path: absPath, content: markdown })
  log.info('对话摘要已打包落盘', { absPath, messageCount: messages.length })

  return {
    fileRef: {
      absPath,
      relPath,
      // 摘要体积远小于原文，用实际 markdown 长度估算
      tokenEstimate: Math.ceil(markdown.length / 4),
    },
    markdown,
  }
}

/**
 * @对话 引用场景的统一打包入口（供 ChatInput 选中历史对话后调用）
 *
 * 与续接（sessionHandoff）共享体积决策阈值，消除「@对话 写死 summary」的决策漂移：
 * - 源较短（< TOKEN_FULL_CAP）：全文落盘并主动 @ 注入（本身小，无负担）
 * - 否则：精简摘要落盘（控制上下文体积）
 *
 * 当前为纯本地结构化打包，无 LLM 调用、无摘要失真风险。
 * 未来若要支持「派子 agent 总结」增强，可在此处按开关切换实现，调用方无感。
 */
export async function packForReference(
  messages: ChatMessage[],
  title: string,
  idSeed: string,
  workspacePath: string,
): Promise<PackToFileResult> {
  const estimated = estimateTokens(messages)
  if (estimated < TOKEN_FULL_CAP) {
    return packToFile(messages, title, idSeed, workspacePath)
  }
  return packToSummary(messages, title, idSeed, workspacePath)
}

export type { TransferMode, TransferModeInput } from './types'
