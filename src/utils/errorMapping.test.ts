import { describe, it, expect, vi } from 'vitest'
import { mapErrorMessage, handleValidationError, extractErrorMessage } from './errorMapping'

// Mock i18n
vi.mock('../i18n', () => ({
  default: {
    t: (key: string, fallback?: string) => fallback || key,
  },
}))

describe('mapErrorMessage', () => {
  it('应该返回空字符串当输入为空', () => {
    expect(mapErrorMessage('')).toBe('')
    expect(mapErrorMessage(null as unknown as string)).toBe('')
    expect(mapErrorMessage(undefined as unknown as string)).toBe('')
  })

  it('应该返回原始错误当没有匹配的关键词', () => {
    expect(mapErrorMessage('some random error')).toBe('some random error')
  })

  it('应该匹配中文调度器错误关键词', () => {
    expect(mapErrorMessage('任务不存在')).toBe('任务不存在')
    expect(mapErrorMessage('任务名称不能为空')).toBe('任务名称不能为空')
    expect(mapErrorMessage('Cron 表达式格式无效')).toBe('Cron 表达式格式无效')
  })

  it('应该匹配中文通用错误关键词', () => {
    expect(mapErrorMessage('文件不存在')).toBe('文件不存在')
    expect(mapErrorMessage('执行失败')).toBe('执行失败')
    expect(mapErrorMessage('路径无效')).toBe('路径无效')
  })

  it('应该匹配英文错误关键词', () => {
    expect(mapErrorMessage('File not found')).toBe('File not found')
    expect(mapErrorMessage('Execution failed')).toBe('Execution failed')
  })

  it('应该在包含关键词的消息中匹配', () => {
    // mock 返回 fallback 参数，即原始错误消息
    expect(mapErrorMessage('错误：文件不存在，请检查路径')).toBe('错误：文件不存在，请检查路径')
  })
})

describe('handleValidationError', () => {
  it('应该返回 null 当验证成功', () => {
    expect(handleValidationError({ valid: true })).toBeNull()
  })

  it('应该返回错误消息当验证失败', () => {
    expect(handleValidationError({ valid: false, error: '文件不存在' })).toBe('文件不存在')
  })

  it('应该返回空字符串当错误消息为空', () => {
    expect(handleValidationError({ valid: false })).toBe('')
  })
})

describe('extractErrorMessage', () => {
  it('应该返回空字符串当输入为空', () => {
    expect(extractErrorMessage(null)).toBe('')
    expect(extractErrorMessage(undefined)).toBe('')
  })

  it('应该处理字符串错误', () => {
    expect(extractErrorMessage('文件不存在')).toBe('文件不存在')
  })

  it('应该处理 Error 对象', () => {
    const error = new Error('文件不存在')
    expect(extractErrorMessage(error)).toBe('文件不存在')
  })

  it('应该处理 Tauri 错误格式（message 字段）', () => {
    const error = { message: '文件不存在' }
    expect(extractErrorMessage(error)).toBe('文件不存在')
  })

  it('应该处理 Tauri 错误格式（error 字段）', () => {
    const error = { error: '文件不存在' }
    expect(extractErrorMessage(error)).toBe('文件不存在')
  })

  it('应该转换其他类型为字符串', () => {
    expect(extractErrorMessage(123)).toBe('123')
    expect(extractErrorMessage(true)).toBe('true')
  })
})
