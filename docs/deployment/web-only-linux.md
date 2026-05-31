# Linux Web 打包与部署指南

Polaris 支持打包为「纯 Web 独立服务」，脱离桌面壳（不依赖 webkit2gtk），通过浏览器访问。本文讲解在 **Linux 服务器 / WSL** 上一键打包成自包含的 `polaris-web/` 目录，以及启动、停止、分发与运维。

> Windows 打包请参见 [web-only-windows.md](./web-only-windows.md)；整体概览见 [打包与部署总览](./README.md)。

## 前置要求（仅打包机器需要）

- Node.js >= 18 + pnpm
- Rust >= 1.78（Cargo.lock v4 需要）
- 编译 `git2` / `openssl` 所需系统库：`pkg-config` + `libssl-dev`（Debian/Ubuntu）或 `openssl-devel`（RHEL 系）
- Claude Code CLI（如需使用 Claude 引擎）

> 以上仅在**打包时**需要；打包出的 `polaris-web/` 目录可在没有这些环境的**同架构** Linux 机器上直接运行。
>
> **Windows 用户**：`.exe` 无法在 Linux 运行，且 Windows 交叉编译 Linux 版成本极高（依赖 `git2` 等 C 库）。推荐用 **WSL（Ubuntu）** 获得真实 Linux 环境：将源码放到 WSL 原生文件系统（如 `~/polaris-build`，**避免**在 `/mnt/` 挂载点上跨文件系统编译，否则极慢且易污染）后运行 `pnpm run package:web` 即可。

## 一键打包

```bash
pnpm install
pnpm run package:web
```

该命令自动完成：

1. `vite build` — 构建前端到 `dist/`
2. `cargo build --release --no-default-features` — 编译独立 Web 服务器 + 4 个 MCP server 二进制（不含 Tauri/WebKit）
3. 将二进制 + MCP server 二进制 + `dist/` + `start.sh` / `stop.sh` 汇集到项目根的 `polaris-web/` 目录

### 仅重新打包（跳过编译）

若已编译过，只想重新生成 `polaris-web/` 目录：

```bash
node scripts/package-web.mjs --no-build
```

## 产物目录结构

```
polaris-web/
├── polaris-web                  # 独立 Web 服务器（ELF 二进制，约 18 MB）
├── polaris-todo-mcp             # Todo MCP Server（约 2 MB，可选）
├── polaris-requirements-mcp     # 需求 MCP Server（约 2 MB，可选）
├── polaris-scheduler-mcp        # 调度器 MCP Server（约 2 MB，可选）
├── polaris-long-goal-mcp        # 长期目标 MCP Server（约 2 MB，可选）
├── dist/                        # 前端静态资源
│   ├── index.html
│   └── assets/
├── start.sh                     # 启动脚本
└── stop.sh                      # 停止脚本
```

> **关键**：`polaris-web` 与 `dist/` 必须在同一目录下（服务端按可执行文件相对路径查找 `dist/`），否则页面返回 404。整个 `polaris-web/` 目录可作为一个整体拷贝或打包分发。
>
> **MCP 二进制全部为可选**：4 个 MCP server 二进制（`polaris-*-mcp`）缺失时不会阻断 AI 对话，仅对应的 MCP 工具不可用。后续补充编译并将二进制放到 `polaris-web/` 同目录即可自动恢复。详见下方「MCP 二进制说明」。

## 启动服务

```bash
cd polaris-web
./start.sh                # 默认监听 0.0.0.0:9830
```

| 方式 | 命令 | 说明 |
|---|---|---|
| 启动脚本 | `./start.sh` | 前台运行，默认 `0.0.0.0:9830` |
| 直接运行 | `./polaris-web` | 同上 |
| 自定义端口 | `./polaris-web --port 8080` | |
| 自定义地址 + 端口 | `./polaris-web --host 127.0.0.1 --port 3000` | |
| 环境变量 | `POLARIS_WEB_PORT=8080 ./polaris-web` | |
| 后台运行 | `nohup ./polaris-web --port 9830 > polaris-web.log 2>&1 &` | 输出重定向到日志文件 |

启动后用浏览器访问 `http://<服务器IP>:9830`（或你指定的端口）。

## 停止服务

| 场景 | 停止方式 | 是否优雅 |
|---|---|---|
| 前台运行 | 在终端按 `Ctrl+C` | ✅ 优雅关停（触发服务的优雅 shutdown） |
| 后台运行 / 另一个终端 | 运行 `./stop.sh` | 按进程名终止（够用） |
| 只想停某个端口的实例 | 见下方「按端口精准停止」 | 精准 |

> `stop.sh` 的本质是 `pkill -x polaris-web`，会终止**所有** `polaris-web` 实例。若同时运行了多个（不同端口），它会一并停掉。

### 按端口精准停止

```bash
# 通过端口找到 PID 并终止
kill $(lsof -t -i:8080)
# 或（无 lsof 时）
kill $(ss -tlnp 2>/dev/null | grep ':8080' | grep -oP 'pid=\K[0-9]+' | head -1)
```

## 打包为 tar.gz 分发

整个 `polaris-web/` 可压缩后传输到目标服务器（`tar` 默认保留可执行权限）：

```bash
# 在项目根（polaris-web/ 所在目录）打包
tar czf polaris-web-linux.tar.gz polaris-web/

# 传输到目标服务器并解压运行
scp polaris-web-linux.tar.gz user@server:~/
ssh user@server
tar xzf polaris-web-linux.tar.gz
cd polaris-web
./start.sh
```

> 目标服务器需与构建机**同 CPU 架构**（x86_64）且 **glibc 版本不低于构建机**，详见下方注意事项。

## 配置优先级

端口/地址配置优先级：**CLI 参数 > 环境变量 `POLARIS_WEB_PORT` > 配置文件**

- 配置文件路径：`~/.config/claude-code-pro/config.json`
- 默认值：host = `0.0.0.0`，port = `9830`

## MCP 二进制说明

Polaris 内置 4 个 MCP server，为 AI 对话提供 Todo、需求管理、定时任务、长期目标等工具能力：

| 二进制 | 功能 | 是否必须 |
|--------|------|----------|
| `polaris-todo-mcp` | Todo 管理工具 | 可选 |
| `polaris-requirements-mcp` | 需求管理工具 | 可选 |
| `polaris-scheduler-mcp` | 定时任务工具 | 可选 |
| `polaris-long-goal-mcp` | 长期目标工具 | 可选 |

**全部为可选**——缺失时对应的 MCP 工具不可用，但 AI 对话完全正常。服务启动时会以 `tracing::warn` 记录跳过的 server 名称。

### 补充 MCP 二进制

如果初始部署时未包含 MCP 二进制，后续可手动补充：

```bash
# 在打包机器上单独编译 MCP 二进制
cd src-tauri
cargo build --release --no-default-features --bin polaris-todo-mcp --bin polaris-requirements-mcp --bin polaris-scheduler-mcp --bin polaris-long-goal-mcp

# 将二进制复制到部署目录（与 polaris-web 同级）
cp target/release/polaris-*-mcp /path/to/deployed/polaris-web/

# 重启服务生效
```

### 环境变量覆盖

每个 MCP server 可通过环境变量指定自定义路径：

| 环境变量 | 说明 |
|----------|------|
| `POLARIS_TODO_MCP_PATH` | polaris-todo-mcp 自定义路径 |
| `POLARIS_REQUIREMENTS_MCP_PATH` | polaris-requirements-mcp 自定义路径 |
| `POLARIS_SCHEDULER_MCP_PATH` | polaris-scheduler-mcp 自定义路径 |
| `POLARIS_LONG_GOAL_MCP_PATH` | polaris-long-goal-mcp 自定义路径 |

---

## ⚠️ 跨平台 / 跨架构注意事项

- **平台专用**：Linux 编出的 ELF 二进制不能在 Windows / macOS 运行（反之亦然），错配时报 `Exec format error`
- **架构专用**：x86_64 编的二进制不能在 ARM（ARM 服务器、Apple Silicon）上运行，需在对应架构上重新编译
- **glibc 版本**：二进制动态链接 glibc，**构建机的 glibc 不能比目标机更新**，否则目标机启动报 `GLIBC_x.xx not found`。查看版本：`ldd --version`。若目标是 CentOS 7（glibc 2.17）、Ubuntu 18.04（2.27）等较老系统，请在该系统或同等/更旧环境上编译
- `dist/`（前端静态资源）平台无关，可通用

## Systemd 服务（可选）

创建 `/etc/systemd/system/polaris-web.service`：

```ini
[Unit]
Description=Polaris Web Server
After=network.target

[Service]
Type=simple
User=polaris
WorkingDirectory=/opt/polaris
ExecStart=/opt/polaris/polaris-web --port 9830
Restart=on-failure
RestartSec=5
Environment=POLARIS_WEB_PORT=9830

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable polaris-web
sudo systemctl start polaris-web
sudo systemctl status polaris-web
```

> 使用 systemd 时由其管理进程生命周期，停止请用 `sudo systemctl stop polaris-web`，无需 `stop.sh`。

## Nginx 反向代理（可选）

```nginx
server {
    listen 80;
    server_name polaris.example.com;

    location / {
        proxy_pass http://127.0.0.1:9830;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

## 故障排查

**启动报 `Exec format error`**

- 二进制与当前系统的平台/架构不匹配（如把 x86_64 二进制拿到 ARM，或把 Windows `.exe` 改名运行）。需在目标平台 / 架构上重新编译。

**启动报 `GLIBC_x.xx not found`**

- 构建机的 glibc 比目标机新。请在目标系统或更旧环境上重新编译，或升级目标系统 glibc。

**指定的端口没生效 / 实际监听端口与预期不符**

- 端口被占用时服务**不会报错退出**，而是自动尝试 `端口 + 1` 直到找到空闲端口，仅打印一条 warning。请查看启动日志确认实际端口。固定端口前先确认空闲：

```bash
ss -tlnp | grep 9830
# 或
lsof -i :9830
```

**Web UI 返回 404**

- 确认 `dist/` 目录与 `polaris-web` 在同一目录下
- 确认 `dist/index.html` 存在

**权限问题**

```bash
chmod +x polaris-web
```

**AI 对话报 `无法定位 polaris-todo-mcp`**

- 此错误仅出现在旧版本中。当前版本所有 MCP 二进制均为可选，缺失时会优雅降级（跳过 MCP 工具，AI 对话正常）。如果仍然遇到此错误，请确认是否为最新版本。
- 若需 MCP 工具能力，将编译好的 `polaris-*-mcp` 二进制放到 `polaris-web/` 同目录后重启服务即可。

## Web 模式功能限制

以下功能在纯 Web 模式下不可用（与 Windows 版一致）：

| 功能 | 原因 |
|------|------|
| 自动更新 | 依赖 Tauri updater 插件 |
| 系统托盘 | 依赖桌面环境 |
| 窗口管理（置顶/最小化） | 无桌面窗口 |
| 本地插件安装 | 需要文件系统访问 |
| 文件资源管理器右键"在资源管理器打开" | 依赖系统文件管理器 |
| F12 开发者工具 | WebKit DevTools，仅桌面模式 |
