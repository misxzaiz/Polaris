# 模块：MCP 服务管理

> ID: mcp | 复杂度: 中 | 变更频率: 中
> 依赖: ipc-bridge, config-settings | 被依赖: Claude Code 会话

## 概述

两层 MCP 管理：配置生成层解析内置 MCP 二进制路径；运行时管理层通过 CLI 桥接健康检查。

## 核心组件

| 组件 | 职责 |
|------|------|
| WorkspaceMcpConfigService | 配置生成 |
| McpManagerService | 运行时管理 |
| McpStore | 前端状态 |

## 已知陷阱

1. 配置生成 ≠ 配置读取
2. CLI 输出格式脆弱
3. 可选二进制静默跳过