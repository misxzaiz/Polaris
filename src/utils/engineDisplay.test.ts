import { describe, it, expect } from 'vitest'
import { normalizeEngineId, getEngineDisplayName, getEngineFullName } from './engineDisplay'

describe('normalizeEngineId', () => {
  it('应该返回 claude-code 当输入为 claude-code', () => {
    expect(normalizeEngineId('claude-code')).toBe('claude-code')
  })

  it('应该返回 simple-ai 当输入为 simple-ai', () => {
    expect(normalizeEngineId('simple-ai')).toBe('simple-ai')
  })

  it('应该返回 claude-code 当输入为空', () => {
    expect(normalizeEngineId()).toBe('claude-code')
    expect(normalizeEngineId(null)).toBe('claude-code')
    expect(normalizeEngineId(undefined)).toBe('claude-code')
  })

  it('应该返回 claude-code 当输入为其他值（已移除的引擎降级）', () => {
    expect(normalizeEngineId('codex')).toBe('claude-code')
    expect(normalizeEngineId('pi')).toBe('claude-code')
    expect(normalizeEngineId('dsh')).toBe('claude-code')
  })
})

describe('getEngineDisplayName', () => {
  it('应该返回 claude-code 当引擎为 claude-code（元数据未加载时降级为 engineId）', () => {
    expect(getEngineDisplayName('claude-code')).toBe('claude-code')
  })

  it('应该返回 claude-code 当输入为空', () => {
    expect(getEngineDisplayName()).toBe('claude-code')
    expect(getEngineDisplayName(null)).toBe('claude-code')
  })
})

describe('getEngineFullName', () => {
  it('应该返回 claude-code 当引擎为 claude-code（元数据未加载时降级为 engineId）', () => {
    expect(getEngineFullName('claude-code')).toBe('claude-code')
  })

  it('应该返回 claude-code 当输入为空', () => {
    expect(getEngineFullName()).toBe('claude-code')
    expect(getEngineFullName(null)).toBe('claude-code')
  })
})
