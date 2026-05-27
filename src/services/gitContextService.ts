/**
 * Git 上下文服务
 * 提供 Git 相关的上下文信息获取功能
 */

import { invoke } from '@/services/transport'
import type { CommitContextChip, DiffContextChip } from '../types/context';
import { createLogger } from '../utils/logger';

const log = createLogger('GitContextService');

/**
 * Git 提交信息
 */
export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  timestamp: number;
}

/**
 * Git 差异统计
 */
export interface GitDiffStats {
  additions: number;
  deletions: number;
  modifications: number;
  files: string[];
}

/**
 * Git 状态信息
 */
export interface GitStatus {
  branch: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/**
 * Git 服务错误
 */
export class GitServiceError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'GitServiceError';
  }
}

/**
 * 获取 Git 提交历史
 */
export async function getGitCommits(
  workDir: string,
  options: {
    limit?: number;
    offset?: number;
    branch?: string;
    author?: string;
    since?: string;
  } = {}
): Promise<GitCommit[]> {
  try {
    // Use the IPC bridge command (git_get_log) instead of plugin:git
    const result = await invoke<unknown[]>('git_get_log', {
      workspacePath: workDir,
    });
    // Map the result to GitCommit format
    const commits: GitCommit[] = (Array.isArray(result) ? result : []).map((c: unknown) => {
      const obj = c as Record<string, unknown>;
      return {
        hash: String(obj.hash || obj.id || ''),
        shortHash: String(obj.shortHash || obj.hash?.toString().slice(0, 7) || ''),
        message: String(obj.message || obj.subject || ''),
        author: String(obj.author || obj.authorName || ''),
        timestamp: Number(obj.timestamp || obj.date || 0),
      };
    });
    // Apply filters
    let filtered = commits;
    if (options.branch) {
      const branch = options.branch;
      filtered = filtered.filter(c => c.message.includes(branch));
    }
    if (options.author) {
      const author = options.author.toLowerCase();
      filtered = filtered.filter(c => c.author.toLowerCase().includes(author));
    }
    if (options.since) {
      const since = new Date(options.since).getTime();
      filtered = filtered.filter(c => c.timestamp >= since);
    }
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 20;
    return filtered.slice(offset, offset + limit);
  } catch (error) {
    log.error('Failed to get git commits', error instanceof Error ? error : new Error(String(error)));
    return [];
  }
}

/**
 * 获取单个提交详情
 */
export async function getGitCommit(workDir: string, hash: string): Promise<GitCommit | null> {
  try {
    const commits = await getGitCommits(workDir, { limit: 50 });
    return commits.find(c => c.hash === hash || c.shortHash === hash) ?? null;
  } catch {
    return null;
  }
}

/**
 * 获取 Git 差异统计
 */
export async function getGitDiffStats(
  workDir: string,
  options: {
    staged?: boolean;
    targetHash?: string;
    sourceHash?: string;
  } = {}
): Promise<GitDiffStats | null> {
  try {
    const cmd = options.staged ? 'git_get_index_diff' : 'git_get_worktree_diff';
    const result = await invoke<unknown>(cmd, {
      workspacePath: workDir,
    });
    // Map to GitDiffStats format
    const obj = result as Record<string, unknown>;
    const files = Array.isArray(obj.files) ? obj.files.map(String) : [];
    return {
      additions: Number(obj.additions ?? obj.insertions ?? 0),
      deletions: Number(obj.deletions ?? 0),
      modifications: files.length,
      files,
    };
  } catch (error) {
    log.error('Failed to get git diff stats', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * 获取 Git 状态
 */
export async function getGitStatus(workDir: string): Promise<GitStatus | null> {
  try {
    const result = await invoke<Record<string, unknown>>('git_get_status', {
      workspacePath: workDir,
    });
    return {
      branch: String(result.branch || ''),
      staged: Array.isArray(result.staged) ? result.staged.map(String) : [],
      unstaged: Array.isArray(result.unstaged) ? result.unstaged.map(String) : [],
      untracked: Array.isArray(result.untracked) ? result.untracked.map(String) : [],
    };
  } catch (error) {
    log.error('Failed to get git status:', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * 搜索 Git 提交
 */
export async function searchGitCommits(
  workDir: string,
  query: string,
  options: { limit?: number } = {}
): Promise<GitCommit[]> {
  try {
    const commits = await getGitCommits(workDir, { limit: options.limit ?? 50 });
    const lowerQuery = query.toLowerCase();

    return commits.filter(commit =>
      commit.message.toLowerCase().includes(lowerQuery) ||
      commit.hash.toLowerCase().startsWith(lowerQuery) ||
      commit.shortHash.toLowerCase().startsWith(lowerQuery) ||
      commit.author.toLowerCase().includes(lowerQuery)
    );
  } catch {
    return [];
  }
}

/**
 * 创建提交上下文芯片
 */
export function createCommitChip(commit: GitCommit): CommitContextChip {
  return {
    type: 'commit',
    hash: commit.hash,
    shortHash: commit.shortHash,
    message: commit.message,
    author: commit.author,
    timestamp: commit.timestamp,
  };
}

/**
 * 创建差异上下文芯片
 */
export function createDiffChip(
  target: 'staged' | 'unstaged' | 'commit',
  stats?: GitDiffStats,
  targetHash?: string
): DiffContextChip {
  return {
    type: 'diff',
    target,
    targetHash,
    fileCount: stats?.files.length,
    stats: stats ? {
      additions: stats.additions,
      deletions: stats.deletions,
      modifications: stats.modifications,
    } : undefined,
  };
}

/**
 * 格式化相对时间
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;

  const date = new Date(timestamp);
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

/**
 * 检查是否在 Git 仓库中
 */
export async function isInGitRepo(workDir: string): Promise<boolean> {
  try {
    const status = await getGitStatus(workDir);
    return status !== null;
  } catch {
    return false;
  }
}
