/**
 * DeepSeek Tool Schemas
 *
 * 定义所有可供 DeepSeek 调用的工具 Schema。
 * 遵循 OpenAI Function Calling 格式（DeepSeek 兼容）。
 *
 * @author Polaris Team
 * @since 2025-01-24
 */

/**
 * DeepSeek Tool Schema 格式
 */
interface DeepSeekToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters?: {
      type: 'object'
      properties?: Record<string, {
        type: string
        description: string
        enum?: string[]
        items?: any
      }>
      required?: string[]
      additionalProperties?: boolean
    }
    strict?: boolean
  }
}

// ==================== 工具定义 ====================

/**
 * 读取文件工具
 */
const READ_FILE_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取文件内容',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对路径',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
}

/**
 * 批量读取文件工具
 */
const READ_MANY_FILES_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'read_many_files',
    description: '批量读取文件内容',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: '文件路径列表（相对路径）',
        },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
}

/**
 * 读取图片工具
 */
const IMAGE_READ_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'image_read',
    description: '读取图片内容（当前仅支持通过文件路径读取）',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '图片路径（相对路径）',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
}

/**
 * 写入文件工具
 */
const WRITE_FILE_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'write_file',
    description: '创建或覆盖文件',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对路径',
        },
        content: {
          type: 'string',
          description: '文件内容',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
}

/**
 * 编辑文件工具
 */
const EDIT_FILE_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'edit_file',
    description: '精确编辑文件（文本替换）',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对路径',
        },
        oldStr: {
          type: 'string',
          description: '原文（精确匹配）',
        },
        newStr: {
          type: 'string',
          description: '新文本',
        },
      },
      required: ['path', 'oldStr', 'newStr'],
      additionalProperties: false,
    },
  },
}

/**
 * 替换工具（别名）
 */
const REPLACE_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'replace',
    description: '编辑文件（与 edit_file 等价）',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对路径',
        },
        oldStr: {
          type: 'string',
          description: '原文（精确匹配）',
        },
        newStr: {
          type: 'string',
          description: '新文本',
        },
      },
      required: ['path', 'oldStr', 'newStr'],
      additionalProperties: false,
    },
  },
}

/**
 * 多文件编辑工具
 */
const MULTI_EDIT_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'multi_edit',
    description: '批量编辑多个文件',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: '编辑列表',
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
  },
}

/**
 * 列出文件工具
 */
const LIST_FILES_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'list_files',
    description: '列出目录文件',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录路径（相对路径）',
        },
        recursive: {
          type: 'boolean',
          description: '是否递归',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
}

/**
 * 列出目录工具（别名）
 */
const LIST_DIRECTORY_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'list_directory',
    description: '列出目录内容（与 list_files 等价）',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录路径（相对路径）',
        },
        recursive: {
          type: 'boolean',
          description: '是否递归',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
}

/**
 * XML 转义工具
 */
const XML_ESCAPE_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'xml_escape',
    description: '对文本进行 XML 转义',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '输入文本',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
}

/**
 * Bash 工具
 */
const BASH_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'bash',
    description: '执行 shell 命令（工作目录已设置为工作区，避免使用 cd）',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '命令内容',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
}

/**
 * 运行 Shell 命令工具（别名）
 */
const RUN_SHELL_COMMAND_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'run_shell_command',
    description: '执行 shell 命令（与 bash 等价）',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '命令内容',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
}

/**
 * Git 状态工具
 */
const GIT_STATUS_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'git_status',
    description: '获取 Git 状态',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
}

/**
 * Git Diff 工具
 */
const GIT_DIFF_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'git_diff',
    description: '查看 Git diff',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径',
        },
        cached: {
          type: 'boolean',
          description: '暂存区 diff',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
}

/**
 * Git Log 工具
 */
const GIT_LOG_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'git_log',
    description: '查看 Git 提交历史',
    parameters: {
      type: 'object',
      properties: {
        maxCount: {
          type: 'number',
          description: '返回数量',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
}

/**
 * Todo 添加工具
 */
const TODO_ADD_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'todo_add',
    description: '添加待办',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '待办内容',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          description: '优先级',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
}

/**
 * Todo 读取工具（别名）
 */
const TODO_READ_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'todo_read',
    description: '读取待办（与 todo_list 等价）',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'all'],
          description: '状态筛选',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
}

/**
 * Todo 写入工具（别名）
 */
const TODO_WRITE_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'todo_write',
    description: '写入待办（与 todo_add 等价）',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '待办内容',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          description: '优先级',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
}

/**
 * Todo 列表工具
 */
const TODO_LIST_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'todo_list',
    description: '列出待办',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'all'],
          description: '状态筛选',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
}

/**
 * Todo 完成工具
 */
const TODO_COMPLETE_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'todo_complete',
    description: '完成待办',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '待办 ID',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
}

/**
 * Todo 删除工具
 */
const TODO_DELETE_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'todo_delete',
    description: '删除待办',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '待办 ID',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
}

/**
 * 搜索文件工具
 */
const SEARCH_FILES_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'search_files',
    description: '按文件名搜索',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '搜索模式（支持 *）',
        },
        path: {
          type: 'string',
          description: '搜索目录',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
}

/**
 * 搜索代码工具
 */
const SEARCH_CODE_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'search_code',
    description: '在文件内容中搜索',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索内容',
        },
        path: {
          type: 'string',
          description: '搜索目录',
        },
        file_pattern: {
          type: 'string',
          description: '文件模式过滤',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
}

/**
 * 搜索文件内容工具（别名）
 */
const SEARCH_FILE_CONTENT_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'search_file_content',
    description: '在文件内容中搜索（与 search_code 等价）',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索内容',
        },
        path: {
          type: 'string',
          description: '搜索目录',
        },
        file_pattern: {
          type: 'string',
          description: '文件模式过滤',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
}

/**
 * Glob 匹配工具（别名）
 */
const GLOB_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'glob',
    description: '按模式匹配文件（与 search_files 等价）',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '搜索模式（支持 *）',
        },
        path: {
          type: 'string',
          description: '搜索目录',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
}

/**
 * Web 搜索工具
 */
const WEB_SEARCH_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '网络搜索（返回简要结果）',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索内容',
        },
        count: {
          type: 'number',
          description: '返回数量（1-10）',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
}

/**
 * Web 抓取工具
 */
const WEB_FETCH_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description: '获取网页内容',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '网页 URL',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
}

/**
 * 任务工具
 */
const TASK_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'task',
    description: '执行子任务（当前实现为简单记录）',
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: '任务输入',
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
  },
}

/**
 * Skill 工具
 */
const SKILL_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'Skill',
    description: '执行技能（读取工作区 .codex/skills）',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '技能名称',
        },
        input: {
          type: 'string',
          description: '技能输入',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
}

/**
 * 读取命令输出工具
 */
const READ_COMMAND_OUTPUT_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'ReadCommandOutput',
    description: '读取命令输出',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '输出 ID',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
}

/**
 * 退出规划模式工具
 */
const EXIT_PLAN_MODE_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'exit_plan_mode',
    description: '退出规划模式',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
}

/**
 * 询问用户问题工具
 */
const ASK_USER_QUESTION_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'ask_user_question',
    description: '询问用户问题',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '问题内容',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
}

/**
 * 保存记忆工具
 */
const SAVE_MEMORY_TOOL: DeepSeekToolSchema = {
  type: 'function',
  function: {
    name: 'save_memory',
    description: '保存记忆',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '记忆内容',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
}

// ==================== 导出 ====================

/**
 * 所有工具 Schema 列表
 */
export const TOOL_SCHEMAS: DeepSeekToolSchema[] = [
  // ===== 文件操作工具 =====
  READ_FILE_TOOL,
  READ_MANY_FILES_TOOL,
  IMAGE_READ_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  REPLACE_TOOL,
  MULTI_EDIT_TOOL,
  LIST_FILES_TOOL,
  LIST_DIRECTORY_TOOL,
  XML_ESCAPE_TOOL,

  // ===== Bash 工具 =====
  BASH_TOOL,
  RUN_SHELL_COMMAND_TOOL,

  // ===== Git 工具 =====
  GIT_STATUS_TOOL,
  GIT_DIFF_TOOL,
  GIT_LOG_TOOL,

  // ===== Todo 工具 =====
  TODO_ADD_TOOL,
  TODO_LIST_TOOL,
  TODO_COMPLETE_TOOL,
  TODO_DELETE_TOOL,
  TODO_READ_TOOL,
  TODO_WRITE_TOOL,

  // ===== 搜索工具 =====
  SEARCH_FILES_TOOL,
  SEARCH_CODE_TOOL,
  SEARCH_FILE_CONTENT_TOOL,
  GLOB_TOOL,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,

  // ===== 其他工具（占位）=====
  TASK_TOOL,
  SKILL_TOOL,
  READ_COMMAND_OUTPUT_TOOL,
  EXIT_PLAN_MODE_TOOL,
  ASK_USER_QUESTION_TOOL,
  SAVE_MEMORY_TOOL,
]

/**
 * 生成 DeepSeek Tool Calls 格式的工具 Schema 列表
 *
 * @returns 工具 Schema 数组
 */
export function generateToolSchemas(): Array<any> {
  return TOOL_SCHEMAS
}

/**
 * 根据意图生成工具 Schema 列表（按需优化）
 *
 * @param requiredTools - 需要的工具名称列表
 * @returns 工具 Schema 数组
 */
export function generateToolSchemasForIntent(requiredTools: string[]): Array<any> {
  if (!requiredTools || requiredTools.length === 0) {
    // 如果没有指定工具，返回空数组（不发送任何工具）
    return []
  }

  const alwaysAvailable = [
    'read_many_files',
    'image_read',
    'replace',
    'multi_edit',
    'list_directory',
    'xml_escape',
    'run_shell_command',
    'todo_read',
    'todo_write',
    'search_file_content',
    'glob',
    'web_search',
    'web_fetch',
    'ask_user_question',
    'save_memory',
    'task',
    'Skill',
    'ReadCommandOutput',
    'exit_plan_mode',
  ]

  const toolSet = new Set([...requiredTools, ...alwaysAvailable])

  // 只返回需要的工具 + 始终可用工具
  return TOOL_SCHEMAS.filter(tool => toolSet.has(tool.function.name))
}

/**
 * 根据名称获取工具 Schema
 *
 * @param name - 工具名称
 * @returns 工具 Schema，不存在返回 undefined
 */
export function getToolSchema(name: string): DeepSeekToolSchema | undefined {
  return TOOL_SCHEMAS.find(tool => tool.function.name === name)
}

/**
 * 获取所有工具名称列表
 *
 * @returns 工具名称数组
 */
export function getToolNames(): string[] {
  return TOOL_SCHEMAS.map(tool => tool.function.name)
}

/**
 * 检查工具是否存在
 *
 * @param name - 工具名称
 * @returns 工具是否存在
 */
export function hasTool(name: string): boolean {
  return TOOL_SCHEMAS.some(tool => tool.function.name === name)
}
