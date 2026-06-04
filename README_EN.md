# Polaris

> Cross-platform desktop client for multi-engine AI coding assistants

[![CI](https://github.com/misxzaiz/Polaris/actions/workflows/ci.yml/badge.svg)](https://github.com/misxzaiz/Polaris/actions/workflows/ci.yml)
[![Dependabot](https://img.shields.io/badge/Dependabot-enabled-green)](https://github.com/misxzaiz/Polaris/security/dependabot)

[中文文档](README.md)

## Introduction

Polaris is a cross-platform desktop application built with Tauri 2.x, providing a unified graphical interface for multiple AI coding CLI tools. It supports **OpenAI Codex CLI**, **Claude Code CLI**, and **OpenAI-compatible APIs**, enabling AI-assisted programming without the command line.

> Note: This is an unofficial third-party client and is not affiliated with Anthropic or OpenAI.

## Multi-Engine Support

Polaris includes three AI engine adapters, switchable in settings:

| Engine | Description | CLI Tool |
|--------|-------------|----------|
| **OpenAI Codex** | OpenAI official CLI, supports GPT-4o/o3 models | `codex` |
| **Claude Code** | Anthropic official CLI, supports Claude 4.x models | `claude` |
| **OpenAI Protocol** | Generic OpenAI-compatible API, supports local models (Ollama/vLLM) or third-party services | HTTP API |

### Engine Feature Comparison

| Feature | OpenAI Codex | Claude Code | OpenAI Protocol |
|---------|--------------|-------------|-----------------|
| Streaming Response | ✅ | ✅ | ✅ |
| Multi-turn Conversation | ✅ | ✅ | ✅ |
| Tool Calling | ✅ MCP Tools | ✅ MCP Tools | ✅ Function Calling |
| Image Generation | ✅ Built-in `image_gen` | ❌ | ✅ DALL-E API |
| Permission Mode | full-auto/bypass | sandbox/auto/bypass | API Controlled |
| Local Models | ❌ | ❌ | ✅ Ollama/vLLM |

### Core Features

- **AI Chat** - Streaming response, multi-session management, session history, workspace context
- **Workspace Management** - Multi-workspace switching and workspace context config
- **File Explorer** - Git status integration, search, context menu
- **Code Editor** - CodeMirror 6, multi-language syntax highlighting, diff preview
- **Git Integration** - Status view, commit, branch management, stash, rebase, cherry-pick
- **Tool Call Visualization** - Real-time display of AI tool execution
- **Scheduler** - Create and manage AI automation tasks, supports cron and interval triggers
- **Todo Management** - MCP-integrated todo system
- **Requirements Management** - MCP-integrated requirements tracking
- **Bot Integration** - QQ Bot / Feishu platform remote interaction support
- **Translate Panel** - Integrated translation, send to AI chat
- **Terminal Panel** - Built-in xterm.js terminal emulator
- **Problems Panel** - LSP diagnostics aggregation, click to jump
- **Plugin System** - MCP plugin discovery and loading
- **Internationalization** - Chinese and English UI support

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19 + TypeScript 5.8 + Vite 7 |
| Styling | Tailwind CSS 3.4 |
| State Management | Zustand 5 + Persist |
| Code Editor | CodeMirror 6 |
| Diagram Rendering | Mermaid + KaTeX |
| Terminal | xterm.js 5 |
| Virtual Scroll | react-virtuoso 4 |
| Desktop Framework | Tauri 2.x (Rust) |
| Backend Services | Tokio + MCP Server |
| Testing | Vitest 4 + fast-check |

## Requirements

- **Node.js** >= 18
- **Rust** >= 1.70
- **OpenAI Codex CLI** (when using Codex engine)
- **Claude Code CLI** (when using Claude engine)

## Quick Start

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Start Development Mode

```bash
pnpm run tauri dev
```

This is equivalent to `cargo tauri dev`, starting the dev server with default config.

To **skip MCP builds** (faster startup, ideal for frontend dev), use:

```bash
# Linux/Mac
pnpm run tauri:dev

# Windows
pnpm run tauri:dev:win
```

**Command Comparison:**

| Feature | `pnpm run tauri dev` | `pnpm run tauri:dev` |
|---------|----------------------|----------------------|
| AI Chat | ✅ Normal | ✅ Normal |
| Startup Speed | Slow (compile MCP) | Fast (skip MCP) |
| Todo Management | ✅ Available | ❌ Unavailable |
| Requirements Management | ✅ Available | ❌ Unavailable |
| Scheduler | ✅ Available | ❌ Unavailable |

> **Note**: MCP (Model Context Protocol) are three independent services built into Polaris. They don't affect core AI chat functionality, only disable related panels.

### 3. Build

```bash
# Build frontend
pnpm run build

# Build Tauri app (includes MCP features)
pnpm run tauri:build      # Linux/Mac
pnpm run tauri:build:win  # Windows
```

#### Web-Only Build (headless server deployment)

Package Polaris as a standalone web server (no desktop shell / WebKit), accessible via browser — ideal for Linux servers, WSL, or headless environments:

```bash
pnpm run package:web
```

This produces a self-contained `polaris-web/` directory (binary + `dist/` + start/stop scripts). See the **[Packaging & Deployment Guide](docs/deployment/README.md)** for platform-specific details:

- [Windows guide](docs/deployment/web-only-windows.md)
- [Linux / server guide](docs/deployment/web-only-linux.md)

### 4. Other Commands

```bash
pnpm run dev          # Frontend dev server only
pnpm run preview      # Preview production build
pnpm run test         # Run tests
pnpm run lint         # Code linting
```

## Project Structure

```
src/
├── components/          # React components
│   ├── Chat/           # AI chat components
│   ├── Editor/         # Code editor
│   ├── FileExplorer/   # File browser
│   ├── GitPanel/       # Git operations panel
│   ├── Scheduler/      # Scheduler management
│   ├── TodoPanel/      # Todo panel
│   ├── RequirementPanel/ # Requirements panel
│   ├── Integration/    # Bot integration panel
│   ├── Terminal/       # Terminal panel
│   ├── Translate/      # Translate panel
│   ├── Problems/       # LSP diagnostics panel
│   ├── Plugins/        # Plugin panel
│   ├── Settings/       # Settings page
│   └── Common/         # Common components
├── engines/            # AI engine adapters
│   ├── codex/          # OpenAI Codex CLI engine
│   ├── claude-code/    # Claude Code CLI engine
│   └── openai-protocol/ # OpenAI-compatible API engine
├── stores/             # Zustand state management
├── services/           # Tauri API wrappers
├── core/               # Core logic
├── hooks/              # Custom hooks
├── types/              # TypeScript type definitions
└── utils/              # Utility functions

src-tauri/
├── src/
│   ├── commands/       # Tauri IPC commands
│   ├── services/       # Backend services
│   │   ├── git/       # Git operations
│   │   ├── scheduler/ # Task scheduling
│   │   └── mcp_config_service.rs # MCP config management
│   ├── ai/            # AI engine integration
│   │   ├── engine/codex.rs   # Codex engine
│   │   ├── engine/claude.rs  # Claude engine
│   │   └── event_parser.rs   # SSE parsing
│   ├── integrations/  # External integrations (QQ Bot / Feishu)
│   ├── models/        # Data models
│   └── bin/           # Standalone MCP Server binaries
└── Cargo.toml

```

## MCP Services

Polaris includes three independent MCP Servers, usable by other AI tools:

| MCP Server | Description | Tools Count |
|------------|-------------|-------------|
| `polaris-todo-mcp` | Todo management | 8 |
| `polaris-requirements-mcp` | Requirements management | 8 |
| `polaris-scheduler-mcp` | Scheduler management | 7 |

## Plugin System

Polaris supports dynamic MCP plugin loading:
- Plugin discovery: scans `plugins/` directory
- Plugin manifest: `plugin.json` + MCP Server definition
- Plugin state: runtime enable/disable control

Example plugins in `examples/plugins/` directory.

## Community

[linux.do](https://linux.do/) - Discussion & Feedback

## License

MIT
