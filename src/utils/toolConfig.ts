/**
 * Tool Configuration - Icons, Colors, Labels Mapping
 * Uses lucide-react icon library
 */

import i18n from '@/i18n';
import type { ToolCategory, ToolConfig } from './toolConfig.types';
import {
  extractFilePath,
  extractRelativeDir,
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
  Boxes,
  Layers,
  Sparkles,
  ListPlus,
  RefreshCw,
  ClipboardList,
  ScrollText,
  Square,
  Workflow as WorkflowIcon,
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

  // Claude Code Task 工具家族（双字符，避开与 TodoWrite 的 'T' 碰撞）
  'TaskCreate': 'TC',
  'TaskUpdate': 'TU',
  'TaskList': 'TL',
  'TaskGet': 'TG',
  'TaskOutput': 'TO',
  'TaskStop': 'TS',
  'Workflow': 'WF',

  // Pi 引擎工具（全小写）
  'read': 'R',
  'edit': 'E',
  'write': 'W',
  'grep': 'G',

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
  const exact = TOOL_SHORT_NAMES[toolName];
  if (exact) return exact;

  // MCP 工具：取 server 名首字母（如 mcp__polaris-api__send_message → 'p'），
  // 比整串原始名首字母更有辨识度
  const mcp = parseMcpToolName(toolName);
  if (mcp) return mcp.server.charAt(0).toUpperCase();

  return toolName.charAt(0).toUpperCase();
}

// ========================================
// 未注册工具名解析层（MCP 前缀 + 启发式友好名）
// ========================================

/**
 * 解析 MCP 工具完整名 `mcp__{server}__{tool}`。
 * 非 MCP 工具返回 null。
 */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  const idx = rest.indexOf('__');
  if (idx <= 0) return null;
  const server = rest.slice(0, idx);
  const tool = rest.slice(idx + 2);
  if (!server || !tool) return null;
  return { server, tool };
}

/** snake_case / kebab-case → 空格分词 */
function splitNameWords(raw: string): string[] {
  return raw
    .replace(/[_-]+/g, ' ')
    // camelCase 边界（含连续大写后接小写，如 HTTPRequest → HTTP Request）
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** 常见动词/名词的中文词典（未注册工具的启发式友好名） */
const NAME_WORD_ZH: Record<string, string> = {
  send: '发送',
  message: '消息',
  msg: '消息',
  read: '读取',
  write: '写入',
  edit: '编辑',
  create: '创建',
  delete: '删除',
  remove: '移除',
  update: '更新',
  get: '获取',
  set: '设置',
  list: '列出',
  search: '搜索',
  find: '查找',
  query: '查询',
  run: '运行',
  exec: '执行',
  execute: '执行',
  call: '调用',
  fetch: '抓取',
  open: '打开',
  close: '关闭',
  start: '启动',
  stop: '停止',
  restart: '重启',
  check: '检查',
  wait: '等待',
  upload: '上传',
  download: '下载',
  copy: '复制',
  move: '移动',
  rename: '重命名',
  generate: '生成',
  save: '保存',
  load: '加载',
  parse: '解析',
  convert: '转换',
  test: '测试',
  install: '安装',
  uninstall: '卸载',
  status: '状态',
  file: '文件',
  files: '文件',
  dir: '目录',
  directory: '目录',
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
  content: '内容',
  data: '数据',
  config: '配置',
  task: '任务',
  todo: '待办',
  plan: '计划',
  session: '会话',
  history: '历史',
  log: '日志',
  report: '报告',
  url: '链接',
  web: '网页',
  page: '页面',
  browser: '浏览器',
  tab: '标签页',
  git: 'Git',
  commit: '提交',
  push: '推送',
  pull: '拉取',
  branch: '分支',
  merge: '合并',
  diff: '差异',
  code: '代码',
  repo: '仓库',
  prompt: '提示词',
  agent: '代理',
  skill: '技能',
  tool: '工具',
  server: '服务器',
  client: '客户端',
  api: 'API',
  http: 'HTTP',
  db: '数据库',
  database: '数据库',
  sql: 'SQL',
};

/**
 * 启发式生成未注册工具的中文友好名：
 * 取分词后词典命中的词拼接（最多 2 个），如
 * 'send_message' → '发送消息'、'read_file_chunk' → '读取文件'。
 * 全部未命中时返回空字符串（由调用方回退原始名）。
 */
function heuristicFriendlyName(toolName: string): string {
  const words = splitNameWords(toolName);
  const hits: string[] = [];
  for (const w of words) {
    const zh = NAME_WORD_ZH[w.toLowerCase()];
    if (zh && !hits.includes(zh)) hits.push(zh);
    if (hits.length >= 2) break;
  }
  return hits.join('');
}

/**
 * 获取工具显示名（统一入口）。
 *
 * 优先级：
 * 1. 精确映射（TOOL_LABEL_KEYS，已注册内置工具，行为不变）
 * 2. MCP 前缀解析 → `{server 词典名} · {tool 启发式名/原名}`
 * 3. 启发式分词词典（snake/camel 工具名 → 中文）
 * 4. 原始名兜底
 */
export function getToolDisplayName(toolName: string): string {
  const exact = TOOL_LABEL_KEYS[toolName];
  if (exact) return t(exact);

  const mcp = parseMcpToolName(toolName);
  if (mcp) {
    const serverZh = NAME_WORD_ZH[mcp.server.toLowerCase()] || mcp.server;
    const toolZh = heuristicFriendlyName(mcp.tool);
    return toolZh ? `${serverZh} · ${toolZh}` : `${serverZh} · ${mcp.tool}`;
  }

  const heur = heuristicFriendlyName(toolName);
  if (heur && heur.length >= 2) return heur;

  return toolName;
}

/** 按工具名关键词推断未注册工具的分类（供 MCP/未知工具回退使用） */
function inferCategory(toolName: string): ToolCategory {
  const n = toolName.toLowerCase();
  if (n.includes('send') || n.includes('message') || n.includes('notify') || n.includes('chat')) return 'network';
  if (n.includes('git') || n.includes('commit') || n.includes('branch')) return 'git';
  if (n.includes('delete') || n.includes('remove')) return 'delete';
  if (n.includes('search') || n.includes('query') || n.includes('find')) return 'search';
  if (n.includes('web') || n.includes('http') || n.includes('fetch') || n.includes('url')) return 'network';
  if (n.includes('bash') || n.includes('command') || n.includes('execute') || n.includes('run')) return 'execute';
  if (n.includes('edit') || n.includes('patch') || n.includes('modify')) return 'edit';
  if (n.includes('write') || n.includes('create') || n.includes('save')) return 'write';
  if (n.includes('read') || n.includes('view') || n.includes('open')) return 'read';
  if (n.includes('list') || n.includes('ls') || n.includes('tree')) return 'list';
  if (n.includes('task') || n.includes('todo') || n.includes('plan')) return 'manage';
  if (n.includes('agent') || n.includes('skill')) return 'agent';
  if (n.includes('analyze') || n.includes('check') || n.includes('lint')) return 'analyze';
  return 'other';
}

/** 工具分类中文描述（岛卡 detail 用，与 summary 的关键参数不重复） */
const CATEGORY_DESCRIPTIONS: Record<ToolCategory, string> = {
  read: '读取文件',
  edit: '编辑文件',
  write: '写入文件',
  execute: '执行命令',
  search: '搜索内容',
  list: '浏览文件',
  git: 'Git 操作',
  delete: '删除文件',
  manage: '任务管理',
  analyze: '代码分析',
  network: '网络请求',
  agent: '调用代理',
  other: '执行操作',
};

/** 获取工具分类（未注册工具按名称关键词推断，MCP 工具取 tool 部分推断） */
export function getToolCategory(toolName: string): ToolCategory {
  return TOOL_CATEGORY[toolName] || inferCategory(toolName);
}

/** 获取工具分类描述文案 */
export function getToolCategoryDescription(toolName: string): string {
  return CATEGORY_DESCRIPTIONS[getToolCategory(toolName)] || '执行操作';
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

  // Claude Code Task 工具家族
  'TaskCreate': ListPlus,
  'TaskUpdate': RefreshCw,
  'TaskList': ClipboardList,
  'TaskGet': Search,
  'TaskOutput': ScrollText,
  'TaskStop': Square,
  'Workflow': WorkflowIcon,

  // Pi 引擎工具（全小写）
  'read': FileText,
  'edit': Edit2,
  'write': Save,
  'grep': FileSearch,

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

  // Claude Code Task 工具家族
  'TaskCreate': 'manage',
  'TaskUpdate': 'manage',
  'TaskList': 'manage',
  'TaskGet': 'manage',
  'TaskOutput': 'manage',
  'TaskStop': 'manage',
  'Workflow': 'agent',

  // Pi 引擎工具（全小写）
  'read': 'read',
  'edit': 'edit',
  'write': 'write',
  'grep': 'search',

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

  // Claude Code Task 工具家族
  'TaskCreate': 'labels.taskCreate',
  'TaskUpdate': 'labels.taskUpdate',
  'TaskList': 'labels.taskList',
  'TaskGet': 'labels.taskGet',
  'TaskOutput': 'labels.taskOutput',
  'TaskStop': 'labels.taskStop',
  'Workflow': 'labels.workflow',

  // Pi 引擎工具（全小写）
  'read': 'labels.read',
  'edit': 'labels.edit',
  'write': 'labels.write',
  'grep': 'labels.searchContent',

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

/** 按分类回退图标（未注册工具 / MCP 工具的图标推断） */
const CATEGORY_FALLBACK_ICONS: Record<ToolCategory, React.ComponentType<{ className?: string }>> = {
  read: FileText,
  write: Save,
  edit: Edit2,
  execute: Terminal,
  search: Search,
  list: List,
  git: GitBranch,
  delete: Trash2,
  manage: ListChecks,
  analyze: ScanSearch,
  network: Globe2,
  agent: Cpu,
  other: Wrench,
};

/** 未注册工具的图标推断：先按分类回退，再按名称关键词微调 */
function inferIcon(toolName: string): React.ComponentType<{ className?: string }> | undefined {
  const category = inferCategory(toolName);
  const fallback = CATEGORY_FALLBACK_ICONS[category];
  if (fallback && fallback !== Wrench) return fallback;

  // 'other' 分类下再按特征细分
  const n = toolName.toLowerCase();
  const mcp = parseMcpToolName(toolName);
  const bare = (mcp ? mcp.tool : toolName).toLowerCase();
  if (n.includes('image') || bare.includes('image')) return FileSearch;
  if (n.includes('browser') || bare.includes('browser') || bare.includes('web')) return Globe2;
  if (n.includes('database') || n.includes('_db') || bare.includes('db')) return Database;
  if (n.startsWith('mcp__')) return Boxes; // MCP 通用兜底：组件箱
  return undefined;
}

export function getToolConfig(toolName: string): ToolConfig {
  const category = getToolCategory(toolName);
  const categoryStyle = CATEGORY_CONFIG[category];
  const IconComponent = TOOL_ICONS[toolName] ?? inferIcon(toolName) ?? TOOL_ICONS['default'] ?? Wrench;
  const labelKey = TOOL_LABEL_KEYS[toolName];
  const label = labelKey ? t(labelKey) : getToolDisplayName(toolName);

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

/**
 * 提取「文件名 + 相对目录」组合，用于头部主次展示：
 * 文件名为主，目录作为次要信息跟随（无目录时仅返回文件名）。
 *
 * @example
 * extractFileNameWithDir({ path: 'src/components/Foo.tsx' })
 * // => 'Foo.tsx · src/components'
 */
export function extractFileNameWithDir(input: Record<string, unknown> | undefined): string {
  const fileName = extractFilePath(input);
  if (!fileName) return '';
  const dir = extractRelativeDir(input);
  return dir ? `${fileName} · ${dir}` : fileName;
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

// prompt 类字段序列提取（Task/Agent/Workflow 家族通用），与灵动岛 deriveWorkflowLabel 同构
function extractPromptLike(input: Record<string, unknown> | undefined, maxLen = 50): string {
  if (!input) return '';
  for (const key of ['prompt', 'task', 'description', 'goal', 'query']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) {
      return v.length > maxLen ? v.slice(0, maxLen - 3) + '...' : v;
    }
  }
  return '';
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

  // Task/Agent/Workflow 工具：提取 prompt/description 等指令字段
  // 覆盖 Agent、Task 旧名，Task 家族（TaskCreate/TaskUpdate/TaskList/TaskGet/TaskOutput/TaskStop），
  // 以及 Workflow / dispatch_agent / read_skill 等 agent 类工具
  const lowerName = toolName.toLowerCase();
  if ((lowerName === 'task' || lowerName === 'agent') && input) {
    const info = extractPromptLike(input);
    if (info) return info;
  }

  // Task 家族工具：按工具语义提取关键参数
  if (lowerName.startsWith('task') && lowerName !== 'task' && input) {
    // TaskCreate：优先 activeForm（进行中描述），次选 subject
    if (lowerName === 'taskcreate') {
      const activeForm = input.activeForm as string | undefined;
      if (activeForm) return activeForm.length > 50 ? activeForm.slice(0, 47) + '...' : activeForm;
      const subject = input.subject as string | undefined;
      if (subject) return subject.length > 50 ? subject.slice(0, 47) + '...' : subject;
      return '';
    }
    // TaskUpdate：taskId + 新状态
    if (lowerName === 'taskupdate') {
      const taskId = input.taskId as string | undefined;
      const status = input.status as string | undefined;
      if (taskId && status) return `#${taskId} → ${status}`;
      if (taskId) return `#${taskId}`;
      return status ? `→ ${status}` : '';
    }
    // TaskGet / TaskOutput / TaskStop：task_id（或 taskId）
    if (lowerName === 'taskget' || lowerName === 'taskoutput' || lowerName === 'taskstop') {
      const taskId = (input.task_id || input.taskId) as string | undefined;
      return taskId ? `#${taskId}` : '';
    }
    // TaskList：无参数
    if (lowerName === 'tasklist') return '';
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
      return extractFileNameWithDir(input);
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
    case 'agent':
      // Workflow / dispatch_agent / read_skill 等：提取指令字段，退化为技能名/查询词
      return extractPromptLike(input) || extractSearchQuery(input);
    default:
      return extractFileName(input) || extractCommand(input) || extractSearchQuery(input) || '';
  }
}
