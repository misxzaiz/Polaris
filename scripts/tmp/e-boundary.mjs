// 阶段 E 边界文档回填
import fs from 'node:fs'

let p = 'dev/docs/sky/step7-consolidation.md'
let s = fs.readFileSync(p, 'utf8')

const boundary = `
### ⚠️ 与 polaris-dispatch MCP 的边界（2026-09-12 补，防工具冲突）

两个 server 会同时挂进同一个 AI 会话，工具描述必须互不重叠，否则 AI 路由混乱：

| | polaris-bus（本节新增） | polaris-dispatch（既有） |
|---|---|---|
| 域 | 应用数据域 | 会话桥接域 |
| 职责 | 持久化应用数据 CRUD（todo → 逐域扩） | 任务派发生命周期（创建派发/查进度/继续/专家名册） |
| 视角 | 全局（与会话无关） | 会话绑定（AskListener 模式，知道自己服务哪个会话） |
| 形态 | 独立进程读共享存储（同 DataRoot todo.db） | TCP 连主进程 ask_listener |

**边界规则**（落在 bus_mcp_server.rs 的白名单注释里）：
1. \`bus_dispatch\` 白名单只收**数据域**能力（cap.todo ✓、未来 cap.context 快照等）
2. **永久排除**：cap.ai.chat（AI 自递归）、一切任务派发/会话桥接类能力（dispatch 领地）
3. 工具描述已收紧：bus_dispatch 明确写"这是数据读写，不是任务派发——派发请用
   polaris-dispatch 的 dispatch_task"，让 AI 在工具选择层就不混淆
`

s = s.replace('### 边界与后续', boundary + '\n### 边界与后续')
s = s.replace(
  '- 阶段 E 余项：其余域 MCP 工具化随对应域迁移逐个补齐；AI 会话内的工具启用\n  粒度（mcpEnabled / 逐 server 开关）沿用插件机制',
  '- 阶段 E 余项：其余域 MCP 工具化随对应域迁移逐个补齐；AI 会话内的工具启用\n  粒度（mcpEnabled / 逐 server 开关）沿用插件机制\n- 阶段 A 回归修复：cap.ai.chat 同步 start 误将整个 payload 反序列化为\n  ChatRequestOptions，嵌套 options（含 contextId）被丢弃 → 事件落 "main" 触发\n  新建会话窗口（用户报告的"自动新增窗口"）。已修：嵌套 options 解析 + 平铺\n  兼容（ai_chat_capability.rs），E2E 验证 contextId 贯通',
)
fs.writeFileSync(p, s)
console.log('boundary doc backfilled')
