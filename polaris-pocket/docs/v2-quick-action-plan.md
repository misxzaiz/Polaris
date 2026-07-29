# Pocket v2 改造方案 — Quick Action 方向

> 基于 OpenMinis 架构对标分析，面向普通用户的 AI 生活助手
> 详见：`docs/v2-technical-plan.md`

---

## 一、核心定位

**Polaris Pocket = 普通人的 AI 生活助手**（不是聊天工具，不是开发者工具）

核心价值：语音驱动，解决真实生活问题，零服务器依赖。

---

## 二、OpenMinis 架构对标

```
OpenMinis 技术栈                    Pocket 现有                       Pocket v2
────────────────────               ────────────                      ──────────
iOS/Android Native App            Tauri 2.0 (Rust+React)             Tauri + Android Kotlin 桥接
├─ SwiftUI UI                     ├─ React 19 UI                     ├─ 首页(语音+文档+待办+导航)
├─ Chat ViewModel                 ├─ ChatPage (流式对话)              ├─ 语音输入组件
├─ Linux Sandbox (iSH/PRoot)     ├─ Pocket Chat Proxy (AI API)       ├─ 文档生成(JS库: docx/pptxgenjs)
├─ Native Offload (22个 Handler)  ├─ pocket_tools.rs (18工具)         ├─ Offload Handlers(日历/闹钟/无障碍/视觉)
└─ Accessibility Service          └─ 已有 18 工具                     └─ Accessibility Service(Kotlin)
```

**关键差异**：
- OpenMinis 需要沙箱是因为让 AI 在 Linux 里跑脚本 → Pocket 不需要，直接用 Offload 调用原生 API
- OpenMinis Offload = execve 拦截 + JSON pipe → Pocket = Tauri invoke + JNI 桥接（更简单）
- OpenMinis 22 个 Handler = Objective-C/JNI → Pocket = Rust + Kotlin JNI

---

## 三、需要新增的 Offload Handlers（借鉴 OpenMinis）

### 优先级排序

| 优先级 | Handler | 对应 OpenMinis | 技术实现 | 用户场景 |
|--------|---------|---------------|----------|---------|
| 🔴 P0 | **文档生成** | 无（Pocket 独有） | 前端 docx/pptxgenjs | "帮我写周报"→ .docx |
| 🔴 P0 | **闹钟/提醒** | AlarmOffload | AlarmManager（Kotlin） | "5分钟后提醒我" |
| 🔴 P0 | **日历** | CalendarOffload | CalendarContract（Kotlin） | "今天下午3点开会" |
| 🔴 P0 | **语音输入** | SpeechOffload | Web Speech API | 按住说话，松手执行 |
| 🔴 P0 | **待办管理** | 无（Pocket 独有） | localStorage + 通知 | "帮我记录今天要做的事" |
| 🟡 P1 | **视觉辅助** | VisionOffload | CameraX + AI 多模态 | 盲人导航：摄像头识别+语音播报 |
| 🟡 P1 | **无障碍自动化** | AccessibilityService | Kotlin AccessibilityService | AI 帮你操作手机 |
| 🟢 P2 | **健康数据** | HealthKitOffload | HealthConnect（Kotlin） | "今天走了多少步" |
| 🟢 P2 | **通讯录** | ContactsOffload | ContactsContract（Kotlin） | "给张三打电话" |
| 🔵 P3 | **悬浮窗** | 悬浮窗状态 | System Alert Window | 后台执行状态显示 |

### Offload 桥接模式（核心）

```
OpenMinis:
沙箱 execve → native_offload.c 拦截 → JSON pipe → Objective-C Handler → iOS Framework

Pocket:
前端 tool_use → Tauri invoke → Rust 命令 → JNI → Kotlin Bridge → Android API
```

---

## 四、前端页面改造（具体文件）

### 4.1 新页面

```
polaris-pocket/src/
├── App.tsx                     ← 修改：TabBar 改为 4 个 Tab
├── pages/
│   ├── HomePage.tsx            ← 新增：首页（语音+提醒+文档+导航卡片）
│   ├── ChatPage.tsx            ← 保留：AI 对话（降级为辅助功能）
│   ├── TodoPage.tsx            ← 新增：待办管理
│   ├── DocumentPage.tsx        ← 新增：文档生成/管理
│   └── SettingsPage.tsx        ← 保留：设置
├── components/
│   ├── VoiceInput.tsx          ← 新增：按住说话（全屏麦克风 UI）
│   ├── BottomSheet.tsx         ← 新增：通用底部抽屉
│   ├── DocGenerator.tsx        ← 新增：文档生成 Sheet（Word/PPT/TXT）
│   ├── TodoCard.tsx            ← 新增：待办卡片
│   ├── ReminderCard.tsx        ← 新增：提醒卡片
│   └── BlindNav.tsx            ← 新增：盲人导航摄像头界面
```

### 4.2 首页布局

```
┌─────────────────────────┐
│  上午好，今天周三 👋     │
├─────────────────────────┤
│   [ 🎙 按住说话 ]       │  ← VoiceInput（大圆环）
├─────────────────────────┤
│  📋 待办（3项）          │
│  · 上午10点开会          │  ← TodoCard
│  · 下午写周报            │
│  · 晚上取快递            │
├─────────────────────────┤
│  ⏰ 提醒（2个）          │
│  · 5分钟后拿快递         │  ← ReminderCard
│  · 1小时后喝水           │
├─────────────────────────┤
│  [📄文档] [👁导航]       │  ← QuickActions（2x2）
│  [📷拍照] [🔧更多]       │
└─────────────────────────┘
```

### 4.3 语音输入组件

```typescript
// components/VoiceInput.tsx
// 使用 Web Speech API（浏览器内置，不需要服务器）

export function VoiceInput({ onTranscript }: { onTranscript: (text: string) => void }) {
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const startRecording = () => {
    const rec = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    rec.lang = 'zh-CN';
    rec.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map(r => r[0].transcript).join('');
      onTranscript(transcript);
    };
    rec.start();
    recognitionRef.current = rec;
    setIsRecording(true);
  };

  return (
    <button onTouchStart={startRecording} onTouchEnd={() => recognitionRef.current?.stop()}>
      🎙 按住说话
    </button>
  );
}
```

### 4.4 文档生成组件

```typescript
// components/DocGenerator.tsx
import { Document, Packer, Paragraph, TextRun } from 'docx';

export function generateWord(content: string): Blob {
  const doc = new Document({
    sections: [{ children: content.split('\n').map(line =>
      new Paragraph({ children: [new TextRun({ text: line })] })
    )}],
  });
  return Packer.toBlob(doc);
}

// 用户流程：
// 1. 点击"文档"卡片
// 2. 底部弹出 Sheet
// 3. 选择 Word/PPT/TXT
// 4. 输入描述："帮我写一份项目总结"
// 5. AI 生成 Markdown
// 6. JS 库转成 .docx
// 7. 下载到手机
```

---

## 五、Rust 后端改造

### 5.1 新增文件

```
polaris-pocket/src-tauri/src/
├── pocket_offload.rs     ← 新增：Offload 统一入口（22 个命令）
├── pocket_document.rs    ← 新增：文档文件存储
└── pocket_alarm.rs       ← 新增：定时任务
```

### 5.2 pocket_offload.rs 命令注册

```rust
#[tauri::command]
pub fn offload_calendar_create(title: String, start: String, end: String) -> Result<String, String> {
    // JNI → PocketCalendarBridge.createEvent → CalendarContract
    // 参考 Tauri 2.0 Android JNI 模式
    Ok(format!("日历事件已创建: {}", title))
}

#[tauri::command]
pub fn offload_alarm_schedule(title: String, message: String, delay_seconds: u64) -> Result<String, String> {
    // 方案 A：Rust setTimeout + tauri-plugin-notification（简单）
    // 方案 B：JNI → AlarmManager（持久化）
    Ok(format!("{}秒后提醒: {}", delay_seconds, title))
}

#[tauri::command]
pub fn offload_accessibility_ui_tree() -> Result<String, String> {
    // JNI → PocketAccessibilityBridge.getUiThread()
    // 返回 UI 树 JSON
    Ok("{}")
}

#[tauri::command]
pub fn offload_accessibility_click(x: f64, y: f64) -> Result<String, String> {
    // JNI → PocketAccessibilityBridge.clickAt(x, y)
    Ok(format!("已点击 ({}) ({})", x, y))
}
```

### 5.3 lib.rs 注册新命令

```rust
// 在 generate_handler! 中添加
.invoke_handler(tauri::generate_handler![
    // 现有命令...
    // 新增 Offload 命令
    pocket_offload::offload_calendar_create,
    pocket_offload::offload_alarm_schedule,
    pocket_offload::offload_accessibility_ui_tree,
    pocket_offload::offload_accessibility_click,
    pocket_document::document_download,
])
```

---

## 六、Android Kotlin 桥接层

### 6.1 目录结构

```
polaris-pocket/src-tauri/android/
├── CalendarBridge.kt          ← 日历
├── AlarmBridge.kt             ← 闹钟
├── VisionBridge.kt            ← 相机
├── PocketAccessibilityService.kt ← 无障碍服务
├── PocketAccessibilityBridge.kt  ← 无障碍查询
├── ContactBridge.kt           ← 通讯录
└── HealthBridge.kt            ← 健康
```

### 6.2 AlarmBridge.kt（核心）

```kotlin
class PocketAlarmBridge {
    companion object {
        @JvmStatic
        fun scheduleAlarm(context: Context, title: String, message: String, atMs: Long) {
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

// PocketAlarmReceiver.kt — 收到闹钟时发通知
class PocketAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val title = intent.getStringExtra("title")
        val message = intent.getStringExtra("message")
        NotificationCompat.Builder(context, "pocket_channel")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(message)
            .setPriority(NotificationCompat.Priority_HIGH)
            .build()
        NotificationManagerCompat.from(context).notify(intent.hashCode(), notification)
    }
}
```

### 6.3 PocketAccessibilityService.kt（核心）

```kotlin
class PocketAccessibilityService : AccessibilityService() {
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 监听 UI 事件，实时获取界面信息
        val root = rootInActiveWindow
        val tree = extractUiTreeJson(root)
        sendToTauri(tree)  // 通过 Tauri 通道发送给前端
    }

    private fun extractUiTreeJson(node: AccessibilityNodeInfo?): String {
        // 递归提取 UI 树：控件类型、文本、边界框、是否可点击
        // 返回 JSON 给前端
        TODO()
    }

    private fun sendToTauri(json: String) {
        // 参考 @tauri-apps/plugin-barcode-scanner 的实现
    }
}

// PocketAccessibilityBridge.kt — 主动查询 UI
class PocketAccessibilityBridge {
    companion object {
        @JvmStatic
        fun getUiThread(): String {
            val service = getService()
            return extractUiTreeJson(service.rootInActiveWindow)
        }

        @JvmStatic
        fun clickAt(x: Float, y: Float): Boolean {
            val service = getService()
            val gesture = AccessibilityGestureDescription.Builder()
                .addStroke(AccessibilityGestureDescription.StrokeDescription(
                    Path().apply { moveTo(x, y) }, 0, 100
                )).build()
            return service.dispatchGesture(gesture, null, null)
        }
    }
}
```

### 6.4 AndroidManifest.xml 权限

```xml
<uses-permission android:name="android.permission.READ_CALENDAR"/>
<uses-permission android:name="android.permission.WRITE_CALENDAR"/>
<uses-permission android:name="android.permission.CAMERA"/>
<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
<uses-permission android:name="android.permission.BIND_ACCESSIBILITY_SERVICE"/>
<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW"/>
<uses-permission android:name="android.permission.READ_CONTACTS"/>

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

## 七、依赖安装

### npm

```bash
npm install docx pptxgenjs
```

### Tauri 插件（可能新增）

```toml
# Cargo.toml
tauri-plugin-fs = "2.0.0"    # 文件系统（文件选择/保存）
```

### Android Kotlin 依赖

```gradle
dependencies {
    implementation 'androidx.camera:camera-camera2:1.3.0'
    implementation 'androidx.health-connect:health-connect-client:1.1.0'
}
```

---

## 八、实现路线图

### Phase 1: 前端改造（2-3 天）
```
Day 1: HomePage + VoiceInput + App.tsx TabBar 改造
Day 2: TodoPage + DocumentPage + DocGenerator
Day 3: BottomSheet + 样式调整
```

### Phase 2: Rust 后端（1-2 天）
```
Day 4: pocket_offload.rs + pocket_document.rs + lib.rs 注册
Day 5: AlarmBridge.kt（闹钟）先做
```

### Phase 3: Android 原生能力（2-3 天）
```
Day 6-7: CalendarBridge + AccessibilityService
Day 8: VisionBridge + AndroidManifest 权限
```

### Phase 4: 优化
```
- 桌面端联动（局域网 WebSocket）
- 自定义快捷指令
- 社区分享
```

---

## 九、总结

| 维度 | OpenMinis | Pocket v2 |
|---|---|---|
| 用户定位 | 开发者/极客 | 普通人 |
| 核心技术 | Linux 沙箱 + 脚本 | Offload 桥接原生 API |
| 文档生成 | ❌ | ✅ 核心功能 |
| 待办管理 | ❌ | ✅ 核心功能 |
| 盲人导航 | ❌ | ✅ 摄像头 + AI 多模态 |
| 无障碍自动化 | ✅ | ✅ 借鉴 |
| 服务器依赖 | 零 | 零 |

**Pocket v2 的核心价值**：
1. 语音驱动的 AI 生活助手（不是聊天工具）
2. 文档生成（普通人最需要）
3. 盲人导航/视觉辅助（社会价值）
4. 零服务器，隐私优先
