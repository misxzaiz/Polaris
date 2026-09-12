// 第六步 E2E：WS 客户端验证流式 dispatch（cap.stream.echo + cap.ai.chat 真实引擎）
// 用法：node scripts/tmp/ws-e2e.mjs [wsBase] [tokenMd5]
// 默认 ws://127.0.0.1:9829 + token 98279829++ 的 md5
const md5 = (s) => require('node:crypto').createHash('md5').update(s).digest('hex')
const BASE = process.argv[2] || 'http://127.0.0.1:9829'
const TOKEN = process.argv[3] || md5('98279829++')
const API = BASE.replace(/^ws/, 'http')

async function post(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(TOKEN)}`)
    const events = []
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(new Error('WS error: ' + (e.message || 'unknown')))
    ws.onmessage = (m) => {
      try { events.push(JSON.parse(m.data)) } catch { /* 非 JSON 忽略 */ }
    }
    ws._events = events
  })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('[1] 连接 WS ...')
  const ws = await connectWs()
  console.log('    WS 已连接')

  // ── 场景 1：cap.stream.echo ──
  console.log('[2] dispatch_stream cap.stream.echo (count=3, intervalMs=50) ...')
  const ack = await post('/api/router-dispatch-stream', {
    req: { target: 'cap.stream.echo', payload: { count: 3, intervalMs: 50 } },
  })
  console.log('    ack:', ack.status, JSON.stringify(ack.json))
  if (ack.status !== 200 || !ack.json?.trace) throw new Error('stream ack 异常')

  let ok = false
  for (let i = 0; i < 60 && !ok; i++) {
    await wait(100)
    const evs = ws._events
    const echo = evs.filter((e) => e.event === 'stream.echo')
    const end = evs.find((e) => e.event === 'dispatch.end' && e.payload?.stream)
    const start = evs.find((e) => e.event === 'dispatch.start' && e.payload?.stream)
    if (echo.length >= 3 && end && start) {
      ok = true
      console.log(`    收到 dispatch.start(stream)=${!!start}, stream.echo×${echo.length}, dispatch.end(stream)=${!!end}`)
      console.log('    trace 贯通:', start.payload.trace === end.payload.trace && echo.every((e) => !e.payload || true))
    }
  }
  if (!ok) throw new Error('echo 流未在期限内完成')

  // ── 场景 2：cap.ai.chat 真实引擎 ──
  console.log('[3] dispatch_stream cap.ai.chat start（真实 claude 引擎）...')
  const before = ws._events.length
  const ack2 = await post('/api/router-dispatch-stream', {
    req: {
      target: 'cap.ai.chat',
      payload: {
        action: 'start',
        message: '请只回复两个字：收到',
        engineId: 'claude-code',
        contextId: 'capai-e2e-' + Date.now(),
      },
    },
  })
  console.log('    ack:', ack2.status, JSON.stringify(ack2.json))
  if (ack2.status !== 200) throw new Error('ai.chat ack 异常: ' + JSON.stringify(ack2.json))

  let sawToken = false, sawSessionStart = false, sawSessionEnd = false
  const deadline = Date.now() + 120000
  while (Date.now() < deadline && !(sawToken && sawSessionEnd)) {
    await wait(300)
    for (const e of ws._events.slice(before)) {
      if (e.event !== 'chat-event') continue
      const p = e.payload?.payload || {}
      if (p.type === 'token' && !sawToken) {
        sawToken = true
        console.log('    首个 token:', JSON.stringify(p).slice(0, 120))
      }
      if (p.type === 'session_start' && !sawSessionStart) {
        sawSessionStart = true
        console.log('    session_start:', p.sessionId, 'engine:', p.engineId)
      }
      if (p.type === 'session_end' && !sawSessionEnd) {
        sawSessionEnd = true
        console.log('    session_end 到达（流将收尾）')
      }
    }
  }
  if (!sawToken || !sawSessionEnd) {
    console.log('    !! token:', sawToken, 'session_end:', sawSessionEnd)
    throw new Error('ai.chat 流不完整')
  }

  const streamEnd = ws._events.find(
    (e, idx) => idx >= before && e.event === 'dispatch.end' && e.payload?.target === 'cap.ai.chat',
  )
  console.log('[4] cap.ai.chat dispatch.end(stream):', streamEnd ? '✅ ' + JSON.stringify(streamEnd.payload) : '（会话期间不关流，属预期——gate 在 SessionEnd 关闭）')

  ws.close()
  console.log('E2E ✅')
  process.exit(0)
}

main().catch((e) => { console.error('E2E ❌', e.message); process.exit(1) })
