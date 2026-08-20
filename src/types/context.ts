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
