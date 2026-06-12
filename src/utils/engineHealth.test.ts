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

  it('应该返回 Codex 引擎健康状态', () => {
    const config = {
      defaultEngine: 'codex' as const,
      codexCode: { cliPath: '/usr/bin/codex' },
    }
    const health = {
      codexAvailable: true,
      codexVersion: '2.0.0',
    }

    const result = getSelectedEngineHealth(config, health)
    expect(result.engineId).toBe('codex')
    expect(result.name).toBe('OpenAI Codex')
    expect(result.command).toBe('codex')
    expect(result.cliPath).toBe('/usr/bin/codex')
    expect(result.available).toBe(true)
    expect(result.version).toBe('2.0.0')
  })

  it('应该返回 Mimo 引擎健康状态', () => {
    const config = {
      defaultEngine: 'mimo' as const,
      mimoCode: { cliPath: 'C:\\npm\\mimo.cmd' },
    }
    const health = {
      claudeAvailable: false,
      mimoAvailable: true,
      mimoVersion: '0.1.0',
    }

    const result = getSelectedEngineHealth(config, health)
    expect(result.engineId).toBe('mimo')
    expect(result.name).toBe('Mimo Code')
    expect(result.command).toBe('mimo')
    expect(result.cliPath).toBe('C:\\npm\\mimo.cmd')
    expect(result.available).toBe(true)
    expect(result.version).toBe('0.1.0')
  })

  it('应该使用 engineOverride', () => {
    const config = { defaultEngine: 'claude-code' as const }
    const health = { codexAvailable: true }

    const result = getSelectedEngineHealth(config, health, 'codex')
    expect(result.engineId).toBe('codex')
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
    expect(hasAnyEngineAvailable({ claudeAvailable: true, codexAvailable: false })).toBe(true)
  })

  it('应该返回 true 当 Codex 可用', () => {
    expect(hasAnyEngineAvailable({ claudeAvailable: false, codexAvailable: true })).toBe(true)
  })

  it('应该返回 true 当两者都可用', () => {
    expect(hasAnyEngineAvailable({ claudeAvailable: true, codexAvailable: true })).toBe(true)
  })

  it('应该返回 true 当仅 Mimo 可用', () => {
    expect(hasAnyEngineAvailable({ claudeAvailable: false, codexAvailable: false, mimoAvailable: true })).toBe(true)
  })

  it('应该返回 false 当两者都不可用', () => {
    expect(hasAnyEngineAvailable({ claudeAvailable: false, codexAvailable: false })).toBe(false)
  })

  it('应该返回 false 当输入为 null', () => {
    expect(hasAnyEngineAvailable(null)).toBe(false)
  })

  it('应该返回 false 当输入为 undefined', () => {
    expect(hasAnyEngineAvailable(undefined)).toBe(false)
  })
})
