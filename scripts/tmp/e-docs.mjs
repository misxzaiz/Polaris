// step7 阶段 E 前置文档回填
import fs from 'node:fs'

let p = 'dev/docs/sky/step7-consolidation.md'
let s = fs.readFileSync(p, 'utf8')

const progress = `
---

## ⏩ 阶段 E 前置落地：bus MCP server（2026-09-12）

**背景**：AI 侧此前没有任何读写存储/转发的 MCP 工具——旧 polaris-todo MCP server
随第四步摘旧删除，"AI 写待办"实为 Claude 引擎内置 TodoWrite（与 Polaris 存储无关）。
本节把总线能力以 MCP 工具面开放给 AI（阶段 E 的"共享业务核"形态，提前部分落地）。

### 实现
- \`services/bus_mcp_server.rs\`（新）：\`polaris-mcp bus [config_dir]\` 独立 stdio 进程，
  进程内构建**与主应用同源**的轻量总线：
  - 同 DataRoot 的 SqliteStorage → \`stores/todo.db\` 与主应用**共享存储**（WAL + busy_timeout）
  - 同一 \`TodoCapability\` 业务核（单份逻辑双入口，这正是阶段 E 的目标形态）
  - \`PolicyPermission\`（Plugin 来源默认放行）+ 独立审计链
    \`audit/dispatch-mcp.jsonl\`（audit_sink 新增 \`audit_file_path_named\`——
    跨进程各自续链，避免与主应用 dispatch.jsonl 哈希链竞争）
- 工具面：**todo_list / todo_get / todo_create / todo_update / todo_complete /
  todo_delete**（精选显式工具，对 AI 友好）+ **bus_dispatch**（通用转发
  {target, payload}，白名单当前仅 cap.todo，按阶段 C 权限策略逐域放开）
- 来源标注：\`Source::Plugin { caller: polaris-bus-mcp }\`
- 注册：\`polaris-mcp\` 子命令 \`bus\`（config_dir 缺省回落 DataRoot.config_dir）+
  **todo 插件 manifest** \`contributes.mcpServers += polaris-bus\`
  （todo 插件 enabledByDefault=true → AI 会话自动挂载；{{appConfigDir}} 与
  主应用能力存储同根，由 mcp_config_service 解析注入）

### 验证（2026-09-12 stdio E2E）
| 步骤 | 结果 |
|---|---|
| initialize | ✅ polaris-bus-mcp / 2024-11-05 |
| tools/list | ✅ 7 个工具 |
| tools/call todo_create | ✅ 真实写入 |
| **存储共享** | ✅ 主应用 cap.todo list 可见 MCP 创建的待办（同一 todo.db） |
| bus_dispatch 白名单 | ✅ target=cap.context 被拒（isError + 提示） |
| 回归 | ✅ cargo check 四目标全绿；tsc 基线 42；plugin-system mcp.test 10/10 |

### 边界与后续
- context 等内存型能力不进 bus server（跨进程不共享内存——如需，走阶段 C 后的
  HTTP 转发而非内存直连）
- 审计链独立于主应用 dispatch.jsonl（跨进程哈希链竞争的显式取舍）
- 阶段 E 余项：其余域 MCP 工具化随对应域迁移逐个补齐；AI 会话内的工具启用
  粒度（mcpEnabled / 逐 server 开关）沿用插件机制
`
s = s.replace('---\n\n## 0. 承接与授权', progress + '\n---\n\n## 0. 承接与授权')
fs.writeFileSync(p, s)
console.log('step7 阶段 E 前置回填完成')
