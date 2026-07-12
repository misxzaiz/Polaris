/**
 * 会话导出工具
 *
 * 把会话消息序列化成可读 markdown，用于「会话续接」：
 * 导出旧会话内容到文件，新会话通过 @ 引用让 AI 读取，从而了解此前进展。
 *
 * 仅做纯函数序列化，不涉及任何 IO 或 store 依赖。
 */

import type { ChatMessage, ContentBlock } from '@/types/chat'

/** 工具结果在 markdown 中的最大保留长度（超出截断，避免文件过大） */
const TOOL_OUTPUT_MAX = 800
/** compact 模式下 assistant 文本块的截断长度（控制摘要体积） */
const COMPACT_TEXT_MAX = 200

export interface MessagesToMarkdownOptions {
  /** 文档标题（通常是会话标题） */
  title?: string
  /** 是否包含 thinking 内容（默认否：省体积、减噪音） */
  includeThinking?: boolean
  /**
   * 紧凑摘要模式（默认否）。
   *
   * 用于跨引擎续接的 summary 模式：丢掉工具输出、截断 assistant 文本，
   * 只保留用户意图与助手要点，把任意长度的对话压缩到 ~1-2k token，
   * 避免新会话初始上下文膨胀。user 文本完整保留（用户意图是核心上下文）。
   */
  compact?: boolean
}

/**
 * 将会话消息序列化为可读 markdown
 *
 * 规则：
 * - user：标题 + 文本
 * - assistant：标题 + 文本块 / 工具调用（名称 + 关键入参 + 截断后的结果）
 * - system：标题 + 文本
 * - thinking 默认跳过；question / plan / agent / 媒体等富块跳过（对续接价值低）
 */
export function messagesToMarkdown(
  messages: ChatMessage[],
  options: MessagesToMarkdownOptions = {},
): string {
  const { title, includeThinking = false, compact = false } = options
  const lines: string[] = []

  if (title) {
    lines.push(`# ${title}`, '')
  }
  lines.push(
    compact
      ? '> 本文件由 Polaris 从历史会话生成的精简摘要，仅保留用户意图与助手要点（工具输出已省略）。'
      : '> 本文件由 Polaris 从历史会话导出，供新会话快速了解此前的对话与进展。',
    '',
    '---',
    '',
  )

  for (const message of messages) {
    if (message.type === 'user') {
      const content = typeof message.content === 'string' ? message.content.trim() : ''
      if (!content) continue
      lines.push('## 👤 用户', '', content, '')
    } else if (message.type === 'assistant') {
      const blockLines = renderBlocks(message.blocks ?? [], includeThinking, compact)
      if (blockLines.length === 0) continue
      lines.push('## 🤖 助手', '', ...blockLines)
    } else if (message.type === 'system') {
      const content = typeof message.content === 'string' ? message.content.trim() : ''
      if (!content) continue
      lines.push('## ⚙️ 系统', '', content, '')
    }
  }

  // 折叠多余空行，保证结尾恰好一个换行
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/** 渲染 assistant 的内容块 */
function renderBlocks(blocks: ContentBlock[], includeThinking: boolean, compact: boolean): string[] {
  const out: string[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        const raw = block.content.trim()
        if (!raw) break
        // compact 模式截断 assistant 文本，控制摘要体积
        const text = compact && raw.length > COMPACT_TEXT_MAX
          ? `${raw.slice(0, COMPACT_TEXT_MAX)}…`
          : raw
        out.push(text, '')
        break
      }
      case 'thinking': {
        if (!includeThinking) break
        const text = block.content.trim()
        if (text) out.push('<details><summary>思考过程</summary>', '', text, '', '</details>', '')
        break
      }
      case 'tool_call': {
        const args = summarizeToolInput(block.input)
        out.push(`**🔧 ${block.name}**${args ? ` — \`${args}\`` : ''}`, '')
        // compact 模式省略工具输出（体积大头），仅保留调用名称与关键入参
        if (!compact && block.output) {
          const output =
            block.output.length > TOOL_OUTPUT_MAX
              ? `${block.output.slice(0, TOOL_OUTPUT_MAX)}\n…（已截断 ${block.output.length - TOOL_OUTPUT_MAX} 字符）`
              : block.output
          out.push('```', output, '```', '')
        }
        break
      }
      default:
        // question / plan_mode / agent_run / tool_group / permission_request / media
        // 这些块对「续接了解上下文」价值低，跳过以保持文件精简
        break
    }
  }

  return out
}

/** 从工具入参中提取一个简短摘要 */
function summarizeToolInput(input: Record<string, unknown>): string {
  if (!input || typeof input !== 'object') return ''

  // 优先展示这些语义明确的关键字段
  const priorityKeys = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt']
  for (const key of priorityKeys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      return truncate(value.trim(), 120)
    }
  }

  try {
    return truncate(JSON.stringify(input), 120)
  } catch {
    return ''
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
