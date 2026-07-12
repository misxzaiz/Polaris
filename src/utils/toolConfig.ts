/**
 * Tool Configuration - Icons, Colors, Labels Mapping
 * Uses lucide-react icon library
 */

import i18n from '@/i18n';
import type { ToolCategory, ToolConfig } from './toolConfig.types';
import {
  extractFilePath,
  extractCommand as extractCommandImpl,
  extractSearchQuery as extractSearchQueryImpl,
  extractTodoInfo as extractTodoInfoImpl,
  extractUrl as extractUrlImpl,
} from './toolInputExtractor';
import {
  FileText,
  FileSearch,
  Edit2,
  Edit3,
  Pencil,
  Save,
  FilePlus,
  FileDown,
  Terminal,
  TerminalSquare,
  Search,
  Globe,
  GitBranch,
  GitCommit,
  GitPullRequest,
  GitMerge,
  List,
  FolderOpen,
  Trash2,
  X,
  XCircle,
  ListChecks,
  ScanSearch,
  Bug,
  Globe2,
  Wifi,
  Database,
  Wrench,
  Cpu,
  Layers,
  Sparkles,
} from 'lucide-react';

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, { ns: 'tools', ...options });

// ========================================
// 工具缩写映射（用于单行紧凑显示）
// ========================================

const TOOL_SHORT_NAMES: Record<string, string> = {
  'Read': 'R',
  'read_file': 'R',
  'ReadFile': 'R',
  'Glob': 'G',
  'Grep': 'G',
  'Edit': 'E',
  'str_replace_editor': 'E',
  'Write': 'W',
  'write_file': 'W',
  'WriteFile': 'W',
  'CreateFile': 'W',
  'create_file': 'W',
  'Bash': 'B',
  'BashCommand': 'B',
  'run_command': 'B',
  'shell': 'B',
  'shell_command': 'B',
  'command_execution': 'B',
  'WebSearch': 'S',
  'web_search': 'S',
  'WebFetch': 'F',
  'web_fetch': 'F',
  'TodoWrite': 'T',
  'todowrite': 'T',
  'Task': 'A',
  'task': 'A',
  'Agent': 'A',
  'agent': 'A',
  'Skill': 'K',
  'skill': 'K',
  'GitCommand': 'G',
  'git_command': 'G',
  'DeleteFile': 'D',
  'delete_file': 'D',
  'Analyze': 'Z',
  'analyze': 'Z',

  // SimpleAI 引擎工具
  'bash': 'B',
  'edit_file': 'E',
  'list_directory': 'L',
  'glob': 'G',
  'apply_patch': 'P',
  'update_plan': 'P',
  'read_skill': 'K',
  'dispatch_agent': 'A',
  'browser': 'W',
  'computer': 'C',
};

/** 获取工具缩写名称 */
export function getToolShortName(toolName: string): string {
  return TOOL_SHORT_NAMES[toolName] || toolName.charAt(0).toUpperCase();
}

const TOOL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'read_file': FileText,
  'Read': FileText,
  'ReadFile': FileText,
  'Glob': FileSearch,
  'Grep': FileSearch,
  'str_replace_editor': Edit2,
  'Edit': Edit2,
  'Edit3': Edit3,
  'Pencil': Pencil,
  'write_file': Save,
  'WriteFile': Save,
  'create_file': FilePlus,
  'CreateFile': FilePlus,
  'Write': FileDown,
  'Bash': Terminal,
  'BashCommand': Terminal,
  'run_command': Terminal,
  'shell': Terminal,
  'shell_command': Terminal,
  'command_execution': Terminal,
  'execute': TerminalSquare,
  'search_files': Search,
  'SearchFiles': Search,
  'web_search': Globe,
  'WebSearch': Globe,
  'api_call': Globe,
  'APICall': Globe,
  'git_command': GitBranch,
  'GitCommand': GitBranch,
  'git_commit': GitCommit,
  'git_pull': GitPullRequest,
  'git_merge': GitMerge,
  'list_files': List,
  'ListFiles': List,
  'file_browser': FolderOpen,
  'FileBrowser': FolderOpen,
  'delete_file': Trash2,
  'DeleteFile': Trash2,
  'remove': X,
  'Remove': XCircle,
  'TodoWrite': ListChecks,
  'todowrite': ListChecks,
  'Analyze': ScanSearch,
  'analyze': ScanSearch,
  'CodeAnalysis': Bug,
  'code_analysis': Bug,
  'WebFetch': Globe2,
  'web_fetch': Globe2,
  'HttpRequest': Wifi,
  'http_request': Wifi,
  'database_query': Database,
  'DatabaseQuery': Database,
  'task': Cpu,
  'Task': Cpu,
  'Skill': Layers,
  'skill': Layers,
  'AskUserQuestion': Sparkles,
  'ask_user_question': Sparkles,

  // SimpleAI 引擎工具
  'bash': Terminal,
  'edit_file': Edit2,
  'list_directory': FolderOpen,
  'glob': FileSearch,
  'apply_patch': GitPullRequest,
  'update_plan': ListChecks,
  'read_skill': Layers,
  'dispatch_agent': Cpu,
  'browser': Globe2,
  'computer': Cpu,
  'default': Wrench,
};

const CATEGORY_CONFIG: Record<ToolCategory, {
  color: string;
  borderColor: string;
  bgColor: string;
}> = {
  read: {
    color: 'text-blue-500',
    borderColor: 'border-l-blue-500',
    bgColor: 'bg-blue-500/10',
  },
  write: {
    color: 'text-green-500',
    borderColor: 'border-l-green-500',
    bgColor: 'bg-green-500/10',
  },
  edit: {
    color: 'text-orange-500',
    borderColor: 'border-l-orange-500',
    bgColor: 'bg-orange-500/10',
  },
  execute: {
    color: 'text-purple-500',
    borderColor: 'border-l-purple-500',
    bgColor: 'bg-purple-500/10',
  },
  search: {
    color: 'text-cyan-500',
    borderColor: 'border-l-cyan-500',
    bgColor: 'bg-cyan-500/10',
  },
  list: {
    color: 'text-indigo-500',
    borderColor: 'border-l-indigo-500',
    bgColor: 'bg-indigo-500/10',
  },
  git: {
    color: 'text-pink-500',
    borderColor: 'border-l-pink-500',
    bgColor: 'bg-pink-500/10',
  },
  delete: {
    color: 'text-red-500',
    borderColor: 'border-l-red-500',
    bgColor: 'bg-red-500/10',
  },
  manage: {
    color: 'text-violet-500',
    borderColor: 'border-l-violet-500',
    bgColor: 'bg-violet-500/10',
  },
  analyze: {
    color: 'text-rose-500',
    borderColor: 'border-l-rose-500',
    bgColor: 'bg-rose-500/10',
  },
  network: {
    color: 'text-sky-500',
    borderColor: 'border-l-sky-500',
    bgColor: 'bg-sky-500/10',
  },
  agent: {
    color: 'text-teal-500',
    borderColor: 'border-l-teal-500',
    bgColor: 'bg-teal-500/10',
  },
  other: {
    color: 'text-gray-500',
    borderColor: 'border-l-gray-500',
    bgColor: 'bg-gray-500/10',
  },
};

const TOOL_CATEGORY: Record<string, ToolCategory> = {
  'read_file': 'read',
  'Read': 'read',
  'ReadFile': 'read',
  'Glob': 'read',
  'Grep': 'search',
  'str_replace_editor': 'edit',
  'Edit': 'edit',
  'Edit3': 'edit',
  'Pencil': 'edit',
  'write_file': 'write',
  'WriteFile': 'write',
  'create_file': 'write',
  'CreateFile': 'write',
  'Write': 'write',
  'Bash': 'execute',
  'BashCommand': 'execute',
  'run_command': 'execute',
  'shell': 'execute',
  'shell_command': 'execute',
  'command_execution': 'execute',
  'execute': 'execute',
  'search_files': 'search',
  'SearchFiles': 'search',
  'web_search': 'search',
  'WebSearch': 'search',
  'api_call': 'search',
  'APICall': 'search',
  'git_command': 'git',
  'GitCommand': 'git',
  'git_commit': 'git',
  'git_pull': 'git',
  'git_merge': 'git',
  'list_files': 'list',
  'ListFiles': 'list',
  'file_browser': 'list',
  'FileBrowser': 'list',
  'delete_file': 'delete',
  'DeleteFile': 'delete',
  'remove': 'delete',
  'Remove': 'delete',
  'TodoWrite': 'manage',
  'todowrite': 'manage',
  'Analyze': 'analyze',
  'analyze': 'analyze',
  'CodeAnalysis': 'analyze',
  'code_analysis': 'analyze',
  'WebFetch': 'network',
  'web_fetch': 'network',
  'HttpRequest': 'network',
  'http_request': 'network',
  'database_query': 'other',
  'DatabaseQuery': 'other',
  'task': 'agent',
  'Task': 'agent',
  'Agent': 'agent',
  'agent': 'agent',
  'Skill': 'agent',
  'skill': 'agent',
  'AskUserQuestion': 'other',
  'ask_user_question': 'other',

  // SimpleAI 引擎工具
  'bash': 'execute',
  'edit_file': 'edit',
  'list_directory': 'list',
  'glob': 'search',
  'apply_patch': 'edit',
  'update_plan': 'manage',
  'read_skill': 'agent',
  'dispatch_agent': 'agent',
  'browser': 'network',
  'computer': 'execute',
};

const TOOL_LABEL_KEYS: Record<string, string> = {
  'read_file': 'labels.read',
  'Read': 'labels.read',
  'ReadFile': 'labels.read',
  'str_replace_editor': 'labels.edit',
  'Edit': 'labels.edit',
  'write_file': 'labels.write',
  'WriteFile': 'labels.write',
  'create_file': 'labels.create',
  'CreateFile': 'labels.create',
  'Write': 'labels.write',
  'Bash': 'labels.execute',
  'BashCommand': 'labels.execute',
  'run_command': 'labels.execute',
  'shell': 'labels.execute',
  'shell_command': 'labels.execute',
  'command_execution': 'labels.execute',
  'Glob': 'labels.searchFiles',
  'Grep': 'labels.searchContent',
  'search_files': 'labels.search',
  'SearchFiles': 'labels.search',
  'web_search': 'labels.search',
  'WebSearch': 'labels.search',
  'git_command': 'labels.git',
  'GitCommand': 'labels.git',
  'list_files': 'labels.list',
  'ListFiles': 'labels.list',
  'delete_file': 'labels.delete',
  'DeleteFile': 'labels.delete',
  'database_query': 'labels.database',
  'DatabaseQuery': 'labels.database',
  'task': 'labels.task',
  'Task': 'labels.task',
  'Agent': 'labels.agent',
  'agent': 'labels.agent',
  'Skill': 'labels.skill',
  'skill': 'labels.skill',
  'TodoWrite': 'labels.todoList',
  'todowrite': 'labels.todoList',
  'Analyze': 'labels.analyze',
  'analyze': 'labels.analyze',
  'CodeAnalysis': 'labels.codeAnalysis',
  'code_analysis': 'labels.codeAnalysis',
  'WebFetch': 'labels.webRequest',
  'web_fetch': 'labels.webRequest',
  'AskUserQuestion': 'labels.ask',
  'ask_user_question': 'labels.ask',

  // SimpleAI 引擎工具
  'bash': 'labels.execute',
  'edit_file': 'labels.edit',
  'list_directory': 'labels.list',
  'glob': 'labels.searchFiles',
  'apply_patch': 'labels.applyPatch',
  'update_plan': 'labels.updatePlan',
  'read_skill': 'labels.skill',
  'dispatch_agent': 'labels.agent',
  'browser': 'labels.browser',
  'computer': 'labels.computer',
};

export function getToolConfig(toolName: string): ToolConfig {
  const category = TOOL_CATEGORY[toolName] || 'other';
  const categoryStyle = CATEGORY_CONFIG[category];
  const IconComponent = TOOL_ICONS[toolName] ?? TOOL_ICONS['default'] ?? Wrench;
  const labelKey = TOOL_LABEL_KEYS[toolName];
  const label = labelKey ? t(labelKey) : toolName;

  return {
    icon: IconComponent,
    category,
    color: categoryStyle.color,
    borderColor: categoryStyle.borderColor,
    bgColor: categoryStyle.bgColor,
    label,
  };
}

export function extractFileName(input: Record<string, unknown> | undefined): string {
  return extractFilePath(input);
}

export function extractCommand(input: Record<string, unknown> | undefined): string {
  return extractCommandImpl(input, 40);
}

export function extractSearchQuery(input: Record<string, unknown> | undefined): string {
  return extractSearchQueryImpl(input, 30);
}

function extractTodoInfo(input: Record<string, unknown> | undefined): string {
  return extractTodoInfoImpl(input);
}

function extractUrl(input: Record<string, unknown> | undefined): string {
  return extractUrlImpl(input, 30);
}

export function extractToolKeyInfo(toolName: string, input: Record<string, unknown> | undefined): string {
  const category = TOOL_CATEGORY[toolName];

  // Skill 工具特殊处理：提取 skill 参数
  if (toolName.toLowerCase() === 'skill' && input) {
    const skill = input.skill as string | undefined;
    if (skill) {
      // 提取技能名称（去掉前缀如 "superpowers:"）
      return skill.includes(':') ? skill.split(':').pop() || skill : skill;
    }
  }

  // Task/Agent 工具：提取 prompt 参数
  if ((toolName.toLowerCase() === 'task' || toolName.toLowerCase() === 'agent') && input) {
    const prompt = input.prompt as string | undefined;
    if (prompt) {
      return prompt.length > 50 ? prompt.slice(0, 47) + '...' : prompt;
    }
    // 尝试 description 参数
    const description = input.description as string | undefined;
    if (description) {
      return description.length > 50 ? description.slice(0, 47) + '...' : description;
    }
  }

  // AskUserQuestion 工具：提取问题标题
  if (toolName.toLowerCase() === 'askuserquestion' && input) {
    const header = input.header as string | undefined;
    if (header) return header;

    const questions = input.questions as Array<{ question?: string }> | undefined;
    if (Array.isArray(questions) && questions[0]?.question) {
      const q = questions[0].question;
      return q.length > 50 ? q.slice(0, 47) + '...' : q;
    }
  }

  // SimpleAI edit_file：提取路径 + 行号范围
  if (toolName === 'edit_file' && input) {
    const path = input.path as string | undefined;
    const startLine = input.start_line as number | undefined;
    const endLine = input.end_line as number | undefined;
    const fileName = path ? path.split('/').pop() || path.split('\\').pop() || path : '';
    if (fileName && startLine && endLine) {
      return `${fileName} L${startLine}-L${endLine}`;
    }
    if (fileName) return fileName;
  }

  // SimpleAI apply_patch：从补丁信封提取文件数
  if (toolName === 'apply_patch' && input) {
    const raw = input.input as string | undefined;
    if (raw) {
      const fileCount = (raw.match(/\*\*\* (Add|Update|Delete) File:/g) || []).length;
      if (fileCount > 0) return `${fileCount} 文件`;
    }
  }

  // SimpleAI update_plan：提取步骤数
  if (toolName === 'update_plan' && input) {
    const plan = input.plan as Array<unknown> | undefined;
    if (Array.isArray(plan)) return `${plan.length} 步`;
  }

  switch (category) {
    case 'read':
    case 'edit':
    case 'write':
    case 'delete':
      // Glob 工具：优先提取 pattern 而非 path（path 是搜索根目录）
      if (toolName.toLowerCase() === 'glob' && input?.pattern) {
        const p = input.pattern as string;
        return p.length > 40 ? p.slice(0, 37) + '...' : p;
      }
      return extractFileName(input);
    case 'execute':
    case 'git':
      return extractCommand(input);
    case 'search':
      return extractSearchQuery(input);
    case 'list':
      return extractFileName(input) || t('output.noFiles');
    case 'manage':
      if (toolName.toLowerCase().includes('todo')) {
        return extractTodoInfo(input);
      }
      return extractFileName(input) || extractCommand(input) || '';
    case 'network':
      return extractUrl(input) || extractSearchQuery(input);
    case 'analyze':
      return extractFileName(input) || extractSearchQuery(input);
    default:
      return extractFileName(input) || extractCommand(input) || extractSearchQuery(input) || '';
  }
}
