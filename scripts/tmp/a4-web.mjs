// A4：删除 web 聊天面（chat.rs 处理器 + 路由）
import fs from 'node:fs'

fs.unlinkSync('src-tauri/src/web/api/chat.rs')

let p = 'src-tauri/src/web/api/mod.rs'
let s = fs.readFileSync(p, 'utf8')
s = s.replace('pub mod chat;\n', '')
fs.writeFileSync(p, s)

p = 'src-tauri/src/web/router.rs'
s = fs.readFileSync(p, 'utf8')
const routes = [
  '        .route("/chat/send", post(api::chat::handle_send_message))\n',
  '        .route("/chat/execute", post(api::chat::handle_execute))\n',
  '        .route("/chat/interrupt", post(api::chat::handle_interrupt))\n',
  '        .route("/chat/history/{session_id}", get(api::chat::handle_get_history))\n',
  '        .route("/chat/answer-question", post(api::chat::handle_answer_question))\n',
  '        .route("/chat/respond-plugin-card", post(api::chat::handle_respond_plugin_card))\n',
  '        .route("/chat/approve-plan", post(api::chat::handle_approve_plan))\n',
  '        .route("/chat/reject-plan", post(api::chat::handle_reject_plan))\n',
]
for (const r of routes) {
  if (!s.includes(r)) throw new Error('route missing: ' + r.trim())
  s = s.split(r).join('')
}
fs.writeFileSync(p, s)
console.log('web chat surface removed')
