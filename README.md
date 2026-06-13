# Polaris

> 多引擎 AI 编程助手的跨平台桌面客户端

## 简介

Polaris 是一款基于 Tauri 2.x 构建的跨平台桌面应用，为多种 AI 编程 CLI 工具提供统一的图形化操作界面。支持 **OpenAI Codex CLI**、**Claude Code CLI** 引擎，让你无需命令行也能享受 AI 辅助编程的体验。

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
pnpm run tauri:dev
```

### 3. 构建

```bash
# 构建前端
pnpm run build

# 构建 Tauri 应用（包含 MCP 功能）
pnpm run tauri:build      # Linux/Mac
pnpm run tauri:build:win  # Windows
```

#### Web 独立服务打包（无 GUI 服务器部署）

将 Polaris 打包为独立 Web 服务（脱离桌面壳、无需 WebKit），通过浏览器访问，适用于 Linux 服务器、WSL 等无图形界面环境：

```bash
pnpm run package:web
```

该命令产出自包含的 `polaris-web/` 目录（二进制 + `dist/` + 启动/停止脚本）。详见 **[打包与部署指南](docs/deployment/README.md)**：

- [Windows 指南](docs/deployment/web-only-windows.md)
- [Linux / 服务器指南](docs/deployment/web-only-linux.md)

## 社区

[linux.do](https://linux.do/) - 讨论与反馈

## 致谢

本项目在开发和灵感阶段参考或使用了以下服务与工具，特此感谢：

- [Claude Code](https://github.com/anthropics/claude-code)
- [Codex (OpenAI)](https://github.com/openai/codex)
- [iFlow(白月光)](https://cli.iflow.cn/?)
- [cc-switch](https://github.com/farion1231/cc-switch)
- [CodeG](https://github.com/xintaofei/codeg)
- [GLM (智谱)](https://open.bigmodel.cn/)
- [OpenAI](https://chatgpt.com/)
- [DeepSeek](https://platform.deepseek.com/)
- [MiMo](https://mimo.mi.com/)
- [Ruoli](https://ruoli.dev/)
- [Agnes](https://agnes-ai.com/)

如有遗漏或需要补充其他工具，欢迎联系我们加上。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=misxzaiz%2Fpolaris&type=Date)](https://api.star-history.com/svg?repos=misxzaiz%2Fpolaris&type=Date)

## 许可证

MIT
