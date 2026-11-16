# 极简核 × Web-first × 手机形态——架构分析与实施建议

日期：2026-11-16 ｜ 关联：kernel-5k-all-plugin-architecture.md、plugin-spec-v2-host-proxy.md、layout-plugin-system-spec.md

## 需求重述

1. Web 服务承载一切，不限技术/框架；启动快、轻量。
2. 支持打包 App（手机），App 通过设置的服务地址请求**电脑后端**。
3. 最好手机能**单独使用**（不连电脑），如装一个纯手机端 AI 对话插件。
4. 手机连上电脑后，**像电脑一样使用电脑已装的全部功能**（能力透传/代理）。
5. 连接方式本身也以插件形式存在。

## 现状核对（重要：大部分地基已存在）

| 需求 | 现有资产 | 缺口 |
|---|---|---|
| Web 服务 | `web/server.rs` axum HTTP+WS 已运行（9829/9830），浏览器已可全功能使用 | 无 |
| 打包 App | `src/mobile/`（MobileConnectionContext/Gate）、安卓 APK 构建先例 | 未出正式 App 包 |
| 手机连电脑 | multichat 插件已实证：任意设备开面板操作同一会话（cap.ai.chat 复用） | 仅聊天域；未泛化为"全部能力" |
| 手机单独使用 | http transport 已可独立跑；但会话存储/引擎在"电脑后端" | 单机模式（数据+引擎都在手机本地）未启用 |
| 全能力透传 | cap 总线 + bus_dispatch 白名单 | 未暴露成"远程能力代理"插件 |
| 热安装/更新 | installRemotePlugin/checkPluginUpdate（重启生效） | 免重启热更新 |

## 架构结论

### 形态一：手机=瘦客户端（连电脑）
**已基本成立**。手机 App = 同一 Web 内核打包（或直接浏览器/PWA），通过 `serverUrl` 指向电脑后端；所有 capability 经 HTTP/WS 调电脑。要做的只是：
- App 打包流水线（Capacitor/Tauri mobile/纯 PWA 三选一；推荐 **PWA 优先**——零打包、可安装、自动更新；需要原生能力再上 Capacitor 壳）。
- 「远程能力代理」插件：把电脑端全部 capability 经一条 WS 隧道映射为手机端 `host.invoke`——这就是"像电脑一样用所有功能"的通用机制，而非逐功能开发。

### 形态二：手机=独立主机（不连电脑）
需要三件套在手机端可运行：
- **前端内核**：同一套 web 内核（天然可跑）。
- **Rust 核编译到手机**：tauri 已支持 iOS/Android；或改用纯 web 后端（SQLite WASM/OPFS）。
- **存储/引擎插件**：纯手机 AI 对话插件 = 前端面板 + 直连模型 API（用户自备 key）+ OPFS/IndexedDB 存储。**这条路不需要电脑后端，最轻**。

### 形态三：连接本身=插件
- 现有 clip-relay/multichat 已是先例。规范化为 `contributes.connectors`：声明传输（ws/relay/p2p）+ 鉴权 + 能力白名单。
- 手机连电脑 = 安装「电脑连接器」插件 → 扫码/局域网发现 → 建隧道 → 手机端 registry 挂载电脑的全部 capabilities（代理模式）。

## 与极简核（5k）的关系

该需求与 5k 核**同向**：
- 核不含桌面专属逻辑（tauri IPC 只是桌面壳适配器）；
- 一切能力（含"连接到某台电脑"）都是插件注册的 capability；
- 手机单独使用 = 手机上装"本地存储插件 + 直连 AI 插件"，不装连接器插件。

## 实施路径

| 步骤 | 内容 | 依赖 |
|---|---|---|
| W1 | PWA 化前端（manifest+SW，可安装到手机主屏） | 无 |
| W2 | 「远程能力代理」插件：WS 隧道 → 远端 host.invoke 全能力映射（手机连电脑=用全部电脑功能） | W1 |
| W3 | 手机独立模式：OPFS/SQLite-WASM 存储插件 + 直连模型 API 的 AI 对话插件 | W1 |
| W4 | 连接器规范化（contributes.connectors）+ 扫码配对 | W2 |
| W5 | App 打包（PWA→Capacitor 壳，按需原生能力） | W1-W3 |

## 风险

- 远程能力代理=把整台电脑的能力暴露给手机，**鉴权必须严格**（现有 token/md5 机制沿用+设备配对）。
- 手机独立模式的 AI 对话需要处理 CORS/网络环境（直连模型 API）。
- 多端并发写同一后端会话：沿用现有"后端权威+事件广播"（multichat 已验证）。

## 建议起点

W1（PWA 化）+ W2（远程能力代理插件）——W2 正是"手机连电脑用全部功能"的通用解，且以插件形式存在，完全落在你的架构原则内。
