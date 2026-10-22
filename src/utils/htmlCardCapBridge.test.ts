/**
 * HTML 卡片 Cap 桥 —— 宿主侧转发单测
 *
 * 覆盖 plans/html-card-cap-bridge.md 验收：
 * - 白名单内 target → 转发并回包
 * - 白名单外 target → ok:false 且不调用后端（拒绝）
 * - 协议版本不对 / 缺 id → null（忽略不响应）
 * - 后端失败 / invoke 抛错 → ok:false + error
 */
import { describe, it, expect, vi } from 'vitest'
import {
  forwardCardCapRequest,
  CARD_CAP_ALLOWLIST,
  CARD_CAP_PROTOCOL,
  type RouterInvoke,
} from './htmlCardCapBridge'

function okInvoke(result: unknown): RouterInvoke {
  return vi.fn(async () => ({ ok: true, result, error: null }))
}

describe('forwardCardCapRequest', () => {
  it('白名单内 target 转发收到 result', async () => {
    const invoke = okInvoke({ items: [{ id: 1, content: 'a' }] })
    const res = await forwardCardCapRequest(
      { __polarisCap: CARD_CAP_PROTOCOL, id: 'card-x', target: 'cap.todo', payload: { action: 'list', scope: 'all' } },
      invoke,
    )
    expect(res).toEqual({
      __polarisCap: CARD_CAP_PROTOCOL,
      id: 'card-x',
      ok: true,
      result: { items: [{ id: 1, content: 'a' }] },
      error: null,
    })
    expect(invoke).toHaveBeenCalledWith('router_dispatch', {
      req: { target: 'cap.todo', payload: { action: 'list', scope: 'all' } },
    })
  })

  it('白名单外 target 拒绝且不调用后端', async () => {
    const invoke = vi.fn(async () => ({ ok: true, result: null, error: null }))
    const res = await forwardCardCapRequest(
      { __polarisCap: CARD_CAP_PROTOCOL, id: 'card-x', target: 'cap.config', payload: {} },
      invoke,
    )
    expect(res?.ok).toBe(false)
    expect(res?.error).toContain('cap.config')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('协议版本不对 → 忽略', async () => {
    const invoke = vi.fn(async () => ({ ok: true, result: null, error: null }))
    const res = await forwardCardCapRequest(
      { __polarisCap: 99, id: 'card-x', target: 'cap.todo', payload: {} },
      invoke,
    )
    expect(res).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('缺 id → 忽略', async () => {
    const invoke = vi.fn(async () => ({ ok: true, result: null, error: null }))
    const res = await forwardCardCapRequest(
      { __polarisCap: CARD_CAP_PROTOCOL, id: '', target: 'cap.todo', payload: {} },
      invoke,
    )
    expect(res).toBeNull()
  })

  it('后端信封 ok:false → 透传 error', async () => {
    const invoke = vi.fn(async () => ({ ok: false, result: null, error: 'cap.todo list 失败' }))
    const res = await forwardCardCapRequest(
      { __polarisCap: CARD_CAP_PROTOCOL, id: 'card-x', target: 'cap.todo', payload: { action: 'list' } },
      invoke,
    )
    expect(res).toEqual({
      __polarisCap: CARD_CAP_PROTOCOL,
      id: 'card-x',
      ok: false,
      result: null,
      error: 'cap.todo list 失败',
    })
  })

  it('invoke 抛错 → ok:false + error 消息', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('network down')
    })
    const res = await forwardCardCapRequest(
      { __polarisCap: CARD_CAP_PROTOCOL, id: 'card-x', target: 'cap.kv', payload: { action: 'list' } },
      invoke,
    )
    expect(res?.ok).toBe(false)
    expect(res?.error).toBe('network down')
  })

  it('payload 非对象 → 兜底为空对象', async () => {
    const invoke = okInvoke([])
    const res = await forwardCardCapRequest(
      { __polarisCap: CARD_CAP_PROTOCOL, id: 'card-x', target: 'cap.kv', payload: 'nope' },
      invoke,
    )
    expect(res?.ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith('router_dispatch', { req: { target: 'cap.kv', payload: {} } })
  })

  it('白名单声明 cap.todo / cap.kv', () => {
    expect(CARD_CAP_ALLOWLIST.has('cap.todo')).toBe(true)
    expect(CARD_CAP_ALLOWLIST.has('cap.kv')).toBe(true)
  })
})