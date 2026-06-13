# Polaris

> 多引擎 AI 编程助手的跨平台桌面客户端

## 简介

Polaris 是一款基于 Tauri 2.x 构建的跨平台桌面应用，为多种 AI 编程 CLI 工具提供统一的图形化操作界面。支持 **OpenAI Codex CLI**、**Claude Code CLI** 引擎，让你无需命令行也能享受 AI 辅助编程的体验。

## 支持的引擎

Polaris 目前内置了 **4 个 AI 引擎**，你可以像换手机壳一样在它们之间自由切换：

| 引擎 | 来源 | 类型 | 一句话介绍 |
|------|------|------|------------|
| **Claude Code** | [Anthropics](https://github.com/anthropics/claude-code) | CLI 引擎 | 本项目的"亲爹"，Polaris 最初就是为给它做 GUI 才诞生的。没有它，就没有 Polaris。 |
| **OpenAI Codex** | [OpenAI](https://github.com/openai/codex) | CLI 引擎 | 红队对手，也是好同事。Polaris 的 Codex 引擎从架构到事件解析都参考了 Codex 的实现，属于"知己知彼"型集成。 |
| **Mimo Code** | [小米](https://mimo.mi.com/) | CLI 引擎 | 小米的 AI 编程助手，Polaris 第三位引擎成员。跟 Codex 引擎结构对称，属于"师出同门"。 |
| **Agnes AI** | [Agnes](https://agnes-ai.com/) | HTTP API 引擎 | 多模态选手，支持文生图、图编辑、视频生成，还有个正经的漫画流水线（Comic Pipeline）。它不是 CLI 工具，但 Polaris 照样给它安排了座位。 |

> 除了上面这些，Polaris 还通过 OpenAI Chat Completions 协议间接支持了 DeepSeek、GLM（智谱）、SiliconFlow 等各类兼容 API 的模型——它们不需要装 CLI，填个 API Key 就行。

## 项目参考

Polaris 站在巨人的肩膀上，以下项目对其设计或实现产生了直接影响：

- **[Claude Code](https://github.com/anthropics/claude-code)** — 事件解析、SSE 流式、工具执行协议的设计源头。Polaris 的 Rust 后端几乎是在翻译 Claude Code 的内部行为。
- **[OpenAI Codex](https://github.com/openai/codex)** — Codex 引擎的参考实现，SimpleAI 层的 `apply_patch` 语法等细节均参照 Codex 代码。
- **[iFlow](https://cli.iflow.cn/)** — CLI 引擎统一层的灵感来源之一，验证了"一个 CLI 适配层通吃多模型"的可行性。
- **[cc-switch](https://github.com/farion1231/cc-switch)** — Claude Code 切换器，启发了 Polaris 多引擎管理的思路：既然能切换模型，为什么不能切换引擎？
- **[CodeG](https://github.com/xintaofei/codeg)** — 本地 AI 编程 CLI 工具，验证了轻量级 CLI 引擎的实用价值。
- **[智谱 GLM](https://open.bigmodel.cn/)** — 国内模型生态的重要参与者，通过 OpenAI 兼容协议被 Polaris 间接支持。
- **[DeepSeek](https://platform.deepseek.com/)** — 同智谱一样，通过 OpenAI 兼容协议接入 Polaris。
- **[OpenAI Chat / API](https://chatgpt.com/)** — OpenAI Chat Completions 协议是 Polaris 代理层（Proxy）的翻译目标，让非 OpenAI 模型也能在 Polaris 里跑。
- **[Ruoli](https://ruoli.dev/)** — 国内 AI 模型服务，在模型配置测试中作为参考用例。

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
- **Claude Code CLI**（使用 Claude 引擎时）
- **OpenAI Codex CLI**（使用 Codex 引擎时）
- **Mimo Code CLI**（使用 Mimo 引擎时）

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
- [iFlow](https://cli.iflow.cn/?)
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
