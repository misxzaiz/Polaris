/**
 * 待办命令解析器
 *
 * 支持以下语法：
 * - @todo 创建待办内容
 * - @todo[high] 高优先级待办
 * - @todo[feature, frontend] 带标签的待办
 * - @todo[urgent, bug] 紧急 bug 待办
 */

import type { ParsedTodoCommand, TodoPriority } from '@/types'

const TODO_REGEX = /@todo(?:\[([^\]]+)\])?\s+(.+)/i

/**
 * 解析用户输入中的待办命令
 *
 * @example
 * parseTodoCommand("@todo[high, frontend] 实现用户登录功能")
 * // => {
 * //   content: "实现用户登录功能",
 * //   priority: "high",
 * //   tags: ["frontend"],
 * //   shouldCreate: true
 * // }
 */
export function parseTodoCommand(input: string): ParsedTodoCommand | null {
  const match = input.match(TODO_REGEX)

  if (!match) {
    return null
  }

  const [, modifiers, content] = match

  // 解析修饰符 [priority, tag1, tag2, ...]
  let priority: TodoPriority = 'normal'
  const tags: string[] = []

  if (modifiers) {
    const parts = modifiers.split(',').map((s) => s.trim().toLowerCase())

    for (const part of parts) {
      // 检查是否为优先级
      if (['low', 'normal', 'high', 'urgent'].includes(part)) {
        priority = part as TodoPriority
      } else {
        // 作为标签
        tags.push(part)
      }
    }
  }

  return {
    content: content.trim(),
    priority,
    tags: tags.length > 0 ? tags : undefined,
    shouldCreate: true,
  }
}

/**
 * 从输入中移除待办命令，返回清理后的消息
 *
 * @example
 * removeTodoCommand("@todo 修复bug\n帮我看看这段代码")
 * // => "帮我看看这段代码"
 */
export function removeTodoCommand(input: string): string {
  return input.replace(TODO_REGEX, '').trim()
}

/**
 * 从消息中提取所有待办命令
 */
export function extractAllTodoCommands(input: string): ParsedTodoCommand[] {
  const commands: ParsedTodoCommand[] = []
  const lines = input.split('\n')

  for (const line of lines) {
    const command = parseTodoCommand(line)
    if (command) {
      commands.push(command)
    }
  }

  return commands
}

/**
 * 检查输入是否包含待办命令
 */
export function hasTodoCommand(input: string): boolean {
  return TODO_REGEX.test(input)
}
