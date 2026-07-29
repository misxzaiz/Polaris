# OpenMinis 技术方案梳理

> 整理日期：2026-07-29
> 用途：技术参考，仅学习借鉴，不直接引用代码

---

## 1. 项目概览

OpenMinis 是一款跨平台（iOS / macOS / visionOS / Android）的**设备端 AI 智能体应用**，核心价值在于：
- 把「AI Agent」运行在用户设备本地，而非云端
- 通过内置 Linux 沙箱实现设备端脚本/工具执行能力
- 通过 Native Offload 桥接设备原生 API（日历、照片、健康、HomeKit 等）

官方仓库：[github.com/OpenMinis/OpenMinis](https://github.com/OpenMinis/OpenMinis)（GPL-3.0）
官网：[openminis.app](https://openminis.app)

---

## 2. 技术栈总览

### 2.1 客户端框架

| 平台 | 技术栈 |
|------|--------|
| iOS / macOS / visionOS | Swift / SwiftUI + Objective-C 桥接 |
| Android | Kotlin / Jetpack Compose + JNI 原生代码 |
| 构建工具 | iOS: Xcode / Swift 6.0；Android: Gradle 8.11.1 + Kotlin 2.1.0 |

### 2.2 依赖体系

| 类别 | 组件 | 协议 |
|------|------|------|
| Linux 沙箱（iOS） | iSH（ARM64 fork） | GPL-3.0 |
| Linux 沙箱（Android） | PRoot（fork） | GPL-2.0 |
| 音视频 | FFmpeg 6.1.2（LGPL 配置） | LGPL-2.1 |
| MP3 编码 | LAME 3.100 | LGPL-2.0 |
| AI 提供商 SDK（iOS） | SwiftAnthropic 2.2.0 | MIT |
| Markdown 渲染（iOS） | swift-cmark 0.7.1（cmark-gfm） | BSD-2-Clause |
| AI 客户端（Android） | OkHttp + SSE | Apache-2.0 |
| AndroidX/Jetpack | Compose BOM 2025.09.00 | Apache-2.0 |

> ⚠️ 整个应用被迫采用 GPL-3.0 的核心原因：链接了 iSH（GPL-3.0）和 PRoot（GPL-2.0）。

---

## 3. 核心技术：设备端 Linux 沙箱

这是 OpenMinis 最核心的技术亮点，也是 Polaris 可以参考的重点。

### 3.1 整体架构

```
┌─────────────────────────────────────────────────────┐
│  移动端 App（SwiftUI / Jetpack Compose）              │
│  └─ AI Chat ViewModel                                │
│     └─ tool_use: execute_command("pip install ...") │
└────────────────────┬────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────┐
│  命令执行协调器（Serialized, Session-aware）           │
│  ├─ FIFO 队列，一次只执行一个命令                     │
│  ├─ 自动挂载/卸载 /var/minis/ 会话目录               │
│  └─ 注入环境变量（Keychain 中的 API Key 等）          │
└────────────────────┬────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────┐
│  沙箱内核（C 语言）                                   │
│  ├─ iOS: iSH 内核（ARM64 用户态模拟）                 │
│  │    - Asbestos 引擎：线程化 JIT 解释器             │
│  │    - 支持 100+ Linux 系统调用                     │
│  │    - fakefs：基于 SQLite 的虚拟文件系统            │
│  │    - 网络：TCP/UDP 通过宿主机网络栈透传           │
│  │                                                   │
│  ├─ Android: PRoot（ptrace 模式）                    │
│  │    - 无需 root 即可运行完整 Linux 环境            │
│  │    - 用户态 chroot + 系统调用拦截                 │
│  │                                                   │
│  ├─ 两者都运行 Alpine Linux aarch64                  │
│  └─ Native Offload：execve 拦截 → 路由到 iOS/Android │
│     原生处理器（JSON over pipe 通信）                 │
└────────────────────┬────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────┐
│  Alpine Linux 用户态                                  │
│  ├─ apk, python, pip, node, go, rust, ffmpeg ...   │
│  └─ /usr/local/bin/apple-*（offload 存根命令）       │
└─────────────────────────────────────────────────────┘
```

### 3.2 沙箱核心能力

| 能力 | 实现方式 |
|------|----------|
| **进程管理** | fork/exec/exit/PID 跟踪/信号处理 |
| **文件系统** | fakefs（SQLite 元数据）+ bind mount |
| **网络** | AF_INET/AF_INET6/AF_LOCAL，DNS 实时同步宿主机 |
| **设备节点** | TTY /dev/tty1-7, PTY, /dev/null/zero/random |
| **系统调用** | mmap/brk/poll/epoll/pipes/eventfd/inotify 等 100+ |
| **安全防护** | 子线程运行、JIT 异常处理防止崩溃传染、输出缓冲区限制（100KB）、命令超时（10 分钟） |

### 3.3 会话隔离文件系统

每个 AI 会话拥有独立的持久化目录，通过 bind mount 暴露给沙箱：

```
/var/minis/
├── workspace/    — 会话工作文件、脚本、数据
├── attachments/  — 图片、音频、视频输入
├── browser/      — 浏览器截图和提取内容
├── offloads/     — 大型工具输出
├── memory/       — 跨会话共享记忆（全局）
└── skills/       — 技能定义（全局）
```

挂载路径映射：
- **iOS**：`Library/MinisChat/minis/{sessionId}/...`
- **Guest → Host**：`/var/minis/...` → 宿主持久化路径
- **minis:// URL scheme**：由 `MinisImageProvider` 解析为本地图片

---

## 4. 核心技术：Native Offload 桥接系统

这是让 AI Agent 真正能操作设备原生能力的关键机制。

### 4.1 工作原理

```
沙箱中执行: execve("/usr/local/bin/apple-calendar", args)
    ↓
iSH 内核拦截（native_offload.c）
    ↓
路由到注册的 Objective-C / JNI Handler
    ↓
调用 iOS Framework（EventKit）或 Android API
    ↓
JSON 结果通过 pipe 返回沙箱进程
```

### 4.2 已实现的 22 个 Offload Handler（iOS）

| 分类 | Handler | 对应 API |
|------|---------|----------|
| **媒体** | FFmpegOffload, MediaOffload, SpeakOffload, SpeechOffload, PlayerOffload | FFmpeg.framework, AVFoundation, AVSpeechSynthesizer, SFSpeechRecognizer |
| **Apple 服务** | CalendarOffload, ContactsOffload, MapsOffload, PhotosOffload, HealthKitOffload, HomeKitOffload | EventKit, Contacts, MapKit, Photos, HealthKit, HomeKit |
| **系统** | LocationOffload, DeviceOffload, ClipboardOffload, WeatherOffload, NotificationOffload, AlarmOffload | CoreLocation, UIKit, UIPasteboard, WeatherKit, UserNotifications |
| **智能** | VisionOffload, NLPOffload | Vision（图像识别/OCR），NaturalLanguage（NLP） |
| **工具** | OpenOffload | UIApplication（打开 URL/App） |

### 4.3 设计要点

- **JSON 信封协议**：宿主 ↔ 沙箱通信统一用 JSON over pipe
- **参数解析**：支持命名参数、flag、位置参数、ISO 8601/相对日期
- **异步派发**：Handler 运行在主线程（iOS 大部分 Framework 要求）
- **存根命令**：沙箱中每个 offload 对应一个 `/usr/local/bin/apple-*` 可执行存根

---

## 5. 核心技术：Agent 执行流程

### 5.1 序列化的命令调度

```
┌─ ISHExecutionCoordinator ─────────────────────────────────┐
│                                                            │
│  ┌─ FIFO 队列（跨所有会话，一次只执行一个命令） ──────┐   │
│  │                                                     │   │
│  ├─ 会话级别 mount/remount /var/minis/ 目录          │   │
│  ├─ 正则检测 shell prompt（$ / # / user@host:）       │   │
│  ├─ 超时抢占（>10 分钟且有等待者时）                  │   │
│  └─ 输出缓冲限制（100KB，无 prompt 时截断）           │   │
│                                                      │   │
└────────────────────────────────────────────────────────────┘
```

### 5.2 命令执行状态机

1. **排队** → 2. **Mount 会话目录** → 3. **启动 PTY shell**
4. **发送命令** → 5. **行回调捕获输出** → 6. **Prompt 检测 → 完成**
7. **Unmount** → 8. **返回结果给 AI Chat ViewModel**

---

## 6. AI 对话层设计

### 6.1 多模型支持

| 提供商 | 对接方式 | 备注 |
|--------|----------|------|
| Anthropic Claude | API Key / OAuth | iOS 用 SwiftAnthropic SDK |
| OpenAI GPT | API Key | REST API |
| Google Gemini | API Key | REST API |
| OpenRouter | API Key | 多提供商路由 |
| 自定义 | OpenAI 兼容 API | 任意后端 |

### 6.2 高级配置

- **模型组**：故障转移（failover）/ 负载均衡（round-robin）
- **Agent 循环模型池**：委派子任务时使用独立模型
- **API Key 存储**：设备 Keychain / Android Keystore

---

## 7. 浏览器集成

- iOS：内置 WKWebView，AI 可通过工具控制导航、点击、填表、截图
- 浏览器内容存储在 `/var/minis/browser/`
- 支持 minis://browser/ URL scheme 访问浏览器资源

---

## 8. 技能系统（SKILL.md）

- 格式：`SKILL.md` 定义文件 + 可选脚本文件
- 安装方式：从 URL 导入 / 文件系统导入 / 对话中创建
- 存储位置：`/var/minis/skills/`
- 可与会话关联启用/禁用
- 社区精选：[github.com/OpenMinis/AwesomeMinis](https://github.com/OpenMinis/AwesomeMinis)

---

## 9. 安全与隔离设计

| 层面 | 措施 |
|------|------|
| **进程隔离** | 沙箱运行在独立 pthread（背景线程） |
| **文件系统隔离** | fakefs SQLite 元数据层，不直接暴露宿主机路径 |
| **网络** | 通过宿主机网络栈透传，无独立网络命名空间 |
| **JIT 安全** | SIGSEGV/SIGBUS 异常处理，防止 Guest 崩溃传染 Host |
| **资源限制** | 输出缓冲 100KB，命令超时 10 分钟，自动抢占 |
| **密钥安全** | API Key 存 Keychain（iOS）/ Keystore（Android） |
| **无数据收集** | 不收集用户数据，无第三方分析 |

---

## 10. Android 端额外亮点

| 能力 | 实现 | 说明 |
|------|------|------|
| **无障碍自动化** | Accessibility Service | 读取任意 App UI 树、点击、滚动、全局截图、监听 UI 事件 |
| **Shizuku 特权** | Shizuku API 13.1.5 | adb 级别权限（安装/卸载 App、权限管理、系统设置） |
| **定时任务** | AlarmManager | 单次/重复 AI 任务调度，对标 iOS 快捷指令 |
| **悬浮窗状态** | System Alert Window | 后台运行时实时显示工具名称和执行状态 |

---

## 11. 对 Polaris 的参考价值

| OpenMinis 技术 | Polaris 可借鉴点 |
|----------------|-------------------|
| **设备端 Linux 沙箱** | Polaris 移动端若需本地执行能力，可参考 iSH/Proot 思路 |
| **Native Offload 桥接** | 通过 execve 拦截 + JSON pipe 桥接原生 API 的设计模式值得学习 |
| **会话隔离文件系统** | `/var/minis/` 命名空间 + bind mount 的隔离方案 |
| **序列化命令调度** | 单任务 FIFO + 会话 mount/unmount 的协调器模式 |
| **SKILL.md 技能系统** | 可扩展的 AI Agent 能力定义格式 |
| **minis:// URL scheme** | 自定义 URL scheme 用于内部资源访问 |
| **多模型组配置** | 故障转移/负载均衡的模型路由策略 |
| **内置浏览器 Agent** | AI 自主浏览网页、提取内容、截图的完整流程 |

---

## 12. 关键设计决策总结

1. **沙箱 = 核心竞争力**：通过 iSH/Proot 在移动端实现真实 Linux 环境，是所有高级能力的基石
2. **Native Offload 解耦**：Guest 不需要了解宿主 API 细节，只需调用约定路径的命令
3. **状态隔离**：每个会话独立的文件系统 + 序列化执行，避免并发冲突
4. **JSON over Pipe**：简单的 IPC 协议，比 RPC 框架更轻、更可控
5. **插件化扩展**：SKILL.md + MCP 双通道扩展 Agent 能力
6. **隐私设计**：本地执行 + Keychain 存储 + 无数据采集
