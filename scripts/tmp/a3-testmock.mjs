// dispatchTaskService.test 适配 dispatch 形态
import fs from 'node:fs'

let p = 'src/services/dispatchTaskService.test.ts'
let s = fs.readFileSync(p, 'utf8')

s = s.replace(
  `    invokeMock.mockResolvedValue('backend-conv-1')`,
  `    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'router_dispatch' || cmd === 'router_dispatch_stream') {
        return Promise.resolve({ msgId: 'm', ok: true, result: 'backend-conv-1', error: null, trace: 't' })
      }
      return Promise.resolve('backend-conv-1')
    })`,
)
s = s.replace(`    invokeMock.mockResolvedValue(null)`, `    invokeMock.mockResolvedValue({ ok: false, error: 'gone' })`)
s = s.replace(
  "invokeMock.mock.calls.find((c) => c[0] === 'continue_chat')",
  "invokeMock.mock.calls.find((c) => c[0] === 'router_dispatch_stream')",
)
s = s.replace(
  /const \[, payload\] = continueCall as \[string, \{ sessionId: string; message: string; options: Record<string, unknown> \}\]/g,
  'const payload = (continueCall as [string, { req: { payload: { sessionId: string; message: string; options: Record<string, unknown> } } }])[1].req.payload',
)
fs.writeFileSync(p, s)
console.log('mock adapted')
