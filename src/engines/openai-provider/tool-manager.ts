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
  private readonly config: Pick<{ workspaceDir?: string }, 'workspaceDir'>

  /** .gitignore 规则缓存 */
  private gitignorePatterns: string[] = []

  /** 命令输出缓存（用于 ReadCommandOutput） */
  private commandOutputCache = new Map<string, { stdout: string; stderr: string }>()
  private commandOutputCounter = 0

  /**
   * 构造函数
   *
   * @param sessionId - 会话 ID
   * @param config - 会话配置
   */
  constructor(sessionId: string, config: Pick<{ workspaceDir?: string }, 'workspaceDir'>) {
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
      // 规范化路径，避免混合斜杠
      const normalizedWorkspace = this.normalizePath(this.config.workspaceDir)
      const gitignorePath = `${normalizedWorkspace}/.gitignore`
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
    if (!this.config.workspaceDir) return false

    // 规范化路径进行比较
    const normalizedWorkspace = this.normalizePath(this.config.workspaceDir)
    const normalizedPath = this.normalizePath(filePath)
    const relativePath = normalizedPath.replace(normalizedWorkspace + '/', '')

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
   * 规范化路径（统一使用正斜杠）
   *
   * @param path - 原始路径
   * @returns 规范化后的路径
   */
  private normalizePath(path: string): string {
    // 将反斜杠替换为正斜杠（Windows 兼容）
    return path.replace(/\\/g, '/')
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
      return this.normalizePath(path)
    }

    // 规范化工作区目录
    const normalizedWorkspace = this.normalizePath(this.config.workspaceDir)

    // 检测是否是绝对路径
    const isAbsolute = path.startsWith('/') || path.match(/^[A-Za-z]:/i)

    if (isAbsolute) {
      // 规范化输入的绝对路径
      const normalizedPath = this.normalizePath(path)

      // 检查是否是工作区内的绝对路径
      if (normalizedPath.startsWith(normalizedWorkspace)) {
        // 工作区内绝对路径，给出建议
        const relative = normalizedPath.slice(normalizedWorkspace.length).replace(/^\//, '')
        console.warn(`[resolvePath] ⚠️ 检测到工作区绝对路径，建议使用相对路径: "${relative}"`)
        console.log(`[resolvePath] ✅ 解析为: "${normalizedPath}"`)
        return normalizedPath
      } else {
        // 外部绝对路径
        console.warn(`[resolvePath] ⚠️ 检测到外部绝对路径: "${normalizedPath}"`)
        return normalizedPath
      }
    }

    // 相对路径，拼接工作区目录（使用正斜杠）
    const resolved = `${normalizedWorkspace}/${path}`
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

        case 'read_many_files':
          return await this.readManyFiles(args.paths)

        case 'image_read':
          return await this.readImage(args.path)

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

        case 'replace':
          if (!args.oldStr || !args.newStr) {
            return {
              success: false,
              error: 'replace 缺少必需参数 oldStr 和 newStr',
            }
          }
          return await this.editFile(this.resolvePath(args.path), args.oldStr, args.newStr)

        case 'multi_edit':
          return await this.multiEdit(args.edits)

        case 'list_files':
          return await this.listFiles(args.path ? this.resolvePath(args.path) : undefined, args.recursive)

        case 'list_directory':
          return await this.listFiles(args.path ? this.resolvePath(args.path) : undefined, args.recursive)

        case 'xml_escape':
          return await this.xmlEscape(args.text)

        // ===== Bash =====
        case 'bash':
          return await this.executeBash(args.command)

        case 'run_shell_command':
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

        case 'todo_read':
          return await this.todoList(args.status)

        case 'todo_write':
          return await this.todoAdd(args.content, args.priority)

        // ===== 搜索 =====
        case 'search_files':
          return await this.searchFiles(args.pattern, args.path ? this.resolvePath(args.path) : undefined)

        case 'search_code':
          return await this.searchCode(args.query, args.path ? this.resolvePath(args.path) : undefined, args.file_pattern)

        case 'search_file_content':
          return await this.searchCode(args.query, args.path ? this.resolvePath(args.path) : undefined, args.file_pattern)

        case 'glob':
          return await this.searchFiles(args.pattern, args.path ? this.resolvePath(args.path) : undefined)

        case 'web_search':
          return await this.webSearch(args.query, args.count)

        case 'web_fetch':
          return await this.webFetch(args.url)

        case 'ask_user_question':
          return await this.askUserQuestion(args.question)

        case 'ReadCommandOutput':
          return await this.readCommandOutput(args.id)

        case 'save_memory':
          return await this.saveMemory(args.content)

        case 'task':
          return await this.runTask(args.input)

        case 'Skill':
          return await this.runSkill(args.name)

        case 'exit_plan_mode':
          return {
            success: true,
            data: { exited: true },
          }

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
   * 批量读取文件
   */
  private async readManyFiles(paths: string[] | undefined): Promise<ToolResult> {
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return {
        success: false,
        error: 'read_many_files 缺少必需参数 paths',
      }
    }

    const results: Record<string, { success: boolean; data?: string; error?: string }> = {}

    for (const rawPath of paths) {
      const targetPath = this.resolvePath(rawPath)
      const res = await this.readFile(targetPath)
      if (res.success) {
        results[rawPath] = { success: true, data: res.data as string }
      } else {
        results[rawPath] = { success: false, error: res.error }
      }
    }

    return {
      success: true,
      data: results,
    }
  }

  /**
   * 读取图片（当前仅支持文本方式读取）
   */
  private async readImage(path: string | undefined): Promise<ToolResult> {
    if (!path) {
      return {
        success: false,
        error: 'image_read 缺少必需参数 path',
      }
    }

    // 当前后端只支持文本读取，二进制图片可能失败
    return await this.readFile(this.resolvePath(path))
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
   * 批量编辑多个文件
   */
  private async multiEdit(edits: Array<{ path: string; oldStr: string; newStr: string }> | undefined): Promise<ToolResult> {
    if (!edits || !Array.isArray(edits) || edits.length === 0) {
      return {
        success: false,
        error: 'multi_edit 缺少必需参数 edits',
      }
    }

    const results: Array<{ path: string; success: boolean; error?: string }> = []

    for (const edit of edits) {
      if (!edit?.path || !edit?.oldStr || !edit?.newStr) {
        results.push({ path: edit?.path || '', success: false, error: '缺少必需参数' })
        continue
      }
      const res = await this.editFile(this.resolvePath(edit.path), edit.oldStr, edit.newStr)
      results.push({ path: edit.path, success: res.success, error: res.error })
    }

    return {
      success: results.every(r => r.success),
      data: results,
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

  /**
   * XML 转义
   */
  private async xmlEscape(text: string | undefined): Promise<ToolResult> {
    if (text === undefined) {
      return {
        success: false,
        error: 'xml_escape 缺少必需参数 text',
      }
    }

    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')

    return {
      success: true,
      data: escaped,
    }
  }

  // ==================== 其他工具实现 ====================

  private storeCommandOutput(stdout: string, stderr: string): string {
    const id = `cmd-${Date.now()}-${++this.commandOutputCounter}`
    this.commandOutputCache.set(id, { stdout, stderr })
    return id
  }

  private async readCommandOutput(id: string | undefined): Promise<ToolResult> {
    if (!id) {
      return {
        success: false,
        error: 'ReadCommandOutput 缺少必需参数 id',
      }
    }

    const output = this.commandOutputCache.get(id)
    if (!output) {
      return {
        success: false,
        error: `ReadCommandOutput 未找到输出: ${id}`,
      }
    }

    return {
      success: true,
      data: output,
    }
  }

  private async askUserQuestion(question: string | undefined): Promise<ToolResult> {
    if (!question) {
      return {
        success: false,
        error: 'ask_user_question 缺少必需参数 question',
      }
    }

    if (typeof window === 'undefined' || !('prompt' in window)) {
      return {
        success: false,
        error: '当前环境不支持用户交互',
      }
    }

    const answer = window.prompt(question) ?? ''
    return {
      success: true,
      data: { answer },
    }
  }

  private async webFetch(url: string | undefined): Promise<ToolResult> {
    if (!url) {
      return {
        success: false,
        error: 'web_fetch 缺少必需参数 url',
      }
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      const response = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)

      const text = await response.text()
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key] = value
      })

      return {
        success: true,
        data: {
          url,
          status: response.status,
          headers,
          text: text.slice(0, 20000),
        },
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('web_fetch 失败', error),
      }
    }
  }

  private async webSearch(query: string | undefined, count?: number): Promise<ToolResult> {
    if (!query) {
      return {
        success: false,
        error: 'web_search 缺少必需参数 query',
      }
    }

    const maxCount = Math.max(1, Math.min(Number(count) || 5, 10))
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const fetchResult = await this.webFetch(url)
    if (!fetchResult.success) return fetchResult

    const html = (fetchResult.data as any)?.text || ''
    const results: Array<{ title: string; url: string; snippet?: string }> = []

    const regex = /<a[^>]+class=\"result__a\"[^>]+href=\"([^\"]+)\"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class=\"result__snippet\"[^>]*>(.*?)<\/a>/gi
    let match: RegExpExecArray | null
    while ((match = regex.exec(html)) && results.length < maxCount) {
      const rawUrl = match[1]
      const title = match[2].replace(/<[^>]+>/g, '').trim()
      const snippet = match[3].replace(/<[^>]+>/g, '').trim()
      results.push({ title, url: rawUrl, snippet })
    }

    return {
      success: true,
      data: {
        query,
        results,
      },
    }
  }

  private async saveMemory(content: string | undefined): Promise<ToolResult> {
    if (!content) {
      return {
        success: false,
        error: 'save_memory 缺少必需参数 content',
      }
    }

    try {
      const entry = {
        id: `memory:${Date.now()}`,
        source: 'history',
        type: 'selection',
        priority: 3,
        content: {
          type: 'selection',
          path: '',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          content,
        },
        created_at: Date.now(),
        estimated_tokens: Math.max(1, Math.ceil(content.length / 4)),
      }

      const { upsertContext } = await import('../../services/tauri')
      await upsertContext(entry)

      return {
        success: true,
        data: { id: entry.id },
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('save_memory 失败', error),
      }
    }
  }

  private async runTask(input: string | undefined): Promise<ToolResult> {
    if (!input) {
      return {
        success: false,
        error: 'task 缺少必需参数 input',
      }
    }

    return {
      success: true,
      data: { message: input },
    }
  }

  private async runSkill(name: string | undefined): Promise<ToolResult> {
    if (!name) {
      return {
        success: false,
        error: 'Skill 缺少必需参数 name',
      }
    }

    try {
      if (!this.config.workspaceDir) {
        return {
          success: false,
          error: '未配置工作区目录，无法加载技能',
        }
      }

      const skillPath = `${this.config.workspaceDir}/.codex/skills/${name}/SKILL.md`
      const content = await invoke<string>('read_file', { path: skillPath })
      return {
        success: true,
        data: { name, content },
      }
    } catch (error) {
      return {
        success: false,
        error: this.formatError('Skill 加载失败', error),
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

      const outputId = this.storeCommandOutput(result.stdout, result.stderr)

      return {
        success: true,
        data: {
          stdout: result.stdout,
          stderr: result.stderr,
          outputId,
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
