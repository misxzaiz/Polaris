// lib.rs invoke_handler 清理 + serde 引号修复
import fs from 'node:fs'

let p = 'src-tauri/src/services/ai_chat_core.rs'
let s = fs.readFileSync(p, 'utf8')
s = s.replace('#[serde(rename_all = \\camelCase\\)]', '#[serde(rename_all = "camelCase")]')
fs.writeFileSync(p, s)

p = 'src-tauri/src/commands/provider_diagnostics.rs'
s = fs.readFileSync(p, 'utf8')
if (!s.includes('use tauri::State;')) s = s.replace('use crate::error::Result;', 'use crate::error::Result;\nuse tauri::State;')
fs.writeFileSync(p, s)

p = 'src-tauri/src/lib.rs'
s = fs.readFileSync(p, 'utf8')
// 移除遗留的裸 chat 命令注册（含可能存在的注释行）
const drop = [
  'list_sessions,', 'get_session_history,', 'delete_session,',
  'list_claude_code_sessions,', 'get_claude_code_session_history,',
  'register_pending_question,', 'answer_question,', 'respond_plugin_card,',
  'get_pending_questions,', 'clear_answered_questions,',
  'register_pending_plan,', 'approve_plan,', 'reject_plan,',
  'get_pending_plans,', 'clear_processed_plans,',
  'send_input,',
  'provider_stats,', 'provider_stats_clear,', 'provider_failed_calls,', 'provider_failed_calls_clear,',
]
const lines = s.split('\n')
const out = []
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim()
  if (drop.includes(t) && i > 700) continue
  out.push(lines[i])
}
s = out.join('\n')
// 补 session_history / provider_diagnostics 注册
s = s.replace(
  'commands::router::audit_tail,\n            commands::router::audit_verify,',
  'commands::router::audit_tail,\n            commands::router::audit_verify,\n            commands::session_history::list_sessions,\n            commands::session_history::get_session_history,\n            commands::session_history::delete_session,\n            commands::session_history::list_claude_code_sessions,\n            commands::session_history::get_claude_code_session_history,\n            commands::provider_diagnostics::provider_route_logs,\n            commands::provider_diagnostics::provider_route_logs_clear,\n            commands::provider_diagnostics::provider_stats,\n            commands::provider_diagnostics::provider_stats_clear,\n            commands::provider_diagnostics::provider_failed_calls,\n            commands::provider_diagnostics::provider_failed_calls_clear,',
)
fs.writeFileSync(p, s)
console.log('lib.rs handler list cleaned')
