/**
 * Tool Summary Generator
 *
 * Converts technical tool calls to user-friendly descriptions
 * Supports specialized parsing for Bash, Grep, Edit, etc.
 */

import i18n from '../i18n';
import type { ToolStatus } from '../types';
import {
  extractFilePath,
  extractCommand,
  extractSearchQuery,
} from './toolInputExtractor';

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, { ns: 'tools', ...options });

const TOOL_NAME_MAP: Record<string, string> = {
  'str_replace_editor': 'names.editFile',
  'Edit': 'names.editFile',
  'Read': 'names.readFile',
  'ReadFile': 'names.readFile',
  'read_file': 'names.readFile',
  'Glob': 'names.searchFiles',
  'Grep': 'names.searchContent',
  'Bash': 'names.executeCommand',
  'BashCommand': 'names.executeCommand',
  'run_command': 'names.executeCommand',
  'Write': 'names.writeFile',
  'WriteFile': 'names.writeFile',
  'write_file': 'names.writeFile',
  'ListFiles': 'names.listFiles',
  'list_files': 'names.listFiles',
  'SearchFiles': 'names.searchFiles',
  'search_files': 'names.searchFiles',
  'GitCommand': 'names.gitOperation',
  'git_command': 'names.gitOperation',
  'DatabaseQuery': 'names.databaseQuery',
  'database_query': 'names.databaseQuery',
  'APICall': 'names.apiRequest',
  'api_call': 'names.apiRequest',
  'WebSearch': 'names.webSearch',
  'web_search': 'names.webSearch',
  'WebFetch': 'names.webRequest',
  'web_fetch': 'names.webRequest',
  'FileBrowser': 'names.browseFiles',
  'file_browser': 'names.browseFiles',
  'CreateFile': 'names.createFile',
  'create_file': 'names.createFile',
  'DeleteFile': 'names.deleteFile',
  'delete_file': 'names.deleteFile',
  'MoveFile': 'names.moveFile',
  'move_file': 'names.moveFile',
  'CopyFile': 'names.copyFile',
  'copy_file': 'names.copyFile',
  'TodoWrite': 'names.todoList',
  'todowrite': 'names.todoList',
  'Task': 'names.task',
  'task': 'names.task',
  'Agent': 'names.agent',
  'agent': 'names.agent',
  'Skill': 'names.skill',
  'skill': 'names.skill',
};

function getToolFriendlyName(toolName: string): string {
  const key = TOOL_NAME_MAP[toolName];
  return key ? t(key) : toolName;
}

export function generateToolSummary(
  toolName: string,
  input?: Record<string, unknown>,
  status: ToolStatus = 'running'
): string {
  const friendlyName = getToolFriendlyName(toolName);
  const filePath = extractFilePath(input);
  const command = extractCommand(input);
  const query = extractSearchQuery(input);

  const isRunning = status === 'running';

  switch (toolName) {
    case 'str_replace_editor':
    case 'Edit':
      if (filePath) {
        return isRunning ? `${t('actions.editing')} ${filePath}` : `${filePath} ${t('actions.edited')}`;
      }
      return isRunning ? `${t('actions.editing')} ${friendlyName}` : friendlyName;

    case 'ReadFile':
    case 'read_file':
      if (filePath) {
        return isRunning ? `${t('actions.reading')} ${filePath}` : `${filePath} ${t('actions.read')}`;
      }
      return isRunning ? `${t('actions.reading')} ${friendlyName}` : friendlyName;

    case 'WriteFile':
    case 'write_file':
    case 'CreateFile':
    case 'create_file':
      if (filePath) {
        return isRunning ? `${t('actions.creating')} ${filePath}` : `${filePath} ${t('actions.created')}`;
      }
      return isRunning ? `${t('actions.creating')} ${friendlyName}` : friendlyName;

    case 'DeleteFile':
    case 'delete_file':
      if (filePath) {
        return isRunning ? `${t('actions.deleting')} ${filePath}` : `${filePath} ${t('actions.deleted')}`;
      }
      return isRunning ? `${t('actions.deleting')} ${friendlyName}` : friendlyName;

    case 'BashCommand':
    case 'run_command':
      if (command) {
        return isRunning ? `${t('actions.executing')}: ${command}` : `${t('actions.executed')}: ${command}`;
      }
      return isRunning ? `${t('actions.executing')} ${friendlyName}` : friendlyName;

    case 'Glob': {
      const pattern = (input?.pattern as string) || query;
      if (pattern) {
        return isRunning ? `${t('actions.searching')}: ${pattern}` : `${t('actions.searched')}: ${pattern}`;
      }
      return isRunning ? `${t('actions.searching')} ${friendlyName}` : friendlyName;
    }

    case 'SearchFiles':
    case 'search_files':
    case 'WebSearch':
    case 'web_search':
      if (query) {
        return isRunning ? `${t('actions.searching')}: ${query}` : `${t('actions.searched')}: ${query}`;
      }
      return isRunning ? `${t('actions.searching')} ${friendlyName}` : friendlyName;

    case 'ListFiles':
    case 'list_files':
      if (filePath) {
        return isRunning ? `${t('actions.listing')} ${filePath}` : `${t('actions.listed')} ${filePath}`;
      }
      return isRunning ? `${t('actions.listing')} ${friendlyName}` : friendlyName;

    case 'GitCommand':
    case 'git_command':
      if (command) {
        return isRunning ? `${t('actions.gitExecuting')}: ${command}` : `${t('actions.gitExecuted')}: ${command}`;
      }
      return isRunning ? `${t('actions.gitExecuting')} ${friendlyName}` : friendlyName;

    default:
      if (filePath) {
        return isRunning ? `${t('actions.executing')} ${friendlyName}: ${filePath}` : `${friendlyName}: ${filePath}`;
      }
      if (command) {
        return isRunning ? `${t('actions.executing')}: ${command}` : command;
      }
      return isRunning ? `${t('actions.executing')} ${friendlyName}` : friendlyName;
  }
}

export function generateToolGroupSummary(
  toolCount: number,
  status: ToolStatus,
  completedCount = 0
): string {
  if (status === 'running') {
    if (toolCount === 1) {
      return t('group.executingOne');
    }
    return t('group.executingMany', { count: toolCount });
  }

  if (status === 'completed') {
    return t('group.completed', { count: toolCount });
  }

  if (status === 'failed') {
    return t('group.failed', { count: toolCount });
  }

  if (status === 'partial') {
    return t('group.partial', { completed: completedCount, total: toolCount });
  }

  return t('group.operations', { count: toolCount });
}

export function calculateToolGroupStatus(
  tools: Array<{ status: ToolStatus }>
): ToolStatus {
  if (tools.length === 0) return 'running';

  const allCompleted = tools.every(t => t.status === 'completed');
  const anyFailed = tools.some(t => t.status === 'failed');
  const allRunning = tools.every(t => t.status === 'running' || t.status === 'pending');
  const someCompleted = tools.some(t => t.status === 'completed');

  if (allCompleted) return 'completed';
  if (anyFailed && !someCompleted) return 'failed';
  if (anyFailed) return 'partial';
  if (allRunning) return 'running';
  return 'partial';
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}

export function calculateDuration(startedAt: string, completedAt?: string): number | undefined {
  if (!completedAt) return undefined;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  return end - start;
}

export function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequence pattern requires control chars
  const ansiRegex = /\x1b\[[0-9;]*m/g;
  return text.replace(ansiRegex, '');
}

export type OutputSummaryType =
  | 'matchCount'
  | 'fileCount'
  | 'lineCount'
  | 'exitStatus'
  | 'resultCount'
  | 'todoProgress'
  | 'urlFetch'
  | 'diffSummary'
  | 'plain'
  | 'agentSummary'
  | 'skillSummary';

export interface OutputSummary {
  type: OutputSummaryType;
  summary: string;
  fullOutput?: string;
  expandable?: boolean;
}

/**
 * 生成折叠状态的简化单行摘要
 * 用于工具调用块的默认显示
 */
export interface CollapsedSummary {
  /** 主要信息（文件名、搜索词等） */
  target: string;
  /** 输出摘要（行数、匹配数等） */
  summary: string;
  /** 摘要类型（用于样式） */
  summaryType: 'lines' | 'files' | 'matches' | 'diff' | 'status' | 'size' | 'count' | 'plain';
}

export function generateCollapsedSummary(
  toolName: string,
  input: Record<string, unknown> | undefined,
  output: string | undefined,
  _status: ToolStatus
): CollapsedSummary {
  const normalizedToolName = toolName.toLowerCase();
  const filePath = extractFilePath(input);
  const command = extractCommand(input, 30);
  const query = extractSearchQuery(input, 20);

  // Read 工具：显示行数
  if (normalizedToolName.includes('read') || normalizedToolName === 'read') {
    const lines = output ? output.split('\n').length : 0;
    return {
      target: filePath || toolName,
      summary: `${lines} ${t('output.lines')}`,
      summaryType: 'lines',
    };
  }

  // Glob 工具：显示文件数
  if (normalizedToolName.includes('glob')) {
    const files = output ? output.trim().split('\n').filter(f => f.trim()).length : 0;
    return {
      target: input?.pattern as string || query || toolName,
      summary: `${files} ${t('output.files')}`,
      summaryType: 'files',
    };
  }

  // Grep 工具：显示匹配数
  if (normalizedToolName.includes('grep')) {
    const matches = output ? output.trim().split('\n').filter(l => l.trim()).length : 0;
    return {
      target: `"${query || input?.pattern || ''}"`,
      summary: `${matches} ${t('output.matches')}`,
      summaryType: 'matches',
    };
  }

  // Edit 工具：显示 diff 统计
  if (normalizedToolName.includes('edit') || normalizedToolName.includes('str_replace')) {
    // 优先从 output 解析 diff 统计
    let diffStats = parseDiffStats(output);

    // output 解析失败时，从 input 的 old_string/new_string 计算行数差
    if (!diffStats && input) {
      const oldStr = (input.old_string || input.old_str) as string | undefined
      const newStr = (input.new_string || input.new_str) as string | undefined
      if (typeof oldStr === 'string' && typeof newStr === 'string') {
        const removed = oldStr.split('\n').length
        const added = newStr.split('\n').length
        diffStats = `+${added} -${removed}`
      }
    }

    return {
      target: filePath || toolName,
      summary: diffStats,
      summaryType: 'diff',
    };
  }

  // Write 工具：显示写入状态
  if (normalizedToolName.includes('write') || normalizedToolName.includes('create')) {
    const lines = output ? output.split('\n').length : 0;
    return {
      target: filePath || toolName,
      summary: lines > 0 ? `${lines} ${t('output.lines')}` : t('output.newFile'),
      summaryType: 'lines',
    };
  }

  // Bash 工具：不显示输出摘要（状态由状态图标统一显示）
  if (normalizedToolName.includes('bash') || normalizedToolName.includes('command')) {
    return {
      target: command || toolName,
      summary: '', // 不显示摘要，避免与状态图标重复
      summaryType: 'status',
    };
  }

  // WebSearch 工具：显示结果数
  if (normalizedToolName.includes('search') || normalizedToolName.includes('web_search')) {
    const countMatch = output?.match(/found?\s*(\d+)\s*result/i);
    const count = countMatch ? countMatch[1] : '?';
    return {
      target: `"${query || ''}"`,
      summary: `${count} ${t('output.results')}`,
      summaryType: 'count',
    };
  }

  // WebFetch 工具：显示大小
  if (normalizedToolName.includes('webfetch') || normalizedToolName.includes('fetch')) {
    const sizeKB = output ? (output.length / 1024).toFixed(1) : '0';
    const url = (input?.url as string) || '';
    const host = url ? new URL(url).host : toolName;
    return {
      target: host,
      summary: `${sizeKB} KB`,
      summaryType: 'size',
    };
  }

  // TodoWrite 工具：显示待办数
  if (normalizedToolName.includes('todo')) {
    const todos = input?.todos as Array<unknown> | undefined;
    const count = todos?.length || 0;
    return {
      target: toolName,
      summary: `${count} ${t('output.todos')}`,
      summaryType: 'count',
    };
  }

  // Task/Agent 工具：不显示输出摘要（状态由状态图标统一显示）
  if (normalizedToolName.includes('task') || normalizedToolName.includes('agent')) {
    const agentType = (input?.agentType as string) || (input?.subagent_type as string) || toolName;
    return {
      target: agentType,
      summary: '', // 不显示摘要，避免与状态图标重复
      summaryType: 'status',
    };
  }

  // Skill 工具：不显示输出摘要（状态由状态图标统一显示）
  if (normalizedToolName.includes('skill')) {
    const skillName = (input?.skill as string) || toolName;
    return {
      target: skillName,
      summary: '', // 不显示摘要，避免与状态图标重复
      summaryType: 'status',
    };
  }

  // 默认：不显示输出摘要（状态由状态图标统一显示）
  return {
    target: filePath || command || query || toolName,
    summary: '', // 不显示摘要，避免与状态图标重复
    summaryType: 'status',
  };
}

/**
 * 解析 diff 统计信息
 */
function parseDiffStats(output: string | undefined): string {
  if (!output) return '';

  // 尝试从输出中提取 +/- 行数
  const plusMatch = output.match(/\+(\d+)/g);
  const minusMatch = output.match(/-(\d+)/g);

  const plusCount = plusMatch?.reduce((sum, m) => sum + parseInt(m.slice(1)), 0) || 0;
  const minusCount = minusMatch?.reduce((sum, m) => sum + parseInt(m.slice(1)), 0) || 0;

  if (plusCount > 0 || minusCount > 0) {
    return `+${plusCount} -${minusCount}`;
  }

  return '';
}

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export interface GrepOutputData {
  matches: GrepMatch[];
  query: string;
  total: number;
}

export function parseGrepMatches(output: string, input?: Record<string, unknown>): GrepOutputData | null {
  const lines = output.trim().split('\n');
  const matches: GrepMatch[] = [];
  const query = extractSearchQuery(input) || '';

  for (const line of lines) {
    if (!line.trim()) continue;

    const match = line.match(/^([^:]+):(\d+)(?::(\d+))?:?(.*)$/);
    if (match) {
      const [, file, lineNum, , content] = match;
      if (content.trim()) {
        matches.push({
          file,
          line: parseInt(lineNum, 10),
          content: content.trim(),
        });
      }
    } else {
      matches.push({
        file: '',
        line: 0,
        content: line.trim(),
      });
    }
  }

  if (matches.length === 0) return null;

  return { matches, query, total: matches.length };
}

function parseGrepOutput(output: string): OutputSummary | null {
  const lines = output.trim().split('\n');
  const matchCount = lines.filter(line => line.trim()).length;

  if (matchCount === 0) {
    return { type: 'matchCount', summary: t('output.noMatches'), fullOutput: output };
  }

  return {
    type: 'matchCount',
    summary: t('output.foundMatches', { count: matchCount }),
    fullOutput: output,
    expandable: true,
  };
}

function parseGlobOutput(output: string): OutputSummary | null {
  if (!output.trim()) {
    return { type: 'fileCount', summary: t('output.noFiles') };
  }

  const files = output.trim().split('\n').filter(f => f.trim());
  return {
    type: 'fileCount',
    summary: t('output.foundFiles', { count: files.length }),
    fullOutput: output,
    expandable: files.length > 0,
  };
}

const ERROR_KEYWORDS = [
  'error:', 'error ', 'Error:', 'Error ', 'ERROR:',
  'fail', 'Fail', 'FAIL', 'failed', 'Failed', 'FAILED',
  'exception', 'Exception', 'EXCEPTION',
  'cannot', 'Cannot', 'CANNOT',
  'unable', 'Unable', 'UNABLE',
  'denied', 'Denied', 'DENIED',
  'not found', 'Not Found', 'NOT FOUND',
  'no such', 'No such', 'NO SUCH',
];

function parseBashOutput(output: string): OutputSummary | null {
  if (!output.trim()) {
    return { type: 'exitStatus', summary: t('output.commandExecuted') };
  }

  const cleanOutput = stripAnsiCodes(output);
  const lines = cleanOutput.trim().split('\n').filter(l => l.trim());

  if (lines.length === 0) {
    return { type: 'exitStatus', summary: t('output.commandNoOutput') };
  }

  const errorLine = lines.find(line =>
    ERROR_KEYWORDS.some(kw =>
      line.toLowerCase().includes(kw.toLowerCase())
    )
  );

  if (errorLine) {
    const cleanError = errorLine.trim().slice(0, 50);
    return {
      type: 'exitStatus',
      summary: t('output.error', { message: cleanError + (errorLine.length > 50 ? '...' : '') }),
      fullOutput: cleanOutput,
      expandable: true,
    };
  }

  const exitCodeMatch = cleanOutput.match(/exit\s+code:\s*(\d+)/i);
  if (exitCodeMatch) {
    const code = parseInt(exitCodeMatch[1], 10);
    if (code !== 0) {
      return {
        type: 'exitStatus',
        summary: t('output.exitCode', { code }),
        fullOutput: cleanOutput,
        expandable: true,
      };
    }
  }

  const npmErrorMatch = cleanOutput.match(/npm\s+err!\s+(.+)/i);
  if (npmErrorMatch) {
    return {
      type: 'exitStatus',
      summary: `npm: ${npmErrorMatch[1].trim().slice(0, 40)}...`,
      fullOutput: cleanOutput,
      expandable: true,
    };
  }

  const firstLine = lines[0].trim();
  return {
    type: 'exitStatus',
    summary: firstLine.slice(0, 50) + (firstLine.length > 50 ? '...' : ''),
    fullOutput: cleanOutput,
    expandable: lines.length > 1,
  };
}

function parseWebSearchOutput(output: string): OutputSummary | null {
  const countMatch = output.match(/found?\s*(\d+)\s*result/i);
  if (countMatch) {
    return {
      type: 'resultCount',
      summary: t('output.foundResults', { count: countMatch[1] }),
      fullOutput: output,
      expandable: true,
    };
  }

  return {
    type: 'resultCount',
    summary: t('output.searchCompleted'),
    fullOutput: output,
    expandable: true,
  };
}

function parseReadOutput(output: string): OutputSummary | null {
  if (!output.trim()) {
    return { type: 'lineCount', summary: t('output.noFiles') };
  }

  const lines = output.split('\n').length;
  const chars = output.length;
  const sizeKB = (chars / 1024).toFixed(1);

  return {
    type: 'lineCount',
    summary: `${lines} ${t('output.writtenLines', { count: lines }).split(' ')[1] || 'lines'} (${sizeKB} KB)`,
    fullOutput: output,
    expandable: true,
  };
}

function parseWriteOutput(output: string): OutputSummary | null {
  if (output.toLowerCase().includes('success') || output.toLowerCase().includes('written')) {
    const linesMatch = output.match(/(\d+)\s*line/);
    if (linesMatch) {
      return { type: 'lineCount', summary: t('output.writtenLines', { count: linesMatch[1] }) };
    }
    return { type: 'lineCount', summary: t('output.writeSuccess') };
  }

  return {
    type: 'lineCount',
    summary: t('output.writeComplete'),
    fullOutput: output,
  };
}

function parseEditOutput(output: string, input?: Record<string, unknown>): OutputSummary | null {
  const filePath = input?.path as string || '';
  const fileName = filePath.split('/').pop() || '';

  if (output.toLowerCase().includes('success') ||
      output.toLowerCase().includes('edited') ||
      output.toLowerCase().includes('updated') ||
      output.toLowerCase().includes('complete')) {
    return {
      type: 'diffSummary',
      summary: fileName ? t('output.modified', { name: fileName }) : t('output.modifySuccess'),
      fullOutput: output,
    };
  }

  if (output.toLowerCase().includes('fail') ||
      output.toLowerCase().includes('error')) {
    return {
      type: 'diffSummary',
      summary: fileName ? t('output.modifyFailed', { name: fileName }) : t('output.modifyFailedShort'),
      fullOutput: output,
      expandable: true,
    };
  }

  return null;
}

export function generateOutputSummary(
  toolName: string,
  output: string,
  status: ToolStatus = 'completed',
  input?: Record<string, unknown>
): OutputSummary | null {
  if (!output || status === 'running' || status === 'pending') {
    return null;
  }

  const normalizedToolName = toolName.toLowerCase();

  if (normalizedToolName.includes('grep')) {
    return parseGrepOutput(output);
  }

  if (normalizedToolName.includes('glob')) {
    return parseGlobOutput(output);
  }

  if (
    normalizedToolName.includes('bash') ||
    normalizedToolName.includes('command') ||
    normalizedToolName.includes('execute')
  ) {
    return parseBashOutput(output);
  }

  if (
    normalizedToolName.includes('edit') ||
    normalizedToolName.includes('str_replace')
  ) {
    const editResult = parseEditOutput(output, input);
    if (editResult) return editResult;
  }

  if (normalizedToolName.includes('search') || normalizedToolName.includes('web_search')) {
    return parseWebSearchOutput(output);
  }

  if (normalizedToolName.includes('read') || normalizedToolName.includes('read_file')) {
    return parseReadOutput(output);
  }

  if (
    normalizedToolName.includes('write') ||
    normalizedToolName.includes('write_file') ||
    normalizedToolName.includes('create')
  ) {
    return parseWriteOutput(output);
  }

  // 新增：WebFetch 工具
  if (normalizedToolName.includes('webfetch') || normalizedToolName.includes('web_fetch')) {
    return parseWebFetchOutput(output);
  }

  // 新增：TodoWrite 工具
  if (normalizedToolName.includes('todo') || normalizedToolName.includes('todowrite')) {
    return parseTodoOutput(output, input);
  }

  // 新增：Task/Agent 工具
  if (normalizedToolName.includes('task') || normalizedToolName.includes('agent')) {
    return parseTaskOutput(output);
  }

  // 新增：Skill 工具
  if (normalizedToolName.includes('skill')) {
    return parseSkillOutput(output);
  }

  const preview = output.slice(0, 50);
  return {
    type: 'plain',
    summary: preview + (output.length > 50 ? '...' : ''),
    fullOutput: output,
    expandable: output.length > 50,
  };
}

/**
 * 解析 WebFetch 输出
 */
function parseWebFetchOutput(output: string): OutputSummary | null {
  if (!output.trim()) {
    return { type: 'urlFetch', summary: t('output.fetchCompleted') };
  }

  const sizeKB = (output.length / 1024).toFixed(1);
  return {
    type: 'urlFetch',
    summary: `${sizeKB} KB`,
    fullOutput: output,
    expandable: output.length > 200,
  };
}

/**
 * 解析 TodoWrite 输出
 */
function parseTodoOutput(output: string, input?: Record<string, unknown>): OutputSummary | null {
  // 从 input 解析待办数量
  const todos = input?.todos as Array<unknown> | undefined;
  if (todos && Array.isArray(todos)) {
    const count = todos.length;
    return {
      type: 'todoProgress',
      summary: t('output.todosUpdated', { count }),
      fullOutput: output,
    };
  }

  return {
    type: 'todoProgress',
    summary: t('output.todoUpdated'),
    fullOutput: output,
  };
}

/**
 * 解析 Task/Agent 输出
 */
function parseTaskOutput(output: string): OutputSummary | null {
  const lines = output.trim().split('\n').length;

  return {
    type: 'plain',
    summary: lines > 1 ? `${lines} ${t('output.lines')}` : t('output.completed'),
    fullOutput: output,
    expandable: output.length > 100,
  };
}

/**
 * 解析 Skill 输出
 */
function parseSkillOutput(output: string): OutputSummary | null {
  if (!output.trim()) {
    return { type: 'plain', summary: t('output.completed') };
  }

  const preview = output.slice(0, 50);
  return {
    type: 'plain',
    summary: preview + (output.length > 50 ? '...' : ''),
    fullOutput: output,
    expandable: output.length > 50,
  };
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
