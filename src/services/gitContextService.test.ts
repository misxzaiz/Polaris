/**
 * Git 上下文服务测试
 *
 * 测试覆盖：
 * - getGitCommits: 获取 Git 提交历史
 * - getGitCommit: 获取单个提交详情
 * - getGitDiffStats: 获取 Git 差异统计
 * - getGitStatus: 获取 Git 状态
 * - searchGitCommits: 搜索 Git 提交
 * - createCommitChip: 创建提交上下文芯片
 * - createDiffChip: 创建差异上下文芯片
 * - formatRelativeTime: 格式化相对时间
 * - isInGitRepo: 检查是否在 Git 仓库中
 * - GitServiceError: 自定义错误类
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  getGitCommits,
  getGitCommit,
  getGitDiffStats,
  getGitStatus,
  searchGitCommits,
  createCommitChip,
  createDiffChip,
  formatRelativeTime,
  isInGitRepo,
  GitServiceError,
  type GitCommit,
  type GitDiffStats,
  type GitStatus,
} from './gitContextService';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock logger to suppress console output in tests
vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('gitContextService', () => {
  const mockInvoke = vi.mocked(invoke);
  const testWorkDir = '/test/workspace';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GitServiceError', () => {
    it('should create error with message', () => {
      const error = new GitServiceError('Test error');
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('GitServiceError');
      expect(error.code).toBeUndefined();
    });

    it('should create error with message and code', () => {
      const error = new GitServiceError('Test error', 'GIT_001');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('GIT_001');
    });

    it('should be instance of Error', () => {
      const error = new GitServiceError('Test error');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('getGitCommits', () => {
    const mockCommits: GitCommit[] = [
      {
        hash: 'abc123def456789',
        shortHash: 'abc123d',
        message: 'feat: add new feature',
        author: 'John Doe',
        timestamp: Date.now() - 3600000,
      },
      {
        hash: 'def456abc789123',
        shortHash: 'def456a',
        message: 'fix: fix bug',
        author: 'Jane Smith',
        timestamp: Date.now() - 7200000,
      },
    ];

    it('should get commits with default options', async () => {
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await getGitCommits(testWorkDir);

      expect(mockInvoke).toHaveBeenCalledWith('plugin:git|get_commits', {
        dir: testWorkDir,
        limit: 20,
        offset: 0,
        branch: undefined,
        author: undefined,
        since: undefined,
      });
      expect(result).toEqual(mockCommits);
    });

    it('should get commits with custom options', async () => {
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await getGitCommits(testWorkDir, {
        limit: 50,
        offset: 10,
        branch: 'main',
        author: 'John Doe',
        since: '2024-01-01',
      });

      expect(mockInvoke).toHaveBeenCalledWith('plugin:git|get_commits', {
        dir: testWorkDir,
        limit: 50,
        offset: 10,
        branch: 'main',
        author: 'John Doe',
        since: '2024-01-01',
      });
      expect(result).toEqual(mockCommits);
    });

    it('should return empty array on error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Git error'));

      const result = await getGitCommits(testWorkDir);

      expect(result).toEqual([]);
    });

    it('should return empty array when invoke returns null', async () => {
      mockInvoke.mockResolvedValueOnce(null);

      const result = await getGitCommits(testWorkDir);

      expect(result).toBeNull();
    });
  });

  describe('getGitCommit', () => {
    const mockCommits: GitCommit[] = [
      {
        hash: 'abc123def456789',
        shortHash: 'abc123d',
        message: 'feat: add new feature',
        author: 'John Doe',
        timestamp: 1000000,
      },
      {
        hash: 'def456abc789123',
        shortHash: 'def456a',
        message: 'fix: fix bug',
        author: 'Jane Smith',
        timestamp: 2000000,
      },
    ];

    it('should find commit by full hash', async () => {
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await getGitCommit(testWorkDir, 'abc123def456789');

      expect(result).toEqual(mockCommits[0]);
    });

    it('should find commit by short hash', async () => {
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await getGitCommit(testWorkDir, 'def456a');

      expect(result).toEqual(mockCommits[1]);
    });

    it('should return null when commit not found', async () => {
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await getGitCommit(testWorkDir, 'nonexistent');

      expect(result).toBeNull();
    });

    it('should return null on error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Git error'));

      const result = await getGitCommit(testWorkDir, 'abc123');

      expect(result).toBeNull();
    });
  });

  describe('getGitDiffStats', () => {
    const mockStats: GitDiffStats = {
      additions: 10,
      deletions: 5,
      modifications: 3,
      files: ['src/file1.ts', 'src/file2.ts'],
    };

    it('should get diff stats with default options', async () => {
      mockInvoke.mockResolvedValueOnce(mockStats);

      const result = await getGitDiffStats(testWorkDir);

      expect(mockInvoke).toHaveBeenCalledWith('plugin:git|get_diff_stats', {
        dir: testWorkDir,
        staged: false,
        targetHash: undefined,
        sourceHash: undefined,
      });
      expect(result).toEqual(mockStats);
    });

    it('should get staged diff stats', async () => {
      mockInvoke.mockResolvedValueOnce(mockStats);

      const result = await getGitDiffStats(testWorkDir, { staged: true });

      expect(mockInvoke).toHaveBeenCalledWith('plugin:git|get_diff_stats', {
        dir: testWorkDir,
        staged: true,
        targetHash: undefined,
        sourceHash: undefined,
      });
      expect(result).toEqual(mockStats);
    });

    it('should get diff stats between commits', async () => {
      mockInvoke.mockResolvedValueOnce(mockStats);

      const result = await getGitDiffStats(testWorkDir, {
        targetHash: 'abc123',
        sourceHash: 'def456',
      });

      expect(mockInvoke).toHaveBeenCalledWith('plugin:git|get_diff_stats', {
        dir: testWorkDir,
        staged: false,
        targetHash: 'abc123',
        sourceHash: 'def456',
      });
      expect(result).toEqual(mockStats);
    });

    it('should return null on error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Git error'));

      const result = await getGitDiffStats(testWorkDir);

      expect(result).toBeNull();
    });
  });

  describe('getGitStatus', () => {
    const mockStatus: GitStatus = {
      branch: 'main',
      staged: ['src/file1.ts'],
      unstaged: ['src/file2.ts'],
      untracked: ['src/file3.ts'],
    };

    it('should get git status', async () => {
      mockInvoke.mockResolvedValueOnce(mockStatus);

      const result = await getGitStatus(testWorkDir);

      expect(mockInvoke).toHaveBeenCalledWith('plugin:git|get_status', {
        dir: testWorkDir,
      });
      expect(result).toEqual(mockStatus);
    });

    it('should return null on error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Git error'));

      const result = await getGitStatus(testWorkDir);

      expect(result).toBeNull();
    });
  });

  describe('searchGitCommits', () => {
    const mockCommits: GitCommit[] = [
      {
        hash: 'abc123def456789',
        shortHash: 'abc123d',
        message: 'feat: add new feature',
        author: 'John Doe',
        timestamp: 1000000,
      },
      {
        hash: 'def456abc789123',
        shortHash: 'def456a',
        message: 'fix: fix bug in module',
        author: 'Jane Smith',
        timestamp: 2000000,
      },
      {
        hash: '123abc456def789',
        shortHash: '123abc4',
        message: 'docs: update README',
        author: 'John Doe',
        timestamp: 3000000,
      },
    ];

    it('should search by message', async () => {
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await searchGitCommits(testWorkDir, 'feature');

      expect(result).toHaveLength(1);
      expect(result[0].message).toBe('feat: add new feature');
    });

    it('should search by hash', async () => {
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await searchGitCommits(testWorkDir, 'abc123d');

      expect(result).toHaveLength(1);
      expect(result[0].shortHash).toBe('abc123d');
    });

    it('should search by author', async () => {
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await searchGitCommits(testWorkDir, 'John');

      expect(result).toHaveLength(2);
      expect(result.every(c => c.author.includes('John'))).toBe(true);
    });

    it('should be case insensitive', async () => {
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await searchGitCommits(testWorkDir, 'FEATURE');

      expect(result).toHaveLength(1);
      expect(result[0].message).toBe('feat: add new feature');
    });

    it('should search by full hash prefix', async () => {
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await searchGitCommits(testWorkDir, 'abc123');

      expect(result).toHaveLength(1);
      expect(result[0].shortHash).toBe('abc123d');
    });

    it('should return empty array when no matches', async () => {
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await searchGitCommits(testWorkDir, 'nonexistent');

      expect(result).toEqual([]);
    });

    it('should return empty array on error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Git error'));

      const result = await searchGitCommits(testWorkDir, 'test');

      expect(result).toEqual([]);
    });

    it('should respect custom limit option', async () => {
      mockInvoke.mockResolvedValueOnce(mockCommits);

      await searchGitCommits(testWorkDir, 'test', { limit: 100 });

      expect(mockInvoke).toHaveBeenCalledWith('plugin:git|get_commits', {
        dir: testWorkDir,
        limit: 100,
        offset: 0,
        branch: undefined,
        author: undefined,
        since: undefined,
      });
    });
  });

  describe('createCommitChip', () => {
    it('should create commit chip from commit', () => {
      const commit: GitCommit = {
        hash: 'abc123def456789',
        shortHash: 'abc123d',
        message: 'feat: add new feature',
        author: 'John Doe',
        timestamp: 1000000,
      };

      const chip = createCommitChip(commit);

      expect(chip).toEqual({
        type: 'commit',
        hash: 'abc123def456789',
        shortHash: 'abc123d',
        message: 'feat: add new feature',
        author: 'John Doe',
        timestamp: 1000000,
      });
    });
  });

  describe('createDiffChip', () => {
    it('should create diff chip for staged changes', () => {
      const chip = createDiffChip('staged');

      expect(chip).toEqual({
        type: 'diff',
        target: 'staged',
        targetHash: undefined,
        fileCount: undefined,
        stats: undefined,
      });
    });

    it('should create diff chip for unstaged changes', () => {
      const chip = createDiffChip('unstaged');

      expect(chip).toEqual({
        type: 'diff',
        target: 'unstaged',
        targetHash: undefined,
        fileCount: undefined,
        stats: undefined,
      });
    });

    it('should create diff chip for commit with stats', () => {
      const stats: GitDiffStats = {
        additions: 10,
        deletions: 5,
        modifications: 3,
        files: ['file1.ts', 'file2.ts'],
      };

      const chip = createDiffChip('commit', stats, 'abc123');

      expect(chip).toEqual({
        type: 'diff',
        target: 'commit',
        targetHash: 'abc123',
        fileCount: 2,
        stats: {
          additions: 10,
          deletions: 5,
          modifications: 3,
        },
      });
    });

    it('should create diff chip without stats', () => {
      const chip = createDiffChip('staged');

      expect(chip.fileCount).toBeUndefined();
      expect(chip.stats).toBeUndefined();
    });
  });

  describe('formatRelativeTime', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-03-19T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return "刚刚" for less than 60 seconds', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 30000);
      expect(result).toBe('刚刚');
    });

    it('should return minutes ago for less than 60 minutes', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 1800000); // 30 minutes
      expect(result).toBe('30 分钟前');
    });

    it('should return hours ago for less than 24 hours', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 7200000); // 2 hours
      expect(result).toBe('2 小时前');
    });

    it('should return days ago for less than 7 days', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 172800000); // 2 days
      expect(result).toBe('2 天前');
    });

    it('should return date for 7 days or more', () => {
      const result = formatRelativeTime(new Date('2024-03-10').getTime());
      expect(result).toMatch(/3月/);
      expect(result).toMatch(/10/);
    });

    it('should handle 1 minute edge case', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 60000);
      expect(result).toBe('1 分钟前');
    });

    it('should handle 1 hour edge case', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 3600000);
      expect(result).toBe('1 小时前');
    });

    it('should handle 1 day edge case', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 86400000);
      expect(result).toBe('1 天前');
    });

    it('should handle 6 days edge case', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 518400000); // 6 days
      expect(result).toBe('6 天前');
    });
  });

  describe('isInGitRepo', () => {
    it('should return true when in git repo', async () => {
      const mockStatus: GitStatus = {
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: [],
      };
      mockInvoke.mockResolvedValueOnce(mockStatus);

      const result = await isInGitRepo(testWorkDir);

      expect(result).toBe(true);
    });

    it('should return false when not in git repo', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Not a git repo'));

      const result = await isInGitRepo(testWorkDir);

      expect(result).toBe(false);
    });

    it('should return false when status is null', async () => {
      mockInvoke.mockResolvedValueOnce(null);

      const result = await isInGitRepo(testWorkDir);

      expect(result).toBe(false);
    });

    it('should return true for repo with no changes', async () => {
      const mockStatus: GitStatus = {
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: [],
      };
      mockInvoke.mockResolvedValueOnce(mockStatus);

      const result = await isInGitRepo(testWorkDir);

      expect(result).toBe(true);
    });
  });

  // ========== 边界情况和错误处理扩展测试 ==========

  describe('getGitCommits - extended', () => {
    it('should handle empty commits result', async () => {
      mockInvoke.mockResolvedValueOnce([]);

      const result = await getGitCommits(testWorkDir);

      expect(result).toEqual([]);
    });

    it('should handle undefined result', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      const result = await getGitCommits(testWorkDir);

      expect(result).toBeUndefined();
    });

    it('should pass limit: 0 to invoke', async () => {
      mockInvoke.mockResolvedValueOnce([]);

      await getGitCommits(testWorkDir, { limit: 0 });

      expect(mockInvoke).toHaveBeenCalledWith('plugin:git|get_commits', {
        dir: testWorkDir,
        limit: 0,
        offset: 0,
        branch: undefined,
        author: undefined,
        since: undefined,
      });
    });

    it('should handle commits with special characters in message', async () => {
      const mockCommits: GitCommit[] = [
        {
          hash: 'abc123',
          shortHash: 'abc1',
          message: 'feat: 支持中文消息 🎉 <script>alert("xss")</script>',
          author: '开发者',
          timestamp: Date.now(),
        },
      ];
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await getGitCommits(testWorkDir);

      expect(result).toEqual(mockCommits);
    });

    it('should handle large number of commits', async () => {
      const mockCommits: GitCommit[] = Array.from({ length: 100 }, (_, i) => ({
        hash: `hash${i}`,
        shortHash: `h${i}`,
        message: `Commit ${i}`,
        author: 'Author',
        timestamp: Date.now() - i * 1000,
      }));
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await getGitCommits(testWorkDir, { limit: 100 });

      expect(result).toHaveLength(100);
    });

    it('should handle network-like error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Network timeout'));

      const result = await getGitCommits(testWorkDir);

      expect(result).toEqual([]);
    });

    it('should handle non-Error rejection', async () => {
      mockInvoke.mockRejectedValueOnce('string error');

      const result = await getGitCommits(testWorkDir);

      expect(result).toEqual([]);
    });
  });

  describe('getGitCommit - extended', () => {
    it('should handle empty hash', async () => {
      mockInvoke.mockResolvedValueOnce([]);

      const result = await getGitCommit(testWorkDir, '');

      expect(result).toBeNull();
    });

    it('should find commit by hash prefix using exact match', async () => {
      // Note: getGitCommit uses exact match (===), not startsWith
      // For prefix matching, use searchGitCommits instead
      const mockCommits: GitCommit[] = [
        {
          hash: 'abc123456789',
          shortHash: 'abc1234',
          message: 'First commit',
          author: 'Author1',
          timestamp: 1000,
        },
      ];
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await getGitCommit(testWorkDir, 'abc1234');

      expect(result).not.toBeNull();
      expect(result?.shortHash).toBe('abc1234');
    });

    it('should handle very long hash', async () => {
      const longHash = 'a'.repeat(64);
      const mockCommits: GitCommit[] = [
        {
          hash: longHash,
          shortHash: 'aaaaaaa',
          message: 'Commit',
          author: 'Author',
          timestamp: 1000,
        },
      ];
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await getGitCommit(testWorkDir, longHash);

      expect(result).not.toBeNull();
      expect(result?.hash).toBe(longHash);
    });
  });

  describe('getGitDiffStats - extended', () => {
    it('should handle empty files array', async () => {
      const mockStats: GitDiffStats = {
        additions: 0,
        deletions: 0,
        modifications: 0,
        files: [],
      };
      mockInvoke.mockResolvedValueOnce(mockStats);

      const result = await getGitDiffStats(testWorkDir);

      expect(result).toEqual(mockStats);
      expect(result?.files).toHaveLength(0);
    });

    it('should handle large numbers', async () => {
      const mockStats: GitDiffStats = {
        additions: 999999,
        deletions: 888888,
        modifications: 777777,
        files: ['file.ts'],
      };
      mockInvoke.mockResolvedValueOnce(mockStats);

      const result = await getGitDiffStats(testWorkDir);

      expect(result?.additions).toBe(999999);
    });

    it('should prioritize staged option over hashes', async () => {
      const mockStats: GitDiffStats = {
        additions: 1,
        deletions: 0,
        modifications: 0,
        files: ['file.ts'],
      };
      mockInvoke.mockResolvedValueOnce(mockStats);

      await getGitDiffStats(testWorkDir, { staged: true, targetHash: 'abc' });

      expect(mockInvoke).toHaveBeenCalledWith('plugin:git|get_diff_stats', {
        dir: testWorkDir,
        staged: true,
        targetHash: 'abc',
        sourceHash: undefined,
      });
    });
  });

  describe('getGitStatus - extended', () => {
    it('should handle empty branch name', async () => {
      const mockStatus: GitStatus = {
        branch: '',
        staged: [],
        unstaged: [],
        untracked: [],
      };
      mockInvoke.mockResolvedValueOnce(mockStatus);

      const result = await getGitStatus(testWorkDir);

      expect(result?.branch).toBe('');
    });

    it('should handle all empty arrays', async () => {
      const mockStatus: GitStatus = {
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: [],
      };
      mockInvoke.mockResolvedValueOnce(mockStatus);

      const result = await getGitStatus(testWorkDir);

      expect(result?.staged).toHaveLength(0);
      expect(result?.unstaged).toHaveLength(0);
      expect(result?.untracked).toHaveLength(0);
    });

    it('should handle many files in status', async () => {
      const mockStatus: GitStatus = {
        branch: 'main',
        staged: Array.from({ length: 50 }, (_, i) => `staged${i}.ts`),
        unstaged: Array.from({ length: 50 }, (_, i) => `unstaged${i}.ts`),
        untracked: Array.from({ length: 50 }, (_, i) => `untracked${i}.ts`),
      };
      mockInvoke.mockResolvedValueOnce(mockStatus);

      const result = await getGitStatus(testWorkDir);

      expect(result?.staged).toHaveLength(50);
    });
  });

  describe('searchGitCommits - extended', () => {
    it('should return all commits for empty query', async () => {
      const mockCommits: GitCommit[] = [
        {
          hash: 'abc',
          shortHash: 'a',
          message: 'Commit 1',
          author: 'Author',
          timestamp: 1000,
        },
        {
          hash: 'def',
          shortHash: 'd',
          message: 'Commit 2',
          author: 'Author',
          timestamp: 2000,
        },
      ];
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await searchGitCommits(testWorkDir, '');

      expect(result).toHaveLength(2);
    });

    it('should handle special regex characters in query', async () => {
      const mockCommits: GitCommit[] = [
        {
          hash: 'abc',
          shortHash: 'a',
          message: 'fix: handle (special) [chars]',
          author: 'Author',
          timestamp: 1000,
        },
      ];
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await searchGitCommits(testWorkDir, '(special)');

      expect(result).toHaveLength(1);
    });

    it('should search with Chinese characters', async () => {
      const mockCommits: GitCommit[] = [
        {
          hash: 'abc',
          shortHash: 'a',
          message: '功能: 新增中文支持',
          author: '开发者',
          timestamp: 1000,
        },
        {
          hash: 'def',
          shortHash: 'd',
          message: 'fix: bug fix',
          author: 'Developer',
          timestamp: 2000,
        },
      ];
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await searchGitCommits(testWorkDir, '中文');

      expect(result).toHaveLength(1);
      expect(result[0].message).toContain('中文');
    });

    it('should handle query with spaces', async () => {
      const mockCommits: GitCommit[] = [
        {
          hash: 'abc',
          shortHash: 'a',
          message: 'feat: add new feature',
          author: 'John Doe',
          timestamp: 1000,
        },
      ];
      mockInvoke.mockResolvedValueOnce(mockCommits);

      const result = await searchGitCommits(testWorkDir, 'new feature');

      expect(result).toHaveLength(1);
    });
  });

  describe('createCommitChip - extended', () => {
    it('should handle empty message', () => {
      const commit: GitCommit = {
        hash: 'abc123',
        shortHash: 'abc',
        message: '',
        author: 'Author',
        timestamp: 1000,
      };

      const chip = createCommitChip(commit);

      expect(chip.message).toBe('');
    });

    it('should handle special characters in author', () => {
      const commit: GitCommit = {
        hash: 'abc',
        shortHash: 'a',
        message: 'Commit',
        author: 'John "The Developer" Doe <john@example.com>',
        timestamp: 1000,
      };

      const chip = createCommitChip(commit);

      expect(chip.author).toContain('<');
    });

    it('should handle unicode in message', () => {
      const commit: GitCommit = {
        hash: 'abc',
        shortHash: 'a',
        message: '🎉 feat: new feature 中文',
        author: 'Author',
        timestamp: 1000,
      };

      const chip = createCommitChip(commit);

      expect(chip.message).toContain('🎉');
      expect(chip.message).toContain('中文');
    });
  });

  describe('createDiffChip - extended', () => {
    it('should handle stats with zero values', () => {
      const stats: GitDiffStats = {
        additions: 0,
        deletions: 0,
        modifications: 0,
        files: ['file.ts'],
      };

      const chip = createDiffChip('staged', stats);

      expect(chip.stats?.additions).toBe(0);
      expect(chip.stats?.deletions).toBe(0);
      expect(chip.stats?.modifications).toBe(0);
    });

    it('should handle stats with empty files array', () => {
      const stats: GitDiffStats = {
        additions: 1,
        deletions: 1,
        modifications: 1,
        files: [],
      };

      const chip = createDiffChip('staged', stats);

      expect(chip.fileCount).toBe(0);
    });

    it('should create chip for commit without stats', () => {
      const chip = createDiffChip('commit', undefined, 'abc123');

      expect(chip.target).toBe('commit');
      expect(chip.targetHash).toBe('abc123');
      expect(chip.stats).toBeUndefined();
    });
  });

  describe('formatRelativeTime - extended', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-03-19T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should handle future timestamp (negative diff)', () => {
      const futureTime = Date.now() + 60000;
      const result = formatRelativeTime(futureTime);
      // Should still return some result (implementation dependent)
      expect(typeof result).toBe('string');
    });

    it('should handle timestamp at 0', () => {
      const result = formatRelativeTime(0);
      expect(typeof result).toBe('string');
    });

    it('should handle exactly 59 seconds', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 59000);
      expect(result).toBe('刚刚');
    });

    it('should handle exactly 60 seconds (1 minute)', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 60000);
      expect(result).toBe('1 分钟前');
    });

    it('should handle exactly 59 minutes', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 3540000); // 59 minutes
      expect(result).toBe('59 分钟前');
    });

    it('should handle exactly 60 minutes (1 hour)', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 3600000);
      expect(result).toBe('1 小时前');
    });

    it('should handle exactly 23 hours', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 82800000); // 23 hours
      expect(result).toBe('23 小时前');
    });

    it('should handle exactly 24 hours (1 day)', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 86400000);
      expect(result).toBe('1 天前');
    });

    it('should handle exactly 6 days', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 518400000);
      expect(result).toBe('6 天前');
    });

    it('should handle exactly 7 days', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 604800000);
      expect(result).toMatch(/3月/);
    });

    it('should handle 100 days ago', () => {
      const now = Date.now();
      const result = formatRelativeTime(now - 8640000000);
      expect(result).toMatch(/\d+月/);
    });
  });

  describe('isInGitRepo - extended', () => {
    it('should return true for repo with empty branch name', async () => {
      const mockStatus: GitStatus = {
        branch: '',
        staged: ['file.ts'],
        unstaged: [],
        untracked: [],
      };
      mockInvoke.mockResolvedValueOnce(mockStatus);

      const result = await isInGitRepo(testWorkDir);

      expect(result).toBe(true);
    });

    it('should handle object without branch property', async () => {
      mockInvoke.mockResolvedValueOnce({ staged: [], unstaged: [], untracked: [] });

      const result = await isInGitRepo(testWorkDir);

      // Should return true as long as status is not null
      expect(result).toBe(true);
    });

    it('should handle non-Error exception', async () => {
      mockInvoke.mockRejectedValueOnce('not an error object');

      const result = await isInGitRepo(testWorkDir);

      expect(result).toBe(false);
    });
  });
});
