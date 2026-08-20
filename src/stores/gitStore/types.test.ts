/**
 * GitStore types 单元测试
 *
 * 测试类型定义中的工具函数
 */

import { describe, it, expect } from 'vitest'
import { parseGitError } from './types'

describe('parseGitError', () => {
  describe('Error 实例处理', () => {
    it('应正确解析 Error 实例', () => {
      const error = new Error('Test error message')
      expect(parseGitError(error)).toBe('Test error message')
    })

    it('应正确解析带有堆栈的 Error', () => {
      const error = new Error('Failed to execute git command')
      expect(parseGitError(error)).toBe('Failed to execute git command')
    })
  })

  describe('对象错误处理', () => {
    it('应解析带有 message 的对象', () => {
      const error = { message: 'Git error' }
      expect(parseGitError(error)).toBe('Git error')
    })

    it('应解析带有 message 和 details 的对象', () => {
      const error = { message: 'Git error', details: 'Detailed info' }
      expect(parseGitError(error)).toBe('Git error (Detailed info)')
    })

    it('应忽略空 details', () => {
      const error = { message: 'Git error', details: '' }
      expect(parseGitError(error)).toBe('Git error')
    })
  })

  describe('原始类型处理', () => {
    it('应正确处理字符串', () => {
      expect(parseGitError('Simple error')).toBe('Simple error')
    })

    it('应正确处理数字', () => {
      expect(parseGitError(404)).toBe('404')
    })

    it('应正确处理 null', () => {
      expect(parseGitError(null)).toBe('null')
    })

    it('应正确处理 undefined', () => {
      expect(parseGitError(undefined)).toBe('undefined')
    })
  })

  describe('复杂对象处理', () => {
    it('应处理无 message 的普通对象', () => {
      const error = { code: 'ENOENT', errno: -2 }
      const result = parseGitError(error)
      expect(result).toContain('ENOENT')
      expect(result).toContain('-2')
    })

    it('应处理循环引用对象', () => {
      const error: Record<string, unknown> = { message: 'Circular error' }
      error.self = error
      // 循环引用对象 JSON.stringify 会抛出错误，但 parseGitError 应该处理这种情况
      expect(parseGitError(error)).toBe('Circular error')
    })

    it('应处理嵌套对象', () => {
      const error = {
        message: 'Nested error',
        nested: { info: 'some info' },
      }
      expect(parseGitError(error)).toBe('Nested error')
    })
  })

  describe('边界情况', () => {
    it('应处理空对象', () => {
      expect(parseGitError({})).toBe('{}')
    })

    it('应处理空字符串 message（会被 JSON 序列化）', () => {
      const error = { message: '' }
      // 空字符串是 falsy，会走到 JSON.stringify 路径
      expect(parseGitError(error)).toBe('{"message":""}')
    })

    it('应处理数组', () => {
      expect(parseGitError(['error1', 'error2'])).toBe('["error1","error2"]')
    })

    it('应处理布尔值', () => {
      expect(parseGitError(false)).toBe('false')
      expect(parseGitError(true)).toBe('true')
    })
  })
})
