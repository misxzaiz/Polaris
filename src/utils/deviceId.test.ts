/**
 * deviceId 工具测试（S4）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getDeviceId, newRequestId } from './deviceId'

describe('deviceId', () => {
  beforeEach(() => {
    localStorage.clear()
    // 重置模块级变量（通过重新 require）
    vi.resetModules()
  })

  it('首次调用生成并持久化到 localStorage', () => {
    const id = getDeviceId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(localStorage.getItem('__polaris_device_id__')).toBe(id)
  })

  it('第二次调用返回同一值（稳定）', () => {
    const id1 = getDeviceId()
    const id2 = getDeviceId()
    expect(id1).toBe(id2)
  })

  it('localStorage 已有值时读已存值', () => {
    localStorage.setItem('__polaris_device_id__', 'existing-id')
    const id = getDeviceId()
    expect(id).toBe('existing-id')
  })
})

describe('newRequestId', () => {
  it('每次调用返回不同 UUID', () => {
    const a = newRequestId()
    const b = newRequestId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})
