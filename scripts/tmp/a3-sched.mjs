// SchedulerPanel start_chat → dispatch；dispatchTaskService 测试断言适配
import fs from 'node:fs'

let p = 'src/components/Scheduler/SchedulerPanel.tsx'
let s = fs.readFileSync(p, 'utf8')
const schedOld = `      const sessionId = await invoke<string>('start_chat', {
        message: finalPrompt,
        options: {
          workDir: task.workDir,
          contextId: \`scheduler-\${task.id}\`,
          engineId,
        },
      });`
if (!s.includes(schedOld)) throw new Error('scheduler anchor')
s = s.replace(
  schedOld,
  `      const sessionId = await aiChatDispatch<string>({
        action: 'start',
        message: finalPrompt,
        options: {
          workDir: task.workDir,
          contextId: \`scheduler-\${task.id}\`,
          engineId,
        },
      });`,
)
const m = s.match(/^import .*transport.*$/m) || s.match(/^import .*services\/tauri.*$/m)
if (!m) throw new Error('scheduler import anchor')
s = s.replace(m[0], m[0] + "\nimport { aiChatDispatch } from '@/services/aiChatDispatch'")
fs.writeFileSync(p, s)

p = 'src/services/dispatchTaskService.test.ts'
s = fs.readFileSync(p, 'utf8')
s = s
  .split("invokeMock.mock.calls.find((c) => c[0] === 'start_chat')")
  .join("invokeMock.mock.calls.find((c) => c[0] === 'router_dispatch')")
s = s.replace(
  /const \[, payload\] = startCall as \[string, \{ message: string; options: Record<string, unknown> \}\]/g,
  'const payload = (startCall as [string, { req: { payload: { message: string; options: Record<string, unknown> } } }])[1].req.payload',
)
s = s.replace(
  /const \[, payload\] = startCall as \[string, \{ options: Record<string, unknown> \}\]/g,
  'const payload = (startCall as [string, { req: { payload: { options: Record<string, unknown> } } }])[1].req.payload',
)
fs.writeFileSync(p, s)
console.log('scheduler + tests updated')
