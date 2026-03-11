/**
 * DeepSeek Tool Call Manager
 *
 * 工具调用管理器，负责：
 * - 将 DeepSeek 的工具调用桥接到 Tauri 后端
 * - 处理工具执行结果
 * - 管理工具执行错误
 * - 路径解析：将相对路径转换为绝对路径
 *
 * @author Polaris Team
 * @since 2025-01-24
 */

import { invoke } from '@tauri-apps/api/core'
import type { deepseekAnyConfig } from './session'

/**
 * 工具执行结果
 */
export interface ToolResult {
  /** 是否成功 */
  success: boolean
  /** 返回数据 */
  data?: any
  /** 错误信息 */
  error?: string
}

/**
 * 工具调用管理器

 * 将 DeepSeek 的工具调用转发到 Tauri 后端执行
 */
export class ToolCallManager {
  /** 会话 ID */
  private readonly sessionId: string

  /** 会话配置 */
  private readonly config: Pick<DeepSeekSessionConfig, 'workspaceDir'>

  /** .gitignore 规则缓存 */
  private gitignorePatterns: string[] = []

  /**
   * 构造函数
   *
   * @param sessionId - 会话 ID
   * @param config - 会话配置
   */
  constructor(sessionId: string, config: Pick<DeepSeekSessionConfig, 'workspaceDir'>) {
    this.sessionId = sessionId
    this.config = config
    this.loadGitignorePatterns()
  }

  /**
   * 加载 .gitignore 规则
   */
  private async loadGitignorePatterns(): Promise<void> {
    if (!this.config.workspaceDir) return

    try {
      const gitignorePath = `${this.config.workspaceDir}/.gitignore`
      const content = await invoke<string>('read_file', { path: gitignorePath })

      // 解析 .gitignore 内容
      this.gitignorePatterns = content
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line && !line.startsWith('#'))
    } catch {
      // 使用默认忽略规则
      this.gitignorePatterns = [
        'node_modules/**',
        'dist/**',
        'build/**',
        '.git/**',
        '*.log',
        '.DS_Store',
        '*.min.js',
        '*.min.css',
        '__pycache__/**',
        '*.pyc',
        '.venv/**',
        'venv/**',
        '.vscode/**',
        '.idea/**',
      ]
    }
  }

  /**
   * 检查文件是否应该被忽略
   */
  private shouldIgnoreFile(filePath: string): boolean {
    const relativePath = filePath.replace(this.config.workspaceDir + '/', '')

    for (const pattern of this.gitignorePatterns) {
      // 简单的 glob 匹配
      const regexPattern = pattern
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')

      const regex = new RegExp(regexPattern)
      if (regex.test(relativePath)) {
        return true
      }
    }

    return false
  }

  /**
   * 解析路径（将相对路径转换为绝对路径）
   *
   * @param path - 文件路径
   * @returns 绝对路径
   */
  private resolvePath(path: string): string {
    console.log(`[resolvePath] 📍 输入路径: "${path}"`, {
      hasWorkspaceDir: !!this.config.workspaceDir,
      workspaceDir: this.config.workspaceDir,
    })

    if (!this.config.workspaceDir) {
      console.warn(`[resolvePath] ⚠️ 未配置工作区目录，使用原始路径`)
      return path
    }

    // 检测是否是绝对路径
    const isAbsolute = path.startsWith('/') || path.match(/^[A-Za-z]:\\/)

    if (isAbsolute) {
      // 检查是否是工作区内的绝对路径
      if (path.startsWith(this.config.workspaceDir)) {
        // 工作区内绝对路径，给出建议
        const relative = path.slice(this.config.workspaceDir.length).replace(/^[\/\\]/, '')
        console.warn(`[resolvePath] ⚠️ 检测到工作区绝对路径，建议使用相对路径: "${relative}"`)
        console.log(`[resolvePath] ✅ 解析为: "${path}"`)
        return path
      } else {
        // 外部绝对路径
        console.warn(`[resolvePath] ⚠️ 检测到外部绝对路径: "${path}"`)
        return path
      }
    }

    // 相对路径，拼接工作区目录
    const resolved = `${this.config.workspaceDir}/${path}`
    console.log(`[resolvePath] ✅ 相对路径解析为: "${resolved}"`)
    return resolved
  }

  /**
   * 执行工具调用
   *
   * @param toolName - 工具名称
   * @param args - 工具参数
   * @returns 工具执行结果
   */
  async executeTool(toolName: string, args: Record<string, any>): Promise<ToolResult> {
    console.log(`[ToolCallManager] Executing: ${toolName}`, args)

    try {
      switch (toolName) {
        // ===== 文件操作 =====
        case 'read_file':
          return await this.readFile(this.resolvePath(args.path))

        case 'write_file':
          return await this.writeFile(this.resolvePath(args.path), args.content)

        case 'edit_file':
          // DeepSeek API 返回 camelCase (oldStr/newStr)，符合 Tauri 2.0 规范
          if (!args.oldStr || !args.newStr) {
            return {
              success: false,
              error: 'edit_file 缺少必需参数 oldStr 和 newStr',
            }
          }
          return await this.editFile(this.resolvePath(args.path), args.oldStr, args.newStr)

        case 'list_files':
          return await this.listFiles(args.path ? this.resolvePath(args.path) : undefined, args.recursive)

        // ===== Bash =====
        case 'bash':
          return await this.executeBash(args.command)

        // ===== Git =====
        case 'git_status':
          return await this.gitStatus()

        case 'git_diff':
          // DeepSeek API 返回 camelCase (cached)，符合 Tauri 2.0 规范
          return await this.gitDiff(args.path, args.cached)

        case 'git_log':
          // DeepSeek API 返回 camelCase (maxCount)，符合 Tauri 2.0 规范
          return await this.gitLog(args.maxCount)

        // ===== Todo =====
        case 'todo_add':
          return await this.todoAdd(args.content, args.priority)

        case 'todo_list':
          return await this.todoList(args.status)

        case 'todo_complete':
          return await this.todoComplete(args.id)

        case 'todo_delete':
          return await this.todoDelete(args.id)

        // ===== 搜索 =====
        case 'search_files':
          return await this.searchFiles(args.pattern, args.path ? this.resolvePath(args.path) : undefined)

        case 'search_code':
          return await this.searchCode(args.query, args.path ? this.resolvePath(args.path) : undefined, args.file_pattern)

        default:
          return {
            success: false,
            error: `Unknown tool: ${toolName}`,
          }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`[ToolCallManager] Tool ${toolName} failed:`, errorMsg)
      return {
        success: false,
        error: errorMsg,
      }
    }
  }

  // ==================== 文件操作实现 ====================

  /**
   * 读取文件
   */
  private async readFile(path: string): Promise<ToolResult> {
    try {
      const content = await invoke<string>('read_file', { path })
      return {
        success: true,
        data: content,
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('读取文件失败', error),
      }
    }
  }

  /**
   * 写入文件
   */
  private async writeFile(path: string, content: string): Promise<ToolResult> {
    try {
      await invoke('write_file', { path, content })
      return {
        success: true,
        data: `Successfully wrote to ${path}`,
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('写入文件失败', error),
      }
    }
  }

  /**
   * 编辑文件
   */
  private async editFile(path: string, oldStr: string, newStr: string): Promise<ToolResult> {
    try {
      // Tauri 2.0 会自动将 camelCase 转换为 snake_case
      // 所以这里直接传递 oldStr, newStr 即可
      await invoke('edit_file', { path, oldStr, newStr })
      return {
        success: true,
        data: `Successfully edited ${path}`,
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('编辑文件失败', error),
      }
    }
  }

  /**
   * 列出文件
   */
  private async listFiles(path?: string, recursive?: boolean): Promise<ToolResult> {
    try {
      // 如果没有指定路径，使用工作区根目录
      const targetPath = path || this.config.workspaceDir || '.'

      // 限制返回文件数量，避免扫描过多文件
      const limit = recursive ? 1000 : 100

      // 读取目录结构
      const allFiles = await invoke<string[]>('list_directory', {
        path: targetPath,
        recursive: recursive || false,
        limit,
      })

      // 应用 .gitignore 过滤
      const filteredFiles = allFiles.filter(file => !this.shouldIgnoreFile(file))

      return {
        success: true,
        data: filteredFiles,
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('列出文件失败', error),
      }
    }
  }

  // ==================== Bash 实现 ====================

  /**
   * 执行 Bash 命令
   */
  private async executeBash(command: string): Promise<ToolResult> {
    try {
      // Tauri 2.0 会自动将 camelCase 转换为 snake_case
      const result = await invoke<{
        stdout: string
        stderr: string
        exit_code: number | null
      }>('execute_bash', {
        command,
        sessionId: this.sessionId,
        workDir: this.config.workspaceDir || undefined, // 传递工作区目录
      })

      // 检查退出码
      if (result.exit_code !== 0 && result.exit_code !== null) {
        return {
          success: false,
          error: `Command failed with exit code ${result.exit_code}`,
          data: {
            stdout: result.stdout,
            stderr: result.stderr,
          },
        }
      }

      return {
        success: true,
        data: {
          stdout: result.stdout,
          stderr: result.stderr,
        },
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('执行命令失败', error),
      }
    }
  }

  // ==================== Git 实现 ====================

  /**
   * Git 状态
   */
  private async gitStatus(): Promise<ToolResult> {
    try {
      const result = await this.executeBash('git status --porcelain')

      if (!result.success) {
        return result
      }

      // 解析 git status 输出
      const stdout = result.data?.stdout || ''
      const lines = stdout.trim().split('\n').filter((line: string) => line.trim())

      const files = lines.map((line: string) => {
        const status = line.slice(0, 2).trim()
        const path = line.slice(3)
        return { status, path }
      })

      return {
        success: true,
        data: {
          files,
          summary: {
            modified: files.filter((f: { status: string }) => f.status.includes('M')).length,
            added: files.filter((f: { status: string }) => f.status.includes('A')).length,
            deleted: files.filter((f: { status: string }) => f.status.includes('D')).length,
            untracked: files.filter((f: { status: string }) => f.status.includes('?')).length,
          },
        },
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('获取 Git 状态失败', error),
      }
    }
  }

  /**
   * Git Diff
   */
  private async gitDiff(path?: string, cached?: boolean): Promise<ToolResult> {
    try {
      let command = 'git diff'

      if (cached) {
        command += ' --cached'
      }

      if (path) {
        command += ` ${path}`
      }

      return await this.executeBash(command)
    } catch (error) {
      return {
        success: false,
        error: this.formatError('获取 Git diff 失败', error),
      }
    }
  }

  /**
   * Git Log
   */
  private async gitLog(maxCount?: number): Promise<ToolResult> {
    try {
      const count = maxCount || 10
      const command = `git log -n ${count} --pretty=format:"%H|%an|%ad|%s" --date=iso`

      return await this.executeBash(command)
    } catch (error) {
      return {
        success: false,
        error: this.formatError('获取 Git log 失败', error),
      }
    }
  }

  // ==================== Todo 实现 ====================

  /**
   * 添加待办事项
   */
  private async todoAdd(content: string, priority?: string): Promise<ToolResult> {
    try {
      // 使用现有的 todo store (通过 Tauri 事件或直接调用)
      await invoke('plugin:todo|add', {
        content,
        priority: priority || 'normal',
      })

      return {
        success: true,
        data: `Added todo: ${content}`,
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('添加待办失败', error),
      }
    }
  }

  /**
   * 列出待办事项
   */
  private async todoList(status?: string): Promise<ToolResult> {
    try {
      const todos = await invoke('plugin:todo|list', {
        status: status || 'all',
      })

      return {
        success: true,
        data: todos,
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('获取待办列表失败', error),
      }
    }
  }

  /**
   * 完成待办事项
   */
  private async todoComplete(id: string): Promise<ToolResult> {
    try {
      await invoke('plugin:todo|complete', { id })

      return {
        success: true,
        data: `Marked todo ${id} as complete`,
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('完成待办失败', error),
      }
    }
  }

  /**
   * 删除待办事项
   */
  private async todoDelete(id: string): Promise<ToolResult> {
    try {
      await invoke('plugin:todo|delete', { id })

      return {
        success: true,
        data: `Deleted todo ${id}`,
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('删除待办失败', error),
      }
    }
  }

  // ==================== 搜索实现 ====================

  /**
   * 搜索文件
   */
  private async searchFiles(pattern: string, path?: string): Promise<ToolResult> {
    try {
      const targetPath = path || this.config.workspaceDir || '.'

      // 使用 ripgrep 或 find
      // 在 Tauri 中，我们统一使用 find 命令（跨平台）
      const command = `find "${targetPath}" -name "${pattern}"`

      return await this.executeBash(command)
    } catch (error) {
      return {
        success: false,
        error: this.formatError('搜索文件失败', error),
      }
    }
  }

  /**
   * 搜索代码
   */
  private async searchCode(
    query: string,
    path?: string,
    filePattern?: string
  ): Promise<ToolResult> {
    try {
      const targetPath = path || this.config.workspaceDir || '.'

      // 使用 ripgrep (rg) 或 grep
      let command = 'rg'

      if (filePattern) {
        command += ` -g "${filePattern}"`
      }

      command += ` "${query}" "${targetPath}"`

      // 如果 rg 不可用，回退到 grep
      try {
        return await this.executeBash(command)
      } catch {
        const grepCmd = `grep -r "${query}" "${targetPath}" ${filePattern ? `--include="${filePattern}"` : ''}`
        return await this.executeBash(grepCmd)
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('搜索代码失败', error),
      }
    }
  }

  // ==================== 辅助方法 ====================

  /**
   * 格式化错误信息
   */
  private formatError(prefix: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return `${prefix}: ${message}`
  }
}
