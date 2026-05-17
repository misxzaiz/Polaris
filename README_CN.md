# Polaris

> 多引擎 AI 编程助手的跨平台桌面客户端

[![CI](https://github.com/misxzaiz/Polaris/actions/workflows/ci.yml/badge.svg)](https://github.com/misxzaiz/Polaris/actions/workflows/ci.yml)
[![Dependabot](https://img.shields.io/badge/Dependabot-enabled-green)](https://github.com/misxzaiz/Polaris/security/dependabot)

[English](README.md)

## 简介

Polaris 是一款基于 Tauri 2.x 构建的跨平台桌面应用，为多种 AI 编程 CLI 工具提供统一的图形化操作界面。支持 **OpenAI Codex CLI**、**Claude Code CLI** 和 **OpenAI 兼容 API** 三种引擎，让你无需命令行也能享受 AI 辅助编程的体验。

> 注意：本项目是非官方的第三方客户端，与 Anthropic 或 OpenAI 无关。

## 多引擎支持

Polaris 内置三套 AI 引擎适配层，可在设置中自由切换：

| 引擎 | 说明 | CLI 工具 |
|------|------|----------|
| **OpenAI Codex** | OpenAI 官方 CLI，支持 GPT-4o/o3 系列模型 | `codex` |
| **Claude Code** | Anthropic 官方 CLI，支持 Claude 4.x 系列模型 | `claude` |
| **OpenAI Protocol** | 通用 OpenAI 兼容 API，支持本地模型 (Ollama/vLLM) 或第三方服务 | HTTP API |

### 引擎特性对比

| 特性 | OpenAI Codex | Claude Code | OpenAI Protocol |
|------|--------------|-------------|-----------------|
| 流式响应 | ✅ | ✅ | ✅ |
| 多轮对话 | ✅ | ✅ | ✅ |
| 工具调用 | ✅ MCP Tools | ✅ MCP Tools | ✅ Function Calling |
| 图像生成 | ✅ 内置 `image_gen` | ❌ | ✅ DALL-E API |
| 权限模式 | full-auto/bypass | sandbox/auto/bypass | API 控制 |
| 本地模型 | ❌ | ❌ | ✅ Ollama/vLLM |

### 核心功能

- **AI 对话** - 流式响应、多会话管理、会话历史、上下文工作区
- **工作区管理** - 多工作区切换、上下文工作区配置
- **文件浏览** - Git 状态集成、搜索、右键菜单
- **代码编辑** - CodeMirror 6 编辑器、多语言语法高亮、Diff 预览
- **Git 集成** - 状态查看、提交、分支管理、Stash、Rebase、Cherry-pick
- **工具调用可视化** - 实时展示 AI 工具调用过程
- **定时任务** - 创建和管理 AI 自动化任务，支持 Cron 和间隔触发
- **待办管理** - MCP 集成的待办事项系统
- **需求管理** - MCP 集成的需求跟踪系统
- **长期目标** - MCP 集成的长期目标追踪与执行系统
- **机器人集成** - QQ Bot / 飞书平台远程交互支持
- **翻译面板** - 集成翻译功能，支持发送到 AI 对话
- **终端面板** - 内置 xterm.js 终端模拟器
- **问题面板** - LSP 诊断聚合，点击跳转
- **插件系统** - MCP 插件发现与加载
- **国际化** - 支持中文和英文界面

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript 5.8 + Vite 7 |
| 样式 | Tailwind CSS 3.4 |
| 状态管理 | Zustand 5 + Persist |
| 代码编辑 | CodeMirror 6 |
| 图表渲染 | Mermaid + KaTeX |
| 终端 | xterm.js 5 |
| 虚拟滚动 | react-virtuoso 4 |
| 桌面框架 | Tauri 2.x (Rust) |
| 后端服务 | Tokio + MCP Server |
| 测试 | Vitest 4 + fast-check |

## 环境要求

- **Node.js** >= 18
- **Rust** >= 1.70
- **OpenAI Codex CLI**（使用 Codex 引擎时）
- **Claude Code CLI**（使用 Claude 引擎时）

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动开发模式

```bash
pnpm run tauri dev
```

以上命令等同于 `cargo tauri dev`，使用默认配置启动开发服务器。

如需**跳过 MCP 构建**（启动更快，适合前端开发），使用：

```bash
# Linux/Mac
pnpm run tauri:dev

# Windows
pnpm run tauri:dev:win
```

**命令区别：**

| 功能 | `pnpm run tauri dev` | `pnpm run tauri:dev` |
|------|----------------------|----------------------|
| AI 对话 | ✅ 正常 | ✅ 正常 |
| 启动速度 | 慢（需编译 MCP） | 快（跳过 MCP） |
| 待办管理 (Todo) | ✅ 可用 | ❌ 不可用 |
| 需求管理 (Requirements) | ✅ 可用 | ❌ 不可用 |
| 定时任务 (Scheduler) | ✅ 可用 | ❌ 不可用 |
| 长期目标 (Long Goal) | ✅ 可用 | ❌ 不可用 |

> **说明**：MCP（Model Context Protocol）是 Polaris 内置的四个独立服务。它们不影响核心 AI 对话功能，仅禁用相关面板。

### 3. 构建

```bash
# 构建前端
pnpm run build

# 构建 Tauri 应用（包含 MCP 功能）
pnpm run tauri:build      # Linux/Mac
pnpm run tauri:build:win  # Windows
```

### 4. 其他命令

```bash
pnpm run dev          # 仅启动前端开发服务器
pnpm run preview      # 预览生产构建
pnpm run test         # 运行测试
pnpm run lint         # 代码检查
```

## 项目结构

```
src/
├── components/          # React 组件
│   ├── Chat/           # AI 对话相关
│   ├── Editor/         # 代码编辑器
│   ├── FileExplorer/   # 文件浏览器
│   ├── GitPanel/       # Git 操作面板
│   ├── Scheduler/      # 定时任务管理
│   ├── TodoPanel/      # 待办事项面板
│   ├── RequirementPanel/ # 需求管理面板
│   ├── LongGoalPanel/  # 长期目标面板
│   ├── Integration/    # 机器人集成面板
│   ├── Terminal/       # 终端面板
│   ├── Translate/      # 翻译面板
│   ├── Problems/       # LSP 诊断面板
│   ├── Plugins/        # 插件面板
│   ├── Settings/       # 设置页面
│   └── Common/         # 通用组件
├── engines/            # AI 引擎适配层
│   ├── codex/          # OpenAI Codex CLI 引擎
│   ├── claude-code/    # Claude Code CLI 引擎
│   └── openai-protocol/ # OpenAI 兼容 API 引擎
├── stores/             # Zustand 状态管理
├── services/           # Tauri API 封装
├── core/               # 核心逻辑
├── hooks/              # 自定义 Hooks
├── types/              # TypeScript 类型定义
└── utils/              # 工具函数

src-tauri/
├── src/
│   ├── commands/       # Tauri IPC 命令
│   ├── services/       # 后端服务
│   │   ├── git/       # Git 操作封装
│   │   ├── scheduler/ # 定时任务调度
│   │   ├── long_goal_service.rs  # 长期目标服务
│   │   └── mcp_config_service.rs # MCP 配置管理
│   ├── ai/            # AI 引擎集成
│   │   ├── engine/codex.rs   # Codex 引擎
│   │   ├── engine/claude.rs  # Claude 引擎
│   │   └── event_parser.rs   # SSE 解析
│   ├── integrations/  # 外部集成（QQ Bot / 飞书）
│   ├── models/        # 数据模型
│   └── bin/           # 独立 MCP Server 二进制
└── Cargo.toml

```

## MCP 服务

Polaris 内置四个独立的 MCP Server，可供其他 AI 工具使用：

| MCP Server | 说明 | 工具数量 |
|------------|------|----------|
| `polaris-todo-mcp` | 待办事项管理 | 8 |
| `polaris-requirements-mcp` | 需求管理 | 8 |
| `polaris-scheduler-mcp` | 定时任务管理 | 7 |
| `polaris-long-goal-mcp` | 长期目标追踪 | 11 |

## 插件系统

Polaris 支持动态加载 MCP 插件：
- 插件发现：扫描 `plugins/` 目录
- 插件清单：`plugin.json` + MCP Server 定义
- 插件状态：运行时启用/禁用控制

示例插件位于 `examples/plugins/` 目录。

## 社区

[linux.do](https://linux.do/) - 讨论与反馈

## 许可证

MIT
