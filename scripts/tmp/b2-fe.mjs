// B2 前端切换（精确版）：三个 history service + historyService 动态导入点
import fs from 'node:fs'

const IMPORT = "import { aiHistoryDispatch } from '@/services/aiHistoryDispatch'"

// ── codexHistoryService.ts ──
let p = 'src/services/codexHistoryService.ts'
let s = fs.readFileSync(p, 'utf8')
if (!s.includes(IMPORT)) {
  const m = s.match(/^import .*services\/tauri.*$/m) || s.match(/^import .*transport.*$/m)
  if (!m) throw new Error('codex import anchor')
  s = s.replace(m[0], m[0] + '\n' + IMPORT)
}
s = s.replace(
  `return await invoke<PagedResult<SessionMetaResponse>>('list_sessions', {
        engineId: 'codex',`,
  `return await aiHistoryDispatch({
        action: 'list_sessions',
        engineId: 'codex',`,
)
fs.writeFileSync(p, s)

// ── claudeCodeHistoryService.ts ──
p = 'src/services/claudeCodeHistoryService.ts'
s = fs.readFileSync(p, 'utf8')
if (!s.includes(IMPORT)) {
  const m = s.match(/^import .*services\/tauri.*$/m) || s.match(/^import .*transport.*$/m)
  if (!m) throw new Error('claude import anchor')
  s = s.replace(m[0], m[0] + '\n' + IMPORT)
}
s = s.replace(
  `const sessions = await invoke<ClaudeCodeSessionMeta[]>('list_claude_code_sessions', {
        projectPath,
      })`,
  `const sessions = await aiHistoryDispatch({
        action: 'list_claude_sessions',
        workDir: projectPath,
      })`,
)
s = s.replace(
  `const result = await invoke<PagedResult<SessionMetaResponse>>('list_sessions', {
        engineId: 'claude-code',`,
  `const result = await aiHistoryDispatch({
        action: 'list_sessions',
        engineId: 'claude-code',`,
)
s = s.replace(
  `const messages = await invoke<ClaudeCodeMessage[]>('get_claude_code_session_history', {
        sessionId,
        projectPath,
      })`,
  `const messages = await aiHistoryDispatch({
        action: 'get_claude_history',
        sessionId,
        projectPath,
      })`,
)
fs.writeFileSync(p, s)

// ── historyService.ts（动态导入两处）──
p = 'src/services/historyService.ts'
s = fs.readFileSync(p, 'utf8')
if (!s.includes(IMPORT)) {
  const m = s.match(/^import \{ invoke \} from '@\/services\/transport'/m)
  if (!m) throw new Error('historyService import anchor')
  s = s.replace(m[0], m[0] + '\n' + IMPORT)
}
s = s.replace(
  `      const { invoke } = await import('../services/tauri')
      try {
        const result = await invoke<{ items: { role: string; content: string; messageId?: string; timestamp?: string }[] }>('get_session_history', {
          sessionId,
          engineId,
          page: 1,
          pageSize: 10000,
        })`,
  `      try {
        const result = await aiHistoryDispatch({
          action: 'get_session_history',
          sessionId,
          engineId,
          page: 1,
          pageSize: 10000,
        })`,
)
s = s.replace(
  `      const { invoke } = await import('../services/tauri')
      await invoke('delete_session', {
        sessionId,
        engineId: engineId || (
          source === 'codex-native' ? 'codex'
          : source === 'plugin-native' ? source
          : 'claude-code'),
      })`,
  `      await aiHistoryDispatch({
        action: 'delete_session',
        sessionId,
        engineId: engineId || (
          source === 'codex-native' ? 'codex'
          : source === 'plugin-native' ? source
          : 'claude-code'),
      })`,
)
fs.writeFileSync(p, s)

// ── httpTransport.ts：摘除已删命令的映射与特殊分支 ──
p = 'src/services/transport/httpTransport.ts'
s = fs.readFileSync(p, 'utf8')
for (const dead of [
  "  get_session_history: '/api/chat/history',\n",
  "  get_claude_code_session_history: '/api/claude-sessions',\n",
  "  list_claude_code_sessions: '/api/claude-sessions',\n",
  "  list_sessions: '/api/sessions',\n",
  "  create_session: '/api/sessions',\n",
  "  delete_session: '/api/sessions',\n",
]) {
  if (!s.includes(dead)) throw new Error('http map missing: ' + dead.trim())
  s = s.split(dead).join('')
}
// GET_COMMANDS / delete_session 特判 / URL 特殊分支（旧端点已删）
s = s.replace(
  "const GET_COMMANDS: ReadonlySet<string> = new Set(['get_config', 'list_sessions', 'health_check', 'list_claude_code_sessions']);",
  "const GET_COMMANDS: ReadonlySet<string> = new Set(['get_config', 'health_check']);",
)
fs.writeFileSync(p, s)
console.log('frontend history switched')
