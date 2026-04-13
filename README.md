# Polaris

> Claude Code CLI 的桌面图形化客户端

[![CI](https://github.com/misxzaiz/Polaris/actions/workflows/ci.yml/badge.svg)](https://github.com/misxzaiz/Polaris/actions/workflows/ci.yml)
[![Dependabot](https://img.shields.io/badge/Dependabot-enabled-green)](https://github.com/misxzaiz/Polaris/security/dependabot)

## 简介

Polaris 是一款基于 Tauri 2.x 构建的跨平台桌面应用，为 [Claude Code CLI](https://claude.ai/code) 提供图形化操作界面，让你无需命令行也能享受 AI 辅助编程的体验。

> 注意：本项目是非官方的第三方客户端，与 Anthropic 无关。

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
- **翻译面板** - 集成翻译功能，支持发送到 AI 对话
- **终端面板** - 内置终端模拟器
- **QQ Bot 集成** - 可选的 QQ Bot 远程交互支持
- **国际化** - 支持中文和英文界面

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Vite |
| 样式 | Tailwind CSS |
| 状态管理 | Zustand + Persist |
| 代码编辑 | CodeMirror 6 |
| 图表渲染 | Mermaid |
| 终端 | xterm.js |
| 桌面框架 | Tauri 2.x (Rust) |
| 后端服务 | Tokio + MCP Server |

## 环境要求

- **Node.js** >= 18
- **Rust** >= 1.70
- **Claude Code CLI**（使用 Claude 引擎时需要）

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

> **说明**：MCP（Model Context Protocol）是 Polaris 内置的三个独立服务（待办、需求、定时任务）。它们不影响核心 AI 对话功能，仅禁用相关面板。

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
│   ├── Terminal/       # 终端面板
│   ├── Translate/      # 翻译面板
│   ├── Settings/       # 设置页面
│   └── Common/         # 通用组件
├── stores/             # Zustand 状态管理
├── services/           # Tauri API 封装
├── engines/            # AI 引擎适配层
├── core/               # 核心逻辑（Agent、工具引导）
├── hooks/              # 自定义 Hooks
├── types/              # TypeScript 类型定义
└── utils/              # 工具函数

src-tauri/
├── src/
│   ├── commands/       # Tauri 命令
│   ├── services/       # 后端服务
│   │   ├── git/       # Git 操作封装
│   │   └── scheduler/ # 定时任务调度
│   ├── ai/            # AI 引擎集成
│   ├── integrations/  # 外部集成（QQ Bot）
│   ├── models/        # 数据模型
│   └── bin/           # 独立 MCP Server
└── Cargo.toml
```

## MCP 服务

Polaris 内置三个独立的 MCP Server，可供其他 AI 工具使用：

- `polaris-todo-mcp` - 待办事项管理
- `polaris-requirements-mcp` - 需求管理
- `polaris-scheduler-mcp` - 定时任务管理

## 社区

[linux.do](https://linux.do/) - 讨论与反馈

## 许可证

MIT
