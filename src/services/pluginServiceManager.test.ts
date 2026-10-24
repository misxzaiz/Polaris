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

/**
 * 服务已迁移到 RouterBus（invoke('router_dispatch', { req: { target, payload } })），
 * mock 返回形态对齐 commands/router.rs RouterDispatchResponse。
 */
function dispatchOk(result: unknown) {
  return {
    msgId: 'm1',
    ok: true,
    result,
    error: null,
    trace: 't',
  }
}

/** 过滤出指定 action 的 router_dispatch 调用（cap.pluginServiceManager） */
function callsByAction(action: string) {
  return invokeMock.mock.calls.filter(
    (c) =>
      c[0] === 'router_dispatch' &&
      (c[1] as { req: { target: string; payload: { action: string } } }).req.target ===
        'cap.pluginServiceManager' &&
      c[1].req.payload.action === action,
  )
}

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
    invokeMock.mockResolvedValueOnce(dispatchOk([makeStatus('running')]))

    const status = await pluginServiceManager.ensureServiceRunning(
      PLUGIN_ID, SERVICE_ID, contribution, '/install/path',
    )

    expect(status.state).toBe('running')
    // 只调了 list_status，没调 start
    expect(callsByAction('list_status')).toHaveLength(1)
    expect(callsByAction('start')).toHaveLength(0)
  })

  it('未运行时发起 startService', async () => {
    // listStatus 返回空（无该服务）
    invokeMock.mockResolvedValueOnce(dispatchOk([]))
    // startService 返回 running
    invokeMock.mockResolvedValueOnce(dispatchOk(makeStatus('running')))

    const status = await pluginServiceManager.ensureServiceRunning(
      PLUGIN_ID, SERVICE_ID, contribution, '/install/path',
    )

    expect(status.state).toBe('running')
    expect(callsByAction('start')).toHaveLength(1)
  })

  it('并发调用同 serviceId 复用同一 Promise，不重复启动', async () => {
    // listStatus 返回空
    invokeMock.mockResolvedValueOnce(dispatchOk([]))
    // startService 返回 running（延迟以制造并发窗口）
    invokeMock.mockResolvedValueOnce(dispatchOk(makeStatus('running')))

    // 并发发起两次 ensure
    const [a, b] = await Promise.all([
      pluginServiceManager.ensureServiceRunning(PLUGIN_ID, SERVICE_ID, contribution, '/install/path'),
      pluginServiceManager.ensureServiceRunning(PLUGIN_ID, SERVICE_ID, contribution, '/install/path'),
    ])

    expect(a.state).toBe('running')
    expect(b.state).toBe('running')

    // 关键断言：start 只被调用一次（去重生效）
    expect(callsByAction('start')).toHaveLength(1)
  })

  it('starting 态视为已激活，不重复启动', async () => {
    invokeMock.mockResolvedValueOnce(dispatchOk([makeStatus('starting')]))

    const status = await pluginServiceManager.ensureServiceRunning(
      PLUGIN_ID, SERVICE_ID, contribution, '/install/path',
    )

    expect(status.state).toBe('starting')
    expect(callsByAction('start')).toHaveLength(0)
  })

  it('查状态失败时降级为启动', async () => {
    // listStatus 抛错
    invokeMock.mockRejectedValueOnce(new Error('network'))
    // startService 成功
    invokeMock.mockResolvedValueOnce(dispatchOk(makeStatus('running')))

    const status = await pluginServiceManager.ensureServiceRunning(
      PLUGIN_ID, SERVICE_ID, contribution, '/install/path',
    )

    expect(status.state).toBe('running')
    expect(callsByAction('start')).toHaveLength(1)
  })

  it('完成后清理去重 Map（下次调用可重新启动）', async () => {
    // 第一次：空 → start
    invokeMock.mockResolvedValueOnce(dispatchOk([]))
    invokeMock.mockResolvedValueOnce(dispatchOk(makeStatus('running')))
    await pluginServiceManager.ensureServiceRunning(
      PLUGIN_ID, SERVICE_ID, contribution, '/install/path',
    )

    // 第二次：空 → start（去重 Map 已清理，允许新一轮）
    invokeMock.mockResolvedValueOnce(dispatchOk([]))
    invokeMock.mockResolvedValueOnce(dispatchOk(makeStatus('running')))
    await pluginServiceManager.ensureServiceRunning(
      PLUGIN_ID, SERVICE_ID, contribution, '/install/path',
    )

    expect(callsByAction('start')).toHaveLength(2)
  })
})
