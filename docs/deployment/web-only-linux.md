# Linux Web-Only 部署指南

Polaris 支持以纯 Web 模式运行，不依赖桌面环境（无需 webkit2gtk），适用于 Linux 服务器、WSL 等无 GUI 场景。

## 前置要求

- Node.js >= 18 + pnpm
- Rust >= 1.70
- Claude Code CLI（如需使用 Claude 引擎）

## 构建

### 方式一：一键构建

```bash
pnpm install
pnpm run build:web
```

该命令会：
1. `vite build` — 构建前端到 `dist/`
2. `cargo build --bin polaris-web --release --no-default-features` — 构建独立 Web 服务器（不依赖 Tauri/WebKit）

### 方式二：分步构建

```bash
# 1. 构建前端
pnpm install
pnpm run build

# 2. 构建后端（跳过 Tauri 依赖）
cd src-tauri
cargo build --bin polaris-web --release --no-default-features
cd ..
```

## 部署目录结构

将以下文件复制到目标服务器：

```
polaris-deploy/
├── polaris-web          # 二进制文件 (from src-tauri/target/release/)
└── dist/                # 前端静态文件 (from 项目根目录/dist/)
    ├── index.html
    └── assets/
        ├── main-*.js
        ├── main-*.css
        └── ...
```

**关键**：`polaris-web` 和 `dist/` 必须在同一目录下，服务端会自动查找 `./dist/` 或 `../dist/`。

### 打包命令示例

```bash
# 创建部署包
mkdir -p polaris-deploy
cp src-tauri/target/release/polaris-web polaris-deploy/
cp -r dist polaris-deploy/

# 打包为 tar.gz（用于传输到 Linux 服务器）
tar czf polaris-web-linux.tar.gz polaris-deploy/
```

## 运行

```bash
# 默认配置：监听 0.0.0.0:9830
./polaris-web

# 自定义端口
./polaris-web --port 8080

# 自定义监听地址 + 端口
./polaris-web --host 127.0.0.1 --port 3000

# 通过环境变量设置端口
POLARIS_WEB_PORT=8080 ./polaris-web
```

启动后访问 `http://<服务器IP>:9830` 即可使用。

## 配置优先级

端口/地址配置优先级：CLI 参数 > 环境变量 > 配置文件

配置文件路径：`~/.config/claude-code-pro/config.json`

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

## Web 模式限制

以下功能在纯 Web 模式下不可用：

| 功能 | 原因 |
|------|------|
| 自动更新 | 依赖 Tauri updater 插件 |
| 系统托盘 | 依赖桌面环境 |
| 窗口管理（置顶/最小化） | 无桌面窗口 |
| 本地插件安装 | 需要文件系统访问 |
| 文件资源管理器右键"在资源管理器打开" | 依赖系统文件管理器 |
| F12 开发者工具 | WebKit DevTools，仅桌面模式 |

## 故障排查

**Web UI 返回 404**
- 确认 `dist/` 目录与 `polaris-web` 在同一目录下
- 检查 `dist/index.html` 是否存在

**端口被占用**
```bash
# 查看端口占用
ss -tlnp | grep 9830
# 或
lsof -i :9830
```

**权限问题**
```bash
chmod +x polaris-web
```
