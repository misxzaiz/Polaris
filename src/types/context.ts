/**
 * 上下文芯片系统类型定义
 * 支持可视化显示和管理 AI 对话中的各种上下文引用
 */

import type { Workspace } from './workspace';

/**
 * 上下文芯片类型
 */
export type ContextChipType =
  | 'file'        // 文件引用
  | 'symbol'      // 代码符号（函数、类等）
  | 'commit'      // Git 提交
  | 'diff'        // Git 差异
  | 'workspace'   // 工作区
  | 'directory';  // 目录

/**
 * 文件上下文芯片
 */
export interface FileContextChip {
  type: 'file';
  path: string;
  size: number;
  language?: string;
  workspace?: Workspace;
}

/**
 * 符号上下文芯片
 */
export interface SymbolContextChip {
  type: 'symbol';
  name: string;
  kind: 'function' | 'class' | 'variable' | 'constant' | 'interface' | 'type' | 'enum';
  filePath: string;
  line?: number;
}

/**
 * Git 提交上下文芯片
 */
export interface CommitContextChip {
  type: 'commit';
  hash: string;
  shortHash: string;
  message: string;
  author?: string;
  timestamp?: number;
}

/**
 * Git 差异上下文芯片
 */
export interface DiffContextChip {
  type: 'diff';
  target?: 'staged' | 'unstaged' | 'commit';
  targetHash?: string;
  fileCount?: number;
  stats?: {
    additions: number;
    deletions: number;
    modifications: number;
  };
}

/**
 * 工作区上下文芯片
 */
export interface WorkspaceContextChip {
  type: 'workspace';
  workspace: Workspace;
  fileCount?: number;
}

/**
 * 目录上下文芯片
 */
export interface DirectoryContextChip {
  type: 'directory';
  path: string;
  fileCount?: number;
  workspace?: Workspace;
}

/**
 * 上下文芯片联合类型（带 id 的版本，用于组件）
 * id 是自动生成的唯一标识符
 */
export type ContextChipWithId = (FileContextChip | SymbolContextChip | CommitContextChip | DiffContextChip | WorkspaceContextChip | DirectoryContextChip) & {
  id: string;
};

/**
 * 上下文芯片联合类型（基础版本）
 */
export type ContextChip =
  | FileContextChip
  | SymbolContextChip
  | CommitContextChip
  | DiffContextChip
  | WorkspaceContextChip
  | DirectoryContextChip;

/**
 * 为芯片添加 id 属性
 */
export function addChipId(chip: ContextChip): ContextChipWithId {
  return {
    ...chip,
    id: getChipId(chip),
  };
}

/**
 * 上下文芯片唯一标识符
 */
export function getChipId(chip: ContextChip): string {
  switch (chip.type) {
    case 'file':
      return `file:${chip.workspace?.id ?? 'current'}:${chip.path}`;
    case 'symbol':
      return `symbol:${chip.filePath}:${chip.name}:${chip.line ?? 0}`;
    case 'commit':
      return `commit:${chip.hash}`;
    case 'diff':
      return `diff:${chip.target ?? 'unstaged'}:${chip.targetHash ?? ''}`;
    case 'workspace':
      return `workspace:${chip.workspace.id}`;
    case 'directory':
      return `directory:${chip.workspace?.id ?? 'current'}:${chip.path}`;
    default:
      return `unknown:${JSON.stringify(chip)}`;
  }
}

/**
 * 获取芯片显示文本
 */
export function getChipLabel(chip: ContextChip): string {
  switch (chip.type) {
    case 'file':
      return chip.path.split(/[/\\]/).pop() ?? chip.path;
    case 'symbol':
      return chip.name;
    case 'commit':
      return chip.shortHash;
    case 'diff':
      return chip.target === 'staged' ? '已暂存' : chip.target === 'commit' ? `提交 ${chip.targetHash?.slice(0, 7)}` : '未暂存';
    case 'workspace':
      return chip.workspace.name;
    case 'directory':
      return chip.path.split(/[/\\]/).pop() ?? chip.path;
    default:
      return '';
  }
}

/**
 * 获取芯片描述文本
 */
export function getChipDescription(chip: ContextChip): string {
  switch (chip.type) {
    case 'file':
      return `${chip.path} • ${formatSize(chip.size)}`;
    case 'symbol':
      return `${chip.kind} • ${chip.filePath}`;
    case 'commit':
      return chip.message;
    case 'diff':
      if (chip.stats) {
        return `+${chip.stats.additions} -${chip.stats.deletions}`;
      }
      return 'Git 差异';
    case 'workspace':
      return chip.fileCount ? `${chip.fileCount} 文件` : '工作区';
    case 'directory':
      return chip.path + (chip.fileCount ? ` • ${chip.fileCount} 文件` : '');
    default:
      return '';
  }
}

/**
 * 格式化文件大小
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 获取芯片图标类型
 */
export type ChipIconType = 'file' | 'symbol' | 'commit' | 'diff' | 'workspace' | 'directory';

export function getChipIcon(chip: ContextChip): ChipIconType {
  return chip.type;
}

// ── 上下文块（ContextBlock · TCB）────────────────────────────────────────────
// 自 conversationStore/types.ts 提升为共享类型：capSlashCommand 等 chrome 消费方
// 只依赖此形状，不再依赖会话状态层实现（chat-desk P6）。

/** 上下文块种类：除内置 kinds 外，来源方/插件可用任意字符串 kind 注册渲染/格式化器 */
export type ContextBlockKind =
  | 'marquee-context' // 浏览器圈选区域
  | 'text-selection'  // 页面文本选中（预留）
  | 'screenshot'      // 页面截图（预留）
  | string            // 插件/来源自定义 kind（未注册时降级渲染）

/** 上下文块（TCB）· 挂在 AI 输入框的临时上下文（与附件平行，不进附件管线） */
export interface ContextBlock {
  id: string
  kind: ContextBlockKind
  title: string
  source?: string
  dedupeKey?: string
  userNote?: string
  data?: Record<string, unknown>
  // marquee-context 顶层兼容字段（双字段兼容，新 kind 只写 data）
  url?: string
  regions?: import('./browserContext').BrowserRegion[]
  browserLabel?: string
}
