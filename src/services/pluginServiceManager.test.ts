/**
 * pluginServiceManager.ensureServiceRunning 单元测试
 *
 * 验证：
 * - 已运行服务不重复启动
 * - 并发调用同 serviceId 复用同一 Promise（去重，不重复拉起进程）
 * - 未运行时发起 startService
 * - 查状态失败时降级为启动
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('./transport', () => ({
  invoke: invokeMock,
}))

// 延迟 import 到 mock 之后
const { pluginServiceManager } = await import('./pluginServiceManager')

const PLUGIN_ID = 'test.plugin'
const SERVICE_ID = 'test-svc'

function makeStatus(state: 'running' | 'starting' | 'stopped' | 'error') {
  return {
    serviceId: SERVICE_ID,
    pluginId: PLUGIN_ID,
    state,
    port: 1234,
    pid: 9999,
    uptime: 100,
    lastError: null,
    restartCount: 0,
  }
}

const contribution = {
  id: SERVICE_ID,
  type: 'stdio' as const,
  command: 'node',
  argsTemplate: [],
  port: null,
  healthCheck: null,
  healthCheckTimeout: null,
  autoStart: true,
  restartOnFailure: true,
  maxRestarts: 3,
  description: null,
}

describe('pluginServiceManager.ensureServiceRunning', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('已运行服务直接返回，不发起 startService', async () => {
    // listStatus 返回 running
    invokeMock.mockResolvedValueOnce([makeStatus('running')])

    const status = await pluginServiceManager.ensureServiceRunning(
      PLUGIN_ID, SERVICE_ID, contribution, '/install/path',
    )

    expect(status.state).toBe('running')
    // 只调了 listStatus，没调 plugin_service_start
    const calls = invokeMock.mock.calls.map((c) => c[0])
    expect(calls).toContain('plugin_service_list_status')
    expect(calls).not.toContain('plugin_service_start')
  })

  it('未运行时发起 startService', async () => {
    // listStatus 返回空（无该服务）
    invokeMock.mockResolvedValueOnce([])
    // startService 返回 running
    invokeMock.mockResolvedValueOnce(makeStatus('running'))

    const status = await pluginServiceManager.ensureServiceRunning(
      PLUGIN_ID, SERVICE_ID, contribution, '/install/path',
    )

    expect(status.state).toBe('running')
    const calls = invokeMock.mock.calls.map((c) => c[0])
    expect(calls).toContain('plugin_service_start')
  })

  it('并发调用同 serviceId 复用同一 Promise，不重复启动', async () => {
    // listStatus 返回空
    invokeMock.mockResolvedValueOnce([])
    // startService 返回 running（延迟以制造并发窗口）
    invokeMock.mockResolvedValueOnce(makeStatus('running'))

    // 并发发起两次 ensure
    const [a, b] = await Promise.all([
      pluginServiceManager.ensureServiceRunning(PLUGIN_ID, SERVICE_ID, contribution, '/install/path'),
      pluginServiceManager.ensureServiceRunning(PLUGIN_ID, SERVICE_ID, contribution, '/install/path'),
    ])

    expect(a.state).toBe('running')
    expect(b.state).toBe('running')

    // 关键断言：plugin_service_start 只被调用一次（去重生效）
    const startCalls = invokeMock.mock.calls.filter((c) => c[0] === 'plugin_service_start')
    expect(startCalls).toHaveLength(1)
  })

  it('starting 态视为已激活，不重复启动', async () => {
    invokeMock.mockResolvedValueOnce([makeStatus('starting')])

    const status = await pluginServiceManager.ensureServiceRunning(
      PLUGIN_ID, SERVICE_ID, contribution, '/install/path',
    )

    expect(status.state).toBe('starting')
    const calls = invokeMock.mock.calls.map((c) => c[0])
    expect(calls).not.toContain('plugin_service_start')
  })

  it('查状态失败时降级为启动', async () => {
    // listStatus 抛错
    invokeMock.mockRejectedValueOnce(new Error('network'))
    // startService 成功
    invokeMock.mockResolvedValueOnce(makeStatus('running'))

    const status = await pluginServiceManager.ensureServiceRunning(
      PLUGIN_ID, SERVICE_ID, contribution, '/install/path',
    )

    expect(status.state).toBe('running')
    const calls = invokeMock.mock.calls.map((c) => c[0])
    expect(calls).toContain('plugin_service_start')
  })

  it('完成后清理去重 Map（下次调用可重新启动）', async () => {
    // 第一次：空 → start
    invokeMock.mockResolvedValueOnce([])
    invokeMock.mockResolvedValueOnce(makeStatus('running'))
    await pluginServiceManager.ensureServiceRunning(
      PLUGIN_ID, SERVICE_ID, contribution, '/install/path',
    )

    // 第二次：空 → start（去重 Map 已清理，允许新一轮）
    invokeMock.mockResolvedValueOnce([])
    invokeMock.mockResolvedValueOnce(makeStatus('running'))
    await pluginServiceManager.ensureServiceRunning(
      PLUGIN_ID, SERVICE_ID, contribution, '/install/path',
    )

    const startCalls = invokeMock.mock.calls.filter((c) => c[0] === 'plugin_service_start')
    expect(startCalls).toHaveLength(2)
  })
})
