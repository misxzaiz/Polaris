/**
 * 结构化提取服务（claude --json-schema）
 *
 * 以自然语言输入 + JSON Schema 约束，调用 Claude CLI 做一次性结构化提取，
 * 用于 Todo / 需求的「AI 结构化提取」。底层走 Tauri 命令 `cli_extract_structured`，
 * 该命令返回 CLI `--output-format json` 的完整输出，本服务负责解包出结构化结果。
 *
 * 注意：CLI 的结果包装结构在本环境未做端到端验证，`unwrapCliJson` 做了多层
 * 防御性解包（外层 result 字段 / 字符串二次解析 / 直接对象），以兼容不同 CLI 版本。
 */

import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'
import type { TodoCreateParams } from '@/types/todo'
import type { RequirementCreateParams } from '@/types/requirement'

const log = createLogger('structuredExtraction')

/** 优先级字面量（Todo / 需求共用同一枚举） */
type PriorityLiteral = 'low' | 'normal' | 'high' | 'urgent'
const VALID_PRIORITIES = new Set<PriorityLiteral>(['low', 'normal', 'high', 'urgent'])

export interface ExtractOptions {
  /** 工作区目录（作为 CLI cwd，便于引用项目上下文） */
  workspaceDir?: string | null
  /** 指定模型（可选） */
  model?: string | null
}

/** 待办提取结果 schema：固定 todos 数组 */
export const TODO_EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    todos: {
      type: 'array',
      description: '从输入中提取出的待办事项列表',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', description: '待办标题，简洁的动宾短语' },
          description: { type: 'string', description: '补充说明（可选）' },
          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high', 'urgent'],
            description: '优先级',
          },
          tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
          estimatedHours: { type: 'number', description: '预估工时（小时，可选）' },
        },
        required: ['content'],
      },
    },
  },
  required: ['todos'],
} as const

/** 需求提取结果 schema：单条需求 */
export const REQUIREMENT_EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: '需求标题，一句话概括' },
    description: { type: 'string', description: '需求详细描述，可用 markdown' },
    priority: {
      type: 'string',
      enum: ['low', 'normal', 'high', 'urgent'],
      description: '优先级',
    },
    tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
  },
  required: ['title', 'description'],
} as const

/**
 * 解包 CLI `--output-format json` 输出，取出结构化结果对象。
 *
 * 兼容多种包装：
 * - 外层 `{ type:"result", subtype, is_error, result }` → 取 `result`
 * - `result` 为对象 → 直接返回
 * - `result` 为 JSON 字符串 → 二次解析
 * - 无 `result` 字段 → 用外层对象本身
 */
function unwrapCliJson(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('CLI 返回为空')
  }

  let outer: unknown
  try {
    outer = JSON.parse(trimmed)
  } catch {
    throw new Error('CLI 输出不是合法 JSON，无法解析结构化结果')
  }

  // 错误检测
  if (outer && typeof outer === 'object') {
    const obj = outer as Record<string, unknown>
    if (obj.is_error === true || obj.subtype === 'error' || obj.type === 'error') {
      const msg =
        typeof obj.result === 'string'
          ? obj.result
          : typeof obj.error === 'string'
            ? obj.error
            : '结构化提取失败'
      throw new Error(msg)
    }
  }

  // 取 result 字段（若存在）
  let result: unknown = outer
  if (outer && typeof outer === 'object' && 'result' in (outer as Record<string, unknown>)) {
    result = (outer as Record<string, unknown>).result
  }

  // result 为字符串时尝试二次解析
  if (typeof result === 'string') {
    const s = result.trim()
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        return JSON.parse(s)
      } catch {
        return result
      }
    }
    return result
  }

  return result
}

/**
 * 通用结构化提取：返回解包后的结构化对象（未做业务字段归一化）。
 */
export async function extractStructured(
  prompt: string,
  schema: unknown,
  options: ExtractOptions = {}
): Promise<unknown> {
  const text = prompt.trim()
  if (!text) {
    throw new Error('提取内容不能为空')
  }

  const raw = await invoke<string>('cli_extract_structured', {
    prompt: text,
    schemaJson: JSON.stringify(schema),
    workspaceDir: options.workspaceDir ?? null,
    model: options.model ?? null,
  })

  log.debug('结构化提取原始输出', { length: raw.length })
  return unwrapCliJson(raw)
}

function normalizePriority(value: unknown): PriorityLiteral | undefined {
  return typeof value === 'string' && VALID_PRIORITIES.has(value as PriorityLiteral)
    ? (value as PriorityLiteral)
    : undefined
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tags = value
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map(t => t.trim())
  return tags.length > 0 ? tags : undefined
}

/**
 * 从自然语言提取待办列表（TodoCreateParams[]）。
 */
export async function extractTodos(
  prompt: string,
  options: ExtractOptions = {}
): Promise<TodoCreateParams[]> {
  const result = await extractStructured(prompt, TODO_EXTRACTION_SCHEMA, options)

  // 兼容 result 直接是数组 / { todos: [...] }
  let list: unknown[] = []
  if (Array.isArray(result)) {
    list = result
  } else if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as Record<string, unknown>).todos)
  ) {
    list = (result as Record<string, unknown>).todos as unknown[]
  }

  const todos: TodoCreateParams[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const content = typeof obj.content === 'string' ? obj.content.trim() : ''
    if (!content) continue
    todos.push({
      content,
      description:
        typeof obj.description === 'string' && obj.description.trim()
          ? obj.description.trim()
          : undefined,
      priority: normalizePriority(obj.priority),
      tags: normalizeTags(obj.tags),
      estimatedHours:
        typeof obj.estimatedHours === 'number' && obj.estimatedHours > 0
          ? obj.estimatedHours
          : undefined,
    })
  }

  return todos
}

/**
 * 从自然语言提取单条需求（RequirementCreateParams）。
 */
export async function extractRequirement(
  prompt: string,
  options: ExtractOptions = {}
): Promise<RequirementCreateParams> {
  const result = await extractStructured(prompt, REQUIREMENT_EXTRACTION_SCHEMA, options)

  if (!result || typeof result !== 'object') {
    throw new Error('未能从输入中提取出有效需求')
  }
  const obj = result as Record<string, unknown>
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  const description = typeof obj.description === 'string' ? obj.description.trim() : ''
  if (!title || !description) {
    throw new Error('提取结果缺少标题或描述')
  }

  return {
    title,
    description,
    priority: normalizePriority(obj.priority),
    tags: normalizeTags(obj.tags),
    generatedBy: 'ai',
  }
}
