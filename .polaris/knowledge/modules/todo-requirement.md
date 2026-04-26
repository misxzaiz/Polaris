# 模块：待办与需求管理

> ID: todo-requirement | 复杂度: 中 | 变更频率: 低
> 依赖: unified repositories | 被依赖: MCP, 前端面板, Scheduler

## 概述

统一管理全局和工作区两级待办与需求。双接口架构（IPC + MCP Server）。

## 核心组件

| 组件 | 职责 |
|------|------|
| TodoMcpServer | 7 工具 MCP |
| RequirementMcpServer | 6 工具 MCP |
| SimpleTodoPanel | 待办面板 |
| RequirementPanel | 需求面板 |

## 已知陷阱

1. JSON-RPC 重复
2. 无文件锁
3. 默认作用域不同