import { describe, it, expect } from 'vitest'
import { getSelectedEngineHealth, hasAnyEngineAvailable } from './engineHealth'

describe('getSelectedEngineHealth', () => {
  it('应该返回 Claude 引擎健康状态', () => {
    const config = {
      defaultEngine: 'claude-code' as const,
      claudeCode: { cliPath: '/usr/bin/claude' },
    }
    const health = {
      claudeAvailable: true,
      claudeVersion: '1.0.0',
    }

    const result = getSelectedEngineHealth(config, health)
    expect(result.engineId).toBe('claude-code')
    expect(result.name).toBe('Claude Code')
    expect(result.command).toBe('claude')
    expect(result.cliPath).toBe('/usr/bin/claude')
    expect(result.available).toBe(true)
    expect(result.version).toBe('1.0.0')
  })

  it('应该使用 engineOverride', () => {
    const config = { defaultEngine: 'claude-code' as const }
    const health = { claudeAvailable: true }

    const result = getSelectedEngineHealth(config, health, 'simple-ai')
    expect(result.engineId).toBe('simple-ai')
  })

  it('应该使用默认 CLI 路径', () => {
    const config = { defaultEngine: 'claude-code' as const }
    const health = { claudeAvailable: false }

    const result = getSelectedEngineHealth(config, health)
    expect(result.cliPath).toBe('claude')
  })

  it('应该处理 null 配置', () => {
    const result = getSelectedEngineHealth(null, null)
    expect(result.engineId).toBe('claude-code')
    expect(result.available).toBe(false)
  })

  it('应该处理 undefined 配置', () => {
    const result = getSelectedEngineHealth(undefined, undefined)
    expect(result.engineId).toBe('claude-code')
    expect(result.available).toBe(false)
  })
})

describe('hasAnyEngineAvailable', () => {
  it('应该返回 true 当 Claude 可用', () => {
    expect(hasAnyEngineAvailable({ claudeAvailable: true })).toBe(true)
  })

  it('应该返回 true 当 Simple AI 配置了模型 Profile', () => {
    const config = {
      modelProfiles: [{ baseUrl: 'https://x', apiKey: 'k', model: 'm' }],
    }
    expect(hasAnyEngineAvailable({ claudeAvailable: false }, config as never)).toBe(true)
  })

  it('应该返回 true 当两者都可用', () => {
    const config = {
      modelProfiles: [{ baseUrl: 'https://x', apiKey: 'k', model: 'm' }],
    }
    expect(hasAnyEngineAvailable({ claudeAvailable: true }, config as never)).toBe(true)
  })

  it('应该返回 false 当都不可用', () => {
    expect(hasAnyEngineAvailable({ claudeAvailable: false })).toBe(false)
  })

  it('应该返回 false 当输入为 null', () => {
    expect(hasAnyEngineAvailable(null)).toBe(false)
  })

  it('应该返回 false 当输入为 undefined', () => {
    expect(hasAnyEngineAvailable(undefined)).toBe(false)
  })
})
