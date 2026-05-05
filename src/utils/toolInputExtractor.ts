/**
 * 工具输入提取器
 *
 * 统一从工具输入参数中提取各种类型的值
 * 避免在 toolConfig.ts 和 toolSummary.ts 中重复实现
 */

/**
 * 文件路径相关的键名
 */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file'] as const;

/**
 * 命令相关的键名
 */
const COMMAND_KEYS = ['command', 'cmd', 'command_string', 'commands'] as const;

/**
 * 搜索查询相关的键名
 */
const QUERY_KEYS = ['query', 'q', 'search', 'keyword', 'pattern', 'regex'] as const;

/**
 * URL 相关的键名
 */
const URL_KEYS = ['url', 'uri', 'href', 'link'] as const;

function stripPairedQuotes(value: string): string {
  let result = value.trim();
  let changed = true;

  while (changed && result.length >= 2) {
    changed = false;
    const first = result[0];
    const last = result[result.length - 1];
    const inner = result.slice(1, -1);
    if (
      (first === '"' && last === '"' && !inner.includes('"')) ||
      (first === "'" && last === "'" && !inner.includes("'")) ||
      (first === '`' && last === '`')
    ) {
      result = inner.trim();
      changed = true;
    }
  }

  return result;
}

/**
 * 清理展示用命令，剥离 Windows shell 启动器等内部包装。
 *
 * 原始命令仍由 extractFullCommand 返回，用于复制和详情调试。
 */
export function normalizeCommandForDisplay(command: string): string {
  let result = stripPairedQuotes(command);

  const rejectedIndex = result.search(/\s+rejected:\s+/i);
  if (rejectedIndex > 0) {
    result = result.slice(0, rejectedIndex).trim();
    result = stripPairedQuotes(result);
  }

  const lower = result.toLowerCase();
  const isPowerShell =
    lower.includes('powershell.exe') ||
    lower.includes('pwsh.exe') ||
    lower.startsWith('powershell ') ||
    lower.startsWith('pwsh ');
  if (isPowerShell) {
    const commandMatch = result.match(/\s-(?:Command|c)\s+/i);
    if (commandMatch?.index !== undefined) {
      result = stripPairedQuotes(result.slice(commandMatch.index + commandMatch[0].length));
    }
  }

  const cmdLower = result.toLowerCase();
  const isCmd = cmdLower.includes('cmd.exe') || cmdLower.startsWith('cmd ');
  if (isCmd) {
    const cmdMatch = result.match(/\s\/c\s+/i);
    if (cmdMatch?.index !== undefined) {
      result = stripPairedQuotes(result.slice(cmdMatch.index + cmdMatch[0].length));
    }
  }

  return result;
}

function truncateForDisplay(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength - 3) + '...' : value;
}

/**
 * 从工具输入中提取文件路径（只返回文件名）
 *
 * @param input - 工具输入参数对象
 * @returns 文件名，如果未找到则返回空字符串
 *
 * @example
 * extractFilePath({ path: '/src/components/App.tsx' })
 * // => 'App.tsx'
 *
 * extractFilePath({ filePath: 'C:\\project\\index.js' })
 * // => 'index.js'
 */
export function extractFilePath(input: Record<string, unknown> | undefined): string {
  if (!input) return '';

  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string') {
      // 只显示文件名，不显示完整路径
      const parts = value.split('/');
      const parts2 = value.split('\\');
      const fileName = parts.length > parts2.length
        ? parts[parts.length - 1]
        : parts2[parts2.length - 1];
      return fileName || value;
    }
  }
  return '';
}

/**
 * 从工具输入中提取完整文件路径（不截断为文件名）
 *
 * @param input - 工具输入参数对象
 * @returns 完整文件路径，如果未找到则返回 null
 */
export function extractFullFilePath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;

  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * 从工具输入中提取命令
 *
 * @param input - 工具输入参数对象
 * @param maxLength - 最大长度限制，超过则截断（默认40）
 * @returns 命令字符串，如果未找到则返回空字符串
 *
 * @example
 * extractCommand({ command: 'npm run build' })
 * // => 'npm run build'
 *
 * extractCommand({ commands: ['git commit -m "fix"', 'git push'] })
 * // => 'git commit -m "fix"'
 */
export function extractCommand(
  input: Record<string, unknown> | undefined,
  maxLength: number = 40
): string {
  if (!input) return '';

  for (const key of COMMAND_KEYS) {
    const value = input[key];
    if (typeof value === 'string') {
      const command = normalizeCommandForDisplay(value);
      return truncateForDisplay(command, maxLength);
    }
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
      const command = normalizeCommandForDisplay(value[0]);
      return truncateForDisplay(command, maxLength);
    }
  }
  return '';
}

/**
 * 从工具输入中提取完整命令（不截断）
 *
 * 用于复制到剪贴板等需要完整内容的场景
 *
 * @param input - 工具输入参数对象
 * @returns 完整命令字符串，如果未找到则返回空字符串
 *
 * @example
 * extractFullCommand({ command: 'npm run build -- --production' })
 * // => 'npm run build -- --production'
 */
export function extractFullCommand(
  input: Record<string, unknown> | undefined
): string {
  if (!input) return '';
  for (const key of COMMAND_KEYS) {
    const value = input[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
      return value[0];
    }
  }
  return '';
}

/**
 * 从工具输入中提取搜索关键词
 *
 * @param input - 工具输入参数对象
 * @param maxLength - 最大长度限制，超过则截断（默认30）
 * @returns 搜索关键词，如果未找到则返回空字符串
 *
 * @example
 * extractSearchQuery({ query: 'useState' })
 * // => 'useState'
 *
 * extractSearchQuery({ pattern: '^export.*function' })
 * // => '^export.*function'
 */
export function extractSearchQuery(
  input: Record<string, unknown> | undefined,
  maxLength: number = 30
): string {
  if (!input) return '';

  for (const key of QUERY_KEYS) {
    const value = input[key];
    if (typeof value === 'string') {
      return value.length > maxLength ? value.slice(0, maxLength - 3) + '...' : value;
    }
  }
  return '';
}

/**
 * 从工具输入中提取 URL
 *
 * @param input - 工具输入参数对象
 * @param maxLength - 最大长度限制，超过则截断（默认30）
 * @returns 简化的 URL，如果未找到则返回空字符串
 *
 * @example
 * extractUrl({ url: 'https://example.com/docs/api/reference' })
 * // => 'example.com/docs/api...'
 */
export function extractUrl(
  input: Record<string, unknown> | undefined,
  maxLength: number = 30
): string {
  if (!input) return '';

  for (const key of URL_KEYS) {
    const value = input[key];
    if (typeof value === 'string') {
      // 简化 URL 显示
      try {
        const urlObj = new URL(value);
        const hostname = urlObj.hostname;
        const pathname = urlObj.pathname.length > 1 ? urlObj.pathname : '';
        const path = pathname.length > 20 ? pathname.slice(0, 17) + '...' : pathname;
        const result = hostname + path;

        return result.length > maxLength ? result.slice(0, maxLength - 3) + '...' : result;
      } catch {
        return value.length > maxLength ? value.slice(0, maxLength - 3) + '...' : value;
      }
    }
  }
  return '';
}

/**
 * 从工具输入中提取 Todo 任务信息
 *
 * @param input - 工具输入参数对象
 * @returns 任务描述字符串，如果未找到则返回空字符串
 *
 * @example
 * extractTodoInfo({ todos: [{ status: 'completed', content: 'task1' }] })
 * // => '1个已完成'
 */
export function extractTodoInfo(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const todos = input.todos as Array<{ status: string; content: string }> | undefined;
  if (!Array.isArray(todos)) return '';

  const total = todos.length;
  const completed = todos.filter(t => t.status === 'completed').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;

  if (completed === total) return `${total}个已完成`;
  if (completed > 0) {
    const percent = Math.round((completed / total) * 100);
    return `${completed}/${total} (${percent}%)`;
  }
  if (inProgress > 0) return `${total}个任务 · 进行中`;
  return `${total}个任务`;
}

/**
 * 通用值提取器
 *
 * @param input - 工具输入参数对象
 * @param keys - 要查找的键名数组
 * @returns 找到的值，如果未找到则返回 null
 *
 * @example
 * extractValue({ name: 'test' }, ['name', 'title'])
 * // => 'test'
 */
export function extractValue(
  input: Record<string, unknown> | undefined,
  keys: readonly string[]
): string | null {
  if (!input) return null;

  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}
