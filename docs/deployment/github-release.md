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

推送标签后，GitHub Actions 自动触发三个工作流（并行执行）：

| 工作流 | 产物 | 平台 |
|---|---|---|
| **Release** | Tauri 桌面应用安装包 | Windows, Linux |
| **Release Web** | Web 独立服务压缩包 | Windows, Linux, macOS |
| **Release APK** | Android APK 安装包 | Android (arm64-v8a) |

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
| `polaris-mobile-x.x.x.apk` | Android APK (arm64-v8a) |
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
2. 选择 **Release**、**Release Web** 或 **Release APK**
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

## v10.4.0 构建记录

**构建时间**: 2026-08-24 (UTC)
**Release 页面**: https://github.com/misxzaiz/Polaris/releases/tag/v10.4.0

### 构建产物

| 产物 | 大小 | 平台 | 说明 |
|---|---|---|---|
| `polaris_10.4.0_x64-setup.exe` | - | Windows x64 | NSIS 安装程序 |
| `polaris_10.4.0_x64_en-US.msi` | - | Windows x64 | MSI 安装程序 |
| `polaris_10.4.0_amd64.deb` | - | Linux x64 | Debian/Ubuntu 安装包 |
| `polaris-10.4.0-1.x86_64.rpm` | - | Linux x64 | Red Hat/Fedora 安装包 |
| `polaris_10.4.0_amd64.AppImage` | - | Linux x64 | 便携版（双击运行） |
| `polaris-web-10.4.0-win-x64.zip` | - | Windows x64 | Web 独立服务 |
| `polaris-web-10.4.0-linux-x86_64.tar.gz` | - | Linux x64 | Web 独立服务 |
| `polaris-web-10.4.0-macos-arm64.tar.gz` | - | macOS ARM64 | Web 独立服务 |
| `latest.json` | - | - | 自动更新元数据 |

### 签名文件

所有安装包均附带 `.sig` 签名文件，用于 Tauri 自动更新验证。

### 修复的问题

- feat(companion): AI 主动陪伴助手 Phase 0+1+2 完整闭环（真实引擎接入/事件驱动/成就桥接/设置面板/Toast 联动）
- fix(simple-ai): 修复 connected_count 在 tokio 异步上下文中使用 blocking_read 导致 panic 卡退
- fix(simple-ai): 缩短请求超时与流空闲超时，防止对话卡退
- fix(simple-ai): 修复工具轮次无上限与 MCP 超时过长
- fix(dsh/pi): 修复对话中途断流——工具循环提前终结 + agent_end 误判
- feat(plugin-system): P1-T3 toolProviders 覆盖硬编码工具 + P3-T1/T4 UI Slot 运行时自省
- feat(plugin-system): 样式覆盖扩展点 contributes.styles
- feat(capabilities): P2-T1~T4 Capability Seam trait 定义 + Registry
- fix(plugin): 卸载时安全终止 MCP/引擎进程防 OS error；友好错误信息 + 强制卸载 + Force 按钮
- fix(plugin): 同步 Rust 端 VALID_PLUGIN_ICONS 缺少 Activity/Film/Globe2/Users
- fix(plugin-loader): shim missing memo/forwardRef exports
- fix(panel): 修复切换应用时左侧插件面板自动关闭
- fix(provider-router): 修复多 Key 加权路由失效 + JSON 序列化 key 类型
- fix(theme): 修复主题自定义页面 TypeScript 编译错误
- feat(perf): PerformanceFeatures 生产级闭环（G1-G4 缺口补齐）+ G4 横幅 dismiss 持久化
- perf(P0): 移除 transparent: true 窗口透明，WebView2 GPU 降 70%
- perf: 减少 WebView2 CPU/内存占用（P1-P4）
- feat(perf): hljs 统一 core 化 + 消除三处重复注册（P1 抓手 B）
- feat(perf): 补齐 codeEditorLanguages 编辑器语言包预加载路径（P0）
- feat(build): 新增 git/lsp-index 编译期 feature 网格（轻量化 P2）+ git Web IPC 统一网关
- feat(git-plugin): 编辑器 git 集成 + 插件扩展点（Phase 0/2）+ 暴露宿主工作区
- feat(dsh-compat): Phase 1 Cordis 运行时嵌入 + 服务桥接骨架
- feat(engine): 引擎稳定性标识 + dev 单实例隔离修复
- feat(engine-test): 引擎插件路径验证面板 + build_start_params 增强
- refactor(chat): Chat 组件目录重组织
- refactor(config): 配置持久化规范化 + 插件配置一等公民
- chore: 移除 EngineTestPanel 及其插件注册；移除 DSH 兼容层；Phase 1 架构冗余治理（死代码删除 + Store 合并）
- chore: 规范化多个文件行尾为 LF（.gitattributes 政策同步）

---

## v10.3.2 构建记录

**构建时间**: 2026-08-06 (UTC)
**Release 页面**: https://github.com/misxzaiz/Polaris/releases/tag/v10.3.2

### 构建产物

| 产物 | 大小 | 平台 | 说明 |
|---|---|---|---|
| `polaris_10.3.2_x64-setup.exe` | - | Windows x64 | NSIS 安装程序 |
| `polaris_10.3.2_x64_en-US.msi` | - | Windows x64 | MSI 安装程序 |
| `polaris_10.3.2_amd64.deb` | - | Linux x64 | Debian/Ubuntu 安装包 |
| `polaris-10.3.2-1.x86_64.rpm` | - | Linux x64 | Red Hat/Fedora 安装包 |
| `polaris_10.3.2_amd64.AppImage` | - | Linux x64 | 便携版（双击运行） |
| `polaris-web-10.3.2-win-x64.zip` | - | Windows x64 | Web 独立服务 |
| `polaris-web-10.3.2-linux-x86_64.tar.gz` | - | Linux x64 | Web 独立服务 |
| `polaris-web-10.3.2-macos-arm64.tar.gz` | - | macOS ARM64 | Web 独立服务 |
| `latest.json` | - | - | 自动更新元数据 |

### 签名文件

所有安装包均附带 `.sig` 签名文件，用于 Tauri 自动更新验证。

### 修复的问题

- feat(ui): ActivityBar 紧凑化重构 + 历史面板支持选择工作区
- feat(ui): 移除左侧面板宽度拖拽限制（硬上限 + CSS 视口保护全移除）
- fix(preview): PRD 预览全屏改用真 Fullscreen API，修复移动端全屏不覆盖物理屏幕
- fix(theme): 使用 `setThemeById` 持久化 `activeThemeId` 到后端 config
- fix(browser): 圈选采样期间 overlay pointer-events 临时关闭（后回退，保留原行为）
- chore: history_index / dialog_index / ipc、SessionHistoryPanel / ArtifactPreviewRenderer / ActivityBar / TopMenuBar / windowService 等杂项同步

---

## v10.3.0 构建记录

**构建时间**: 2026-08-04 (UTC)
**Release 页面**: https://github.com/misxzaiz/Polaris/releases/tag/v10.3.0

### 构建产物

| 产物 | 大小 | 平台 | 说明 |
|---|---|---|---|
| `polaris_10.3.0_x64-setup.exe` | - | Windows x64 | NSIS 安装程序 |
| `polaris_10.3.0_x64_en-US.msi` | - | Windows x64 | MSI 安装程序 |
| `polaris_10.3.0_amd64.deb` | - | Linux x64 | Debian/Ubuntu 安装包 |
| `polaris-10.3.0-1.x86_64.rpm` | - | Linux x64 | Red Hat/Fedora 安装包 |
| `polaris_10.3.0_amd64.AppImage` | - | Linux x64 | 便携版（双击运行） |
| `polaris-web-10.3.0-win-x64.zip` | - | Windows x64 | Web 独立服务 |
| `polaris-web-10.3.0-linux-x86_64.tar.gz` | - | Linux x64 | Web 独立服务 |
| `polaris-web-10.3.0-macos-arm64.tar.gz` | - | macOS ARM64 | Web 独立服务 |
| `latest.json` | - | - | 自动更新元数据 |

### 签名文件

所有安装包均附带 `.sig` 签名文件，用于 Tauri 自动更新验证。

### 修复的问题

- feat(theme): 实现 Spider-Man 沉浸式主题（蓝调增强、红蓝黑三色平衡）
- feat(theme): 主题配置完善 — UI 密度与聊天字体大小设置
- feat(theme): 透明层级系统 — 聊天工具面板、悬停背景、模态框独立可调透明度
- feat: 浏览器 acquire 重试机制 & 样式优化
- feat: 移动端二维码扫描连接 + 手势链修复
- fix(browser): WebView 覆盖问题（Phase 0+1 / Phase 2+3）
- fix(pi): release input_sender before wait 防止 EPIPE 崩溃
- fix(theme): 默认深色主题背景改为纯黑，AI 回复消息背景调整
- fix(spiderman): 半透明支持覆盖设置页静态背景区域
- fix(spiderman): 聊天消息工具面板半透明支持 + 设置侧栏激活态背景修复
- fix: 多窗口 ThinkingOrb 动画 + i18n 修复
- refactor: 重构主题配置与样式系统，新增动态主题切换
- refactor(theme): Spider-Man 主题区块顺序调整，移除 emoji，优化面板遮罩
- ui(spiderman): 背景网格增加至 4 列

---

## v10.2.2 构建记录

**构建时间**: 2026-07-28 (UTC)
**Release 页面**: https://github.com/misxzaiz/Polaris/releases/tag/v10.2.2

### 构建产物

| 产物 | 大小 | 平台 | 说明 |
|---|---|---|---|
| `polaris_10.2.2_x64-setup.exe` | - | Windows x64 | NSIS 安装程序 |
| `polaris_10.2.2_x64_en-US.msi` | - | Windows x64 | MSI 安装程序 |
| `polaris_10.2.2_amd64.deb` | - | Linux x64 | Debian/Ubuntu 安装包 |
| `polaris-10.2.2-1.x86_64.rpm` | - | Linux x64 | Red Hat/Fedora 安装包 |
| `polaris_10.2.2_amd64.AppImage` | - | Linux x64 | 便携版（双击运行） |
| `polaris-web-10.2.2-win-x64.zip` | - | Windows x64 | Web 独立服务 |
| `polaris-web-10.2.2-linux-x86_64.tar.gz` | - | Linux x64 | Web 独立服务 |
| `polaris-web-10.2.2-macos-arm64.tar.gz` | - | macOS ARM64 | Web 独立服务 |
| `latest.json` | - | - | 自动更新元数据 |

### 签名文件

所有安装包均附带 `.sig` 签名文件，用于 Tauri 自动更新验证。

### 修复的问题

- 修复手机端语音输入输出（feat/mobile）
- 修复圈选发送提示「没有圈选」的竞态问题（fix/browser）
- 修复圈选同步 fetched 类型推断问题（fix/browser）
- 圈选区域增加纯文本采集，支持无交互元素区域（feat/browser）
- 内置浏览器圈选区域上下文 + 注释投喂 AI（feat/browser）
- 沉浸式状态栏，Android WebView 全屏显示（feat/mobile）
- 提升 HTTP 超时至 10 分钟，适配弱网/跨地域远程连接（fix/httpTransport）
- 清理未使用的导入/方法 + 认证成功后自动刷新（chore）

---

## v10.2.0 构建记录

**构建时间**: 2026-07-25 (UTC)
**Release 页面**: https://github.com/misxzaiz/Polaris/releases/tag/v10.2.0

### 构建产物

| 产物 | 大小 | 平台 | 说明 |
|---|---|---|---|
| `polaris_10.2.0_x64-setup.exe` | - | Windows x64 | NSIS 安装程序 |
| `polaris_10.2.0_x64_en-US.msi` | - | Windows x64 | MSI 安装程序 |
| `polaris_10.2.0_amd64.deb` | - | Linux x64 | Debian/Ubuntu 安装包 |
| `polaris-10.2.0-1.x86_64.rpm` | - | Linux x64 | Red Hat/Fedora 安装包 |
| `polaris_10.2.0_amd64.AppImage` | - | Linux x64 | 便携版（双击运行） |
| `polaris-web-10.2.0-win-x64.zip` | - | Windows x64 | Web 独立服务 |
| `polaris-web-10.2.0-linux-x86_64.tar.gz` | - | Linux x64 | Web 独立服务 |
| `polaris-web-10.2.0-macos-arm64.tar.gz` | - | macOS ARM64 | Web 独立服务 |
| `latest.json` | - | - | 自动更新元数据 |

### 签名文件

所有安装包均附带 `.sig` 签名文件，用于 Tauri 自动更新验证。

### 修复的问题

- 工具调用面板 JSON 输出支持格式化树形展示与折叠
- 工具调用 JSON 树支持搜索/匹配跳转与失败摘要
- 工具调用错误信息加红色左色条 + `durationMs` 类型兜底
- JsonTreeView 健壮性复审修复 + 补齐全局缺失的 error 色 token
- 专家库面板加一键初始化状态条与重装入口
- 新增硬题攻坚工作流 PRD/ADR/实施计划与内置 profile

---

## v10.1.9 构建记录

**构建时间**: 2026-07-24 (UTC)
**Release 页面**: https://github.com/misxzaiz/Polaris/releases/tag/v10.1.9

### 构建产物

| 产物 | 大小 | 平台 | 说明 |
|---|---|---|---|
| `polaris_10.1.9_x64-setup.exe` | - | Windows x64 | NSIS 安装程序 |
| `polaris_10.1.9_x64_en-US.msi` | - | Windows x64 | MSI 安装程序 |
| `polaris_10.1.9_amd64.deb` | - | Linux x64 | Debian/Ubuntu 安装包 |
| `polaris-10.1.9-1.x86_64.rpm` | - | Linux x64 | Red Hat/Fedora 安装包 |
| `polaris_10.1.9_amd64.AppImage` | - | Linux x64 | 便携版（双击运行） |
| `polaris-web-10.1.9-win-x64.zip` | - | Windows x64 | Web 独立服务 |
| `polaris-web-10.1.9-linux-x86_64.tar.gz` | - | Linux x64 | Web 独立服务 |
| `polaris-web-10.1.9-macos-arm64.tar.gz` | - | macOS ARM64 | Web 独立服务 |
| `latest.json` | - | - | 自动更新元数据 |

### 签名文件

所有安装包均附带 `.sig` 签名文件，用于 Tauri 自动更新验证。

### 修复的问题

- 修复历史记录面板冷态打开触发 `ensure_native_scan` 同步阻塞在 `history_query` 命令线程（实测 6.4s），且扫描持 `index_cell` 全局锁把并发查询挡在锁外（实测 7.3s）
- `ensure_native_scan` 改为 `std::thread::spawn` 后台执行，命令立即返回当前索引快照；新增 `AtomicBool NATIVE_SCAN_IN_FLIGHT` 防重入
- 新增独立扫描连接 `open_scan_connection(scan_into)`，不经 `index_cell` 锁，WAL 模式下写连接与查询读连接并发互不阻塞
- `scan_into` 用 `BEGIN IMMEDIATE/COMMIT` 单事务批量 upsert，失败整体回滚，修复单条 upsert 偶发失败触发 `with_conn` 删库重建、丢掉整个 native 索引的脆弱逻辑
- 实测（1505 个 native 文件 / 830MB）：冷态命令返回 6.4s → 97ms，扫描中并发查询 7.3s → 70~78ms

---

## v10.1.8 构建记录

**构建时间**: 2026-07-23 (UTC)
**Release 页面**: https://github.com/misxzaiz/Polaris/releases/tag/v10.1.8

### 构建产物

| 产物 | 大小 | 平台 | 说明 |
|---|---|---|---|
| `polaris_10.1.8_x64-setup.exe` | - | Windows x64 | NSIS 安装程序 |
| `polaris_10.1.8_x64_en-US.msi` | - | Windows x64 | MSI 安装程序 |
| `polaris_10.1.8_amd64.deb` | - | Linux x64 | Debian/Ubuntu 安装包 |
| `polaris-10.1.8-1.x86_64.rpm` | - | Linux x64 | Red Hat/Fedora 安装包 |
| `polaris_10.1.8_amd64.AppImage` | - | Linux x64 | 便携版（双击运行） |
| `polaris-web-10.1.8-win-x64.zip` | - | Windows x64 | Web 独立服务 |
| `polaris-web-10.1.8-linux-x86_64.tar.gz` | - | Linux x64 | Web 独立服务 |
| `polaris-web-10.1.8-macos-arm64.tar.gz` | - | macOS ARM64 | Web 独立服务 |
| `latest.json` | - | - | 自动更新元数据 |

### 签名文件

所有安装包均附带 `.sig` 签名文件，用于 Tauri 自动更新验证。

### 修复的问题

- 修复 Web/HTTP 模式下专家 corpus 资源目录解析回退到编译期 `CARGO_MANIFEST_DIR` 导致部署机 catalog 加载失败（os error 3）；`resolve_resources_agents_dir` 增加可执行文件同目录与铺平结构兜底，`ipc.rs` 桥接统一传入 `resource_dir`
- 注册 Agnes 多模态卡片（`generate_image` / `generate_video` / `query_video`），manifest 与 builtinPlugins 同步登记 `media-card`

---

## v10.1.7 构建记录

**构建时间**: 2026-07-20 (UTC)
**Release 页面**: https://github.com/misxzaiz/Polaris/releases/tag/v10.1.7

### 构建产物

| 产物 | 大小 | 平台 | 说明 |
|---|---|---|---|
| `polaris_10.1.7_x64-setup.exe` | - | Windows x64 | NSIS 安装程序 |
| `polaris_10.1.7_x64_en-US.msi` | - | Windows x64 | MSI 安装程序 |
| `polaris_10.1.7_amd64.deb` | - | Linux x64 | Debian/Ubuntu 安装包 |
| `polaris-10.1.7-1.x86_64.rpm` | - | Linux x64 | Red Hat/Fedora 安装包 |
| `polaris_10.1.7_amd64.AppImage` | - | Linux x64 | 便携版（双击运行） |
| `polaris-web-10.1.7-win-x64.zip` | - | Windows x64 | Web 独立服务 |
| `polaris-web-10.1.7-linux-x86_64.tar.gz` | - | Linux x64 | Web 独立服务 |
| `polaris-web-10.1.7-macos-arm64.tar.gz` | - | macOS ARM64 | Web 独立服务 |
| `latest.json` | - | - | 自动更新元数据 |

### 签名文件

所有安装包均附带 `.sig` 签名文件，用于 Tauri 自动更新验证。

### 修复的问题

- 更新 rosters 配置与派发/管道服务
- AgentGalleryPanel 视觉精修：圆角统一、配色收束、移除 emoji 图标

---

## v10.1.4 构建记录

**构建时间**: 2026-07-19 (UTC)
**Release 页面**: https://github.com/misxzaiz/Polaris/releases/tag/v10.1.4

### 构建产物

| 产物 | 大小 | 平台 | 说明 |
|---|---|---|---|
| `polaris_10.1.4_x64-setup.exe` | - | Windows x64 | NSIS 安装程序 |
| `polaris_10.1.4_x64_en-US.msi` | - | Windows x64 | MSI 安装程序 |
| `polaris_10.1.4_amd64.deb` | - | Linux x64 | Debian/Ubuntu 安装包 |
| `polaris-10.1.4-1.x86_64.rpm` | - | Linux x64 | Red Hat/Fedora 安装包 |
| `polaris_10.1.4_amd64.AppImage` | - | Linux x64 | 便携版（双击运行） |
| `polaris-web-10.1.4-win-x64.zip` | - | Windows x64 | Web 独立服务 |
| `polaris-web-10.1.4-linux-x86_64.tar.gz` | - | Linux x64 | Web 独立服务 |
| `polaris-web-10.1.4-macos-arm64.tar.gz` | - | macOS ARM64 | Web 独立服务 |
| `latest.json` | - | - | 自动更新元数据 |

### 签名文件

所有安装包均附带 `.sig` 签名文件，用于 Tauri 自动更新验证。

### 修复的问题

- 布局与移动端连接门禁相关修复（NewSessionButton / CreateWorkspaceModal / index.css / MobileConnectionGate）

---

## v10.1.3 构建记录

**构建时间**: 2026-07-19 (UTC)
**Release 页面**: https://github.com/misxzaiz/Polaris/releases/tag/v10.1.3

### 构建产物

| 产物 | 大小 | 平台 | 说明 |
|---|---|---|---|
| `polaris_10.1.3_x64-setup.exe` | - | Windows x64 | NSIS 安装程序 |
| `polaris_10.1.3_x64_en-US.msi` | - | Windows x64 | MSI 安装程序 |
| `polaris_10.1.3_amd64.deb` | - | Linux x64 | Debian/Ubuntu 安装包 |
| `polaris-10.1.3-1.x86_64.rpm` | - | Linux x64 | Red Hat/Fedora 安装包 |
| `polaris_10.1.3_amd64.AppImage` | - | Linux x64 | 便携版（双击运行） |
| `polaris-web-10.1.3-win-x64.zip` | - | Windows x64 | Web 独立服务 |
| `polaris-web-10.1.3-linux-x86_64.tar.gz` | - | Linux x64 | Web 独立服务 |
| `polaris-web-10.1.3-macos-arm64.tar.gz` | - | macOS ARM64 | Web 独立服务 |
| `latest.json` | - | - | 自动更新元数据 |

### 签名文件

所有安装包均附带 `.sig` 签名文件，用于 Tauri 自动更新验证。

### 修复的问题

- 修复 context-meter 用量解析双口径：turn 单轮快照（水位）vs cumulative 累计（成本）
- 补充 context-cost-meter-resolutions 文档

---

## v10.1.1 构建记录

**构建时间**: 2026-07-12 (UTC)
**Release 页面**: https://github.com/misxzaiz/Polaris/releases/tag/v10.1.1

### 构建产物

| 产物 | 大小 | 平台 | 说明 |
|---|---|---|---|
| `polaris_10.1.1_x64-setup.exe` | - | Windows x64 | NSIS 安装程序 |
| `polaris_10.1.1_x64_en-US.msi` | - | Windows x64 | MSI 安装程序 |
| `polaris_10.1.1_amd64.deb` | - | Linux x64 | Debian/Ubuntu 安装包 |
| `polaris-10.1.1-1.x86_64.rpm` | - | Linux x64 | Red Hat/Fedora 安装包 |
| `polaris_10.1.1_amd64.AppImage` | - | Linux x64 | 便携版（双击运行） |
| `polaris-web-10.1.1-win-x64.zip` | - | Windows x64 | Web 独立服务 |
| `polaris-web-10.1.1-linux-x86_64.tar.gz` | - | Linux x64 | Web 独立服务 |
| `polaris-web-10.1.1-macos-arm64.tar.gz` | - | macOS ARM64 | Web 独立服务 |
| `latest.json` | - | - | 自动更新元数据 |

### 签名文件

所有安装包均附带 `.sig` 签名文件，用于 Tauri 自动更新验证。

### 快速安装

**Windows (NSIS)**:
```
下载 polaris_10.1.1_x64-setup.exe → 双击运行
```

**Windows (MSI)**:
```
下载 polaris_10.1.1_x64_en-US.msi → 双击运行
```

**Linux (Debian/Ubuntu)**:
```bash
sudo dpkg -i polaris_10.1.1_amd64.deb
```

**Linux (AppImage)**:
```bash
chmod +x polaris_10.1.1_amd64.AppImage
./polaris_10.1.1_amd64.AppImage
```

**Web 独立服务 (Linux)**:
```bash
tar xzf polaris-web-10.1.1-linux-x86_64.tar.gz
cd polaris-web
./start.sh
# 浏览器访问 http://localhost:9830
```

**Web 独立服务 (Windows)**:
```
解压 polaris-web-10.1.1-win-x64.zip
双击 start.bat
浏览器访问 http://localhost:9830
```

**Web 独立服务 (macOS)**:
```bash
tar xzf polaris-web-10.1.1-macos-arm64.tar.gz
cd polaris-web
./start.sh
# 浏览器访问 http://localhost:9830
```

### 修复的问题

- （待补充）

---

## v9.9.7 构建记录

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
