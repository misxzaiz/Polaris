# Polaris Pocket v2 — Spec 规范开发文档

> 版本：1.0 · 日期：2026-07-29
> 状态：Spec-Ready（可直接驱动 `/spec` 流程实施）
>
> **设计原则**：先做功能可用性，**不改页面样式，不新增页面，不改 TabBar**。所有新能力挂入现有 `ChatPage` 的 Agent 工具链（toolRegistry），让 AI 在对话中按需调用。UI 改造留到后续迭代。
>
> 上游文档：`docs/v2-quick-action-plan.md`（方案总纲，部分路径已降级）、`docs/v2-technical-plan.md`（技术细节）、`docs/references/openminis-technical-summary.md`（架构对标）

---

## 0. Spec 驱动协议（System Prompt 四步）

当本文件作为 `/spec` 输入被加载时，开发 Agent 必须严格按以下四步执行，不得跳步：

1. **读规格** — 完整读取本文件，理解每条 AC（Acceptance Criteria）的验收点。任何实现不得违背 §3 硬约束与 §6 命令签名。
2. **计划** — 针对当前要落地的 Phase，输出实施计划：列出要新增/修改的文件清单、顺序、依赖关系。计划必须映射到 §8 路线图的 Day 粒度。
3. **实施** — 按计划逐文件编码，遵循 §5 文件契约（只在 `toolRegistry.ts` 增工具定义、新增 Rust/Kotlin 后端文件；遵循命令签名、`#[cfg(mobile)]` 门控、`_probe` 探测模式）。
4. **AC 验证矩阵** — 实现完成后，逐条对照 §9 的 AC 矩阵打勾；任一 AC 未通过即标记该 Phase 未完成，不得进入下一 Phase。

**唯一硬约束**：零自建服务器、面向普通人（非开发者）、增量交付（只新增 Rust/Kotlin 后端文件 + 改 `toolRegistry.ts`/`lib.rs`，**不改任何前端 UI**），不重写现有模块。

---

## 1. 产品定位

### 1.1 一句话定义

**Polaris Pocket = 面向普通人的语音驱动 AI 生活助手**（Android App）。

不是聊天工具，不是开发者工具。核心价值是让普通人用一句话解决真实生活问题：改文档、记待办、设提醒、盲人导航。

### 1.2 用户画像

普通人。不会写代码、不懂 Prompt 工程、不关心模型选型。期望：按住说话 → AI 直接把事办完。交互模型是「语音指令 → 自动执行」，不是「对话式往返」。

### 1.3 与 v1 的关系

v1 = AI 聊天框（ChatPage + toolRegistry + Agent 循环，3 Tab：AI/空间/设置）。
v2 = 在 v1 之上**新增 AI 工具定义**（待办/文档/提醒/日历/无障碍/相机），挂入 `toolRegistry.ts`，让 AI 在现有 ChatPage 的对话中按需调用。**不新增页面，不改 TabBar，不改现有 UI 样式**。

---

## 2. 硬约束（不可违背）

| 编号 | 约束 | 说明 |
|---|---|---|
| C1 | **零自建服务器** | 唯一外部依赖是用户自己配置的 AI API Key（Pocket 设置页已有多 Profile 管理）。云同步用 Supabase 免费额度（个人空间，`SpacePage.tsx` 已接入）。不得引入任何后端服务。 |
| C2 | **面向普通人** | 不得出现开发者术语（Prompt/Agent/Tool/JSON）。不得回到「开发者工具/桌面端联动」方向（用户已两次否决）。 |
| C3 | **增量交付（不改 UI）** | 不重写 `pocket_tools.rs`/`ChatPage.tsx`/`toolRegistry.ts`。不改 `App.tsx`、不改 TabBar、不新增页面、不改现有 UI 样式。只新增 Rust/Kotlin 后端文件 + 在 `toolRegistry.ts` 增工具定义。**所有新能力通过 AI 对话调用，不新增前端 UI 组件。** |
| C4 | **`#[cfg(mobile)]` 门控** | 新增 Offload 命令用 `#[cfg(mobile)]` 分平台编译，`#[cfg(not(mobile))]` 分支返回 `Err("仅移动端可用")`。**此为 spec 新引入策略**：`pocket_tools.rs` 现有 24 个函数均无门控，不后补。Phase 2 阶段 `#[cfg(not(mobile))]` 分支返回 stub（不影响桌面端 dev），Phase 3 收紧为 `Err("仅移动端可用")`。 |
| C5 | **`_probe` 探测模式（必须注册）** | 每个会触发系统权限弹窗的 Offload 命令必须有对应 `*_probe` 命令，且**必须**注册到 `lib.rs` 的 `generate_handler!` 中，前端 `getAvailableTools` 调用时不触发权限请求。
> ⚠️ **既有模式存在缺失**：`pocket_tools.rs` 已定义 5 个 `*_probe`（`get_location_probe`、`send_sms_probe`、`get_contacts_probe`、`scan_barcode_probe`、`authenticate_biometric_probe`）但**均未注册**到 `lib.rs`。新增 Offload 命令的 probe 必须修复此遗漏，不能延续既有缺失模式。 |
| C6 | **客户端生成** | 文档（.docx/.pptx）必须用前端 JS 库（`docx`/`pptxgenjs`）生成，Rust 端只负责落盘与分享，不得在 Rust 端组装文档。 |

---

## 3. 现状基线（已验证）

### 3.1 前端（`polaris-pocket/src/`）

| 文件 | 角色 | 实际可用 | 状态 |
|---|---|---|---|
| `App.tsx` | 3 Tab 路由（chat/space/settings） | ✅ | **保留，不改** |
| `pages/ChatPage.tsx` | 独立流式对话，直连 OpenAI 兼容 API，多会话 localStorage | ✅ | 保留，新增工具由 Agent 在此对话页自动调用 |
| `pages/SpacePage.tsx` | Supabase 云同步（个人空间） | ✅ | 保留 |
| `pages/SettingsPage.tsx` | 多 Profile AI 配置（`ModelProfile` 对齐主项目 `src/types/modelProfile.ts`） | ✅ | 保留 |
| `services/useAgentLoop.ts` | Agent 循环（578 行） | ✅ | 保留，复用 |
| `services/toolRegistry.ts` | 35 条工具定义（前端工具 + 系统工具 + probe 适配 + 协议适配） | ✅ | 保留，新增 Offload 工具定义时挂入 |
| `services/toolTypes.ts` / `chatProxy.ts` | 类型与代理 | ✅ | 保留 |
| `services/supabaseClient.ts` / `auth.ts` | 云同步 | ✅ | 保留 |
| `components/Markdown.tsx` / `ToolBlockCard.tsx` | 渲染 | ✅ | 保留 |

### 3.2 Rust 后端（`polaris-pocket/src-tauri/src/`）

| 文件 | 函数数 | `lib.rs` 已注册 | 实际可用 | 状态 |
|---|---|---|---|---|
| `lib.rs` | — | — | — | **需改：`generate_handler!` 增 Offload/Document/Alarm 命令** |
| `pocket_config.rs` | 2（`pocket_get_config`/`pocket_save_config`） | 2 | ✅ | 保留 |
| `pocket_tools.rs` | 24（18 业务函数 + 6 probe 函数 + 额外 probe） | 20 | ⚠️ 部分占位 | 保留，**复用 `resolve_app_path`** |
| `pocket_chat_proxy.rs` | 2（174 行，绕 CORS） | 2 | ✅ | 保留 |

**`pocket_tools.rs` 现状细分**：

- **已注册且可用的 16 个**：`get_device_info`、`get_device_info_probe`、`copy_to_device_storage`、`copy_to_device_storage_probe`、`take_photo_probe`（返回 Err）、`get_applications`（返回占位）、`get_applications_probe`、`file_system_probe`、`read_file`/`write_file`/`list_files`/`delete_file`/`create_directory`/`file_exists`/`get_file_size`。
- **已注册但为 JNI 占位的 4 个**：`send_sms`、`get_contacts`、`scan_barcode`、`authenticate_biometric`——代码中显式返回 "JNI 未实现" 提示字符串，**不可用**。
- **已定义但未注册的 4 个 probe**：`get_location_probe`（文件第 58 行，lib.rs 未注册）、`send_sms_probe`、`get_contacts_probe`、`scan_barcode_probe`、`authenticate_biometric_probe`——这 4 个 `*_probe` 在 `lib.rs` 的 `generate_handler!` 中**缺失**。前端现有 `getAvailableTools` 无法探测到这些命令。

### 3.3 构建/配置

- `tauri.conf.json`：已启用 geolocation/notification/opener/haptics/barcode-scanner/biometric 插件，`minSdkVersion: 24`，`identifier: com.polaris.pocket`。
- `Cargo.toml`：移动插件用 `cfg(any(target_os = "android", target_os = "ios"))` 依赖。
- `build.rs`：仅 `tauri_build::build()`（4 行）。Tauri 2.0 的 Kotlin 编译由 `tauri-build` 内部自动处理，**不**通过改 `build.rs` 实现。自定义 Kotlin 放在正确目录后会被自动拾取（见 §5.3 修正后的路径）。**需改的是 `build.gradle.kts`**（增 CameraX/HealthConnect 依赖，Phase 3）。

### 3.4 未验证项（风险）

- JNI 桥接的具体调用路径（`pocket_offload.rs` 中 `jni_call!` 为占位）。
- 5 个 `*_probe` 命令已定义但未注册到 `lib.rs` 的 `generate_handler!`：`get_location_probe`（`pocket_tools.rs:58`）、`send_sms_probe`、`get_contacts_probe`、`scan_barcode_probe`、`authenticate_biometric_probe`。前端 `getAvailableTools` 无法探测到这些命令，新增 Offload 命令的 probe **必须**注册，不能延续既有缺失模式。
- `@tauri-apps/plugin-camera` 是否可用未确认（影响 VisionBridge 实现路径）。
- 本机 Rust lib 测试只能 `cargo check --lib`，无法启动 Tauri 原生 DLL；移动端最终需真机打包验证。

---

## 4. 目标架构

### 4.1 架构总览

```
┌──────────────────────────────────────────────────────────┐
│  React 19 前端（src/）  — 现有页面/UI 保持不变             │
│  ├─ ChatPage.tsx          保留：现有 AI 对话页，不改       │
│  ├─ SpacePage.tsx         保留                            │
│  ├─ SettingsPage.tsx      保留                            │
│  ├─ toolRegistry.ts       增：新工具定义（待办/文档/提醒/日历/无障碍/相机）│
│  └─ 现有组件              全部保留，不新增 UI 组件           │
└────────────────────┬─────────────────────────────────────┘
                     │ Tauri invoke（AI 对话中 tool_use 自动调用）
┌────────────────────▼─────────────────────────────────────┐
│  Rust 后端（src-tauri/src/）                              │
│  ├─ pocket_offload.rs   新增：统一 offload_* 入口         │
│  ├─ pocket_document.rs  新增：文档落盘 + 分享             │
│  ├─ pocket_tools.rs     保留：24 函数 + resolve_app_path   │
│  └─ pocket_chat_proxy.rs 保留：AI API 代理                │
└────────────────────┬─────────────────────────────────────┘
                     │ JNI（仅 #[cfg(mobile)] 分支）
┌────────────────────▼─────────────────────────────────────┐
│  Kotlin 桥接层（src-tauri/gen/android/.../）              │
│  ├─ AlarmBridge.kt + AlarmReceiver.kt（AlarmManager）     │
│  ├─ CalendarBridge.kt（CalendarContract）                 │
│  ├─ VisionBridge.kt（CameraX / @tauri-apps/plugin-camera）│
│  ├─ PocketAccessibilityService.kt + Bridge.kt             │
│  ├─ ContactBridge.kt / HealthBridge.kt                     │
│  └─ AndroidManifest.xml（权限 + <service> 声明）          │
└──────────────────────────────────────────────────────────┘
```

### 4.2 工具调用链路（核心模式）

新功能**不依赖新页面**，全部通过 AI Agent 工具链调用：

```
用户说话/打字 → AI 理解意图 → toolRegistry 匹配工具 → Tauri invoke → Rust 命令 → JNI（可选）→ Kotlin → Android API
                                                        ↑ 文档生成用前端 JS 库，不走 JNI
```

**新增工具定义（挂入 `toolRegistry.ts` 的 TOOL_REGISTRY 数组）**：

| 工具名 | 用户指令示例 | 实现层 | Phase |
|---|---|---|---|
| `todo_add` / `todo_list` / `todo_done` / `todo_delete` | "帮我记一下3点开会" | localStorage（前端） | P1 |
| `document_generate` | "帮我写一份周报" | 前端 `docx`/`pptxgenjs` + `pocket_document.document_download` | P1 |
| `alarm_schedule` | "30分钟后提醒我喝水" | `tauri-plugin-notification`（前台）/ `AlarmBridge`（后台） | P1-P2 |
| `calendar_create` | "下午3点加个会议" | JNI → `CalendarBridge` | P2 |
| `accessibility_ui_tree` / `accessibility_click` | "截图当前页面"/"点击那个按钮" | JNI → `PocketAccessibilityBridge` | P2 |
| `vision_capture` | "拍张照"/"这是什么" | JNI → `VisionBridge` + 多模态 AI | P2 |
| `contact_lookup` | "打电话给张三" | JNI → `ContactBridge` | P2 |

### 4.3 Offload 桥接模式（核心）

借鉴 OpenMinis Native Offload，但**不引入其 Linux 沙箱**：

```
OpenMinis：沙箱 execve → native_offload.c 拦截 → JSON pipe → ObjC Handler → iOS Framework
Pocket  ：前端 tool_use → Tauri invoke → Rust #[tauri::command] → JNI → Kotlin Bridge → Android API
```

**不采用 OpenMinis 的**：iSH/PRoot Linux 沙箱、会话隔离文件系统、FIFO 命令调度。理由：Pocket 面向普通人，用 `localStorage` + `app_data_dir` + Tauri invoke 天然异步即可。

**关键差异（vs 早期方案）**：所有工具由 AI 在对话中调用，**不创建独立的 UI 入口**。用户通过自然语言触发功能，而非点击页面按钮。

---

## 5. 文件契约（Spec）

### 5.0 需修改的现有文件（共 2 个）

| 文件 | 改动内容 | Phase |
|---|---|---|
| `src/services/toolRegistry.ts` | 在 `TOOL_REGISTRY` 数组中新增 §4.1 列出的 7 组工具定义（name/description/inputSchema/category/handler） | P1-P2 |
| `src-tauri/src/lib.rs` | `mod` 声明增 `pocket_offload`/`pocket_document`；`generate_handler!` 注册新命令（见 §6.4） | P2 |

> **注意**：`App.tsx`、`ChatPage.tsx`、`settings`、页面组件**全部不改**。新增功能通过现有 ChatPage 的 Agent 循环 + toolRegistry 自动暴露给 AI。

### 5.1 前端新增文件：无

**本迭代不新增任何前端文件。** 新工具直接定义在现有 `toolRegistry.ts` 的 `TOOL_REGISTRY` 数组中，前端处理器挂在 `frontend_tool_handlers`/`system_tool_handlers` 映射中，AI 对话中自动调用。

### 5.2 Rust 新增文件（`src-tauri/src/`）

| 文件 | 职责 | Phase |
|---|---|---|
| `pocket_offload.rs` | Offload 统一入口：日历/闹钟（后台）/无障碍 UI 树/无障碍点击/视觉拍照 | P2 |
| `pocket_document.rs` | base64 解码 → 写 `app_data_dir` → 触发系统分享 | P1 |
| `pocket_alarm.rs` | 定时任务调度（前台用 tauri-plugin-notification，后台用 AlarmManager） | P1-P2 |

### 5.3 Kotlin 新增文件（`src-tauri/gen/android/app/src/main/java/com/polaris/pocket/`）

> Tauri 2.0 Kotlin 源码由 `tauri android init` 生成，位于 `src-tauri/gen/android/`。自定义业务逻辑放在 `com.polaris.pocket` 包下，与 `generated/` 子包并列。`tauri-build` 自动拾取该目录下的 `.kt` 文件，无需修改 `build.rs`。

| 文件 | 职责 | Phase | 优先级 |
|---|---|---|---|
| `AlarmBridge.kt` + `AlarmReceiver.kt` | AlarmManager 持久化提醒 | P3 | 🔴 先做（最低风险） |
| `CalendarBridge.kt` | CalendarContract 日历事件 | P3 | 🔴 |
| `PocketAccessibilityService.kt` + `PocketAccessibilityBridge.kt` | 无障碍自动化 | P3 | 🟡 |
| `VisionBridge.kt` | 相机拍照 | P3 | 🟡 |
| `ContactBridge.kt` | 通讯录 | P3 | 🟢 |
| `HealthBridge.kt` | 健康数据（HealthConnect） | P3 | 🟢 降级为「今日 AI 使用统计」纯本地（见 §10.3） |

---

## 6. 技术契约

### 6.1 通用命令规范

- 所有 `#[tauri::command]` 返回 `Result<String, String>`（与 `pocket_tools.rs` 既有约定一致，前端统一处理）。
- 新增 Offload 命令必须 `#[cfg(mobile)]` 门控；`#[cfg(not(mobile))]` 分支在 **Phase 2** 返回 stub 值（保证桌面端 `cargo check` 通过）、**Phase 3** 收紧为 `Err("仅移动端可用")`。
- 触发权限的命令必须有同名 `*_probe` 命令，且 **probe 必须注册**到 `lib.rs` 的 `generate_handler!` 中。

### 6.2 `pocket_offload.rs` 命令签名

```rust
#[tauri::command]
pub fn offload_calendar_create(
    app: tauri::AppHandle,
    req: CalendarCreateRequest,  // { title, start(Iso8601), end(Iso8601), location: Option<String> }
) -> Result<String, String>;

#[tauri::command]
pub fn offload_alarm_schedule(
    app: tauri::AppHandle,
    title: String, message: String, delay_seconds: u64,
) -> Result<String, String>;
// 推荐方案 A（前端能覆盖时用 tauri-plugin-notification），方案 B（需后台持久化用 JNI AlarmManager）

#[tauri::command]
pub fn offload_accessibility_ui_tree() -> Result<String, String>;

#[tauri::command]
pub fn offload_accessibility_click(x: f64, y: f64) -> Result<String, String>;

#[tauri::command]
pub fn offload_vision_capture() -> Result<String, String>;  // 返回 base64 图片
```

### 6.3 `pocket_document.rs` 命令签名

```rust
#[tauri::command]
pub fn document_download(
    app: tauri::AppHandle,
    filename: String,
    content_base64: String,
) -> Result<String, String>;
// 复用 app.path().app_data_dir()；base64 解码后写文件，触发 Intent.ACTION_SEND 分享
```

### 6.4 `lib.rs` 命令注册清单（新增部分）

```rust
mod pocket_offload;
mod pocket_document;
mod pocket_alarm;

// 在 generate_handler! 追加：
pocket_offload::offload_calendar_create,
pocket_offload::offload_alarm_schedule,
pocket_offload::offload_accessibility_ui_tree,
pocket_offload::offload_accessibility_click,
pocket_offload::offload_vision_capture,
pocket_document::document_download,
// + 各 *_probe 探测命令
```

### 6.5 `AndroidManifest.xml` 权限与声明

**实际路径**：`src-tauri/gen/android/app/src/main/AndroidManifest.xml`

**已存在的权限**（46 行已有，无需重复声明）：`INTERNET`、`ACCESS_FINE_LOCATION`、`ACCESS_COARSE_LOCATION`、`POST_NOTIFICATIONS`、`VIBRATE`、`CAMERA`、`READ_CONTACTS`、`SEND_SMS`。

**缺失的权限**（需新增）：

```xml
<uses-permission android:name="android.permission.READ_CALENDAR"/>
<uses-permission android:name="android.permission.WRITE_CALENDAR"/>
<uses-permission android:name="android.permission.BIND_ACCESSIBILITY_SERVICE"/>
<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW"/>

<service android:name=".PocketAccessibilityService"
    android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
    <intent-filter><action android:name="android.accessibilityservice.AccessibilityService"/></intent-filter>
    <meta-data android:name="android.accessibilityservice"
        android:resource="@xml/accessibility_service_config"/>
</service>
```

### 6.6 新增依赖

```bash
# npm
npm install docx pptxgenjs
npm install --save-dev @types/docx
# Cargo.toml 新增
base64 = "0.22"
# Android Gradle（P3）
implementation 'androidx.camera:camera-camera2:1.3.0'
implementation 'androidx.camera:camera-lifecycle:1.3.0'
implementation 'androidx.camera:camera-view:1.3.0'
```

---

## 7. 数据模型

### 7.1 Todo（localStorage key: `pocket-todos`）

```typescript
interface Todo {
  id: string;          // UUID
  text: string;
  done: boolean;
  createdAt: number;   // epoch ms
  dueAt?: number;      // 可选提醒时间
}
```

### 7.2 Reminder（localStorage key: `pocket-reminders`）

```typescript
interface Reminder {
  id: string;
  title: string;
  message: string;
  triggerAt: number;   // epoch ms
  fired: boolean;
}
```

### 7.3 ModelProfile（既有，不动）

对齐主项目 `src/types/modelProfile.ts`，多 Profile，`active=true` 为当前激活。`ChatPage` 已实现 `readActiveProfile()` 读取逻辑。

---

## 8. 实现路线图

### Phase 1 — 工具定义 + 前端处理器（1-2 天，纯前端，见效最快）

| Day | 任务 | 产出 |
|---|---|---|
| 1 | `toolRegistry.ts` 新增 4 组工具定义 + 前端处理器：`todo_*`（localStorage）、`document_generate`（`docx`/`pptxgenjs`）、`alarm_schedule`（`tauri-plugin-notification`）、`contact_lookup` | AI 对话中"记个待办"/"写份周报"/"30分钟后提醒我"可执行 |
| 2 | 安装 `docx`/`pptxgenjs`；测试 Agent 循环中工具调用链路；`pocket_document.rs` 落盘命令 | 文档生成到手机可下载 |

### Phase 2 — Rust 后端（1-2 天）

| Day | 任务 | 产出 |
|---|---|---|
| 3 | `pocket_offload.rs`、`pocket_document.rs`、`pocket_alarm.rs`、`lib.rs` 注册、`Cargo.toml` 增 base64 | `cargo check --lib` 通过 |
| 4 | JNI 桥接框架（参考 `@tauri-apps/plugin-haptics`）；`AlarmBridge.kt`（最低风险） | 后台提醒可在真机触发 |

### Phase 3 — Android 原生能力（2-3 天）

| Day | 任务 | 产出 |
|---|---|---|
| 5-6 | `CalendarBridge.kt`、`PocketAccessibilityService.kt` + `Bridge.kt` | AI 对话中可创建日历事件、读屏幕 UI 树 |
| 7 | `VisionBridge.kt`（或确认 `@tauri-apps/plugin-camera`）、`AndroidManifest.xml` 权限 | AI 对话中可拍照识别 |

### Phase 4 — 高级/低优先

- 语音输入（`VoiceInput.tsx`，Web Speech API，待确认国内可用性）
- 自定义快捷指令
- 健康数据：降级为「今日 AI 使用统计」（纯本地，见 §10.3）

---

## 9. AC 验证矩阵（Acceptance Criteria）

> 每条 AC 必须可被客观验证（编译通过 / 真机操作观察 / 文件存在）。未打勾的 Phase 不得进入下一 Phase。

### Phase 1 AC

| 编号 | 验收点 | 验证方式 |
|---|---|---|
| AC1.1 | `toolRegistry.ts` 新增 `todo_*` 工具定义（`todo_add`/`todo_list`/`todo_done`/`todo_delete`），含 description/inputSchema | 代码审查 |
| AC1.2 | `todo_*` 前端处理器读写 localStorage key `pocket-todos` 正确 | 刷新后数据保留 |
| AC1.3 | `toolRegistry.ts` 新增 `document_generate` 工具定义，前端处理器能调用 `docx`/`pptxgenjs` 生成 Blob | 生成文件可用 |
| AC1.4 | `toolRegistry.ts` 新增 `alarm_schedule` 工具定义，前端处理器能发送 `tauri-plugin-notification` | 接收通知 |
| AC1.5 | `toolRegistry.ts` 新增 `contact_lookup` 工具定义，前端处理器调用 `pocket_tools::get_contacts` | 代码审查 |
| AC1.6 | `tsc` 编译零错误 | `npx tsc --noEmit` |
| AC1.7 | `build` 成功 | `npm run build` |
| AC1.8 | `App.tsx`、`ChatPage.tsx`、`SpacePage.tsx`、`SettingsPage.tsx` 无任何改动 | `git diff --stat` 确认 |

### Phase 2 AC

| 编号 | 验收点 | 验证方式 |
|---|---|---|
| AC2.1 | `pocket_offload.rs`/`pocket_document.rs`/`pocket_alarm.rs` 文件存在且命令签名符合 §6.2/§6.3 | 代码审查 |
| AC2.2 | 所有 Offload 命令有 `#[cfg(mobile)]` 门控；`#[cfg(not(mobile))]` 分支在 Phase 2 返回 stub（不影响桌面端 dev 编译），Phase 3 收紧为 `Err("仅移动端可用")` | 代码审查 |
| AC2.3 | `lib.rs` `generate_handler!` 注册了 §6.4 全部命令，**且每个 Offload 命令的 `*_probe` 均已注册**（修复既有 probe 未注册缺失） | 代码审查 |
| AC2.4 | `cargo check --lib` 通过 | 本机编译 |
| AC2.5 | `document_download` 能将 base64 解码写入 `app_data_dir` 并返回路径 | 桌面端 stub 返回 Err，移动端真机验证 |

### Phase 3 AC

| 编号 | 验收点 | 验证方式 |
|---|---|---|
| AC3.1 | `AlarmBridge.kt` + `AlarmReceiver.kt` 存在，`AlarmManager.RTC_WAKEUP` 调度 | 真机设提醒后到时收到通知 |
| AC3.2 | `CalendarBridge.kt` 能创建日历事件 | 系统日历 App 可见新事件 |
| AC3.3 | `PocketAccessibilityService` 在 Android 设置页可被手动授权 | 设置页观察 |
| AC3.4 | `AndroidManifest.xml` 含 §6.5 全部权限与 `<service>` 声明 | 代码审查 |
| AC3.5 | 首屏引导文案覆盖无障碍/通知/相机权限请求 | 真机首屏观察 |
| AC3.6 | APK 真机打包成功 | `tauri android build` |

---

## 10. 未解问题与风险

### 10.1 语音输入（Phase 4，延后评估）🔴

语音输入功能（`VoiceInput.tsx` + Web Speech API）延后到 Phase 4。Android WebView 的 `SpeechRecognition` 底层调 Google 服务，国内可能不稳，且需要新增 UI 组件与当前"不改 UI"原则冲突。Phase 1-3 先通过打字交互完成所有功能。

### 10.2 JNI 桥接实现路径未验证 🟡

`pocket_offload.rs` 的 `jni_call!` 是占位写法。Tauri 2.0 的 Android JNI 调用需参考 `@tauri-apps/plugin-haptics`/`barcode-scanner` 已有插件实现模板。Kotlin 源码放在 `src-tauri/gen/android/app/src/main/java/com/polaris/pocket/` 下，`tauri_build::build()` 自动拾取，**无需**修改 `build.rs`。

影响：Phase 2-3 的主要技术风险点。缓解策略：Phase 2 先用 `tauri-plugin-notification` 方案 A（不依赖 JNI）覆盖提醒场景，JNI 方案 B 留到 Phase 3 验证。

### 10.3 健康数据降级 🟢

`HealthConnect` 依赖 `READ_HEALTH_DATA` 权限且用户需安装 Google 健康。决策：降级为 P2 或砍掉，换成「今日 AI 使用统计」（纯本地计数）。

### 10.4 `@tauri-apps/plugin-camera` 可用性 🟡

若 Tauri 生态有成熟 camera 插件，可省去 CameraX JNI。Phase 3 落地 `VisionBridge` 前先确认，否则走 CameraX JNI 方案。

### 10.5 权限首屏引导 🟡

无障碍服务需用户在 Android 设置页手动授权；通知需 `POST_NOTIFICATIONS` 运行时权限。首屏引导文案须提前设计，覆盖在 AC3.5。

---

## 11. OpenMinis 对标与差异化

| 维度 | OpenMinis | Pocket v2 |
|---|---|---|
| 用户定位 | 开发者/极客 | 普通人 |
| 核心技术 | Linux 沙箱(iSH/PRoot) + 脚本执行 | Offload 桥接原生 API（无沙箱） |
| Offload 机制 | execve 拦截 + JSON pipe | Tauri invoke + JNI |
| 文档生成 | ❌ | ✅ 核心功能（docx/pptxgenjs） |
| 待办管理 | ❌ | ✅ 核心功能（localStorage） |
| 盲人导航 | ❌ | 🔲 待定（Phase 4 摄像头 + 多模态 AI + TTS） |
| 无障碍自动化 | ✅ | ✅ 借鉴 |
| 服务器依赖 | 零 | 零 |
| 技术栈 | Swift/Kotlin + iSH/PRoot | Tauri 2.0 + Rust + Kotlin JNI |

**借鉴的三个 OpenMinis 模式**：Native Offload 桥接、Accessibility Service、AlarmManager 持久化提醒。
**不借鉴的三个**：Linux 沙箱、会话隔离文件系统、FIFO 命令调度。

---

## 12. 首页布局规格（保留，Phase 4 后迭代）

> 当前迭代**不实现**首页 UI。以下为 Phase 4 的预期布局，供参考：

```
┌─────────────────────────┐
│  上午好，今天周三 👋     │
├─────────────────────────┤
│      [ 🎙 按住说话 ]    │  ← VoiceInput（大圆环，80×80px）
├─────────────────────────┤
│  📋 待办（3项）         │
│  · 上午10点开会         │
│  · 下午写周报           │
│  · 晚上取快递           │
├─────────────────────────┤
│  ⏰ 提醒（2个）         │
│  · 5分钟后拿快递        │
│  · 1小时后喝水          │
├─────────────────────────┤
│  [📄文档] [👁导航]      │  ← QuickActions（2x2 网格）
│  [📷拍照] [🔧更多]      │
└─────────────────────────┘
```

---

## 附录 A — 原型预览（历史参考，UI 改造已延后）

| previewId | 方向 | 说明 |
|---|---|---|
| `c09906d1-...` | Quick Action | 早期 9 宫格方案（已否决，保留为历史） |
| `5b7919e1-...` | Remote Control | 桌面端 Agent 遥控器（已否决，用户明确不要桌面端为主方向） |
| `0e360ef4-...` | Life Assistant v3 | 语音圆环 + 卡片 + 2x2 网格（**UI 改造已延后到 Phase 4，当前仅做工具功能**） |

---

## 附录 B — Spec 驱动协议执行清单

当 `/spec` 加载本文件，逐 Phase 执行时，按以下顺序产出：

1. **读规格** → 确认 §3 基线与 §2 约束未被违反。
2. **计划** → 选定 Phase，输出该 Phase 的文件清单与 Day 分解（映射到 §8）。
3. **实施** → 按 §5 文件契约编码，遵循 §6 技术契约。
4. **AC 验证矩阵** → 逐条勾选对应 Phase 的 §9 AC，未全勾不进下一 Phase。

> 任何偏离 §2 约束（零服务器/面向普通人/增量交付/`#[cfg(mobile)]`/`_probe`/客户端生成）的实现，视为 Spec 违规，必须回退。
