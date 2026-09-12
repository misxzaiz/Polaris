// A3：chatService 全部改走 cap.ai.chat dispatch
import fs from 'node:fs'

let p = 'src/services/tauri/chatService.ts'
let s = fs.readFileSync(p, 'utf8')

const dispatchHelper = `import { invoke } from '@/services/transport';
import { createLogger } from '@/utils/logger';

const log = createLogger('ChatService');

// Lazy-load Tauri dialog plugin
const isTauriEnv = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/** 经统一总线调用 cap.ai.chat（第七步阶段 A3：chat 命令层已摘除） */
async function chatDispatch(action: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: { target: 'cap.ai.chat', payload: { action, ...payload } },
  });
  if (!res.ok) {
    throw new Error(res.error || ('cap.ai.chat ' + action + ' 失败'));
  }
  return res.result || {};
}
`

const headOld = `import { invoke } from '@/services/transport';
import { createLogger } from '@/utils/logger';

const log = createLogger('ChatService');
`
if (!s.includes(headOld)) throw new Error('head anchor not found')
s = s.replace(headOld, dispatchHelper)

const swaps = [
  ["invoke('register_pending_question', {", "chatDispatch('register_pending_question', {"],
  ["invoke('answer_question', {", "chatDispatch('answer_question', {"],
  ["invoke('respond_plugin_card', {", "chatDispatch('respond_plugin_card', {"],
  ["invoke<PendingQuestion[]>('get_pending_questions', { sessionId })", "chatDispatch('get_pending_questions', { sessionId }) as unknown as PendingQuestion[]"],
  ["invoke<number>('clear_answered_questions')", "(await chatDispatch('clear_answered_questions')).removed as number"],
  ["invoke('register_pending_plan', {", "chatDispatch('register_pending_plan', {"],
  ["invoke('approve_plan', {", "chatDispatch('approve_plan', {"],
  ["invoke('reject_plan', {", "chatDispatch('reject_plan', {"],
  ["invoke<PendingPlan[]>('get_pending_plans', { sessionId })", "chatDispatch('get_pending_plans', { sessionId }) as unknown as PendingPlan[]"],
  ["invoke<number>('clear_processed_plans')", "(await chatDispatch('clear_processed_plans')).removed as number"],
  ["invoke<boolean>('send_input', { sessionId, input })", "(await chatDispatch('send_input', { sessionId, input })).delivered as boolean"],
]
for (const [a, b] of swaps) {
  if (!s.includes(a)) throw new Error('swap anchor missing: ' + a)
  s = s.split(a).join(b)
}
fs.writeFileSync(p, s)
console.log('chatService switched to dispatch')
