// httpTransport 死分支清理
import fs from 'node:fs'

let p = 'src/services/transport/httpTransport.ts'
let s = fs.readFileSync(p, 'utf8')

s = s.replace(
  "  return command === 'delete_session' && !!args?.sessionId;",
  "  // 第七步阶段 B2：会话历史走 cap.history dispatch，DELETE 专用映射已摘除\n  return false;",
)

const del1 = `      } else if (isDeleteCommand(command, args)) {
        method = 'DELETE';
        // delete_session 需要在 URL 中带 id，可选 engine_id
        const sessionId = encodeURIComponent((args as { sessionId: string }).sessionId);
        const engineId = (args as { engineId?: string })?.engineId;
        const queryStr = engineId ? \`?engineId=\${encodeURIComponent(engineId)}\` : '';
        url = \`\${baseUrl}/api/sessions/\${sessionId}\${queryStr}\`;
      } else if (command === 'get_claude_code_session_history' && args?.sessionId) {
        // Legacy endpoint: returns flat array (not PagedResult)
        method = 'GET';
        url = \`\${baseUrl}/api/claude-sessions/\${encodeURIComponent(args.sessionId as string)}/history\`;
      } else if (command === 'get_session_history' && args?.sessionId) {
        method = 'GET';
        const params = new URLSearchParams();
        for (const [key, val] of Object.entries(args)) {
          if (key !== 'sessionId' && val != null && val !== '') {
            params.set(key, String(val));
          }
        }
        const qs = params.toString();
        url = \`\${baseUrl}/api/chat/history/\${encodeURIComponent(args.sessionId as string)}\${qs ? \`?\${qs}\` : ''}\`;
      }`
if (!s.includes(del1)) throw new Error('special branches anchor')
s = s.replace(del1, '      }')

s = s.replace(/\/\*\*\n \* IMPORTANT: do NOT add `get_claude_code_session_history`[\s\S]*?\*\/\n/, '')

fs.writeFileSync(p, s)
console.log('httpTransport dead branches removed')
