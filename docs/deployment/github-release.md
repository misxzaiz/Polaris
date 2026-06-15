# GitHub Release 发布指南

本文档介绍如何通过 GitHub Actions 自动打包并发布 Polaris 各平台二进制安装包。

## 前置条件

### 1. 配置 Tauri 签名密钥

Tauri 应用需要签名密钥来支持自动更新功能。

```bash
# 生成密钥对
npx tauri signer generate -w ~/.tauri/polaris.key

# 按提示设置密码（请牢记，丢失后无法为旧版本生成更新包）
```

生成的文件：
- `~/.tauri/polaris.key` — 私钥（保密）
- `~/.tauri/polaris.key.pub` — 公钥（配置在 tauri.conf.json）

### 2. 在 GitHub 仓库添加 Secrets

进入仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret Name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥文件完整内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设置的密码 |

### 3. 更新公钥配置

将生成的公钥更新到 `src-tauri/tauri.conf.json`：

```json
{
  "plugins": {
    "updater": {
      "pubkey": "<你的公钥内容>"
    }
  }
}
```

## 发布流程

### 步骤一：更新版本号

同时更新以下两个文件的版本号：

```bash
# package.json
"version": "x.x.x"

# src-tauri/tauri.conf.json
"version": "x.x.x"
```

### 步骤二：提交更改

```bash
git add package.json src-tauri/tauri.conf.json
git commit -m "chore: release vx.x.x"
```

### 步骤三：推送并打标签

```bash
# 推送 commit
git push origin main

# 创建并推送标签（标签名必须以 v 开头）
git tag vx.x.x
git push origin vx.x.x
```

### 步骤四：等待自动打包

推送标签后，GitHub Actions 自动触发两个工作流：

| 工作流 | 产物 | 平台 |
|---|---|---|
| **Release** | Tauri 桌面应用安装包 | Windows, Linux |
| **Release Web** | Web 独立服务压缩包 | Windows, Linux, macOS |

查看进度：仓库 → **Actions** → 选择对应的工作流运行

### 步骤五：获取产物

打包完成后，在仓库的 **Releases** 页面自动创建新版本，包含以下产物：

| 产物 | 说明 |
|---|---|
| `polaris_x.x.x_x64Setup.exe` | Windows 安装程序 |
| `polaris_x.x.x_amd64.AppImage` | Linux 便携版 |
| `polaris_x.x.x_amd64.deb` | Debian/Ubuntu 安装包 |
| `polaris-web-x.x.x-win-x64.zip` | Windows Web 版 |
| `polaris-web-x.x.x-linux-x64.tar.gz` | Linux Web 版 |
| `polaris-web-x.x.x-macos-x64.tar.gz` | macOS Web 版 |
| `latest.json` | 自动更新元数据 |

## 完整命令参考

```bash
# 1. 更新版本号后，一条命令完成发布
git add package.json src-tauri/tauri.conf.json && \
git commit -m "chore: release vx.x.x" && \
git push origin main && \
git tag vx.x.x && \
git push origin vx.x.x
```

## 手动触发打包

如需在不打标签的情况下测试打包：

1. 进入仓库 → **Actions**
2. 选择 **Release** 或 **Release Web**
3. 点击 **Run workflow**
4. 选择分支，点击 **Run workflow**

手动触发的打包产物仅上传为 Workflow Artifact（保留 14 天），不会创建 GitHub Release。

## 注意事项

### 版本号格式

- 标签名格式：`v` + 语义化版本号（如 `v1.0.0`、`v9.9.7`）
- 版本号必须与 `package.json` 和 `tauri.conf.json` 中的一致

### Secrets 配置

- 如果不配置签名密钥，打包仍可完成，但：
  - 桌面应用无法使用自动更新功能
  - 构建日志会显示警告信息

### 跨平台说明

- 每个平台由独立的 Runner 构建，无需交叉编译
- macOS 构建默认在 Intel 架构运行（如需 ARM 版本需修改工作流配置）

### 产物签名

- Windows 安装程序使用 Tauri 私钥签名
- 其他平台产物不签名，依赖 GitHub Release 的完整性校验

## 故障排查

### 构建失败

1. 检查 Secrets 是否正确配置
2. 查看 Actions 运行日志中的具体错误
3. 确认版本号格式正确（不能有前导零等非法格式）

### 签名失败

1. 确认 `TAURI_SIGNING_PRIVATE_KEY` 包含完整私钥内容（含换行）
2. 确认 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 与生成密钥时一致
3. 确认 `tauri.conf.json` 中的 pubkey 与私钥匹配

### 自动更新不工作

1. 检查 `latest.json` 是否正确生成并上传
2. 确认客户端配置的更新端点 URL 正确
3. 确认新版本号大于已安装版本号

---

## v9.9.7 构建记录

**构建时间**: 2026-06-15 15:33 - 15:54 (UTC)
**Release 页面**: https://github.com/misxzaiz/Polaris/releases/tag/v9.9.7

### 构建产物

| 产物 | 大小 | 平台 | 说明 |
|---|---|---|---|
| `polaris_9.9.7_x64-setup.exe` | 18.7 MB | Windows x64 | NSIS 安装程序 |
| `polaris_9.9.7_x64_en-US.msi` | 28.4 MB | Windows x64 | MSI 安装程序 |
| `polaris_9.9.7_amd64.deb` | 36.7 MB | Linux x64 | Debian/Ubuntu 安装包 |
| `polaris-9.9.7-1.x86_64.rpm` | 36.7 MB | Linux x64 | Red Hat/Fedora 安装包 |
| `polaris_9.9.7_amd64.AppImage` | 112.7 MB | Linux x64 | 便携版（双击运行） |
| `polaris-web-9.9.7-win-x64.zip` | 11.5 MB | Windows x64 | Web 独立服务 |
| `polaris-web-9.9.7-linux-x86_64.tar.gz` | 11.6 MB | Linux x64 | Web 独立服务 |
| `polaris-web-9.9.7-macos-arm64.tar.gz` | 9.5 MB | macOS ARM64 | Web 独立服务 |
| `latest.json` | 4.2 KB | - | 自动更新元数据 |

### 签名文件

所有安装包均附带 `.sig` 签名文件，用于 Tauri 自动更新验证。

### 快速安装

**Windows (NSIS)**:
```
下载 polaris_9.9.7_x64-setup.exe → 双击运行
```

**Windows (MSI)**:
```
下载 polaris_9.9.7_x64_en-US.msi → 双击运行
```

**Linux (Debian/Ubuntu)**:
```bash
sudo dpkg -i polaris_9.9.7_amd64.deb
```

**Linux (AppImage)**:
```bash
chmod +x polaris_9.9.7_amd64.AppImage
./polaris_9.9.7_amd64.AppImage
```

**Web 独立服务 (Linux)**:
```bash
tar xzf polaris-web-9.9.7-linux-x86_64.tar.gz
cd polaris-web
./start.sh
# 浏览器访问 http://localhost:9830
```

**Web 独立服务 (Windows)**:
```
解压 polaris-web-9.9.7-win-x64.zip
双击 start.bat
浏览器访问 http://localhost:9830
```

**Web 独立服务 (macOS)**:
```bash
tar xzf polaris-web-9.9.7-macos-arm64.tar.gz
cd polaris-web
./start.sh
# 浏览器访问 http://localhost:9830
```

### 修复的问题

- 修复 Tauri NPM 包与 Rust crate 版本不匹配问题（`@tauri-apps/api` 升级到 v2.11.0）
- 添加 GitHub Actions workflow `contents: write` 权限以支持上传 Release 产物
