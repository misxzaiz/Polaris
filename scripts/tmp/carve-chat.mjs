// 第七步阶段 A1 切割脚本：把 commands/chat.rs 的业务核搬入 services/，
// chat.rs 摘除。机械搬移，语义逐行保持；编译器验证。
import fs from 'node:fs'

const SRC = 'src-tauri/src/commands/chat.rs'
const lines = fs.readFileSync(SRC, 'utf8').split('\n')
const L = (a, b) => lines.slice(a - 1, b).join('\n')

// ── 定位边界 ──
function findLine(pred, from = 1) {
  for (let i = from; i <= lines.length; i++) if (pred(lines[i - 1], i)) return i
  throw new Error('line not found')
}
const r1End = findLine((l) => l.startsWith('pub async fn start_chat(')) - 2 // wrap start_chat 上方（含 attr 行往前回溯）
// 精确：找 #[tauri::command] 前一行（start_chat 包装前）
const startCmdAttr = findLine((l, i) => l.trim() === '#[tauri::command]' && lines[i] && lines[i].includes('pub async fn start_chat('))
const r1 = L(1, startCmdAttr - 2) // 1 ..= (attr-2)，含 broadcast helpers

// history 区：list_sessions 命令 attr 到 claude-session-history 区结束（plugin_card 区前）
const histStart = findLine((l) => l.includes('Claude Code 会话历史（旧接口')) // 区头注释在 LinkedPR 前
const listSessionsAttr = findLine((l, i) => l.trim() === '#[tauri::command]' && lines[i] && lines[i].includes('pub async fn list_sessions('))
const histR1 = L(listSessionsAttr, histStart - 2) // list/get/delete 三个命令
const histR2 = L(histStart, findLine((l) => l.startsWith('pub struct PluginCardResponse')) - 2) // LinkedPR .. get_claude_code_session_history 结束

// 问答/plan/send_input 区：PluginCardResponse 到 provider diag 区头
const qStart = findLine((l) => l.startsWith('pub struct PluginCardResponse')) - 1 // 含其上注释块? 从 struct 行起
const qStartAttr = findLine((l) => l.startsWith('pub struct PluginCardResponse'))
const sendInputEnd = (() => {
  const si = findLine((l) => l.startsWith('pub async fn send_input('))
  let depth = 0
  let opened = false
  for (let i = si; i <= lines.length; i++) {
    depth += (lines[i - 1].match(/{/g) || []).length - (lines[i - 1].match(/}/g) || []).length
    if (depth > 0) opened = true
    if (opened && depth === 0) return i
  }
})()
const qRange = L(qStartAttr, sendInputEnd)

// provider diag 命令区（保留为壳命令）
const provStart = findLine((l) => l.includes('供应商路由日志查询'))
const provEnd = (() => {
  const ti = findLine((l) => l.includes('mod route_failover_tests'))
  // 回溯到 #[cfg(test)]
  for (let i = ti; i > 1; i--) if (lines[i - 1].trim() === '#[cfg(test)]') return i - 1
})()
const provRange = L(provStart, provEnd - 1)
const testsRange = L(provEnd, lines.length)

// ── 通用变换 ──
function deTauri(text) {
  return text
    .replace(/^#\[cfg\(feature = "tauri-app"\)\]\n/gm, '')
    .replace(/^#\[tauri::command\]\n/gm, '')
    .replace(/state: tauri::State<'_, crate::AppState>/g, 'state: &crate::AppState')
    .replace(/_state: tauri::State<'_, crate::AppState>/g, '_state: &crate::AppState')
    .replace(/\n\s*window: Window,/g, '')
    .replace(/\n\s*window,\n/g, '\n')
    .replace(/\n\s*window\s*\n\s*\.emit\("chat-event", &routed_event\)[^;]*;?\n/g, '\n')
    .replace(/\n\s*window\s*\n\s*\.emit\("chat-event", &routed_event\)\?;\n/g, '\n')
}

// ── services/ai_chat_core.rs ──
const coreHeader = `/*! AI 聊天业务核（第七步阶段 A1：自 commands/chat.rs 抽出，传输无关）
 *
 * 全部函数仅依赖 '&crate::AppState' 与回调参数（ChatCallbacks/AppPaths），
 * 不含任何 Tauri 类型；事件经 'broadcast_chat_event'（EventBroadcaster）出站，
 * 桌面 Tauri 事件由 lib.rs 的 chat-event 中继任务镜像（见 step7-consolidation.md）。
 *
 * 入口：cap.ai.chat（dispatch/dispatch_stream）——命令层包装已摘除。
 */

`
let core = coreHeader + deTauri(r1) + '\n' + deTauri(qRange) + '\n' + testsRange + '\n'
core = core.replace(/use tauri::\{[^}]*\};\n/g, '').replace(/#\[cfg\(feature = "tauri-app"\)\]\nuse tauri_plugin_notification::NotificationExt;\n/g, '')
fs.writeFileSync('src-tauri/src/services/ai_chat_core.rs', core)

// ── services/ai_history_core.rs ──
const histHeader = `/*! AI 会话历史业务核（第七步阶段 A1：自 commands/chat.rs 抽出）
 *
 * list_sessions / get_session_history / delete_session（统一分页接口）+
 * Claude Code 会话树（元数据解析 / fork 关系推断 / 历史消息读取）。
 * 入口：commands/session_history.rs 壳命令（cap.history 迁移在阶段 B）。
 */

`
let hist = histHeader + deTauri(histR1) + '\n' + deTauri(histR2) + '\n'
hist = hist.replace(/use tauri::\{[^}]*\};\n/g, '')
// BufRead 引入（parse_session_metadata 用）
if (!/use std::io::\{BufRead, BufReader\};/.test(hist)) {
  hist = hist.replace(/use base64::/, 'use std::io::{BufRead, BufReader};\nuse base64::')
}
fs.writeFileSync('src-tauri/src/services/ai_history_core.rs', hist)

// ── commands/session_history.rs（壳命令，签名不变）──
const shWrappers = deTauri(histR1 + '\n' + L(histStart, findLine((l) => l.startsWith('pub struct PluginCardResponse')) - 2))
  .replace(/(?<![_a-zA-Z])(list_sessions|get_session_history|delete_session|list_claude_code_sessions|get_claude_code_session_history)\(/g,
    (m, fn) => fn + '_core(')
  .replace(/use crate::ai::\{/, 'use crate::services::ai_history_core as core_mod;\nuse crate::ai::{')
const shHeader = `//! 会话历史壳命令（第七步阶段 A1：实现移入 services/ai_history_core.rs，签名不变）
//!
//! cap.history 迁移（阶段 B）后本文件整体摘除。
use crate::error::Result;
use crate::ai::{ClaudeHistoryProvider, CodexHistoryProvider, PluginHistoryProvider, HistoryMessage, SessionMeta, PagedResult, Pagination};
`
fs.writeFileSync('src-tauri/src/commands/session_history.rs',
  shHeader + shWrappers.replace(/(?<![_a-zA-Z])(list_sessions|get_session_history|delete_session|list_claude_code_sessions|get_claude_code_session_history)\(/g, '$1(').replace(/_core\(/g, '('))

// ── commands/provider_diagnostics.rs（壳命令，原样搬移）──
const provHeader = `//! 供应商路由诊断壳命令（第七步阶段 A1：自 commands/chat.rs 搬移）
//!
//! 管理面诊断读取，属平台壳命令白名单（step7 §阶段 D），不进总线。
use crate::error::Result;
`
fs.writeFileSync('src-tauri/src/commands/provider_diagnostics.rs', provHeader + provRange)

console.log('carved:',
  'ai_chat_core.rs', core.split('\n').length, 'lines;',
  'ai_history_core.rs', hist.split('\n').length, 'lines;',
  'session_history.rs', shWrappers.split('\n').length, 'lines;',
  'provider_diagnostics.rs', provRange.split('\n').length, 'lines')
