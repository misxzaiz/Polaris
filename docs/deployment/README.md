# 打包与部署指南

本目录汇总 Polaris 所有打包与部署相关文档。Polaris 支持两种分发形态，可按使用场景选择。

## 两种分发形态

| 形态 | 命令 | 产物 | 适用场景 |
|---|---|---|---|
| **桌面应用** | `pnpm run tauri:build` | 平台安装包（`.msi` / `.dmg` / `.AppImage` / `.deb`） | 个人桌面使用，功能最完整 |
| **Web 独立服务** | `pnpm run package:web` | 自包含的 `polaris-web/` 目录 | 服务器 / 无 GUI 环境，浏览器访问 |

---

## Web 独立服务打包（服务器部署推荐）

将 Polaris 编译为不依赖桌面环境（无需 WebKit / webkit2gtk）的独立 Web 服务器，通过浏览器访问，适用于 Linux 服务器、WSL、Docker 等无图形界面场景。

### 一键打包

```bash
pnpm install
pnpm run package:web
```

该命令自动完成三步：

1. `vite build` — 构建前端到 `dist/`
2. `cargo build --bin polaris-web --release --no-default-features` — 编译独立 Web 服务器（不含 Tauri / WebKit 依赖）
3. 将二进制 + `dist/` + 启动/停止脚本汇集到项目根的 `polaris-web/` 目录

> Windows 上也可直接双击 `scripts\package-web.bat` 触发同样的流程。

### 命令速查

| 命令 | 作用 |
|---|---|
| `pnpm run package:web` | **完整打包**：编译前后端 + 汇集产物到 `polaris-web/` |
| `pnpm run build:web` | 仅编译（`vite build` + `cargo build --release --no-default-features`），不汇集脚本 |
| `node scripts/package-web.mjs --no-build` | 跳过编译，仅用现有产物重新汇集 `polaris-web/` |
| 双击 `scripts\package-web.bat`（Windows） | 等价于 `pnpm run package:web` |

### 产物结构

打包脚本会按**当前平台**生成对应的二进制与脚本：

```
# Windows                                  # Linux / macOS
polaris-web/                               polaris-web/
├── polaris-web.exe         (~15 MB)       ├── polaris-web                (~18 MB)
├── polaris-todo-mcp.exe    (~2 MB)        ├── polaris-todo-mcp           (~2 MB)
├── polaris-requirements-mcp.exe (~2 MB)   ├── polaris-requirements-mcp   (~2 MB)
├── polaris-scheduler-mcp.exe   (~2 MB)    ├── polaris-scheduler-mcp      (~2 MB)
├── polaris-long-goal-mcp.exe   (~2 MB)    ├── polaris-long-goal-mcp      (~2 MB)
├── dist/                                  ├── dist/
├── start.bat                              ├── start.sh
└── stop.bat                               └── stop.sh
```

> **关键**：二进制与 `dist/` 必须位于同一目录（服务端按 exe 相对路径查找 `dist/`，否则页面返回 404）。整个 `polaris-web/` 文件夹可作为一个整体拷贝、移动或打包分发。
>
> **MCP 二进制全部可选**：`polaris-*-mcp` 缺失时对应的 MCP 工具不可用，但 AI 对话正常运行。后续补充二进制到同目录并重启即可恢复。

### 启动 / 停止速查

| 平台 | 启动 | 停止 |
|---|---|---|
| Windows | 双击 `start.bat`，或 `.\polaris-web.exe` | `Ctrl+C` / 关闭窗口 / `stop.bat` |
| Linux · macOS | `./start.sh`，或 `./polaris-web` | `Ctrl+C` / `./stop.sh` |

- 默认监听 `0.0.0.0:9830`，浏览器访问 `http://localhost:9830`
- 自定义端口：`--port 8080`；自定义地址：`--host 127.0.0.1`
- 配置优先级：**CLI 参数 > 环境变量 `POLARIS_WEB_PORT` > 配置文件**
- 配置文件路径：Windows `%APPDATA%\claude-code-pro\config.json`；Linux/macOS `~/.config/claude-code-pro/config.json`

### 平台详细文档

| 平台 | 文档 | 额外内容 |
|---|---|---|
| Windows | [web-only-windows.md](./web-only-windows.md) | 双击启动、按端口精准停止、EPERM 排查 |
| Linux / 服务器 | [web-only-linux.md](./web-only-linux.md) | systemd 服务、Nginx 反向代理、tar.gz 分发 |

### ⚠️ 跨平台核心注意事项

编译产物是**目标平台 + CPU 架构专用**的原生二进制，不能跨平台/跨架构直接复制：

- Windows 的 `polaris-web.exe`（PE 格式）拿到 Linux/macOS 运行会报 `Exec format error`，反之亦然
- x86_64 上编译的二进制不能在 ARM（如 Apple Silicon、ARM 服务器）上运行
- `dist/`（前端静态资源）是平台无关的，可通用
- **要在某平台部署，必须把源码放到该平台（或对应架构）上重新运行 `pnpm run package:web`**。打包脚本本身是跨平台的，会自动生成匹配当前平台的二进制与 `start`/`stop` 脚本
- **Linux glibc 版本**：二进制动态链接 glibc，构建机的 glibc 版本**不能比目标机更新**，否则目标机启动时报 `GLIBC_x.xx not found`。若目标是较老发行版（CentOS 7、Ubuntu 18.04 等），请在该系统或同等/更旧环境上编译

> Windows 无法交叉编译 Linux 版（项目依赖 `git2` 等 C 库，交叉编译成本极高）。Windows 用户可借助 **WSL** 获得真实 Linux 环境进行编译，详见 [web-only-linux.md](./web-only-linux.md)。

### Web 模式功能限制

以下功能依赖桌面环境，在纯 Web 模式下不可用：

| 功能 | 原因 |
|---|---|
| 自动更新 | 依赖 Tauri updater 插件 |
| 系统托盘 | 依赖桌面环境 |
| 窗口管理（置顶 / 最小化） | 无桌面窗口 |
| 本地插件安装 | 需要文件系统访问 |
| F12 开发者工具 | WebKit DevTools，仅桌面模式 |

---

## 桌面应用打包

标准 Tauri 构建流程，产出带安装包的桌面应用（包含全部 MCP 功能：Todo / Requirements / Scheduler / Long Goal）：

```bash
pnpm run tauri:build        # 当前平台
pnpm run tauri:build:win    # Windows 专用配置
```

安装包产物位于 `src-tauri/target/release/bundle/`。

> 前置要求：Node.js >= 18 + pnpm、Rust >= 1.78（Windows 需 MSVC 工具链）。详见各平台 Tauri 官方[环境配置](https://tauri.app/start/prerequisites/)。

---

## 文档导航

- [Windows Web 打包与部署指南](./web-only-windows.md)
- [Linux Web 打包与部署指南](./web-only-linux.md)
