# Pocket v2 技术方案（基于 OpenMinis 架构对标）

> 参考：`../../docs/references/openminis-technical-summary.md`
> 目标：面向普通用户的 AI 生活助手，零服务器，设备端完成一切

---

## 一、OpenMinis 架构 → Pocket 架构映射（核心）

### 1.1 架构对标

```
OpenMinis                    Pocket（现有）               Pocket v2（改造）
─────────                    ──────────                   ──────────
iOS/Android Native App      Tauri 2.0 (Rust+React)       Tauri 2.0 + Android Kotlin 桥接
├─ SwiftUI UI               ├─ React 19 UI               ├─ 新增首页(文档/待办/导航)
├─ Chat ViewModel           ├─ ChatPage (流式对话)        ├─ 新增语音输入组件
├─ Linux Sandbox (iSH)      ├─ Pocket Chat Proxy (AI)     ├─ 新增文档生成(JS库)
├─ Native Offload (22个)    ├─ pocket_tools.rs (18工具)  ├─ 新增 Offload Handlers
└─ Accessibility Service    └─ 已有 18 个工具             └─ 新增无障碍自动化(Kotlin)
```

**关键差异**：
- OpenMinis 需要沙箱（iSH/PRoot），因为要让 AI 在 Linux 里跑脚本 → **Pocket 不需要**，面向普通人，直接用 Offload 调用原生 API
- OpenMinis 的 Offload 通过 `execve 拦截 + JSON pipe` → **Pocket 直接用 Tauri invoke + JNI 桥接**，更简单
- OpenMinis 的 22 个 Offload Handler 全部是 Objective-C/JNI → **Pocket 用 Rust + Kotlin JNI**

### 1.2 Offload 桥接模式（核心架构）

OpenMinis 的模式（参考 `openminis-technical-summary.md §4.1`）：
```
沙箱 execve → native_offload.c 拦截 → JSON pipe → Objective-C Handler → iOS Framework
```

Pocket 的等价模式（更简单）：
```
前端 tool_use → Tauri invoke → Rust 命令 → JNI 桥接 → Android API
```

**代码对应关系**：

| OpenMinis 组件 | Pocket 现有等价 | Pocket v2 新增 |
|---|---|---|
| `native_offload.c` | `pocket_tools.rs` | `pocket_offload.rs`（统一入口） |
| `AppleCalendarHandler.m` | 无 | Kotlin `CalendarBridge.kt` |
| `AlarmOffload.m` | `tauri-plugin-notification` | Kotlin `AlarmBridge.kt`（AlarmManager） |
| `VisionOffload.m` | `take_photo_probe()` 占位 | Kotlin `VisionBridge.kt`（相机+AI多模态） |
| `AccessibilityService` | 无 | Kotlin `PocketAccessibilityService.kt` |

---

## 二、需要新增的 Android Kotlin 桥接层

### 2.1 目录结构

```
polaris-pocket/src-tauri/
├── src/
│   ├── pocket_tools.rs        ← 现有 18 工具（不动）
│   ├── pocket_offload.rs      ← 新增：Offload 统一入口（22 个命令）
│   ├── pocket_document.rs     ← 新增：文档生成 Rust 端
│   └── pocket_alarm.rs        ← 新增：定时任务 Rust 端
├── android/                   ← 新增：Kotlin 桥接层
│   ├── CalendarBridge.kt      ← 日历（CalendarContract）
│   ├── AlarmBridge.kt         ← 闹钟（AlarmManager）
│   ├── VisionBridge.kt        ← 相机+视觉识别
│   ├── HealthBridge.kt        ← 健康（HealthConnect）
│   ├── AccessibilityBridge.kt ← 无障碍自动化
│   ├── ContactBridge.kt       ← 通讯录
│   └── PocketAccessibilityService.kt ← Accessibility Service
└── build.rs                   ← 修改：编译 Kotlin + JNI
```

### 2.2 Kotlin 桥接模板（以 CalendarBridge 为例）

```kotlin
// PocketCalendarBridge.kt
class PocketCalendarBridge {
    companion object {
        @JvmStatic
        fun createEvent(context: Context, title: String, startMs: Long, endMs: Long, location: String?): String {
            val calendarId = getOrCreateCalendar(context)
            val event = ContentValues().apply {
                put(CalendarContract.Events.CALENDAR_ID, calendarId)
                put("title", title)
                put("beginTime", startMs)
                put("endTime", endMs)
                if (location != null) put("eventLocation", location)
            }
            val uri = context.contentResolver.insert(
                CalendarContract.Events.CONTENT_URI, event
            )
            return uri?.lastPathSegment ?: "null"
        }
    }
}
```

### 2.3 Rust 端 JNI 调用（以创建日历事件为例）

```rust
// pocket_offload.rs
#[tauri::command]
pub fn offload_calendar_create(
    app: tauri::AppHandle,
    title: String,
    start: String,
    end: String,
    location: Option<String>,
) -> Result<String, String> {
    // 通过 JNI 调用 Kotlin 端 PocketCalendarBridge.createEvent
    // Tauri 2.0 Android 已有成熟的 JNI 调用方式
    // 参考 @tauri-apps/plugin-haptics 的实现
    let start_ms = parse_date_to_ms(&start)?;
    let end_ms = parse_date_to_ms(&end)?;
    
    // jni_call!(PocketCalendarBridge, createEvent, context, title, start_ms, end_ms, location)
    // 具体 JNI 调用方式参考 Tauri 2.0 Android 插件
    Ok(format!("日历事件已创建: {} ({})", title, start))
}
```

---

## 三、前端改造方案（具体到文件）

### 3.1 页面结构重构

**现有**：`App.tsx` 三个 Tab（AI/空间/设置）
**改造后**：

```
polaris-pocket/src/
├── App.tsx                     ← 修改：TabBar 改为 4 个 Tab
├── pages/
│   ├── HomePage.tsx            ← 新增：首页（语音+提醒+文档+导航卡片）
│   ├── ChatPage.tsx            ← 保留：AI 对话（降级，不是主入口）
│   ├── TodoPage.tsx            ← 新增：待办管理
│   ├── DocumentPage.tsx        ← 新增：文档生成/管理
│   └── SettingsPage.tsx        ← 保留：设置
├── components/
│   ├── VoiceInput.tsx          ← 新增：按住说话组件（全屏麦克风 UI）
│   ├── BottomSheet.tsx         ← 新增：通用底部抽屉
│   ├── DocGenerator.tsx        ← 新增：文档生成 Sheet（Word/PPT/TXT）
│   ├── TodoCard.tsx            ← 新增：待办卡片
│   ├── ReminderCard.tsx        ← 新增：提醒卡片
│   └── BlindNav.tsx            ← 新增：盲人导航摄像头界面
```

### 3.2 首页（HomePage.tsx）核心组件

```typescript
// 首页顶部：语音输入（大圆环按住说话）
<VoiceInput onTranscript={(text) => handleVoiceInput(text)} />

// 中部：待办 + 提醒卡片
<RemindersList reminders={loadReminders()} />
<TodosList todos={loadTodos()} />

// 底部：功能卡片（2x2 网格）
<QuickActions>
  <ActionCard icon="📄" label="文档" onClick={() => setShowDocSheet(true)} />
  <ActionCard icon="👁" label="导航" onClick={() => setShowNav(true)} />
  <ActionCard icon="📷" label="拍照识别" onClick={() => setShowVision(true)} />
  <ActionCard icon="🔧" label="更多" onClick={() => setShowTools(true)} />
</QuickActions>
```

### 3.3 语音输入（VoiceInput.tsx）

```typescript
// 使用 Web Speech API（浏览器内置，不需要服务器）
// 参考：https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition

export function VoiceInput({ onTranscript }: { onTranscript: (text: string) => void }) {
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const startRecording = () => {
    if (!('SpeechRecognition' in window)) return;
    const rec = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    
    rec.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map(r => r[0].transcript)
        .join('');
      onTranscript(transcript);
    };
    
    rec.start();
    recognitionRef.current = rec;
    setIsRecording(true);
  };

  const stopRecording = () => {
    recognitionRef.current?.stop();
    setIsRecording(false);
  };

  return (
    <button
      onTouchStart={startRecording}
      onTouchEnd={stopRecording}
      className={`w-[80px] h-[80px] rounded-full flex items-center justify-center ${
        isRecording ? 'bg-primary animate-pulse' : 'bg-background-surface'
      }`}
    >
      <MicrophoneIcon />
    </button>
  );
}
```

### 3.4 文档生成（DocGenerator.tsx）

```typescript
// 使用 docx 库（客户端生成 .docx）
// npm install docx

import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, Cell, Row } from 'docx';

export function generateWordDocument(content: string): Blob {
  const doc = new Document({
    sections: [{
      properties: {},
      children: content.split('\n').map(line => {
        if (line.startsWith('# ')) {
          return new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: line.slice(2), size: 32, bold: true })],
          });
        } else if (line.startsWith('## ')) {
          return new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun({ text: line.slice(3), size: 26, bold: true })],
          });
        } else {
          return new Paragraph({
            children: [new TextRun({ text: line, size: 22 })],
          });
        }
      }),
    }],
  });

  return Packer.toBlob(doc);
}

// PPT 生成用 pptxgenjs
// import PptxGenJS from 'pptxgenjs';
```

---

## 四、Android Kotlin 桥接层（具体实现）

### 4.1 AlarmBridge.kt（闹钟/提醒）

```kotlin
// 使用 Android AlarmManager + BroadcastReceiver
class PocketAlarmBridge {
    companion object {
        @JvmStatic
        fun scheduleAlarm(
            context: Context,
            title: String,
            message: String,
            atMs: Long
        ) {
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val intent = Intent(context, PocketAlarmReceiver::class.java).apply {
                putExtra("title", title)
                putExtra("message", message)
            }
            val pendingIntent = PendingIntent.getBroadcast(
                context, atMs.hashCode(), intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            alarmManager.set(AlarmManager.RTC_WAKEUP, atMs, pendingIntent)
        }
    }
}

// PocketAlarmReceiver.kt
class PocketAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val title = intent.getStringExtra("title") ?: "提醒"
        val message = intent.getStringExtra("message") ?: ""
        
        val notification = NotificationCompat.Builder(context, "pocket_channel")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(message)
            .setPriority(NotificationCompat.Priority_HIGH)
            .build()
        
        NotificationManagerCompat.from(context)
            .notify(intent.hashCode(), notification)
    }
}
```

### 4.2 VisionBridge.kt（相机 + 拍照）

```kotlin
// 使用 Android CameraX（Tauri 2.0 插件可能不够用）
class PocketVisionBridge {
    companion object {
        @JvmStatic
        fun takePhoto(context: Context): String? {
            // 使用 CameraX ImageCapture
            // 返回 base64 或文件路径
            TODO("CameraX ImageCapture 实现")
        }
    }
}
```

**替代方案**：直接用 Tauri 的 `@tauri-apps/plugin-camera`（如果可用），比 JNI 简单。

### 4.3 PocketAccessibilityService.kt（无障碍自动化）

```kotlin
// 这是 OpenMinis 最值得借鉴的能力
class PocketAccessibilityService : AccessibilityService() {
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 监听 UI 事件，实时获取界面信息
        val root = rootInActiveWindow
        val tree = extractUiTree(root)  // 提取 UI 树为 JSON
        // 通过 Tauri 通道发送给前端
        sendToTauri(tree)
    }

    override fun onInterrupt() {
        // 无障碍服务被中断
    }

    private fun extractUiTree(node: AccessibilityNodeInfo?): String {
        // 递归提取 UI 树，返回 JSON
        // 包含：控件类型、文本、边界框、是否可点击
        TODO()
    }

    private fun sendToTauri(json: String) {
        // 通过 Tauri 的 Android 通道发送到前端
        // 参考 @tauri-apps/plugin-barcode-scanner 的实现
    }
}

// AccessibilityInfo.kt — 主动查询 UI 树
class PocketAccessibilityBridge {
    companion object {
        @JvmStatic
        fun getUiThread(): String {
            val service = getAccessibilityService()  // 获取已绑定的服务实例
            val root = service.rootInActiveWindow
            return extractUiTreeJson(root)
        }

        @JvmStatic
        fun clickAt(x: Float, y: Float): Boolean {
            val service = getAccessibilityService()
            val gesture = AccessibilityGestureDescription.Builder()
                .addStroke(AccessibilityGestureDescription.StrokeDescription(
                    Path().apply { moveTo(x, y) }, 0, 100
                )).build()
            return service.dispatchGesture(gesture, null, null)
        }
    }
}
```

**AndroidManifest.xml 配置**：
```xml
<service
    android:name=".PocketAccessibilityService"
    android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
    <intent-filter>
        <action android:name="android.accessibilityservice.AccessibilityService"/>
    </intent-filter>
    <meta-data
        android:name="android.accessibilityservice"
        android:resource="@xml/accessibility_service_config"/>
</service>
```

---

## 五、Rust 后端新增模块

### 5.1 pocket_offload.rs（Offload 统一入口）

```rust
use serde::{Deserialize, Serialize};
use tauri::Manager;

// ============================================================================
// Offload 命令（统一前缀：offload_）
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct CalendarCreateRequest {
    pub title: String,
    pub start: String,    // ISO 8601
    pub end: String,      // ISO 8601
    pub location: Option<String>,
}

#[tauri::command]
pub fn offload_calendar_create(
    app: tauri::AppHandle,
    req: CalendarCreateRequest,
) -> Result<String, String> {
    #[cfg(mobile)]
    {
        // JNI 调用 PocketCalendarBridge.createEvent
        // 实际实现参考 Tauri Android JNI 模板
        let result = /* jni_call! */ "success".to_string();
        Ok(result)
    }
    #[cfg(not(mobile))]
    { Err("仅移动端可用".to_string()) }
}

#[tauri::command]
pub fn offload_alarm_schedule(
    app: tauri::AppHandle,
    title: String,
    message: String,
    delay_seconds: u64,
) -> Result<String, String> {
    // 方案 A：前端 setTimeout + tauri-plugin-notification（简单，App 在前台时可用）
    // 方案 B：JNI 调用 AlarmManager（需要后台持久化）
    // 推荐方案 A，因为大多数提醒是 App 打开时设的
    #[cfg(mobile)]
    {
        // 通过 Rust 端发送通知（不需要 JNI）
        let notif = app.notify_notification(tauri::Manager::app_handle(&app));
        Ok(format!("{} 秒后提醒: {}", delay_seconds, title))
    }
    #[cfg(not(mobile))]
    { Err("仅移动端可用".to_string()) }
}

#[tauri::command]
pub fn offload_accessibility_ui_tree() -> Result<String, String> {
    #[cfg(mobile)]
    {
        // JNI 调用 PocketAccessibilityBridge.getUiThread()
        let result = /* jni_call! */ "{}".to_string();
        Ok(result)
    }
    #[cfg(not(mobile))]
    { Err("仅移动端可用".to_string()) }
}

#[tauri::command]
pub fn offload_accessibility_click(x: f64, y: f64) -> Result<String, String> {
    #[cfg(mobile)]
    {
        // JNI 调用 PocketAccessibilityBridge.clickAt(x, y)
        Ok(format!("已点击 ({}{})", x, y))
    }
    #[cfg(not(mobile))]
    { Err("仅移动端可用".to_string()) }
}

#[tauri::command]
pub fn offload_vision_capture() -> Result<String, String> {
    #[cfg(mobile)]
    {
        // JNI 调用 PocketVisionBridge.takePhoto()
        // 返回 base64 图片
        let result = /* jni_call! */ "";
        Ok(result)
    }
    #[cfg(not(mobile))]
    { Err("仅移动端可用".to_string()) }
}
```

### 5.2 pocket_document.rs（文档生成 Rust 端）

```rust
// 文档生成主要在前端用 JS 库完成，Rust 端只做文件存储
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[tauri::command]
pub fn document_download(
    app: tauri::AppHandle,
    filename: String,
    content_base64: String,
) -> Result<String, String> {
    // 将前端生成的 base64 文件存到手机存储
    // 触发系统文件分享（让用户选择保存位置）
    #[cfg(mobile)]
    {
        // 通过 Android Intent.ACTION_SEND 分享文件
        // 或者直接保存到 Downloads 目录
        let data_dir = app.path().app_data_dir().unwrap();
        let file_path = data_dir.join(&filename);
        let content = base64::decode(&content_base64).map_err(|e| e.to_string())?;
        fs::write(&file_path, content).map_err(|e| e.to_string())?;
        Ok(format!("文件已保存: {}", file_path.display()))
    }
    #[cfg(not(mobile))]
    { Err("仅移动端可用".to_string()) }
}
```

---

## 六、依赖安装清单

### 6.1 npm 包（新增）

```bash
# 文档生成
npm install docx                    # .docx 生成
npm install pptxgenjs               # .pptx 生成

# 类型定义
npm install --save-dev @types/docx
```

### 6.2 Tauri 插件（可能需要的）

```toml
# Cargo.toml
[dependencies]
# 已有的
tauri = { version = "2.11.1", features = ["mobile"] }
tauri-plugin-geolocation = "2.3.2"
tauri-plugin-notification = "2.3.3"
tauri-plugin-haptics = "2.3.2"
tauri-plugin-barcode-scanner = "2.4.5"
tauri-plugin-biometric = "2.3.2"
tauri-plugin-opener = "2.5.4"

# 可能需要新增
tauri-plugin-fs = "2.0.0"           # 文件系统（文件选择/保存）
tauri-plugin-shell = "2.0.0"        # Shell 命令（可能需要）
```

### 6.3 Android Kotlin 依赖

```gradle
// build.gradle
dependencies {
    implementation 'androidx.camera:camera-camera2:1.3.0'  // CameraX
    implementation 'androidx.camera:camera-lifecycle:1.3.0'
    implementation 'androidx.camera:camera-view:1.3.0'
    implementation 'androidx.health-connect:health-connect-client:1.1.0'  // HealthConnect
}
```

---

## 七、权限需求（AndroidManifest.xml）

```xml
<!-- 日历 -->
<uses-permission android:name="android.permission.READ_CALENDAR"/>
<uses-permission android:name="android.permission.WRITE_CALENDAR"/>

<!-- 相机（视觉辅助/拍照识别） -->
<uses-permission android:name="android.permission.CAMERA"/>

<!-- 通知（提醒） -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>

<!-- 无障碍（自动化操作手机） -->
<uses-permission android:name="android.permission.BIND_ACCESSIBILITY_SERVICE"/>

<!-- 悬浮窗（后台状态显示） -->
<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW"/>

<!-- 通讯录 -->
<uses-permission android:name="android.permission.READ_CONTACTS"/>

<!-- 健康 -->
<uses-permission android:name="android.permission.READ_HEALTH_DATA"/>
```

---

## 八、实现路线图（按优先级）

### Phase 1: 前端改造（2-3 天）
```
Day 1:
  ├── HomePage.tsx（首页：语音输入 + 卡片布局）
  ├── components/VoiceInput.tsx（语音输入组件）
  └── App.tsx 修改（TabBar 改为 4 个 Tab）

Day 2:
  ├── pages/TodoPage.tsx（待办管理）
  ├── pages/DocumentPage.tsx（文档管理）
  ├── components/DocGenerator.tsx（文档生成 Sheet）
  └── 安装 docx + pptxgenjs

Day 3:
  ├── components/BottomSheet.tsx（通用底部抽屉）
  └── 样式调整
```

### Phase 2: Rust 后端（1-2 天）
```
Day 4:
  ├── pocket_offload.rs（Offload 统一入口）
  ├── pocket_document.rs（文档文件存储）
  └── lib.rs 注册新命令

Day 5:
  ├── Android Kotlin 桥接层（AlarmBridge 先做）
  └── 编译配置（build.rs 支持 Kotlin）
```

### Phase 3: Android 原生能力（2-3 天）
```
Day 6-7:
  ├── PocketCalendarBridge.kt（日历）
  ├── PocketAlarmBridge.kt（闹钟/提醒）
  └── PocketAccessibilityService.kt（无障碍）

Day 8:
  ├── PocketVisionBridge.kt（相机）
  └── AndroidManifest.xml 权限配置
```

---

## 九、与 OpenMinis 的核心区别总结

| 维度 | OpenMinis | Pocket v2 |
|---|---|---|
| 用户定位 | 开发者/极客 | 普通人 |
| 核心技术 | Linux 沙箱 + 脚本执行 | Offload 桥接原生 API |
| 能力扩展 | SKILL.md + 脚本 | Tool Registry + Rust 命令 |
| 文档生成 | ❌ 无 | ✅ 核心功能（Word/PPT） |
| 待办管理 | ❌ 无 | ✅ 核心功能 |
| 盲人导航 | ❌ 无 | ✅ 摄像头 + AI 多模态 + TTS |
| 无障碍自动化 | ✅ Accessibility Service | ✅ 借鉴 OpenMinis |
| 服务器依赖 | 零 | 零 |
| 技术栈 | Swift/Kotlin + iSH/PRoot | Tauri 2.0 + Rust + Kotlin JNI |

**Pocket v2 的独特价值**：
1. 语音驱动的 AI 生活助手（不是聊天工具）
2. 文档生成（普通人最需要）
3. 盲人导航/视觉辅助（社会价值）
4. 零服务器，隐私优先
