// step7 阶段 B 文档回填
import fs from 'node:fs'

let p = 'dev/docs/sky/step7-consolidation.md'
let s = fs.readFileSync(p, 'utf8')

const progress = `
---

## ⏩ 阶段 B 实施：cap.context + cap.history（2026-09-12）

### ✅ B1 cap.context（上下文管理）
- \`commands/context.rs\`（539 行）删除 → \`services/context_core.rs\`（类型+ContextMemoryStore
  内存存储，与原命令层同源）+ \`services/router/context_capability.rs\`（9 个同步动作，
  含 3 个 IDE 上报动作）。
- state.rs context_store 改持 context_core 同源 Arc；前端 contextService 9 函数全部
  改走 dispatch；ipc.rs 孤立 stub 分支摘除；web/integration_tests.rs 导入修正。
- verify crate +6 单测（upsert/roundtrip/many+remove/query/clear/ide_report）。

### ✅ B2 cap.history（会话历史）
- 壳命令 \`commands/session_history.rs\`（5 个）摘除 → \`services/router/history_capability.rs\`
  （接 ai_history_core 业务核，block_in_place 驱动 async）。
- 前端切换：historyService（动态导入 2 处）/ claudeCodeHistoryService（3）/ codexHistoryService（1）
  → \`services/aiHistoryDispatch.ts\`；httpTransport 摘除 6 条 /api/sessions、/api/claude-sessions
  专用映射与 DELETE/GET 特殊分支及 GET_COMMANDS 条目。
- 摘旧：\`web/api/session.rs\` 删除（/api/sessions、/api/claude-sessions 共 5 条路由）——
  会话历史 web 端点全部由 cap.history dispatch 承接。

### 验证状态（2026-09-12）
| 项 | 结果 |
|---|---|
| cargo check（lib/tests/web-only） | ✅ 全绿 |
| verify crate | ✅ **94 passed / 0 failed** |
| tsc | ✅ 基线 42（零新增） |
| vitest | ✅ dispatchTask 12/12 + httpTransport 7/7（过时端点测试删除） |
| E2E | ✅ cap.context upsert/get_all/query/clear；cap.history list_sessions（5 条真实数据）+ list_claude_sessions（1009 个真实会话） |
`
s = s.replace('---\n\n## 0. 承接与授权', progress + '\n---\n\n## 0. 承接与授权')
fs.writeFileSync(p, s)
console.log('backfilled')
