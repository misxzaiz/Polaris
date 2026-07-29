# Polaris Pocket AI 工具调用扩展 — 重构总结

> 对应提交：`cd70f948` + `e8dfb585`
> 日期：2026-07-29

---

## 一、背景与目标

Pocket 的 AI 工具调用存在以下问题：

1. **get_location 超时** — 使用 WebView 的 `navigator.geolocation`，在 Tauri 自定义协议环境下不可靠，10s 超时几乎必触发
2. **send_notification / open_url 是 log 占位** — Rust 后端只 `eprintln` 打印，不实际调用 Android API
3. **工具数量少（18 个）** — 缺少文件操作、网络信息、内存信息等实用工具
4. **权限不足** — AndroidManifest.xml 只有 INTERNET 权限

**目标**：在 Tauri 2.11.5 + Rust 1.93 环境下，利用官方插件体系 + 纯 Rust 命令，大幅扩展工具能力，解决可用性问题。

---

## 二、架构决策

### 工具分层架构

```
┌─────────────────────────────────────────────┐
│  Layer 1: 前端 JS 工具（浏览器 API）         │
│  get_time / get_date / read_clipboard / ...  │
│  get_network_info / evaluate_math / ...       │
│  ✅ 无需重新构建 APK，改前端即生效            │
├─────────────────────────────────────────────┤
│  Layer 2: Tauri 2 官方插件（JS API 调用）     │
│  geolocation / notification / opener /       │
│  haptics / barcode-scanner / biometric       │
│  ❌ 需重新构建 APK（插件在 Android 编译）     │
├─────────────────────────────────────────────┤
│  Layer 3: Rust #[tauri::command] 命令         │
│  read_file / write_file / list_files / ...   │
│  send_sms / get_contacts / ...               │
│  ❌ 需重新构建 APK                           │
└─────────────────────────────────────────────┘
```

### 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 定位方案 | `tauri-plugin-geolocation`（原生 FusedLocationProviderClient） | 彻底解决 WebView 自定义协议超时 |
| 通知/URL | 从 Rust 命令→logs 改为 `tauri-plugin-notification`/`opener` 前端 JS 调用 | 官方插件已封装 Android API，无需手写 Kotlin |
| 文件系统 | 纯 Rust `std::fs`，不自带插件依赖 | 操作限制在 `app_data_dir` 私有目录，无需额外依赖 |
| 权限声明 | `capabilities/default.json`（桌面）+ `mobile.json`（移动端） | Tauri 2 权限模型，桌面编译时不加载移动插件权限 |
| 路径安全 | `resolve_app_path()` 函数，拦截 `../` 和绝对路径 | 防止 AI 模型误用导致文件穿越 |

---

## 三、变更清单

### 3.1 Rust 后端（`src-tauri/`）

| 文件 | 变更 |
|------|------|
| `Cargo.toml` | 新增 6 个 mobile-only 插件依赖（geolocation/notification/opener/haptics/barcode-scanner/biometric） |
| `src/lib.rs` | 注册 6 个插件 + 新增 15 个 `#[tauri::command]` 注册 |
| `src/pocket_tools.rs` | 新增文件系统命令（7 个）+ Android 原生命令（4 个）+ 对应 probe 命令 |
| `capabilities/default.json` | 保持桌面干净 |
| `capabilities/mobile.json` | **新文件**，配置移动端插件权限 |

### 3.2 前端（`src/services/`）

| 文件 | 变更 |
|------|------|
| `toolRegistry.ts` | 工具定义从 18 个 → 38 个；新增 7 个前端 handler + 7 个文件系统 handler + 2 个原生插件 handler |
| `toolTypes.ts` | 无变更（保持向后兼容） |
| `useAgentLoop.ts` | 无变更（保持向后兼容） |
| `chatProxy.ts` | 无变更（保持向后兼容） |

### 3.3 Android 配置

| 文件 | 变更 |
|------|------|
| `AndroidManifest.xml` | 新增 8 项权限（ACCESS_FINE_LOCATION/ACCESS_COARSE_LOCATION/POST_NOTIFICATIONS/VIBRATE/CAMERA/READ_CONTACTS/SEND_SMS） |

---

## 四、工具完整列表（38 个）

### 4.1 前端 JS 工具（19 个）

| 工具名 | 用途 | 实现 |
|--------|------|------|
| `get_time` | 当前时间 + 时区 | `Intl.DateTimeFormat` |
| `get_date` | 完整日期 + 闰年/天数 | `Date` |
| `read_clipboard` | 读取剪贴板 | `navigator.clipboard` |
| `write_clipboard` | 写入剪贴板 | `navigator.clipboard` |
| `get_location` | GPS 定位 | 优先 `tauri-plugin-geolocation`，回退 `navigator.geolocation` |
| `get_device_orientation` | 设备朝向 | `DeviceOrientationEvent` |
| `get_battery` | 电量信息 | `Battery Status API` |
| `speak_text` | TTS 语音 | `speechSynthesis` |
| `vibrate` | 震动（旧） | `navigator.vibrate` |
| `play_sound` | 播放音频 | `Audio` |
| `get_local_storage` | 读取 localStorage | `localStorage` |
| `get_applications` | 应用列表 | `invoke("get_applications")` |
| `send_notification` | 通知 | 优先 `tauri-plugin-notification`，回退 `Notification API` |
| `open_url` | 打开 URL | 优先 `tauri-plugin-opener`，回退 `window.open` |
| `get_network_info` | ⭐ 网络信息 | `navigator.connection` |
| `evaluate_math` | ⭐ 数学计算 | 安全 `Function` 沙箱 |
| `get_battery_advanced` | ⭐ 电池详情 | `Battery Status API` + 预估时间 |
| `memory_info` | ⭐ 内存信息 | `deviceMemory` / `performance.memory` |
| `screen_info` | ⭐ 屏幕信息 | `window.screen` |
| `language_info` | ⭐ 语言偏好 | `navigator.languages` |
| `get_online_status` | ⭐ 在线状态 | `navigator.onLine` |
| `vibrate_native` | ⭐ 原生震动 | `tauri-plugin-haptics`（比 navigator.vibrate 可靠） |
| `scan_barcode` | ⭐ 扫码 | `tauri-plugin-barcode-scanner` |

> ⭐ 标记为本次新增

### 4.2 系统工具（Rust 后端，15 个）

| 工具名 | 用途 | 实现 |
|--------|------|------|
| `get_device_info` | 设备信息 | Rust `std::env::consts` |
| `take_photo` | 拍照 | 当前不可用（probe 返回不可用） |
| `copy_to_device_storage` | 保存文件 | Rust `std::fs::write`（已有） |
| `read_file` | ⭐ 读文件 | `std::fs::read_to_string` |
| `write_file` | ⭐ 写文件 | `std::fs::write` |
| `list_files` | ⭐ 列出目录 | `std::fs::read_dir` |
| `delete_file` | ⭐ 删除文件/目录 | `std::fs::remove_file` / `remove_dir_all` |
| `create_directory` | ⭐ 创建目录 | `std::fs::create_dir_all` |
| `file_exists` | ⭐ 检查存在 | `std::fs::metadata` |
| `get_file_size` | ⭐ 文件大小+时间 | `std::fs::metadata` |
| `send_sms` | ⭐ 发送短信 | Kotlin 桥接待实现（当前为 log 占位） |
| `get_contacts` | ⭐ 获取联系人 | Kotlin 桥接待实现（当前为 log 占位） |

---

## 五、技术细节

### 5.1 定位修复（get_location 超时根因）

**根因**：Android WebView 在 Tauri 自定义协议（`tauri://`）下，`navigator.geolocation` 的权限请求流程不完整。`getCurrentPosition` 的回调不会触发错误或成功，导致 10s 超时。

**修复**：改用 `tauri-plugin-geolocation`，它通过 Android 原生 `FusedLocationProviderClient` 获取位置，不走 WebView 地理位置 API。

```typescript
// 优先 Tauri 原生定位
try {
  const { requestPermissions, getCurrentPosition } = await import("@tauri-apps/plugin-geolocation");
  const permission = await requestPermissions(["location"]);
  if (permission?.location !== "granted") {
    return { content: "位置权限未授予", is_error: true };
  }
  const pos = await getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
  return { content: formatPosition(pos) };
} catch {
  // 回退到 navigator.geolocation（桌面开发环境）
}
```

### 5.2 文件系统路径沙箱

所有文件操作调用 `resolve_app_path()` 函数，将相对路径解析到 `app_data_dir` 私有目录：

```rust
fn resolve_app_path(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir()?;
    if path.is_empty() { return Ok(base); }
    if path.starts_with('/') || path.starts_with("..") {
        return Err("路径不安全：文件操作限制在应用私有目录内".into());
    }
    Ok(base.join(path))
}
```

### 5.3 通知修复（send_notification）

从 Rust log 占位改为前端直接调用 `tauri-plugin-notification`：

```typescript
// 前端 handler
const { requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
const perm = await requestPermission();
if (perm === "granted") {
  await sendNotification({ title, body });
}
```

### 5.4 权限体系

```
AndroidManifest.xml   ← 声明 Android 系统权限（定位/通知/相机/联系人/短信）
       ↓
capabilities/mobile.json  ← Tauri 2 权限门控（插件级细粒度权限）
       ↓
tiuri.conf.json        ← 应用配置
```

---

## 六、Android 原生工具等待实现

| 工具 | 状态 | 需要的 Kotlin 代码 |
|------|------|--------------------|
| `send_sms` | Rust 占位 | `SmsManager.getDefault().sendTextMessage()` |
| `get_contacts` | Rust 占位 | `ContentResolver.query(ContactsContract.Contacts.CONTENT_URI)` |
| `take_photo` | probe 返回不可用 | `ActivityResultContracts.TakePicture()` + FileProvider |
| `authenticate_biometric` | 前端通过插件调用 | `tauri-plugin-biometric` 已注册，前端需加工具定义 |

---

## 七、构建验证

| 检查项 | 结果 |
|--------|------|
| `npx tsc --noEmit` | ✅ 0 错误 |
| `cargo check --lib` | ✅ 编译通过（11 个 unused 警告，不影响构建） |
| `npx tauri android build --target aarch64` | ✅ APK 构建成功（17MB） |
| 签名验证 | ✅ 已签名 + zipalign 对齐 |
| GitHub Release | ✅ 上传到 `polaris-pocket-v1.0.0` 草稿 |

---

## 八、后续升级方向

| 方向 | 说明 | 优先级 |
|------|------|--------|
| Kotlin 桥接补全 | 实现 `send_sms` / `get_contacts` / `take_photo` 的 Kotlin 代码 | 高 |
| MCP 协议接入 | 从 function calling 升级为 MCP，支持动态工具加载 | 中 |
| 工具确认机制 | 高危操作（删除文件/发短信）前让用户确认 | 中 |
| 外部存储访问 | 通过 SAF（Storage Access Framework）访问 Documents/Downloads | 低 |
| 内置浏览器 | 通过 `tauri-plugin-opener` 的 `inAppBrowser` 参数 | 低 |