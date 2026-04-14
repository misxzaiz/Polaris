# Claude Code 执行日志简洁显示方案

## 一、需求理解

参考项目中飞书/QQ机器人的消息格式（`src-tauri/src/integrations/manager.rs`）：

```
[Read] parser.ts
[Edit] parser.ts +15/-3 完成 ✅
[Bash] npm run build 完成 ✅
```

核心格式：`[工具名] 简短描述 状态`

---

## 二、当前问题

**当前 EventItem 显示** (`ClaudeCodeSessionPanel.tsx:448-471`):
```tsx
if (event.data.tool) {
  return (
    <span>
      <span className="text-primary">{event.data.tool}</span>
      {event.data.message && (
        <span className="text-text-muted ml-1">- {event.data.message}</span>
      )}
    </span>
  )
}
```

问题：
1. `event.data.message` 是原始消息，可能很长且不简洁
2. 没有从 args 中提取关键信息（文件名、命令等）
3. 状态标识不明显

---

## 三、实现方案

### 3.1 新增工具信息提取函数

**文件**: `src/assistant/utils/toolInfoExtractor.ts`

```typescript
/**
 * 从工具参数中提取关键信息
 * 对应后端 manager.rs 中的 format_tool_brief()
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
}

/**
 * 安全截断字符串
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

/**
 * 从路径提取文件名
 */
function extractBasename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

/**
 * 提取文件名（从各种可能的参数名）
 */
function extractFileBasename(args: ToolArgs): string | undefined {
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'file'] as const) {
    const val = args[key]
    if (val && typeof val === 'string') {
      return extractBasename(val)
    }
  }
  return undefined
}

/**
 * 提取命令
 */
function extractCommand(args: ToolArgs, maxLen: number): string | undefined {
  for (const key of ['command', 'cmd', 'command_string'] as const) {
    const val = args[key]
    if (val && typeof val === 'string') {
      return truncate(val, maxLen)
    }
  }
  return undefined
}

/**
 * 提取搜索词
 */
function extractSearchQuery(args: ToolArgs, maxLen: number): string | undefined {
  for (const key of ['query', 'q', 'search', 'keyword', 'pattern', 'regex'] as const) {
    const val = args[key]
    if (val && typeof val === 'string') {
      return truncate(val, maxLen)
    }
  }
  return undefined
}

/**
 * 提取 URL 简称
 */
function extractUrlBrief(args: ToolArgs, maxLen: number): string | undefined {
  for (const key of ['url', 'uri', 'href'] as const) {
    const val = args[key]
    if (val && typeof val === 'string') {
      // 简化显示：取 hostname + 路径前段
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
    if (skill) {
      // 取最后一部分作为名称
      return skill.split(':').pop() || skill
    }
  }

  // Task / Agent 工具：提取 prompt 或 description
  if (nameLower === 'task' || nameLower === 'agent') {
    if (args.prompt) return truncate(args.prompt, 50)
    if (args.description) return truncate(args.description, 50)
  }

  // AskUserQuestion：提取问题
  if (nameLower === 'askuserquestion') {
    if (args.description) return args.description
    // 可能还有其他字段，根据实际情况扩展
  }

  // Glob：优先取 pattern
  if (toolName === 'Glob') {
    if (args.pattern) return truncate(args.pattern, 40)
  }

  // 文件类工具（Read / Write / Edit / Delete）
  if (['read', 'readfile', 'read_file', 'write', 'writefile', 'write_file', 
       'create_file', 'edit', 'edit3', 'str_replace_editor', 'delete', 
       'deletefile', 'remove'].includes(nameLower)) {
    const basename = extractFileBasename(args)
    if (basename) return basename
  }

  // Bash / 执行类
  if (['bash', 'bashcommand', 'run_command', 'execute'].includes(nameLower)) {
    const cmd = extractCommand(args, 40)
    if (cmd) return cmd
  }

  // Grep / 搜索类
  if (['grep', 'search', 'searchfiles', 'websearch', 'web_search'].includes(nameLower)) {
    const q = extractSearchQuery(args, 30)
    if (q) return q
  }

  // 网络请求类
  if (['webfetch', 'web_fetch', 'httprequest', 'http_request'].includes(nameLower)) {
    const url = extractUrlBrief(args, 30)
    if (url) return url
  }

  // TodoWrite：提取统计
  if (nameLower === 'todowrite' && args.todos) {
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

  // 兜底：尝试文件名 → 命令 → 搜索词
  return extractFileBasename(args) 
    || extractCommand(args, 40) 
    || extractSearchQuery(args, 30) 
    || ''
}

/**
 * 从事件数据中解析工具参数
 */
export function parseToolArgsFromEvent(eventData: {
  tool?: string
  content?: string
  message?: string
  error?: string
}): { toolName: string; brief: string } {
  const { tool, message, content } = eventData
  
  if (!tool) {
    return { toolName: '', brief: message || content?.slice(0, 50) || '' }
  }
  
  // 尝试从 message 中解析 JSON 参数
  let args: ToolArgs = {}
  if (message) {
    try {
      // 尝试解析 JSON
      const parsed = JSON.parse(message)
      if (typeof parsed === 'object' && parsed !== null) {
        args = parsed
      } else {
        // 不是 JSON，直接作为描述
        return { toolName: tool, brief: truncate(message, 50) }
      }
    } catch {
      // 不是 JSON，直接作为描述
      return { toolName: tool, brief: truncate(message, 50) }
    }
  }
  
  // 如果 args 为空，尝试从 content 解析
  if (Object.keys(args).length === 0 && content) {
    // 从 content 中提取信息（例如 "Reading file.ts"）
    const match = content.match(/(?:reading|writing|editing|running)\s+(.+)/i)
    if (match) {
      return { toolName: tool, brief: truncate(match[1], 50) }
    }
  }
  
  const brief = formatToolBrief(tool, args)
  return { toolName: tool, brief }
}
```

### 3.2 修改 EventItem 组件

**文件**: `src/assistant/components/ClaudeCodeSessionPanel.tsx`

```tsx
import { parseToolArgsFromEvent } from '../utils/toolInfoExtractor'

/**
 * 单个事件项
 */
function EventItem({ event }: { event: ClaudeCodeExecutionEvent }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const time = new Date(event.timestamp).toLocaleTimeString()

  const getIcon = () => {
    switch (event.type) {
      case 'tool_call':
        return <Wrench className="w-3 h-3 text-primary" />
      case 'assistant_message':
        return <FileText className="w-3 h-3 text-text-secondary" />
      case 'session_start':
        return <Loader2 className="w-3 h-3 text-primary animate-spin" />
      case 'session_end':
        return <CheckCircle className="w-3 h-3 text-success" />
      case 'error':
        return <XCircle className="w-3 h-3 text-danger" />
      case 'complete':
        return <CheckCircle className="w-3 h-3 text-success" />
      default:
        return <Code className="w-3 h-3 text-text-muted" />
    }
  }

  const getContent = () => {
    // 错误优先
    if (event.data.error) {
      return (
        <span>
          <span className="text-danger">错误: </span>
          <span className="text-text-secondary">{event.data.error}</span>
        </span>
      )
    }
    
    // 工具调用 - 使用简洁格式
    if (event.data.tool) {
      const { toolName, brief } = parseToolArgsFromEvent(event.data)
      
      // 判断是否完成
      const isComplete = event.type === 'complete'
      const statusText = isComplete ? ' ✓' : ''
      
      return (
        <span>
          <span className="text-primary font-mono">[{toolName}]</span>
          {brief && <span className="text-text-secondary ml-1">{brief}</span>}
          {statusText && <span className="text-success ml-1">{statusText}</span>}
        </span>
      )
    }
    
    // AI 消息 - 显示预览
    if (event.data.content) {
      const content = event.data.content
      const truncated = content.length > 80 ? content.slice(0, 80) + '...' : content
      return (
        <span className="text-text-primary whitespace-pre-wrap">
          {truncated}
        </span>
      )
    }
    
    // 普通消息
    if (event.data.message) {
      return (
        <span className="text-text-secondary">{event.data.message}</span>
      )
    }
    
    return null
  }

  const hasLongContent = (event.data.content?.length || 0) > 80
  const fullContent = event.data.content || ''

  return (
    <div className="text-xs">
      <div
        className={cn(
          'flex items-start gap-2 py-0.5 hover:bg-background-hover px-1 rounded',
          hasLongContent && 'cursor-pointer'
        )}
        onClick={() => hasLongContent && setIsExpanded(!isExpanded)}
      >
        <span className="text-text-tertiary shrink-0 w-14 font-mono">{time}</span>
        <span className="shrink-0 mt-0.5">{getIcon()}</span>
        <span className="flex-1 min-w-0">{getContent()}</span>
        {hasLongContent && (
          <span className="shrink-0 text-text-muted">
            {isExpanded ? (
              <ChevronLeft className="w-3 h-3 rotate-90" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </span>
        )}
      </div>
      {/* 展开的完整内容 */}
      {isExpanded && hasLongContent && (
        <div className="ml-[72px] mt-1 p-2 bg-background-base rounded border border-border-subtle">
          <pre className="text-xs text-text-primary whitespace-pre-wrap break-all font-mono">
            {fullContent}
          </pre>
        </div>
      )}
    </div>
  )
}
```

---

## 四、效果对比

### 改造前

```
14:32:15 🔧 Read - Reading file...
14:32:16 🔧 Edit - Applying changes to file...
14:32:18 📝 This is a very long message that goes on and on...
```

### 改造后

```
14:32:15 🔧 [Read] parser.ts
14:32:16 🔧 [Edit] parser.ts ✓
14:32:18 📝 This is a very long message that goes on and on...
```

---

## 五、文件变更

```
新增:
└── src/assistant/utils/toolInfoExtractor.ts

修改:
└── src/assistant/components/ClaudeCodeSessionPanel.tsx
    - 导入 parseToolArgsFromEvent
    - 重构 EventItem 组件的 getContent() 方法
```

---

## 六、工作量估算

约 **1-2 小时**，主要是：
1. 实现 `toolInfoExtractor.ts`（参考后端 `format_tool_brief`）
2. 修改 `EventItem` 组件
3. 测试验证
