/**
 * 工具信息提取器
 *
 * 从工具参数中提取关键信息，生成简洁的工具调用描述。
 * 对应后端 manager.rs 中的 format_tool_brief() 逻辑。
 */

/**
 * 工具参数类型
 */
interface ToolArgs {
  path?: string
  file_path?: string
  filePath?: string
  filename?: string
  file?: string
  command?: string
  cmd?: string
  command_string?: string
  query?: string
  q?: string
  search?: string
  keyword?: string
  pattern?: string
  regex?: string
  url?: string
  uri?: string
  href?: string
  skill?: string
  prompt?: string
  description?: string
  todos?: Array<{ status?: string }>
  [key: string]: unknown
}

/**
 * 安全截断字符串（按字符边界）
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

/**
 * 从路径提取文件名
 */
function extractBasename(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

/**
 * 提取文件名（从各种可能的参数名）
 */
function extractFileBasename(args: ToolArgs): string | undefined {
  const keys = ['path', 'file_path', 'filePath', 'filename', 'file'] as const
  for (const key of keys) {
    const val = args[key]
    if (val && typeof val === 'string' && val.trim()) {
      return extractBasename(val)
    }
  }
  return undefined
}

/**
 * 提取命令
 */
function extractCommand(args: ToolArgs, maxLen: number): string | undefined {
  const keys = ['command', 'cmd', 'command_string'] as const
  for (const key of keys) {
    const val = args[key]
    if (val && typeof val === 'string' && val.trim()) {
      return truncate(val, maxLen)
    }
  }
  return undefined
}

/**
 * 提取搜索词
 */
function extractSearchQuery(args: ToolArgs, maxLen: number): string | undefined {
  const keys = ['query', 'q', 'search', 'keyword', 'pattern', 'regex'] as const
  for (const key of keys) {
    const val = args[key]
    if (val && typeof val === 'string' && val.trim()) {
      return truncate(val, maxLen)
    }
  }
  return undefined
}

/**
 * 提取 URL 简称
 */
function extractUrlBrief(args: ToolArgs, maxLen: number): string | undefined {
  const keys = ['url', 'uri', 'href'] as const
  for (const key of keys) {
    const val = args[key]
    if (val && typeof val === 'string' && val.trim()) {
      // 简化显示：移除协议，截断查询参数
      const simplified = val.replace(/^https?:\/\//, '').split('?')[0]
      return truncate(simplified, maxLen)
    }
  }
  return undefined
}

/**
 * 根据工具名和参数生成简短描述
 */
export function formatToolBrief(toolName: string, args: ToolArgs): string {
  const nameLower = toolName.toLowerCase()

  // Skill 工具：提取 skill 参数
  if (nameLower === 'skill') {
    const skill = args.skill
    if (skill && typeof skill === 'string') {
      // 取最后一部分作为名称（如 "superpowers:brainstorming" -> "brainstorming"）
      return skill.split(':').pop() || skill
    }
  }

  // Task / Agent 工具：提取 prompt 或 description
  if (nameLower === 'task' || nameLower === 'agent') {
    if (args.prompt && typeof args.prompt === 'string') {
      return truncate(args.prompt, 50)
    }
    if (args.description && typeof args.description === 'string') {
      return truncate(args.description, 50)
    }
  }

  // AskUserQuestion：提取描述
  if (nameLower === 'askuserquestion') {
    if (args.description && typeof args.description === 'string') {
      return truncate(args.description, 50)
    }
  }

  // Glob：优先取 pattern
  if (toolName === 'Glob') {
    if (args.pattern && typeof args.pattern === 'string') {
      return truncate(args.pattern, 40)
    }
  }

  // Grep：优先取 pattern
  if (toolName === 'Grep') {
    if (args.pattern && typeof args.pattern === 'string') {
      return truncate(args.pattern, 40)
    }
  }

  // 文件类工具（Read / Write / Edit / Delete）
  const fileTools = [
    'read', 'readfile', 'read_file',
    'write', 'writefile', 'write_file', 'create_file',
    'edit', 'edit3', 'str_replace_editor',
    'delete', 'deletefile', 'remove',
  ]
  if (fileTools.includes(nameLower)) {
    const basename = extractFileBasename(args)
    if (basename) return basename
  }

  // Bash / 执行类
  const execTools = ['bash', 'bashcommand', 'run_command', 'execute']
  if (execTools.includes(nameLower)) {
    const cmd = extractCommand(args, 40)
    if (cmd) return cmd
  }

  // 搜索类
  const searchTools = ['search', 'searchfiles', 'websearch', 'web_search']
  if (searchTools.includes(nameLower)) {
    const q = extractSearchQuery(args, 30)
    if (q) return q
  }

  // 网络请求类
  const webTools = ['webfetch', 'web_fetch', 'httprequest', 'http_request']
  if (webTools.includes(nameLower)) {
    const url = extractUrlBrief(args, 30)
    if (url) return url
  }

  // TodoWrite：提取统计
  if (nameLower === 'todowrite' && Array.isArray(args.todos)) {
    const todos = args.todos
    const total = todos.length
    const completed = todos.filter(t => t.status === 'completed').length
    if (completed === total && total > 0) {
      return `${total}个已完成`
    } else if (completed > 0) {
      return `${completed}/${total} (${Math.round(completed * 100 / total)}%)`
    } else {
      return `${total}个任务`
    }
  }

  // LSP：提取文件名
  if (nameLower === 'lsp') {
    const basename = extractFileBasename(args)
    if (basename) return basename
  }

  // 兜底：尝试文件名 → 命令 → 搜索词 → URL
  return extractFileBasename(args)
    || extractCommand(args, 40)
    || extractSearchQuery(args, 30)
    || extractUrlBrief(args, 30)
    || ''
}

/**
 * 从事件数据中解析工具参数和生成描述
 */
export function parseToolArgsFromEvent(eventData: {
  tool?: string
  content?: string
  message?: string
  error?: string
}): { toolName: string; brief: string } {
  const { tool, message, content } = eventData

  if (!tool) {
    // 非工具调用，直接返回消息预览
    const preview = message || content?.slice(0, 50) || ''
    return { toolName: '', brief: preview }
  }

  // 尝试从 message 中解析 JSON 参数
  let args: ToolArgs = {}

  if (message) {
    try {
      const parsed = JSON.parse(message)
      if (typeof parsed === 'object' && parsed !== null) {
        args = parsed as ToolArgs
      } else {
        // 不是对象，直接作为描述
        return { toolName: tool, brief: truncate(String(parsed), 50) }
      }
    } catch {
      // 不是 JSON，直接作为描述
      // 但要排除一些无意义的默认消息
      if (!message.match(/^(reading|writing|editing|running|executing)\s/i)) {
        return { toolName: tool, brief: truncate(message, 50) }
      }
    }
  }

  // 如果 args 为空，尝试从 content 中提取信息
  if (Object.keys(args).length === 0 && content) {
    // 尝试从 content 中匹配文件路径
    const pathMatch = content.match(/([/\\]?[\w\-./]+\.[\w]+)(?:\s|$|:)/)
    if (pathMatch) {
      return { toolName: tool, brief: extractBasename(pathMatch[1]) }
    }

    // 尝试匹配 "Reading xxx" 等模式
    const actionMatch = content.match(/(?:reading|writing|editing|running)\s+(.+)/i)
    if (actionMatch) {
      return { toolName: tool, brief: truncate(actionMatch[1], 50) }
    }
  }

  const brief = formatToolBrief(tool, args)
  return { toolName: tool, brief }
}

/**
 * 格式化工具调用显示文本
 * 返回格式: [工具名] 简短描述
 */
export function formatToolDisplay(eventData: {
  tool?: string
  content?: string
  message?: string
  error?: string
}): { toolPart: string; briefPart: string } {
  const { toolName, brief } = parseToolArgsFromEvent(eventData)

  if (!toolName) {
    return { toolPart: '', briefPart: brief }
  }

  return {
    toolPart: `[${toolName}]`,
    briefPart: brief,
  }
}
