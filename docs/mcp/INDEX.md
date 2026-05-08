# MCP 插件系统计划索引

更新时间：2026-05-08

用途：后续每次让 AI 继续 MCP 插件系统相关工作时，优先读取本文件。只有需要细节时，再按链接读取对应编号文档，避免每次加载全部上下文。

## 当前结论

MCP 插件系统已经完成第一阶段骨架、阶段 4 后端 registry、阶段 5 前后端 manifest 对齐的第一步，以及阶段 6 插件发现/安装/更新闭环的主要操作面：前端插件注册表、Todo 插件案例、插件 UI/MCP 开关、状态后端持久化、聊天请求禁用 MCP server 过滤、设置页 MCP runtime 状态展示、后端内置 MCP server 声明式定义表、后端插件 MCP contribution registry、共享 manifest schema 文档、Todo 插件 MCP server 前后端一致性测试、用户/项目插件目录扫描、已安装插件 manifest 清单返回、前端发现插件 metadata 动态注册、设置页区分内置/用户安装/项目插件、设置页手动刷新已安装插件、前端 manifest contribution 校验诊断反馈、刷新时替换非内置插件避免已删除安装残留、用户/项目安装目录查询与打开入口、从本地目录复制安装插件、按已发现安装路径安全卸载插件、后端 manifest schema 校验命令、安装前 manifest 诊断拦截、Web/Tauri 两种传输下的 manifest 校验入口、manifest `origin` 来源链接展示、基于 `origin.updateUrl` 的插件更新检查入口、本地 zip/json 包安装、远程 manifest/zip 安装、`origin.downloadUrl` 更新包解析，以及用户确认后的覆盖更新。

当前还没有完成的是：插件市场/远程来源管理、插件权限执行边界、插件可视化模块的动态加载与隔离策略、外部插件 MCP server 的分发与运行时权限收敛。阶段 5 仍可继续扩展为自动 JSON schema/生成式 schema 校验；阶段 6 仍可继续扩展为更完整的安装错误展示、来源可信度提示和更新回滚 UX。

## 下一方向：协议文档模式外部 MCP 插件化

目标：把定时任务中的“协议文档模式”抽取为一个可安装的外部 MCP 插件，而不是继续作为内置插件或核心调度器专属功能。这个方向可行，但建议先做协议/能力边界设计，不直接实现。具体方案见 [长期目标执行 MCP 插件方案](./6-long-goal-executor-plugin.md)。

当前已先落地一版宿主侧原型：长期目标文档服务、Tauri/Web IPC 命令、前端 typed wrapper、长期目标左侧面板、规划/执行/维护会话 prompt 生成、从面板创建新的 AI 会话并发送 prompt、目标创建后可自动启动第一次规划会话、把运行中的 `sessionId` 写回 `goal.json`、长期目标面板中断当前运行会话、监听 `session_end` 后写回会话摘要并清空 `currentSessionId`、按 `nextRunAt` 自动开启下一次执行会话、自动失败时按重试退避重新排期并在超过上限后标记 `blocked`、创建目标时配置代码修改和 git 提交权限、completed 状态下的完成复审入口，以及目标详情运行状态可视化。这个原型仍不是最终外部 MCP 插件，只是用于验证协议文档模式和会话编排 UX。

需求草案：

- 用户设定一个长期目标。
- AI 先拆解目标，生成阶段、任务队列和执行规则。
- 第一次会话只负责拆解和落盘规划；拆解完成后结束当前会话，由 Polaris 按配置自动新建下一次会话。
- 每次自动执行都新建独立会话，并只推进一个小模块，避免一次性改动过大。
- 每次执行前必须读取协议文档、当前进度、任务队列和用户补充。
- 每次执行后必须更新协议文档或记忆文件，记录进度、下一步、阻塞点和用户需要确认的事项。
- 支持用户随时补充要求，补充内容在下一次执行前被读取并合并处理。
- 支持暂停、恢复；暂停时不再自动推进，但保留文档状态，并允许用户手动触发一次“只整理文档、不执行代码”的维护会话。
- 允许长期目标执行会话修改代码和提交 git；这需要在权限模型中显式声明并由用户授权。
- 完成状态由 AI 根据协议、任务队列和验收标准判定；完成后自动暂停，但保留用户复审入口，用户可以要求继续拆解后续任务并恢复执行。

现有基础：

- `scheduler_read_protocol_documents` 已能读取协议文档、用户补充、记忆索引和任务队列。
- `scheduler_update_protocol`、`scheduler_update_supplement`、`scheduler_update_memory_index`、`scheduler_update_memory_tasks` 已能写回协议相关文档。
- `scheduler_build_protocol_prompt` 已经把协议文档、用户补充、记忆索引和任务队列组合成执行 prompt。
- 协议模板、文档渲染和备份入口已经存在，可以作为外部插件设计的参考。

建议抽取边界：

- 外部 MCP 插件只负责“目标拆解、协议文档读写、下一小步选择、执行后状态更新”的工具能力。
- Polaris 核心仍负责插件发现、安装、启停、MCP server 配置生成和权限授权。
- 自动定时触发、新建会话、选择 AI 引擎、监听会话结束和安排下一次运行应保持在 Polaris 核心侧；外部插件暴露可被 AI 调用的 MCP tools，避免让外部插件直接拥有后台常驻调度权。
- 文档存储位置需要显式约束在工作区允许目录内，例如 `.polaris/protocol-tasks/<task-id>/`，不能由插件任意读写文件系统。
- 建议优先使用“完成后间隔”语义：上一轮会话结束并写回状态后，再按用户配置的间隔创建下一次新会话，而不是固定墙钟时间强行并发触发。

建议第一版 MCP tools：

- `create_protocol_goal`：输入目标、约束、工作区，创建协议任务文档结构。
- `read_protocol_state`：读取协议、用户补充、进度索引和任务队列。
- `append_user_supplement`：追加用户补充，不直接覆盖已有补充。
- `plan_next_step`：根据当前文档返回下一小步建议和需要读取的上下文。
- `mark_step_result`：写入执行结果、进度、阻塞点、下一步。
- `pause_protocol_goal` / `resume_protocol_goal`：切换暂停状态。
- `mark_goal_completed`：由 AI 在满足验收标准时标记完成，并返回完成摘要、复审建议和是否自动暂停。
- `prepare_maintenance_session`：暂停状态下生成“只整理文档、不执行代码”的维护会话 prompt。

主要风险：

- AI 执行权边界：MCP 插件可以指导下一步，但真正执行代码/文件修改和 git 提交的是宿主 AI 会话，需要明确“插件给计划，AI 执行，插件记录结果，Polaris 编排会话”的责任边界。
- 并发与冲突：用户补充、AI 执行、定时触发可能同时写文档，需要文件锁或版本号。
- 权限：该插件至少需要工作区读写、命令执行和 git 提交权限；如果允许网络或跨目录访问，必须进入阶段 7 的权限确认模型。
- 非内置插件运行：当前外部插件可声明 MCP server，但外部 server 的二进制分发、启动路径、权限审计还没有完全收敛，第一版应优先使用本地可审计脚本/二进制。
- 完成误判：完成状态由 AI 判定，必须保留用户复审和“继续执行/重新拆解后续任务”的入口，避免目标被过早关闭。

开放问题：

- 用户补充是纯追加日志，还是需要 AI 合并进主协议后清空补充区？
- 第一版是否需要 UI 面板，还是只提供 MCP tools 和文档目录？
- 目标拆解文档是否继续沿用当前 scheduler 协议模板，还是定义一个新的外部插件 schema？
- 允许自动提交 git 时，提交粒度按“每轮会话一个提交”，还是按 AI 判断的可验证小阶段提交？

## 阅读顺序

1. [已完成内容与当前架构](./1-current-state.md)
2. [后续阶段计划](./2-roadmap.md)
3. [每次执行前的检查清单](./3-execution-playbook.md)
4. [插件 Manifest Schema](./4-manifest-schema.md)
5. [外部 Demo MCP 插件](./5-demo-plugin.md)
6. [长期目标执行 MCP 插件方案](./6-long-goal-executor-plugin.md)

## 下一步建议

优先推进长期目标会话编排：下一步建议开始拆外部 MCP server 打包和 manifest，明确哪些能力保留在宿主、哪些通过 MCP tools 暴露。外部 MCP 插件化仍保留为后续阶段，当前先验证宿主侧状态机、权限和 UX。

建议下一次任务入口：

> 读取 `docs/mcp/INDEX.md`、`docs/mcp/6-long-goal-executor-plugin.md`、`docs/mcp/4-manifest-schema.md` 和现有 `src-tauri/src/services/*_mcp_server.rs`，开始规划长期目标外部 MCP server 打包、manifest 和 tools 边界。
