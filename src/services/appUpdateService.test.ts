import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * appUpdateService 单测：覆盖 cap.app.update dispatch 调用形态
 * （router_dispatch 信封、错误信封转 throw、事件类型守卫）。
 */

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@/services/transport', () => ({
  invoke: invokeMock,
  currentMode: 'tauri',
}))

import {
  getUpdateStatus,
  isUpdateCompletedEvent,
  isUpdateProgressEvent,
  runAutoUpdate,
} from './appUpdateService'

function okDispatch(result: Record<string, unknown>) {
  return {
    msgId: 'm1',
    ok: true,
    result,
    error: null,
    trace: 't1',
  }
}

beforeEach(() => {
  invokeMock.mockReset()
})

describe('getUpdateStatus', () => {
  it('dispatch 形态：target=cap.app.update, action=status', async () => {
    invokeMock.mockResolvedValue(
      okDispatch({
        currentVersion: '11.0.7',
        source: { sourceType: 'github', repo: 'misxzaiz/Polaris', checkOnStartup: false },
        latestVersion: null,
        updateAvailable: false,
      }),
    )

    const status = await getUpdateStatus()

    expect(invokeMock).toHaveBeenCalledWith('router_dispatch', {
      req: { target: 'cap.app.update', payload: { action: 'status' } },
    })
    expect(status.supported).toBe(true)
    if (status.supported) {
      expect(status.currentVersion).toBe('11.0.7')
      expect(status.source.sourceType).toBe('github')
    }
  })

  it('旧宿主 dispatch 失败 → 兜底 supported=false（不 throw）', async () => {
    invokeMock.mockRejectedValue(new Error('cap not found'))
    const status = await getUpdateStatus()
    expect(status.supported).toBe(false)
  })

  it('error 信封（ok=false）→ 兜底 supported=false（status 永不 throw，见 catch 分支）', async () => {
    invokeMock.mockResolvedValue({ msgId: 'm1', ok: false, result: null, error: 'boom', trace: 't1' })
    const status = await getUpdateStatus()
    expect(status.supported).toBe(false)
  })
})

describe('runAutoUpdate', () => {
  it('dispatch 形态：action=run，透传 force', async () => {
    invokeMock.mockResolvedValue(okDispatch({ started: true }))

    const r = await runAutoUpdate(false)

    expect(invokeMock).toHaveBeenCalledWith('router_dispatch', {
      req: { target: 'cap.app.update', payload: { action: 'run', force: false } },
    })
    expect(r.started).toBe(true)
  })

  it('force=true 透传', async () => {
    invokeMock.mockResolvedValue(okDispatch({ started: true }))
    await runAutoUpdate(true)
    expect(invokeMock.mock.calls[0][1].req.payload.force).toBe(true)
  })

  it('error 信封 → throw（调用方可 toast）', async () => {
    invokeMock.mockResolvedValue({
      msgId: 'm1',
      ok: false,
      result: null,
      error: '已有更新任务进行中',
      trace: 't1',
    })
    await expect(runAutoUpdate()).rejects.toThrow('已有更新任务进行中')
  })
})

describe('事件载荷类型守卫', () => {
  it('isUpdateProgressEvent', () => {
    expect(isUpdateProgressEvent({ stage: 'downloading', percent: 50 })).toBe(true)
    expect(isUpdateProgressEvent({ stage: 'checking', percent: 0, version: '12.0.0' })).toBe(true)
    expect(isUpdateProgressEvent({ percent: 50 })).toBe(false)
    expect(isUpdateProgressEvent(null)).toBe(false)
  })

  it('isUpdateCompletedEvent', () => {
    expect(isUpdateCompletedEvent({ updated: true })).toBe(true)
    expect(isUpdateCompletedEvent({ updated: false, reason: 'no-update' })).toBe(true)
    expect(isUpdateCompletedEvent({ reason: 'error' })).toBe(false)
    expect(isUpdateCompletedEvent('nope')).toBe(false)
  })
})
