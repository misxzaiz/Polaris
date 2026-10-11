/**
 * workspaceKey 解析测试（S2）
 */
import { describe, it, expect } from 'vitest'
import {
  resolveWorkspaceKey,
  resolveWorkspaceKeyFromPath,
  isFreeWorkspaceKey,
} from './workspaceKey'
import { FREE_WORKSPACE_KEY } from './types'

describe('resolveWorkspaceKey', () => {
  it('identity 非空时优先用 identity', () => {
    expect(resolveWorkspaceKey({ path: '/local/path', identity: 'ssh:remote' })).toBe('ssh:remote')
  })

  it('identity 为空时回退 path', () => {
    expect(resolveWorkspaceKey({ path: '/local/path' })).toBe('/local/path')
  })

  it('identity 为空白字符串时回退 path', () => {
    expect(resolveWorkspaceKey({ path: '/local/path', identity: '   ' })).toBe('/local/path')
  })

  it('path 与 identity 都空时返回 FREE_WORKSPACE_KEY', () => {
    expect(resolveWorkspaceKey({ path: '' })).toBe(FREE_WORKSPACE_KEY)
    expect(resolveWorkspaceKey({ path: '  ' })).toBe(FREE_WORKSPACE_KEY)
  })
})

describe('resolveWorkspaceKeyFromPath', () => {
  it('正常 path 返回 path', () => {
    expect(resolveWorkspaceKeyFromPath('/home/user/project')).toBe('/home/user/project')
  })

  it('null/undefined 返回 FREE_WORKSPACE_KEY', () => {
    expect(resolveWorkspaceKeyFromPath(null)).toBe(FREE_WORKSPACE_KEY)
    expect(resolveWorkspaceKeyFromPath(undefined)).toBe(FREE_WORKSPACE_KEY)
  })

  it('空白返回 FREE_WORKSPACE_KEY', () => {
    expect(resolveWorkspaceKeyFromPath('')).toBe(FREE_WORKSPACE_KEY)
  })
})

describe('isFreeWorkspaceKey', () => {
  it('FREE_WORKSPACE_KEY 返回 true', () => {
    expect(isFreeWorkspaceKey(FREE_WORKSPACE_KEY)).toBe(true)
  })

  it('其他 key 返回 false', () => {
    expect(isFreeWorkspaceKey('/some/path')).toBe(false)
  })
})
