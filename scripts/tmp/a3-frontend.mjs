// A3：前端聊天调用全部切到 cap.ai.chat dispatch
import fs from 'node:fs'

// 1. 共享 helper
fs.writeFileSync(
  'src/services/aiChatDispatch.ts',
  `/**
 * cap.ai.chat 统一调用助手（第七步阶段 A3）
 *
 * chat 命令层已摘除：所有 AI 会话操作经 RouterBus dispatch
 * （同步动作 router_dispatch；流式动作 router_dispatch_stream，
 *   事件经既有 chat-event 通道推送，前端 EventRouter 零改动）。
 */
import { invoke } from '@/services/transport'

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
export interface AiDispatchResponse {
  msgId: string
  ok: boolean
  result: unknown
  error: string | null
  trace: string
}

export interface AiStreamAck {
  msgId: string
  trace: string
}

const TARGET = 'cap.ai.chat'

/** 同步动作：interrupt / send_input / approve_plan / reject_plan / answer_question 等 */
export async function aiChatDispatch<T = unknown>(payload: Record<string, unknown>): Promise<T> {
  const res = await invoke<AiDispatchResponse>('router_dispatch', {
    req: { target: TARGET, payload },
  })
  if (!res.ok) {
    throw new Error(res.error || ('cap.ai.chat ' + String(payload.action ?? '') + ' 失败'))
  }
  return res.result as T
}

/** 流式动作：start / continue（返回 ack；内容经 chat-event 事件流推送） */
export async function aiChatDispatchStream(payload: Record<string, unknown>): Promise<AiStreamAck> {
  return invoke<AiStreamAck>('router_dispatch_stream', {
    req: { target: TARGET, payload },
  })
}
`,
)

// 2. createConversationStore：start/continue
let p = 'src/stores/conversationStore/createConversationStore.ts'
let s = fs.readFileSync(p, 'utf8')
if (!s.includes('aiChatDispatch')) {
  s = s.replace("import { invoke } from '@/services/transport'", "import { invoke } from '@/services/transport'\nimport { aiChatDispatch, aiChatDispatchStream } from '@/services/aiChatDispatch'")
}
const contOld = `            await invoke('continue_chat', {
              sessionId: conversationId,
              message: normalizeForInvoke(processedMessage),
              options: chatOptions,
            })`
if (!s.includes(contOld)) throw new Error('continue anchor 1835')
s = s.replace(
  contOld,
  `            await aiChatDispatchStream({
              action: 'continue',
              sessionId: conversationId,
              message: normalizeForInvoke(processedMessage),
              options: chatOptions,
            })`,
)
const startOld = `            const newSessionId = await invoke<string>('start_chat', {
              message: normalizeForInvoke(processedMessage),
              options: {
                ...chatOptions,
                forkSessionId: forkSessionId || undefined,
              },
            })
            set({ conversationId: newSessionId })`
if (!s.includes(startOld)) throw new Error('start anchor 1844')
s = s.replace(
  startOld,
  `            const newSessionId = await aiChatDispatch<string>({
              action: 'start',
              message: normalizeForInvoke(processedMessage),
              options: {
                ...chatOptions,
                forkSessionId: forkSessionId || undefined,
              },
            })
            set({ conversationId: newSessionId })`,
)
// 第二处 continue（1973 附近）
const cont2Old = `          await invoke('continue_chat', {`
const cont2Idx = s.indexOf(cont2Old)
if (cont2Idx > 0) {
  const end = s.indexOf('})', cont2Idx)
  const block = s.slice(cont2Idx, end + 3)
  const inner = block.replace("invoke('continue_chat', {", "aiChatDispatchStream({")
  s = s.slice(0, cont2Idx) + inner + s.slice(end + 3)
}
fs.writeFileSync(p, s)
console.log('createConversationStore switched')

// 3. engines/claude-code/session.ts：start/continue/interrupt
p = 'src/engines/claude-code/session.ts'
s = fs.readFileSync(p, 'utf8')
if (!s.includes('aiChatDispatch')) {
  s = s.replace("import { invoke } from '@/services/transport'", "import { invoke } from '@/services/transport'\nimport { aiChatDispatch, aiChatDispatchStream } from '@/services/aiChatDispatch'")
}
const sOld = `    try {
      await invoke('start_chat', args)
    } catch (error) {`
if (!s.includes(sOld)) throw new Error('session start anchor')
s = s.replace(
  sOld,
  `    try {
      await aiChatDispatch({
        action: 'start',
        message: args.message,
        options: { workDir: args.workspaceDir },
      })
    } catch (error) {`,
)
const iOld = `    invoke('interrupt_chat', { sessionId: this.id })`
if (!s.includes(iOld)) throw new Error('session interrupt anchor')
s = s.replace(
  iOld,
  `    aiChatDispatch({ action: 'interrupt', sessionId: this.id })`,
)
const cOld = `      await invoke('continue_chat', {
        sessionId: this.id,
        message: prompt,
      })`
if (!s.includes(cOld)) throw new Error('session continue anchor')
s = s.replace(
  cOld,
  `      await aiChatDispatchStream({
        action: 'continue',
        sessionId: this.id,
        message: prompt,
      })`,
)
fs.writeFileSync(p, s)
console.log('claude-code session switched')

// 4. dispatchTaskService：start/continue
p = 'src/services/dispatchTaskService.ts'
s = fs.readFileSync(p, 'utf8')
if (!s.includes('aiChatDispatch')) {
  s = s.replace("import { invoke } from '@/services/transport'", "import { invoke } from '@/services/transport'\nimport { aiChatDispatch, aiChatDispatchStream } from '@/services/aiChatDispatch'")
}
const dStartOld = `    const conversationId = await invoke<string>('start_chat', {`
if (!s.includes(dStartOld)) throw new Error('dispatch start anchor')
s = s.replace(dStartOld, `    const conversationId = await aiChatDispatch<string>({`)
const dContOld = `    await invoke('continue_chat', {`
if (!s.includes(dContOld)) throw new Error('dispatch continue anchor')
s = s.replace(dContOld, `    await aiChatDispatchStream({`)
fs.writeFileSync(p, s)
console.log('dispatchTaskService switched')

// 5. httpTransport：摘除已删命令的专用映射（通用 dispatch 映射已存在）
p = 'src/services/transport/httpTransport.ts'
s = fs.readFileSync(p, 'utf8')
for (const dead of [
  "  start_chat: '/api/chat/send',\n",
  "  continue_chat: '/api/chat/send',\n",
  "  interrupt_chat: '/api/chat/interrupt',\n",
  "  answer_question: '/api/chat/answer-question',\n",
  "  respond_plugin_card: '/api/chat/respond-plugin-card',\n",
  "  approve_plan: '/api/chat/approve-plan',\n",
  "  reject_plan: '/api/chat/reject-plan',\n",
]) {
  if (!s.includes(dead)) throw new Error('http mapping missing: ' + dead.trim())
  s = s.split(dead).join('')
}
fs.writeFileSync(p, s)
console.log('httpTransport chat mappings removed')
