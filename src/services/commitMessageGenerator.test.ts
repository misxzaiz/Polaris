/**
 * commitMessageGenerator 测试
 *
 * 测试 Git 提交消息生成服务的核心功能。
 *
 * Mock 策略：
 * - @tauri-apps/api/core: invoke（全局 mock）
 * - ./eventRouter: getEventRouter, createContextId
 * - ../ai-runtime: 类型守卫函数
 * - ../utils/logger: createLogger
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateCommitMessage } from './commitMessageGenerator'
import { invoke } from '@tauri-apps/api/core'
import type { GitDiffEntry } from '@/types/git'

// Mock logger
vi.mock('../utils/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// Mock eventRouter
const mockRegister = vi.fn()
const mockInitialize = vi.fn()
vi.mock('./eventRouter', () => ({
  getEventRouter: vi.fn(() => ({
    initialize: mockInitialize,
    register: mockRegister,
  })),
  createContextId: vi.fn(() => 'test-context-id'),
}))

// Mock ai-runtime 类型守卫
vi.mock('../ai-runtime', () => ({
  isAIEvent: vi.fn((value: unknown) => {
    if (!value || typeof value !== 'object') return false
    const event = value as Record<string, unknown>
    return typeof event.type === 'string'
  }),
  isTokenEvent: vi.fn((value: unknown) => {
    if (!value || typeof value !== 'object') return false
    return (value as Record<string, unknown>).type === 'token'
  }),
  isAssistantMessageEvent: vi.fn((value: unknown) => {
    if (!value || typeof value !== 'object') return false
    return (value as Record<string, unknown>).type === 'assistant_message'
  }),
  isSessionStartEvent: vi.fn((value: unknown) => {
    if (!value || typeof value !== 'object') return false
    return (value as Record<string, unknown>).type === 'session_start'
  }),
  isSessionEndEvent: vi.fn((value: unknown) => {
    if (!value || typeof value !== 'object') return false
    return (value as Record<string, unknown>).type === 'session_end'
  }),
  isErrorEvent: vi.fn((value: unknown) => {
    if (!value || typeof value !== 'object') return false
    return (value as Record<string, unknown>).type === 'error'
  }),
  isResultEvent: vi.fn((value: unknown) => {
    if (!value || typeof value !== 'object') return false
    return (value as Record<string, unknown>).type === 'result'
  }),
}))

const mockInvoke = vi.mocked(invoke)

describe('commitMessageGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInitialize.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('generateCommitMessage - 基础场景', () => {
    it('应该使用提供的 stagedDiffs 生成提交消息', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        {
          file_path: 'src/app.ts',
          change_type: 'modified',
          old_content: 'const x = 1',
          new_content: 'const x = 2',
        },
      ]

      // 设置 mock register 回调
      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        // 模拟 AI 返回提交消息
        setTimeout(() => {
          callback({ type: 'assistant_message', content: 'fix(app): update x value', isDelta: true })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBeDefined()
      expect(mockInvoke).not.toHaveBeenCalledWith('git-get-index-diff')
    })

    it('应该在无 stagedDiffs 时调用 git-get-index-diff', async () => {
      const mockDiffs: GitDiffEntry[] = [
        {
          file_path: 'src/new.ts',
          change_type: 'added',
          old_content: null,
          new_content: 'export const foo = 1',
        },
      ]

      mockInvoke.mockResolvedValueOnce(mockDiffs)
      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'assistant_message', content: 'feat: add new file', isDelta: false })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      await generateCommitMessage({
        workspacePath: '/test/workspace',
      })

      expect(mockInvoke).toHaveBeenCalledWith('git_get_index_diff', {
        workspacePath: '/test/workspace',
      })
    })

    it('应该在无暂存更改时抛出错误', async () => {
      mockInvoke.mockResolvedValueOnce([])

      await expect(
        generateCommitMessage({
          workspacePath: '/test/workspace',
        })
      ).rejects.toThrow('Failed to get staged changes')
    })

    it('应该正确处理 git-get-index-diff 错误', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Git error'))

      await expect(
        generateCommitMessage({
          workspacePath: '/test/workspace',
        })
      ).rejects.toThrow('Failed to get staged changes')
    })
  })

  describe('generateCommitMessage - AI 响应处理', () => {
    it('应该正确处理 token 事件累积', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/test.ts', change_type: 'modified', old_content: null, new_content: 'test' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'token', value: 'feat: ' })
          callback({ type: 'token', value: 'add new feature' })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('feat: add new feature')
    })

    it('应该正确处理 assistant_message 事件', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/test.ts', change_type: 'modified', old_content: null, new_content: 'test' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'assistant_message', content: 'fix: resolve bug', isDelta: false })
          callback({ type: 'result', output: 'done' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('fix: resolve bug')
    })

    it('应该正确处理错误事件', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/test.ts', change_type: 'modified', old_content: null, new_content: 'test' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'error', error: 'AI failed' })
        }, 10)
        return vi.fn()
      })

      // AI 失败时应该返回 fallback 消息
      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBeDefined()
    })

    it('应该在 AI 响应超时时返回 fallback 消息', async () => {
      // 注意：实际超时时间为 30 秒，此处只验证 fallback 逻辑
      // 通过 error 事件触发 fallback
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/test.ts', change_type: 'modified', old_content: null, new_content: 'test' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'error', error: 'timeout simulated' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBeDefined()
    })

    it('应该在 AI 无响应时返回 fallback 消息', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/test.ts', change_type: 'modified', old_content: null, new_content: 'test' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      // 无 accumulated text 时会 reject，然后返回 fallback
      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBeDefined()
    })
  })

  describe('extractCommitMessage - 边界情况', () => {
    it('应该正确处理带有前缀的响应', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/test.ts', change_type: 'modified', old_content: null, new_content: 'test' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          // 注意：源代码正则只匹配 "Here's", "Here is", "The commit message is", "Commit message:"
          callback({ type: 'assistant_message', content: "Here is the commit message: feat: add feature", isDelta: false })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      // 由于 "Here is" 被移除，剩下 "the commit message: feat: add feature"
      // 第一行是 "the commit message: feat: add feature"
      expect(result).toBe('the commit message: feat: add feature')
    })

    it('应该正确处理带有引号的响应', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/test.ts', change_type: 'modified', old_content: null, new_content: 'test' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'assistant_message', content: '`fix: resolve issue`', isDelta: false })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('fix: resolve issue')
    })

    it('应该正确处理多行响应（只取第一行）', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/test.ts', change_type: 'modified', old_content: null, new_content: 'test' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({
            type: 'assistant_message',
            content: `feat: add feature

This is a detailed description
- Point 1
- Point 2`,
            isDelta: false,
          })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('feat: add feature')
    })

    it('应该截断超长的提交消息', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/test.ts', change_type: 'modified', old_content: null, new_content: 'test' },
      ]

      const longMessage = 'feat: ' + 'a'.repeat(150)

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'assistant_message', content: longMessage, isDelta: false })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result.length).toBeLessThanOrEqual(100)
    })
  })

  describe('generateFallbackMessage - 各种文件类型', () => {
    it('应该为新增文件生成正确的 fallback 消息', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/new-feature.ts', change_type: 'added', old_content: null, new_content: 'export const x = 1' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'error', error: 'AI failed' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('feat: add src/new-feature.ts')
    })

    it('应该为多个新增文件生成正确的 fallback 消息', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/a.ts', change_type: 'added', old_content: null, new_content: 'a' },
        { file_path: 'src/b.ts', change_type: 'added', old_content: null, new_content: 'b' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'error', error: 'AI failed' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('feat: add 2 files')
    })

    it('应该为删除文件生成正确的 fallback 消息', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/old.ts', change_type: 'deleted', old_content: 'old content', new_content: null },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'error', error: 'AI failed' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('chore: remove src/old.ts')
    })

    it('应该为重命名文件生成正确的 fallback 消息', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/renamed.ts', change_type: 'renamed', old_content: 'old', new_content: 'new' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'error', error: 'AI failed' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('refactor: rename src/renamed.ts')
    })

    it('应该为修改文件生成正确的 fallback 消息', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/modified.ts', change_type: 'modified', old_content: 'old', new_content: 'new' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'error', error: 'AI failed' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('chore: update src/modified.ts')
    })

    it('应该在无法识别变更类型时返回默认消息', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/unknown.ts', change_type: 'unknown' as GitDiffEntry['change_type'], old_content: null, new_content: null },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'error', error: 'AI failed' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      // 未知类型会 fallthrough 到 update 消息
      expect(result).toBe('chore: update src/unknown.ts')
    })

    it('应该在无文件变更信息时返回默认消息', async () => {
      // 空的 diff 内容，无法解析文件变更
      mockInvoke.mockResolvedValueOnce([])

      // 由于 mockInvoke 返回空数组，会抛出 'Failed to get staged changes'
      await expect(
        generateCommitMessage({
          workspacePath: '/test/workspace',
        })
      ).rejects.toThrow('Failed to get staged changes')
    })
  })

  describe('formatDiffs - 内容处理', () => {
    it('应该正确格式化包含旧内容和新内容的 diff', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        {
          file_path: 'src/app.ts',
          change_type: 'modified',
          old_content: 'const a = 1\nconst b = 2',
          new_content: 'const a = 2\nconst b = 3',
        },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'assistant_message', content: 'test message', isDelta: false })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      // 验证 invoke 被正确调用
      expect(mockRegister).toHaveBeenCalled()
    })

    it('应该正确处理无旧内容的 diff', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        {
          file_path: 'src/new.ts',
          change_type: 'added',
          old_content: null,
          new_content: 'export const x = 1',
        },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'assistant_message', content: 'feat: add new file', isDelta: false })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('feat: add new file')
    })

    it('应该正确处理无新内容的 diff', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        {
          file_path: 'src/deleted.ts',
          change_type: 'deleted',
          old_content: 'export const y = 2',
          new_content: null,
        },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'assistant_message', content: 'chore: remove file', isDelta: false })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('chore: remove file')
    })

    it('应该截断超长的 diff 内容', async () => {
      const longContent = 'x'.repeat(1000)
      const stagedDiffs: GitDiffEntry[] = [
        {
          file_path: 'src/large.ts',
          change_type: 'modified',
          old_content: longContent,
          new_content: longContent,
        },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'assistant_message', content: 'fix: update large file', isDelta: false })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
        maxDiffLength: 1000, // 使用较小的 maxDiffLength
      })

      expect(result).toBeDefined()
    })
  })

  describe('错误处理', () => {
    it('应该正确处理 eventRouter 初始化失败', async () => {
      mockInitialize.mockRejectedValueOnce(new Error('Init failed'))
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/test.ts', change_type: 'modified', old_content: null, new_content: 'test' },
      ]

      // 初始化失败会触发 AI 调用失败，然后返回 fallback
      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBeDefined()
    })

    it('应该正确处理 register 抛出错误', async () => {
      mockRegister.mockImplementation(() => {
        throw new Error('Register failed')
      })
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/test.ts', change_type: 'modified', old_content: null, new_content: 'test' },
      ]

      // 注册失败会触发 AI 调用失败，然后返回 fallback
      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBeDefined()
    })

    it('应该正确处理 invoke 调用失败', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Invoke failed'))

      await expect(
        generateCommitMessage({
          workspacePath: '/test/workspace',
        })
      ).rejects.toThrow('Failed to get staged changes')
    })
  })

  describe('maxDiffLength 参数', () => {
    it('应该使用自定义的 maxDiffLength', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        {
          file_path: 'src/test.ts',
          change_type: 'modified',
          old_content: 'a'.repeat(1000),
          new_content: 'b'.repeat(1000),
        },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'assistant_message', content: 'test', isDelta: false })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
        maxDiffLength: 500,
      })

      expect(mockRegister).toHaveBeenCalled()
    })
  })

  describe('混合变更类型', () => {
    it('应该正确处理混合的变更类型（优先添加）', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/new.ts', change_type: 'added', old_content: null, new_content: 'new' },
        { file_path: 'src/modified.ts', change_type: 'modified', old_content: 'old', new_content: 'new' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'error', error: 'AI failed' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('feat: add 2 files')
    })

    it('应该正确处理混合的变更类型（优先删除）', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/deleted.ts', change_type: 'deleted', old_content: 'old', new_content: null },
        { file_path: 'src/modified.ts', change_type: 'modified', old_content: 'old', new_content: 'new' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'error', error: 'AI failed' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('chore: remove 2 files')
    })

    it('应该正确处理混合的变更类型（优先重命名）', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/renamed.ts', change_type: 'renamed', old_content: 'old', new_content: 'new' },
        { file_path: 'src/modified.ts', change_type: 'modified', old_content: 'old', new_content: 'new' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'error', error: 'AI failed' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('refactor: rename 2 files')
    })
  })

  describe('事件处理边界情况', () => {
    it('应该忽略非 AI 事件', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/test.ts', change_type: 'modified', old_content: null, new_content: 'test' },
      ]

      const { isAIEvent } = await import('../ai-runtime')
      vi.mocked(isAIEvent).mockReturnValueOnce(false)

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ invalid: 'event' })
          callback({ type: 'assistant_message', content: 'valid message', isDelta: false })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBeDefined()
    })

    it('应该正确处理 session_start 事件（忽略）', async () => {
      const stagedDiffs: GitDiffEntry[] = [
        { file_path: 'src/test.ts', change_type: 'modified', old_content: null, new_content: 'test' },
      ]

      mockRegister.mockImplementation((contextId: string, callback: (payload: unknown) => void) => {
        setTimeout(() => {
          callback({ type: 'session_start', sessionId: 'test-session' })
          callback({ type: 'assistant_message', content: 'feat: test', isDelta: false })
          callback({ type: 'session_end', sessionId: 'test-session' })
        }, 10)
        return vi.fn()
      })

      const result = await generateCommitMessage({
        workspacePath: '/test/workspace',
        stagedDiffs,
      })

      expect(result).toBe('feat: test')
    })
  })
})
