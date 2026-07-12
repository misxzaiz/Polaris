import { describe, it, expect } from 'vitest'
import { normalizeSessionConfig } from './sessionConfigStore'
import { DEFAULT_SESSION_CONFIG } from '@/types/sessionConfig'

describe('normalizeSessionConfig', () => {
  it('undefined 时返回默认配置', () => {
    expect(normalizeSessionConfig(undefined)).toEqual(DEFAULT_SESSION_CONFIG)
  })

  it('补全缺失字段（旧版本持久化数据兼容）', () => {
    const result = normalizeSessionConfig({ agent: 'Explore' })
    expect(result.agent).toBe('Explore')
    expect(result.model).toBe(DEFAULT_SESSION_CONFIG.model)
    expect(result.effort).toBe(DEFAULT_SESSION_CONFIG.effort)
    expect(result.permissionMode).toBe(DEFAULT_SESSION_CONFIG.permissionMode)
  })

  it('剔除废弃的 effort=max', () => {
    const result = normalizeSessionConfig({ effort: 'max' })
    expect(result.effort).toBe(DEFAULT_SESSION_CONFIG.effort)
    expect(result.effort).not.toBe('max')
  })

  it('保留持久化的 permissionMode（默认值即 bypassPermissions，不再特判剔除）', () => {
    const result = normalizeSessionConfig({ permissionMode: 'bypassPermissions' })
    expect(result.permissionMode).toBe('bypassPermissions')
    // 非默认模式同样原样保留
    expect(normalizeSessionConfig({ permissionMode: 'plan' }).permissionMode).toBe('plan')
  })

  it('保留合法值', () => {
    const result = normalizeSessionConfig({
      agent: 'Plan',
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'acceptEdits',
      modelProfileId: 'profile_abc',
    })
    expect(result).toEqual({
      agent: 'Plan',
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'acceptEdits',
      modelProfileId: 'profile_abc',
    })
  })

  it('保留会话级 modelProfileId（P1 会话绑定）', () => {
    const result = normalizeSessionConfig({ modelProfileId: 'profile_xyz' })
    expect(result.modelProfileId).toBe('profile_xyz')
  })
})
