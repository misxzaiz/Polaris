# WSL 一键打包使用教程

> 适用于 Windows 用户在 WSL 中编译 Linux 二进制并生成可分发包。
>
> **核心流程**：Windows 双击脚本 → 自动进入 WSL → 编译打包 → 产物自动复制回 Windows。全程零手动操作。

---

## 前置条件

| 条件 | 说明 |
|------|------|
| WSL 2 | 已安装 Ubuntu 发行版（`wsl --list` 可见） |
| Node.js | WSL 内已安装 ≥ 18（推荐 20+） |
| Rust | WSL 内已安装（rustup 管理，推荐 1.78+） |
| pnpm | WSL 内已安装 |

> **不需要手动安装任何依赖** — 首次运行时脚本会自动检测并提示缺失项。

### 快速验证环境

```bash
# 在 Windows 终端执行
wsl --list --verbose
wsl -d Ubuntu -e bash -c "rustc --version && node --version && pnpm --version"
```

---

## 一键打包

### 方式一：双击运行（推荐）

```
双击 scripts\wsl-package-web.bat
```

### 方式二：命令行

```bash
# Windows CMD
scripts\wsl-package-web.bat

# PowerShell
.\scripts\wsl-package-web.bat
```

### 方式三：从 WSL 侧直接运行

```bash
# 在项目根目录
bash scripts/wsl-package-web-runner.sh
```

---

## 自动流程说明

脚本依次执行 6 个步骤：

| 步骤 | 操作 | 说明 | 耗时参考 |
|------|------|------|----------|
| 1 | 检查 WSL | 确认 Ubuntu 发行版可达 | <1s |
| 2 | 检查 Rust | 自动修复 `.bashrc` 确保使用 rustup 版本 | <1s |
| 3 | 同步项目 | 首次克隆到 WSL 原生路径，后续 git pull | ~5s |
| 4 | 安装依赖 | `pnpm install`（已有 `node_modules` 则跳过） | ~15s |
| 5 | 编译打包 | `vite build` + `cargo build --release` + 产物汇集 | ~4min（首次）/ ~3s（增量） |
| 6 | 压缩复制 | `tar czf` 后复制到 Windows 项目根目录 | <5s |

> **增量编译极快**：代码不变时，Rust 增量编译仅 ~3s，前端构建 ~37s。

---

## 产物位置

打包完成后，产物位于项目根目录：

```
polaris-web-linux.tar.gz    (约 11 MB)
```

可直接用于：
- 部署到 Linux 服务器
- 分发给团队成员
- 上传到下载页面

---

## 部署到 Linux 服务器

```bash
# 1. 传输到目标服务器
scp polaris-web-linux.tar.gz user@server:~/

# 2. 在目标服务器上解压运行
ssh user@server
tar xzf polaris-web-linux.tar.gz
cd polaris-web
./start.sh

# 3. 浏览器访问 http://<服务器IP>:9830
```

### systemd 服务（可选）

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

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable polaris-web
sudo systemctl start polaris-web
```

---

## 常见问题

### Q1: 提示 "无法连接 WSL"

确认已安装 WSL 发行版：

```cmd
wsl --list --verbose
```

如果列表中没有 Ubuntu，安装：

```cmd
wsl --install -d Ubuntu
```

### Q2: Rust 版本不对（显示 1.75 而非 1.96）

WSL 内可能存在 apt 安装的旧版 Rust，脚本已自动在 `.bashrc` 中添加 `source $HOME/.cargo/env`。如果遇到：

```bash
wsl -d Ubuntu -e bash -c "source \$HOME/.cargo/env && rustc --version"
```

应显示 1.96+。如果不是，检查是否有 rustup：

```bash
wsl -d Ubuntu -e bash -c "source \$HOME/.cargo/env && rustup show"
```

如未安装 rustup：

```bash
wsl -d Ubuntu -e bash -c "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
```

### Q3: 编译卡在 "Downloading crates ..."

首次编译需要下载大量 Rust 依赖，请耐心等待。如果中断：

```bash
wsl -d Ubuntu -e bash -c "source \$HOME/.cargo/env && cd ~/polaris && pnpm run package:web"
```

会从中断处继续（cargo 有缓存）。

### Q4: 产物 404 页面

确保 `dist/` 目录与 `polaris-web` 二进制在同一目录下（脚本已自动处理）。

```bash
ls polaris-web/dist/index.html    # 应存在
ls polaris-web/polaris-web        # 应存在
```

### Q5: Node.js 版本警告

脚本使用 WSL 内 Node.js 18.x 可正常编译，但 Vite 建议 20+。如需升级：

```bash
wsl -d Ubuntu -e bash -c "
  export NVM_DIR=\$HOME/.nvm
  [ -s \$NVM_DIR/nvm.sh ] && \. \$NVM_DIR/nvm.sh
  nvm install 20
  nvm use 20
"
```

---

## 与其他打包方式对比

| 方式 | 入口 | 产物 | 适用场景 |
|------|------|------|----------|
| **WSL 一键脚本** | 双击 `wsl-package-web.bat` | `polaris-web-linux.tar.gz` | Windows 用户编译 Linux 二进制 |
| Windows 本地打包 | 双击 `package-web.bat` | `polaris-web/` (Windows) | Windows 桌面版 Web 模式 |
| WSL 手动打包 | `pnpm run package:web` | `polaris-web/` (Linux) | WSL 内已有项目，需精细控制 |
| Tauri 桌面打包 | `pnpm run tauri:build` | `.msi`/`.deb` 安装包 | 完整桌面应用 |
