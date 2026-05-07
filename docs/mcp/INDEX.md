# MCP 插件系统计划索引

更新时间：2026-05-07

用途：后续每次让 AI 继续 MCP 插件系统相关工作时，优先读取本文件。只有需要细节时，再按链接读取对应编号文档，避免每次加载全部上下文。

## 当前结论

MCP 插件系统已经完成第一阶段骨架、阶段 4 后端 registry、阶段 5 前后端 manifest 对齐的第一步，以及阶段 6 插件发现流程的安装反馈入口：前端插件注册表、Todo 插件案例、插件 UI/MCP 开关、状态后端持久化、聊天请求禁用 MCP server 过滤、设置页 MCP runtime 状态展示、后端内置 MCP server 声明式定义表、后端插件 MCP contribution registry、共享 manifest schema 文档、Todo 插件 MCP server 前后端一致性测试、用户/项目插件目录扫描、已安装插件 manifest 清单返回、前端发现插件 metadata 动态注册、设置页区分内置/用户安装/项目插件、设置页手动刷新已安装插件、前端 manifest contribution 校验诊断反馈、刷新时替换非内置插件避免已删除安装残留。

当前还没有完成的是：完整插件安装/卸载 UI 与安装来源管理、插件权限执行边界、插件可视化模块的动态加载与隔离策略。阶段 5 仍可继续扩展为自动 JSON schema 校验；阶段 6 仍可继续扩展为 manifest schema 校验命令、安装目录选择/打开入口和安装/卸载 UX，但已具备本地目录发现、前端 metadata 注册、刷新与诊断反馈闭环。

## 阅读顺序

1. [已完成内容与当前架构](./1-current-state.md)
2. [后续阶段计划](./2-roadmap.md)
3. [每次执行前的检查清单](./3-execution-playbook.md)
4. [插件 Manifest Schema](./4-manifest-schema.md)

## 下一步建议

优先继续补齐“插件安装与发现流程”的用户操作面：在已有目录扫描、已安装插件清单返回、设置页刷新和 manifest contribution 诊断基础上，增加安装目录管理、打开安装目录入口和安装/卸载 UX。

建议下一次任务入口：

> 读取 `docs/mcp/INDEX.md`、`docs/mcp/2-roadmap.md` 和 `docs/mcp/4-manifest-schema.md`，继续阶段 6：插件安装与发现流程的安装目录管理、打开目录入口与安装/卸载 UX。
