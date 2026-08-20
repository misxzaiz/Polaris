# Windows Web 打包与部署指南

Polaris 支持打包为「纯 Web 独立服务」，脱离桌面壳（不依赖 WebKit），通过浏览器访问。本文讲解如何在 **Windows** 上一键打包成自包含的 `polaris-web/` 目录，以及如何启动 / 停止服务。

> Linux / 服务器部署请参见 [web-only-linux.md](./web-only-linux.md)。

## 前置要求（仅打包机器需要）

- Node.js >= 18 + pnpm
- Rust >= 1.70（含 MSVC 工具链）
- Claude Code CLI（如需使用 Claude 引擎）

> 以上仅在**打包时**需要。打包出的 `polaris-web/` 目录可在没有这些环境的 Windows 机器上直接运行。

## 一键打包

```powershell
pnpm install
pnpm run package:web
```

该命令会自动完成：

1. `vite build` — 构建前端到 `dist/`
2. `cargo build --bin polaris-web --release --no-default-features` — 编译独立 Web 服务器（不含 Tauri/WebKit 依赖）
3. 将二进制 + `dist/` + 启动/停止脚本汇集到项目根的 `polaris-web/` 目录

> 也可直接双击 `scripts\package-web.bat` 触发同样的打包流程。

### 仅重新打包（跳过编译）

若已经编译过，只想重新生成 `polaris-web/` 目录：

```powershell
node scripts/package-web.mjs --no-build
```

## 产物目录结构

```
polaris-web/
├── polaris-web.exe     # 独立 Web 服务器（约 15 MB）
├── dist/               # 前端静态资源
│   ├── index.html
│   └── assets/
├── start.bat           # 启动脚本
└── stop.bat            # 停止脚本
```

> **关键**：`polaris-web.exe` 与 `dist/` 必须在同一目录下，服务端按 exe 相对路径查找 `dist/`，否则页面会返回 404。整个 `polaris-web/` 文件夹可作为一个整体拷贝或移动到别处。

## 启动服务

| 方式 | 命令 | 说明 |
|---|---|---|
| 双击 | 双击 `polaris-web\start.bat` | 最简单，弹出控制台窗口 |
| 命令行 | `cd polaris-web` 后 `.\polaris-web.exe` | 默认监听 `0.0.0.0:9830` |
| 自定义端口 | `.\polaris-web.exe --port 8080` | 或 `start.bat --port 8080` |
| 自定义地址 + 端口 | `.\polaris-web.exe --host 127.0.0.1 --port 3000` | |
| 环境变量 | `$env:POLARIS_WEB_PORT=8080; .\polaris-web.exe` | PowerShell |

启动后用浏览器访问 `http://localhost:9830`（或你指定的端口）。局域网其他设备可访问 `http://<本机IP>:9830`。

## 停止服务

按场景选择，**优先使用优雅方式**：

| 场景 | 停止方式 | 是否优雅 |
|---|---|---|
| `start.bat` / 命令行前台运行 | 在窗口内按 `Ctrl+C`，或直接**关闭窗口** | ✅ 优雅关停（触发服务的优雅 shutdown） |
| 后台运行 / 找不到窗口 | 双击 `polaris-web\stop.bat` | 强制终止（够用） |
| 只想停某个端口的实例 | 见下方「按端口精准停止」 | 强制终止 |

> `stop.bat` 的本质是 `taskkill /F /IM polaris-web.exe`，会终止**所有** `polaris-web.exe` 实例。若你同时运行了多个（不同端口），它会一并停掉。

### 按端口精准停止（进阶）

只停止占用某端口（如 8080）的那个实例：

```powershell
# PowerShell
$p = (Get-NetTCPConnection -LocalPort 8080 -State Listen).OwningProcess
Stop-Process -Id $p -Force
```

```cmd
:: CMD：先查 PID，再结束
netstat -ano | findstr :8080
taskkill /F /PID <上一步查到的 PID>
```

## 配置优先级

端口/地址配置优先级：**CLI 参数 > 环境变量 `POLARIS_WEB_PORT` > 配置文件**

- 配置文件路径：`%APPDATA%\claude-code-pro\config.json`
- 默认值：host = `0.0.0.0`，port = `9830`

## 跨平台注意事项

⚠️ **`polaris-web.exe` 是 Windows 专用二进制，不能拷到 Linux/macOS 运行**（反之亦然）。

- `dist/`（前端）是平台无关的，可以通用
- 二进制必须在目标平台重新编译

要在 Linux 上部署，请把**源码**放到 Linux/WSL，在那里运行 `pnpm run package:web`（打包脚本本身跨平台，会自动生成 `start.sh` / `stop.sh`）。详见 [web-only-linux.md](./web-only-linux.md)。

## 故障排查

**指定的端口没生效 / 实际监听端口与预期不符**

服务在指定端口被占用时**不会报错退出**，而是自动尝试 `端口 + 1` 直到找到空闲端口，仅打印一条 warning。请查看启动窗口日志确认实际监听端口，例如日志会显示：

```
[Web] Port 9830 is in use, trying 9831
[Web] Server listening on 0.0.0.0:9831
```

若需要固定端口（如配了反向代理），启动前请先确认端口空闲：

```powershell
netstat -ano | findstr :9830
```

**Web UI 返回 404**

- 确认 `dist\` 目录与 `polaris-web.exe` 在同一目录下
- 确认 `dist\index.html` 存在

**重新打包时报 `EPERM` / `Device or resource busy`**

说明 `polaris-web\` 目录正被占用，常见原因：

- 服务进程仍在运行 → 先运行 `stop.bat`，或 `taskkill /F /IM polaris-web.exe`
- 有终端窗口或资源管理器停留在该目录 → 关闭它们
- 打包脚本已做健壮处理：会**清空目录内容**而非删除目录本身，因此多数情况下可正常覆盖

## Web 模式功能限制

以下功能在纯 Web 模式下不可用（与 Linux 版一致）：

| 功能 | 原因 |
|---|---|
| 自动更新 | 依赖 Tauri updater 插件 |
| 系统托盘 | 依赖桌面环境 |
| 窗口管理（置顶/最小化） | 无桌面窗口 |
| 本地插件安装 | 需要文件系统访问 |
| F12 开发者工具 | WebKit DevTools，仅桌面模式 |
