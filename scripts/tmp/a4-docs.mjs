// step7 文档回填
import fs from 'node:fs'

let p = 'dev/docs/sky/step7-consolidation.md'
let s = fs.readFileSync(p, 'utf8')
s = s.replace(
  '> 状态：规划定稿（阶段 A 实施中）',
  '> 状态：✅ 阶段 A（C2 AI 聊天全量上总线）已实施（2026-09-12）；阶段 B-E 待启动',
)

const progress = `
---

## ⏩ 阶段 A 实施进展（2026-09-12）

### ✅ A1 抽核
- \`commands/chat.rs\`（3518 行）删除，业务核迁入：
  - \`services/ai_chat_core.rs\`（2650 行）：start/continue/interrupt inner + Profile failover
    全家桶 + 附件处理 + 问答/plan 簿记 + send_input + route_failover_tests（随核迁移）
  - \`services/ai_history_core.rs\`（674 行）：会话历史（统一分页 + Claude 会话树/fork 推断）
- 壳命令：\`commands/session_history.rs\`（5 个，签名不变，前端历史 UI 零改动）、
  \`commands/provider_diagnostics.rs\`（6 个诊断读取，平台壳白名单）
- 全部核函数传输无关（&AppState + ChatCallbacks/AppPaths）；web/api/session.rs 的
  web 辅助（build_web_callbacks/run_claude_blocking 等）收敛至 session.rs 本地

### ✅ A2 cap.ai.chat 完整化
- \`Arc<AppState>\` 持有（clone_for_web 共享业务字段），装配点注册（桌面 setup + 独立 Web，幂等）
- 同步动作 12 个 + start/continue 同步形态（返回值承载引擎 sessionId —— 前端
  conversationId 语义保持）；流式动作 start/continue 经 dispatch_stream（程序化消费方通道）
- 同步 dispatch 对流式表目标自动回退 invoke（混合型能力）
- 桌面 chat-event 中继：lib.rs 订阅广播通道 → Tauri emit + session_end 桌面通知
  （承接旧 window.emit 双发语义）

### ✅ A3 前端切换
- \`services/aiChatDispatch.ts\` 新助手（dispatch/dispatch_stream 双通道）
- 切换点：chatService（12 函数）/ createConversationStore（start/continue/interrupt）/
  dispatchTaskService（start/continue/interrupt）/ engines/claude-code + codex session /
  SchedulerPanel / dynamic-island / PlanModeBlockRenderer / AskQuestionCard
- EventRouter / conversationStore 渲染链 **零改动**（chat-event 线格式不变）

### ✅ A4 摘旧
- 删：\`commands/chat.rs\`、\`web/api/chat.rs\`、8 条 /api/chat/* 路由、lib.rs 约 20 个
  命令注册、httpTransport 7 条专用映射
- 残留 grep：\`start_chat\` 等旧命令字符串全库 **0 处**（仅历史注释）

### 验证状态
| 项 | 结果 |
|---|---|
| cargo check（lib/tests/web-only） | ✅ 全绿 |
| verify crate | ✅ 88 passed / 0 failed（含幂等注册更新） |
| tsc | ✅ 基线 42（零新增） |
| vitest | ✅ dispatchTask 12/12 + plugin-system/stores/services 通过 |
| E2E（9829，Profile 凭证真实引擎） | ✅ start 同步返回 sid → continue 模型回复"完成"经 chat-event 送达 → interrupt ok → get_pending_plans ok → 同步打流式目标防误用生效 → 隔离事件流 9 事件干净收尾 |
| 待办 | 配套可视化原型；24h 用户可见性回访（桌面聊天全功能） |
`
s = s.replace('---\n\n## 0. 承接与授权', progress + '\n---\n\n## 0. 承接与授权')
fs.writeFileSync(p, s)
console.log('step7 doc backfilled')
