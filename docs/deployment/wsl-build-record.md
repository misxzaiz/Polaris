# WSL Linux 打包操作实录

> 记录从 Windows 主机到 WSL Linux 完整打包流程，供后续复用。
>
> **日期**: 2026-06-11
> **项目**: Polaris v9.9.2
> **分支**: test/9.9.2

---

## 环境概览

| 角色 | 环境 | 关键版本 |
|------|------|----------|
| 主机 | Windows 11 Home China (x86_64) | — |
| WSL | WSL 2 (Ubuntu 24.04.1 LTS) | 内核 6.6.87 |
| Rust (rustup) | stable (通过 rustup 安装) | 1.96.0 |
| Node.js | WSL 内 | 18.19.1 |
| pnpm | WSL 内 | 10.33.0 |
| glibc | WSL 内 | 2.39 |

### 关键发现：WSL 内有两个 Rust 来源

| 来源 | 路径 | 版本 | 生效方式 |
|------|------|------|----------|
| **rustup (stable)** | `~/.cargo/bin/rustc` | **1.96.0** | 需 `source $HOME/.cargo/env` |
| **apt 系统包** | `/usr/bin/rustc` | 1.75.0 | 默认生效（旧版，已失效） |

**解决方案**：在 `~/.bashrc` 末尾追加 `source $HOME/.cargo/env`，后续新终端自动使用 rustup 版本。

---

## 完整操作流程

### Step 1: 克隆项目到 WSL 原生文件系统

```bash
# ❌ 不要用 /mnt/d/ 跨文件系统编译（性能极差且易出错）
# ✅ 克隆到 WSL 原生路径
wsl -d Ubuntu -e bash -c \
  "source \$HOME/.cargo/env && git clone /mnt/d/space/base/Polaris ~/polaris"
```

> **注意**: 文档明确建议将源码放到 WSL 原生文件系统（如 `~/polaris`），**避免**在 `/mnt/` 挂载点上编译。

### Step 2: 安装前端依赖

```bash
wsl -d Ubuntu -e bash -c \
  "source \$HOME/.cargo/env && cd ~/polaris && pnpm install"
```

耗时约 13.5s，安装 872 个包。

### Step 3: 执行 Web 打包

```bash
wsl -d Ubuntu -e bash -c \
  "source \$HOME/.cargo/env && cd ~/polaris && pnpm run package:web"
```

打包自动完成三步：
1. **前端构建** — `vite build`，产出 `dist/` 静态资源
2. **Rust 编译** — `cargo build --release --no-default-features`，编译：
   - `polaris-web` (18.1 MB，独立 Web 服务器)
   - `polaris-todo-mcp` (2.1 MB)
   - `polaris-requirements-mcp` (2.1 MB)
   - `polaris-scheduler-mcp` (2.3 MB)
3. **产物汇集** — 将二进制 + dist + 启停脚本放到 `polaris-web/` 目录

**总耗时**：前端 ~37s + Rust 编译 ~4m01s

### Step 4: 压缩产物

```bash
wsl -d Ubuntu -e bash -c \
  "cd ~/polaris && tar czf polaris-web-linux.tar.gz polaris-web/"
```

压缩后大小：**11 MB**（从 25 MB 压缩）

### Step 5: 复制到 Windows 主机

```bash
wsl -d Ubuntu -e bash -c \
  "cp ~/polaris/polaris-web-linux.tar.gz /mnt/d/space/base/Polaris/"
```

最终产物位置：`D:\space\base\Polaris\polaris-web-linux.tar.gz`

---

## 产物清单

```
polaris-web/
├── polaris-web                 (19 MB, ELF 二进制)
├── polaris-todo-mcp            (2.1 MB)
├── polaris-requirements-mcp    (2.1 MB)
├── polaris-scheduler-mcp       (2.3 MB)
├── dist/
│   ├── index.html
│   └── assets/
├── start.sh
└── stop.sh
```

## 后续使用

### 在 WSL 中直接启动

```bash
wsl -d Ubuntu -e bash -c "source \$HOME/.cargo/env && cd ~/polaris/polaris-web && ./start.sh"
```

启动后 Windows 浏览器访问 `http://localhost:9830`。

### 部署到 Linux 服务器

```bash
# 目标服务器
scp polaris-web-linux.tar.gz user@server:~/
ssh user@server
tar xzf polaris-web-linux.tar.gz
cd polaris-web
./start.sh
```

> 目标服务器需与构建机 **同 CPU 架构（x86_64）** 且 **glibc >= 2.39**。

---

## 踩坑记录

1. **WSL 内 Rust 版本不生效** — 有 rustup 但 `~/.cargo/bin` 不在 PATH，需要 `source $HOME/.cargo/env`
2. **跨文件系统编译极慢** — `/mnt/d/` 上编译 `git2`/`openssl` 等 C 库非常慢，必须用 WSL 原生路径
3. **编译依赖** — `libssl-dev` 已预装，`pkg-config` 也已就绪，无需额外安装
