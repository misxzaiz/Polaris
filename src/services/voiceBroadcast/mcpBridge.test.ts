/**
 * mcpBridge 单元测试
 *
 * 覆盖 callMimoTts：成功（file url / base64 audioDataUrl）、插件错误、
 * cap.mcp 层失败、resultJson 解析异常、缺音频地址。mock invoke 不触真后端。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()
vi.mock('@/services/transport', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// import after mock
import { callMimoTts, probeMimoTts } from './mcpBridge'

/** 构造 router_dispatch 成功响应 */
function dispatchOk(result: unknown): unknown {
  return { msgId: 'm1', ok: true, result, error: null, trace: '' }
}

function dispatchFail(error: string): unknown {
  return { msgId: 'm1', ok: false, result: null, error, trace: '' }
}

beforeEach(() => {
  mockInvoke.mockReset()
})

describe('callMimoTts', () => {
  it('成功：file 模式取 url', async () => {
    const capResult = {
      ok: true,
      resultJson: JSON.stringify({
        success: true,
        model: 'mimo-v2.5-tts',
        voice: '冰糖',
        text: '你好',
        format: 'wav',
        url: 'http://127.0.0.1:9861/audio/x.wav',
      }),
    }
    mockInvoke.mockResolvedValue(dispatchOk(capResult))

    const res = await callMimoTts({ text: '你好', voice: '冰糖' })
    expect(res.ok).toBe(true)
    expect(res.url).toBe('http://127.0.0.1:9861/audio/x.wav')
    expect(res.format).toBe('wav')

    // 校验 payload 形状：target=cap.mcp, action=call, mcpServerId=mimo-tts
    const [cmd, args] = mockInvoke.mock.calls[0] as [string, { req: unknown }]
    expect(cmd).toBe('router_dispatch')
    const req = args.req as { target: string; payload: Record<string, unknown> }
    expect(req.target).toBe('cap.mcp')
    expect(req.payload).toMatchObject({
      action: 'call',
      mcpServerId: 'mimo-tts',
      tool: 'mimo_tts_synthesize',
      arguments: { text: '你好', voice: '冰糖' },
    })
  })

  it('成功：base64 模式取 audioDataUrl', async () => {
    const capResult = {
      ok: true,
      resultJson: JSON.stringify({
        success: true,
        format: 'wav',
        audioDataUrl: 'data:audio/wav;base64,AAAA',
      }),
    }
    mockInvoke.mockResolvedValue(dispatchOk(capResult))

    const res = await callMimoTts({ text: 'hi', outputMode: 'base64' })
    expect(res.ok).toBe(true)
    expect(res.url).toBe('data:audio/wav;base64,AAAA')
  })

  it('失败：插件返回 error（未配 Key 等）', async () => {
    const capResult = {
      ok: true,
      resultJson: JSON.stringify({ error: '未配置 API Key' }),
    }
    mockInvoke.mockResolvedValue(dispatchOk(capResult))

    const res = await callMimoTts({ text: '你好' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未配置 API Key')
  })

  it('失败：cap.mcp 层返回 ok=false', async () => {
    mockInvoke.mockResolvedValue(dispatchOk({ ok: false, error: 'MCP server 未注册' }))
    const res = await callMimoTts({ text: '你好' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未注册')
  })

  it('失败：router_dispatch 返回 ok=false', async () => {
    mockInvoke.mockResolvedValue(dispatchFail('cap.mcp 调用失败'))
    const res = await callMimoTts({ text: '你好' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('cap.mcp')
  })

  it('失败：resultJson 不是合法 JSON', async () => {
    const capResult = { ok: true, resultJson: 'not-json{' }
    mockInvoke.mockResolvedValue(dispatchOk(capResult))
    const res = await callMimoTts({ text: '你好' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('无法解析')
  })

  it('失败：缺少音频地址', async () => {
    const capResult = {
      ok: true,
      resultJson: JSON.stringify({ success: true, format: 'wav' }),
    }
    mockInvoke.mockResolvedValue(dispatchOk(capResult))
    const res = await callMimoTts({ text: '你好' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('缺少音频地址')
  })

  it('错误：invoke 抛异常', async () => {
    mockInvoke.mockRejectedValue(new Error('network down'))
    const res = await callMimoTts({ text: '你好' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('network down')
  })
})

describe('probeMimoTts', () => {
  it('成功探测', async () => {
    mockInvoke.mockResolvedValue(
      dispatchOk({ ok: true, resultJson: JSON.stringify({ success: true, audioDataUrl: 'data:audio/wav;base64,AAA' }) }),
    )
    const res = await probeMimoTts('冰糖')
    expect(res.ok).toBe(true)
    // 探测用最小文本 + base64
    const payload = (mockInvoke.mock.calls[0] as unknown[])[1] as { req: { payload: Record<string, unknown> } }
    const args = payload.req.payload.arguments as Record<string, unknown>
    expect(args.outputMode).toBe('base64')
    expect(args.text).toBe('。')
  })

  it('失败探测', async () => {
    mockInvoke.mockResolvedValue(
      dispatchOk({ ok: true, resultJson: JSON.stringify({ error: '未配置 API Key' }) }),
    )
    const res = await probeMimoTts()
    expect(res.ok).toBe(false)
    expect(res.error).toContain('API Key')
  })
})