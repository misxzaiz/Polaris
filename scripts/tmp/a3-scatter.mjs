// A3 收尾：散落调用点（组件/codex 引擎）批量转换
import fs from 'node:fs'

const files = [
  'src/components/Chat/dynamic-island/index.tsx',
  'src/components/Chat/tool-calls/PlanModeBlockRenderer.tsx',
  'src/components/Chat/tool-calls/AskQuestionCard.tsx',
  'src/engines/codex/session.ts',
  'src/services/dispatchTaskService.ts',
  'src/stores/conversationStore/createConversationStore.ts',
]
const swaps = [
  ["invoke('interrupt_chat', {", "aiChatDispatch({ action: 'interrupt',"],
  ["invoke('answer_question', {", "aiChatDispatch({ action: 'answer_question',"],
  ["invoke('approve_plan', {", "aiChatDispatch({ action: 'approve_plan',"],
  ["invoke('reject_plan', {", "aiChatDispatch({ action: 'reject_plan',"],
  ["invoke('start_chat', {", "aiChatDispatch({ action: 'start',"],
  ["invoke('continue_chat', {", "aiChatDispatchStream({ action: 'continue',"],
]
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8')
  for (const [a, b] of swaps) s = s.split(a).join(b)
  const IMPORT = "from '@/services/aiChatDispatch'"
  if (!s.includes(IMPORT)) {
    const m = s.match(/^import .*transport.*$/m) || s.match(/^import .*services\/tauri.*$/m)
    if (!m) throw new Error('no import anchor ' + f)
    s = s.replace(m[0], m[0] + "\nimport { aiChatDispatch, aiChatDispatchStream } from '@/services/aiChatDispatch'")
  }
  fs.writeFileSync(f, s)
  console.log('done', f)
}
