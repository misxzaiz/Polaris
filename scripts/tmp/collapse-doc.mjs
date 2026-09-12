// step7 阶段 E：工具面收敛文档回填
import fs from 'node:fs'

let p = 'dev/docs/sky/step7-consolidation.md'
let s = fs.readFileSync(p, 'utf8')

s = s.replace(
  `- 工具面：**bus_help**（发现/文档工具：能力清单、工具入参、白名单、迁移路线图、
  用法示例——8 个工具）+ **todo_list / todo_get / todo_create / todo_update /
  todo_complete / todo_delete**（精选显式工具，对 AI 友好）+ **bus_dispatch**（通用转发
  {target, payload}，白名单当前仅 cap.todo，按阶段 C 权限策略逐域放开）`,
  `- 工具面（**收敛后仅 2 个，防工具大爆炸**）：
  - **bus_help**：发现/文档工具——server 信息、bus_dispatch 白名单、本进程注册能力、
    各域迁移状态、**各白名单能力的动作协议逐动作文档**（payload 字段级）、用法示例。
    AI 每次任务先查它即可组装调用。
  - **bus_dispatch**：唯一执行工具 {target, payload:{action, ...}}，payload 即能力
    动作协议；白名单当前仅 cap.todo（8 个动作全可达），按阶段 C 逐域放开。
  - 演进记录：初版曾铺 6 个 todo_* 精选工具，评审后按"一域一入口"收敛撤销——
    精选工具随域线性增长（scheduler 48 命令会是灾难），通用转发 + 协议文档
    使工具数恒定为 2，与域数量解耦。`,
)
fs.writeFileSync(p, s)
console.log('doc updated')
