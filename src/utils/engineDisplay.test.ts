import { describe, it, expect } from 'vitest'
import { normalizeEngineId, getEngineDisplayName, getEngineFullName } from './engineDisplay'

describe('normalizeEngineId', () => {
  it('应该返回 codex 当输入为 codex', () => {
    expect(normalizeEngineId('codex')).toBe('codex')
  })

  it('应该返回 claude-code 当输入为 claude-code', () => {
    expect(normalizeEngineId('claude-code')).toBe('claude-code')
  })

  it('应该返回 mimo 当输入为 mimo', () => {
    expect(normalizeEngineId('mimo')).toBe('mimo')
  })

  it('应该返回 claude-code 当输入为空', () => {
    expect(normalizeEngineId()).toBe('claude-code')
    expect(normalizeEngineId(null)).toBe('claude-code')
    expect(normalizeEngineId(undefined)).toBe('claude-code')
  })

  it('应该返回 claude-code 当输入为其他值', () => {
    expect(normalizeEngineId('openai')).toBe('claude-code')
    expect(normalizeEngineId('gpt-4')).toBe('claude-code')
  })
})

describe('getEngineDisplayName', () => {
  it('应该返回 Codex 当引擎为 codex', () => {
    expect(getEngineDisplayName('codex')).toBe('Codex')
  })

  it('应该返回 Claude 当引擎为 claude-code', () => {
    expect(getEngineDisplayName('claude-code')).toBe('Claude')
  })

  it('应该返回 Mimo 当引擎为 mimo', () => {
    expect(getEngineDisplayName('mimo')).toBe('Mimo')
  })

  it('应该返回 Claude 当输入为空', () => {
    expect(getEngineDisplayName()).toBe('Claude')
    expect(getEngineDisplayName(null)).toBe('Claude')
  })
})

describe('getEngineFullName', () => {
  it('应该返回 OpenAI Codex 当引擎为 codex', () => {
    expect(getEngineFullName('codex')).toBe('OpenAI Codex')
  })

  it('应该返回 Claude Code 当引擎为 claude-code', () => {
    expect(getEngineFullName('claude-code')).toBe('Claude Code')
  })

  it('应该返回 Mimo Code 当引擎为 mimo', () => {
    expect(getEngineFullName('mimo')).toBe('Mimo Code')
  })

  it('应该返回 Claude Code 当输入为空', () => {
    expect(getEngineFullName()).toBe('Claude Code')
    expect(getEngineFullName(null)).toBe('Claude Code')
  })
})
