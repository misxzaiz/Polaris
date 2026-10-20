/**
 * P3 工具注入管理面 — pluginToolService 前端桥测试
 *
 * mock invoke('router_dispatch')，不触真后端。覆盖：
 * - list_plugin_tools 成功解析
 * - set_plugin_tools 成功 / 失败
 * - invoke 异常兜底
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/transport', () => ({
  invoke: vi.fn(),
}))

import { invoke } from '@/services/transport'
import { listPluginTools, setPluginTools } from '@/services/pluginToolService'

const mockInvoke = vi.mocked(invoke)

function dispatchOk(result: unknown) {
  return {
    msgId: 'm1',
    ok: true,
    result,
    error: null,
    trace: 't',
  }
}

function dispatchFail(error: string) {
  return { msgId: 'm1', ok: false, result: null, error, trace: 't' }
}

describe('pluginToolService', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it('list_plugin_tools 解析 servers 与 toolGates', async () => {
    mockInvoke.mockResolvedValue(dispatchOk({
      ok: true,
      pluginId: 'mimo-tts',
      servers: [
        {
          pluginId: 'mimo-tts',
          server: 'mimo-tts',
          tools: ['mimo_tts_synthesize', 'mimo_tts_voice_clone'],
          toolGates: { mimo_tts_synthesize: true, mimo_tts_voice_clone: false },
          injected: 'injected',
          gate: 'open',
          via: 'external',
        },
      ],
    }))

    const res = await listPluginTools('mimo-tts')
    expect(res.ok).toBe(true)
    expect(res.servers).toHaveLength(1)
    expect(res.servers[0].tools).toContain('mimo_tts_synthesize')
    expect(res.servers[0].toolGates.mimo_tts_voice_clone).toBe(false)

    // 校验 payload 形状
    expect(mockInvoke).toHaveBeenCalledWith('router_dispatch', {
      req: { target: 'cap.mcp', payload: { action: 'list_plugin_tools', pluginId: 'mimo-tts' } },
    })
  })

  it('list_plugin_tools 空 pluginId 不传 pluginId 字段', async () => {
    mockInvoke.mockResolvedValue(dispatchOk({ ok: true, pluginId: '', servers: [] }))
    await listPluginTools()
    expect(mockInvoke).toHaveBeenCalledWith('router_dispatch', {
      req: { target: 'cap.mcp', payload: { action: 'list_plugin_tools' } },
    })
  })

  it('list_plugin_tools 后端 ok=false 透传 error', async () => {
    mockInvoke.mockResolvedValue(dispatchFail('cap.mcp 未注册'))
    const res = await listPluginTools('p')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('cap.mcp')
  })

  it('set_plugin_tools 成功带 tools 名单', async () => {
    mockInvoke.mockResolvedValue(dispatchOk({
      ok: true,
      pluginId: 'mimo-tts',
      enabled: false,
      effectiveFrom: 'nextTurn',
    }))
    const res = await setPluginTools('mimo-tts', false, ['mimo_tts_synthesize'])
    expect(res.ok).toBe(true)
    expect(res.effectiveFrom).toBe('nextTurn')
    expect(mockInvoke).toHaveBeenCalledWith('router_dispatch', {
      req: {
        target: 'cap.mcp',
        payload: { action: 'set_plugin_tools', pluginId: 'mimo-tts', enabled: false, tools: ['mimo_tts_synthesize'] },
      },
    })
  })

  it('set_plugin_tools 无 tools 走整插件开关', async () => {
    mockInvoke.mockResolvedValue(dispatchOk({ ok: true, pluginId: 'p', enabled: true, effectiveFrom: 'nextTurn' }))
    const res = await setPluginTools('p', true)
    expect(res.ok).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith('router_dispatch', {
      req: { target: 'cap.mcp', payload: { action: 'set_plugin_tools', pluginId: 'p', enabled: true } },
    })
  })

  it('invoke 异常兜底返回 ok=false', async () => {
    mockInvoke.mockRejectedValue(new Error('network down'))
    const res = await listPluginTools('p')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('network down')
  })
})
