// B2 收尾修复
import fs from 'node:fs'

// 1. claudeCodeHistoryService: 未用 invoke 移除 + 泛型标注
let p = 'src/services/claudeCodeHistoryService.ts'
let s = fs.readFileSync(p, 'utf8')
s = s.replace("import { invoke } from '@/services/tauri'\n", '')
s = s.replace(
  "const sessions = await aiHistoryDispatch({\n        action: 'list_claude_sessions',",
  "const sessions = await aiHistoryDispatch<ClaudeCodeSessionMeta[]>({\n        action: 'list_claude_sessions',",
)
s = s.replace(
  "const result = await aiHistoryDispatch({\n        action: 'list_sessions',",
  "const result = await aiHistoryDispatch<PagedResult<SessionMetaResponse>>({\n        action: 'list_sessions',",
)
s = s.replace(
  "const messages = await aiHistoryDispatch({\n        action: 'get_claude_history',",
  "const messages = await aiHistoryDispatch<ClaudeCodeMessage[]>({\n        action: 'get_claude_history',",
)
fs.writeFileSync(p, s)

// 2. httpTransport: isDeleteCommand 函数删除
p = 'src/services/transport/httpTransport.ts'
s = fs.readFileSync(p, 'utf8')
s = s.replace(
  `/** 判断命令是否使用 DELETE */
function isDeleteCommand(command: string, args?: Record<string, unknown>): boolean {
  // 第七步阶段 B2：会话历史走 cap.history dispatch，DELETE 专用映射已摘除
  return false;
}

`,
  '',
)
fs.writeFileSync(p, s)

// 3. httpTransport.test.ts: 删除两个过时端点测试
p = 'src/services/transport/httpTransport.test.ts'
s = fs.readFileSync(p, 'utf8')
const t1 = s.indexOf("it('routes get_claude_code_session_history to the dedicated /history sub-path (not the list endpoint)'")
if (t1 > 0) {
  const t1end = s.indexOf('\n  });\n', t1)
  const t2 = s.indexOf("it('routes list_claude_code_sessions to the list endpoint with query params'", t1end)
  if (t2 > 0) {
    const t2end = s.indexOf('\n  });\n', t2)
    s = s.slice(0, t1) + s.slice(t2end + 6)
  }
}
fs.writeFileSync(p, s)
console.log('B2 fixes applied')
