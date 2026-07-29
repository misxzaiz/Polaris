/**
 * toolRegistry — 工具注册表
 *
 * 包含：
 * 1. 工具定义注册表（输入 schema + 描述）
 * 2. 前端工具处理器（浏览器 API，纯前端）
 * 3. 系统工具处理器（Tauri invoke → Rust 后端 → Android API）
 * 4. 协议适配器（Anthropic / OpenAI wireApi 格式转换）
 * 5. 工具可用性运行时探测
 *
 * 交叉对抗性审查修正：
 * - 工具输入有参数校验（JSON Schema 轻量校验）
 * - 单工具超时保护
 * - wireApi 感知（Anthropic tool_use vs OpenAI tool_calls 格式分离）
 * - 运行时可用性探测（不可用工具从注册表剔除，不发给模型）
 */

import type {
  ToolDefinition,
  ToolHandler,
  ToolCategory,
  ToolCapability,
  ToolAvailability,
  ProtocolAdapter,
  WireApi,
  ContentValue,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  MsgBlock,
} from "./toolTypes";

// ============================================================================
// 工具定义注册表
// ============================================================================

const SCHEMA_STRING = { type: "string" as const };
const SCHEMA_BOOLEAN = { type: "boolean" as const };
const SCHEMA_NUMBER = { type: "number" as const };
const SCHEMA_INTEGER = { type: "integer" as const };
const SCHEMA_ANY = { type: "string" as const };
const SCHEMA_OBJECT = (props: Record<string, Record<string, unknown>>) => ({
  type: "object" as const,
  properties: props,
  required: Object.keys(props),
});

// ============================================================================
// 待办数据层（localStorage，不与外部交互）
// ============================================================================

const TODO_LS_KEY = "pocket-todos";

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  dueAt?: number;
}

function loadTodos(): TodoItem[] {
  try {
    const raw = localStorage.getItem(TODO_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveTodos(todos: TodoItem[]): void {
  localStorage.setItem(TODO_LS_KEY, JSON.stringify(todos));
}

export const TOOL_REGISTRY: ToolDefinition[] = [
  // ---- 前端工具（纯浏览器 API） ----

  {
    name: "get_time",
    category: "frontend",
    icon: "🕐",
    description:
      "获取当前系统时间，包含时区、星期、日期。用于回答时间相关问题，或确认当前时刻。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_date",
    category: "frontend",
    icon: "📅",
    description:
      "获取今天的完整日期信息，包括年月日、星期、闰年判断、当月天数等。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_clipboard",
    category: "frontend",
    icon: "📋",
    description:
      "读取剪贴板中的文本内容。当用户粘贴内容需要查询时使用。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "write_clipboard",
    category: "frontend",
    icon: "📌",
    description:
      "将文本写入剪贴板。当用户需要复制内容到剪贴板时使用。",
    inputSchema: SCHEMA_OBJECT({ text: SCHEMA_STRING }),
  },
  {
    name: "get_location",
    category: "frontend",
    icon: "📍",
    description:
      "获取当前地理位置（经纬度、精度）。需要用户已授权位置权限。",
    inputSchema: {
      type: "object",
      properties: {
        precision: {
          type: "string",
          enum: ["low", "high"],
          description: "low=网络级(≈100m), high=GPS级(≈10m)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_device_orientation",
    category: "frontend",
    icon: "📐",
    description:
      "获取设备当前朝向/姿态（pitch/roll/heading）。需设备支持。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_battery",
    category: "frontend",
    icon: "🔋",
    description:
      "获取设备电量信息和充电状态（需 Battery Status API 支持）。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "speak_text",
    category: "frontend",
    icon: "🔊",
    description:
      "使用浏览器语音合成（TTS）朗读文本。支持语言参数。",
    inputSchema: SCHEMA_OBJECT({
      text: SCHEMA_STRING,
      lang: { type: "string", default: "zh-CN", description: "语言代码" },
    }),
  },
  {
    name: "vibrate",
    category: "frontend",
    icon: "📳",
    description:
      "触发设备震动。pattern 为震动/静默交替的毫秒数组。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "array",
          items: SCHEMA_INTEGER,
          description: "震动模式，如 [200, 100, 200] 表示震200ms-停100ms-震200ms",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "play_sound",
    category: "frontend",
    icon: "🔔",
    description: "播放浏览器可访问的音频文件（base64 或网络 URL）。",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string", description: "音频 base64 或 URL" },
        volume: { type: "number", minimum: 0, maximum: 1, description: "音量 0-1" },
      },
      required: ["data"],
    },
  },
  {
    name: "get_local_storage",
    category: "frontend",
    icon: "💾",
    description:
      "读取 localStorage 指定 key 的内容（调试用途）。omitKey 为真时返回所有 key。",
    inputSchema: {
      type: "object",
      properties: {
        key: SCHEMA_STRING,
        omitKey: { type: "boolean", description: "真则列出所有 key" },
      },
      required: [],
    },
  },
  {
    name: "get_applications",
    category: "frontend",
    icon: "📱",
    description:
      "获取已安装应用列表（PWA/Web App 列表）。仅在 Tauri mobile 中返回已安装应用包名。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_device_info",
    category: "system",
    icon: "🖥",
    description:
      "获取设备基本信息：型号、品牌、系统版本、屏幕分辨率、电池（如果可用）。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "take_photo",
    category: "system",
    icon: "📷",
    description:
      "调用相机拍照，返回图片 base64。需要 CAMERA 权限。",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["camera", "gallery"],
          default: "camera",
          description: "camera=实时拍摄, gallery=从相册选择",
        },
      },
      required: [],
    },
  },
  {
    name: "send_notification",
    category: "frontend",
    icon: "🔔",
    description: "发送一条 Android 系统通知（通知栏显示）。支持标题、内容和优先级。",
    inputSchema: SCHEMA_OBJECT({
      title: SCHEMA_STRING,
      body: SCHEMA_STRING,
      priority: {
        type: "string",
        enum: ["low", "normal", "high"],
        default: "normal",
      },
    }),
  },
  {
    name: "open_url",
    category: "frontend",
    icon: "🔗",
    description:
      "在浏览器或支持该 URL scheme 的应用中打开链接。",
    inputSchema: SCHEMA_OBJECT({ url: SCHEMA_STRING }),
  },
  {
    name: "copy_to_device_storage",
    category: "system",
    icon: "📁",
    description: "将文本保存为设备存储文件。",
    inputSchema: SCHEMA_OBJECT({
      filename: SCHEMA_STRING,
      content: SCHEMA_STRING,
      directory: { type: "string", default: "Documents" },
    }),
  },
  // ---- 生活助手工具（工具链新增，不改 UI） ----

  {
    name: "todo_add",
    category: "frontend",
    icon: "📝",
    description:
      "新增一条待办事项。text 是待办内容，dueAt 是可选截止时间（ISO 8601，如 2026-07-29T14:00:00）。不传 dueAt 则无截止提醒。",
    inputSchema: SCHEMA_OBJECT({
      text: SCHEMA_STRING,
      dueAt: {
        type: "string",
        description: "可选截止时间，ISO 8601 格式，如 2026-07-29T15:00:00",
      },
    }),
  },
  {
    name: "todo_list",
    category: "frontend",
    icon: "📋",
    description: "列出所有待办事项，显示完成状态、内容和截止时间。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "todo_done",
    category: "frontend",
    icon: "✅",
    description: "将指定待办事项标记为已完成。需要 todo_id。",
    inputSchema: SCHEMA_OBJECT({ todo_id: SCHEMA_STRING }),
  },
  {
    name: "todo_delete",
    category: "frontend",
    icon: "🗑",
    description: "删除指定待办事项。需要 todo_id。",
    inputSchema: SCHEMA_OBJECT({ todo_id: SCHEMA_STRING }),
  },
  {
    name: "generate_document",
    category: "frontend",
    icon: "📄",
    description:
      "生成一份 Word 文档（.docx），保存到设备并触发下载。content 是 Markdown 格式正文。格式仅支持 docx。",
    inputSchema: SCHEMA_OBJECT({
      content: {
        type: "string",
        description:
          "文档正文，支持 Markdown 语法（# 标题、- 列表、**加粗**、\n换行）。",
      },
      filename: {
        type: "string",
        description: "文件名，不含扩展名，如 '周报'。默认 '文档'",
      },
    }),
  },
  {
    name: "alarm_schedule",
    category: "frontend",
    icon: "⏰",
    description:
      "设置一次性提醒。delay_seconds 是从现在开始的延迟秒数（60-86400，即 1 分钟到 24 小时）。系统会在指定时间后发送一条通知。",
    inputSchema: SCHEMA_OBJECT({
      delay_seconds: {
        type: "integer",
        minimum: 60,
        maximum: 86400,
        description: "从现在起的延迟秒数，60-86400（1 分钟到 24 小时）",
      },
      title: { type: "string", description: "通知标题" },
      message: { type: "string", description: "通知内容" },
    }),
  },
  // ---- 文件管理工具（AI 可读取/搜索本地文件） ----
  {
    name: "file_list",
    category: "frontend",
    icon: "📂",
    description:
      "列出本地文件目录内容。path 是相对于应用私有目录的路径（如 'documents'），空字符串列出根目录。返回文件名、大小、修改时间、类型。",
    inputSchema: SCHEMA_OBJECT({
      path: { type: "string", description: "目录相对路径，空字符串=根目录" },
    }),
  },
  {
    name: "file_read",
    category: "frontend",
    icon: "📖",
    description:
      "读取本地文件内容（文本文件，如 .txt/.md/.json/.py/.js/.ts/.rs 等）。返回文件源码。path 是相对于应用私有目录的路径，如 'documents/周报.txt'。",
    inputSchema: SCHEMA_OBJECT({
      path: { type: "string", description: "文件相对路径，如 'documents/周报.txt'" },
    }),
  },
  {
    name: "contact_lookup",
    category: "system",
    icon: "👤",
    description:
      "查询通讯录联系人。phone_hint 提供时按电话号码过滤，否则返回全部联系人列表。需要 READ_CONTACTS 权限。",
    inputSchema: {
      type: "object",
      properties: {
        phone_hint: { type: "string", description: "可选电话号码关键字过滤" },
      },
      required: [],
    },
  },
  // ---- 前端新工具（纯浏览器 API，无需重新构建 APK） ----

  {
    name: "get_network_info",
    category: "frontend",
    icon: "📶",
    description:
      "获取当前网络连接信息：在线状态、连接类型（wifi/cellular/ethernet）、有效带宽、是否节流模式。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "evaluate_math",
    category: "frontend",
    icon: "🔢",
    description:
      "安全执行数学表达式计算，返回计算结果。支持四则运算、幂、三角函数、对数等。",
    inputSchema: SCHEMA_OBJECT({
      expression: {
        type: "string",
        description: "数学表达式，如 'Math.sin(30 * Math.PI / 180) + 2 ** 10'",
      },
    }),
  },
  {
    name: "get_battery_advanced",
    category: "frontend",
    icon: "🔋",
    description:
      "获取电池详细信息：电量、充电状态、剩余时间（估算）、放电时间（估算）。需 Battery Status API。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "memory_info",
    category: "frontend",
    icon: "🧠",
    description:
      "获取设备内存信息：总内存、可用内存、已用百分比（需 device-memory API 支持）。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "screen_info",
    category: "frontend",
    icon: "🖥",
    description:
      "获取屏幕信息：分辨率、色深、像素比、视口尺寸。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "language_info",
    category: "frontend",
    icon: "🌐",
    description:
      "获取用户语言偏好和系统语言设置信息。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_online_status",
    category: "frontend",
    icon: "🌐",
    description:
      "检测设备当前是否在线（网络连通性）。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  // ---- Android 原生插件工具（前端 JS 调用） ----

  {
    name: "vibrate_native",
    category: "frontend",
    icon: "📳",
    description:
      "Android 原生震动反馈（比 navigator.vibrate 更可靠）。支持持续时长和反馈类型。",
    inputSchema: {
      type: "object",
      properties: {
        duration: { type: "integer", description: "震动时长（毫秒），1-1000", default: 100 },
        style: { type: "string", enum: ["vibrate", "impact", "notification", "selection"], default: "vibrate", description: "震动风格" },
      },
      required: [],
    },
  },
  {
    name: "scan_barcode",
    category: "frontend",
    icon: "📷",
    description:
      "扫描二维码或条形码。需要 CAMERA 权限。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  // ---- 系统工具（Rust/Kotlin 后端） ----
  {
    name: "send_sms",
    category: "system",
    icon: "💬",
    description:
      "发送短信。需 SEND_SMS 权限。",
    inputSchema: SCHEMA_OBJECT({
      phone: { type: "string", description: "手机号" },
      message: { type: "string", description: "短信内容" },
    }),
  },
  {
    name: "get_contacts",
    category: "system",
    icon: "👤",
    description:
      "获取设备联系人列表。需 READ_CONTACTS 权限。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  // ---- 文件系统工具（Rust std::fs 后端，需重新构建 APK） ----
  {
    name: "read_file",
    category: "system",
    icon: "📖",
    description:
      "读取应用私有目录中的文件内容（UTF-8 文本）。路径基于应用私有目录。",
    inputSchema: SCHEMA_OBJECT({
      path: { type: "string", description: "文件相对路径，如 notes/hello.txt" },
    }),
  },
  {
    name: "write_file",
    category: "system",
    icon: "✏️",
    description:
      "写入文本到应用私有目录中的文件（UTF-8）。自动创建父目录。",
    inputSchema: SCHEMA_OBJECT({
      path: { type: "string", description: "文件相对路径" },
      content: { type: "string", description: "文件内容" },
    }),
  },
  {
    name: "list_files",
    category: "system",
    icon: "📂",
    description:
      "列出应用私有目录中的文件和文件夹。空字符串列出根目录。",
    inputSchema: SCHEMA_OBJECT({
      path: { type: "string", description: "目录相对路径，空字符串=根目录" },
    }),
  },
  {
    name: "delete_file",
    category: "system",
    icon: "🗑",
    description:
      "删除文件或空目录。递归删除目录需设 recursive=true。",
    inputSchema: SCHEMA_OBJECT({
      path: { type: "string", description: "路径相对路径" },
      recursive: { type: "boolean", description: "是否递归删除目录" },
    }),
  },
  {
    name: "create_directory",
    category: "system",
    icon: "📁",
    description:
      "创建目录（自动创建父目录）。路径基于应用私有目录。",
    inputSchema: SCHEMA_OBJECT({
      path: { type: "string", description: "目录相对路径" },
    }),
  },
  {
    name: "file_exists",
    category: "system",
    icon: "🔍",
    description:
      "检查文件或目录是否存在于应用私有目录中。",
    inputSchema: SCHEMA_OBJECT({
      path: { type: "string", description: "路径相对路径" },
    }),
  },
  {
    name: "get_file_size",
    category: "system",
    icon: "📏",
    description:
      "获取文件或目录的大小和修改时间信息。",
    inputSchema: SCHEMA_OBJECT({
      path: { type: "string", description: "路径相对路径" },
    }),
  },
];

// ============================================================================
// 工具处理器
// ============================================================================

const FRONTEND_TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_time: async () => {
    const now = new Date();
    const weekday = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
    return {
      content: `当前时间：${now.toLocaleString("zh-CN", {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })}（星期${weekday}）\n时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    };
  },

  get_date: async () => {
    const now = new Date();
    const isLeap =
      (now.getFullYear() % 4 === 0 && now.getFullYear() % 100 !== 0) ||
      now.getFullYear() % 400 === 0;
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysOfYear = Math.floor(
      (now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000
    ) + 1;
    return {
      content: `今天：${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（第 ${daysOfYear} 天）\n当月共 ${daysInMonth} 天\n${isLeap ? "闰年" : "平年"}`,
    };
  },

  read_clipboard: async () => {
    try {
      const text = await navigator.clipboard.readText();
      return { content: text || "剪贴板为空" };
    } catch {
      return { content: "剪贴板不可读（页面非安全上下文或未获授权）", is_error: true };
    }
  },

  write_clipboard: async (input) => {
    const text = input.text as string;
    if (!text) return { content: "写入内容为空", is_error: true };
    try {
      await navigator.clipboard.writeText(text);
      return { content: `已将 ${text.slice(0, 60)}${text.length > 60 ? "..." : ""} 写入剪贴板` };
    } catch {
      return { content: "写入剪贴板失败（页面非安全上下文）", is_error: true };
    }
  },

  get_location: async (input) => {
    // Tauri 环境：优先使用原生 tauri-plugin-geolocation（FusedLocationProviderClient），
    // 彻底解决 WebView 自定义协议下 navigator.geolocation 不可靠/超时的根因
    try {
      const {
        requestPermissions,
        getCurrentPosition,
      } = await import("@tauri-apps/plugin-geolocation");

      const permission = await requestPermissions(["location"]);
      if (permission?.location !== "granted") {
        return {
          content: "位置权限未授予。请在 Android 设置 → 应用 → Polaris Pocket → 权限 → 位置 中开启。",
          is_error: true,
        };
      }
      const high = (input.precision as string) === "high";
      const pos = await getCurrentPosition({
        enableHighAccuracy: high,
        timeout: 10000,
        maximumAge: 300000,
      });
      const { latitude, longitude, accuracy, altitude, speed } = pos.coords;
      let result = `纬度：${latitude.toFixed(6)}\n经度：${longitude.toFixed(6)}\n精度：±${accuracy.toFixed(1)} 米`;
      if (altitude != null) result += `\n海拔：${altitude.toFixed(1)} 米`;
      if (speed != null) result += `\n移动速度：${speed.toFixed(1)} m/s`;
      return { content: result };
    } catch {
      // 插件不可用时（桌面/开发环境）回退到 navigator.geolocation
    }
    if (!navigator.geolocation) {
      return { content: "此浏览器不支持地理位置 API", is_error: true };
    }
    const high = (input.precision as string) === "high";
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy, altitude, speed } = pos.coords;
          let result = `纬度：${latitude.toFixed(6)}\n经度：${longitude.toFixed(6)}\n精度：±${accuracy.toFixed(1)} 米`;
          if (altitude != null) result += `\n海拔：${altitude.toFixed(1)} 米`;
          if (speed != null) result += `\n移动速度：${speed.toFixed(1)} m/s`;
          resolve({ content: result });
        },
        (err) => {
          const msg = err.code === 1
            ? "位置权限被拒绝，请在设置中允许"
            : err.code === 2
            ? "无法获取位置（定位信号弱）"
            : "定位超时";
          resolve({ content: msg, is_error: true });
        },
        { enableHighAccuracy: high, timeout: 10000, maximumAge: 300000 }
      );
    });
  },

  get_device_orientation: async () => {
    const result = await new Promise<{ alpha: number; beta: number; gamma: number; absolute: boolean }>((resolve, reject) => {
      const onEvent = (e: DeviceOrientationEvent) => {
        window.removeEventListener("deviceorientation", onEvent);
        resolve({
          alpha: Math.round((e.alpha ?? 0) * 10) / 10,
          beta: Math.round((e.beta ?? 0) * 10) / 10,
          gamma: Math.round((e.gamma ?? 0) * 10) / 10,
          absolute: !!e.absolute,
        });
      };
      window.addEventListener("deviceorientation", onEvent);
      setTimeout(() => {
        window.removeEventListener("deviceorientation", onEvent);
        reject(new Error("超时"));
      }, 3000);
    });
    if (!result.alpha && !result.beta && !result.gamma) {
      return { content: "设备朝向传感器数据均为 0，可能不支持或未开启", is_error: true };
    }
    return {
      content: `朝向（Alpha）：${result.alpha}°\n前后倾斜（Beta）：${result.beta}°\n左右倾斜（Gamma）：${result.gamma}°\n绝对参考：${result.absolute ? "是" : "否"}`,
    };
  },

  get_battery: async () => {
    if (!("getBattery" in navigator)) {
      return { content: "此浏览器不支持 Battery Status API", is_error: true };
    }
    const battery = await (navigator as { getBattery?: () => Promise<any> }).getBattery?.();
    if (!battery) return { content: "获取电池信息失败", is_error: true };
    return {
      content: `电量：${Math.round((battery.level ?? 0) * 100)}%\n充电中：${(battery.charging ?? false) ? "是" : "否"}`,
    };
  },

  speak_text: async (input) => {
    const text = input.text as string;
    const lang = (input.lang as string) || "zh-CN";
    if (!("speechSynthesis" in window)) {
      return { content: "此浏览器不支持语音合成", is_error: true };
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang;
    utter.rate = 1;
    window.speechSynthesis.speak(utter);
    return { content: `已开始朗读（${lang}）：${text.slice(0, 40)}${text.length > 40 ? "..." : ""}` };
  },

  vibrate: async (input) => {
    const pattern = input.pattern as number[];
    if (!("vibrate" in navigator)) {
      return { content: "此设备不支持震动", is_error: true };
    }
    // 截断总时长
    const safe = pattern
      .map((n) => Math.max(0, Math.min(n, 5000)))
      .slice(0, 100);
    (navigator as { vibrate?: (p: number[]) => void }).vibrate?.(safe);
    return { content: `震动模式：[${safe.join(", ")} ms]` };
  },

  play_sound: async (input) => {
    const data = input.data as string;
    const volume = (input.volume as number) ?? 1;
    try {
      const audio = new Audio();
      audio.volume = Math.max(0, Math.min(1, volume));
      audio.src = data;
      audio.play().catch(() => {
        return { content: "音频播放失败（可能被浏览器阻止）", is_error: true };
      });
      return { content: `已开始播放音频（音量：${volume}）` };
    } catch {
      return { content: "创建音频对象失败", is_error: true };
    }
  },

  get_local_storage: async (input) => {
    if ((input.omitKey as boolean)) {
      const keys = Object.keys(localStorage);
      return {
        content: keys.length === 0 ? "localStorage 为空" : `共 ${keys.length} 个 key：\n${keys.slice(0, 30).join(", ")}${keys.length > 30 ? `\n（还有 ${keys.length - 30} 个）` : ""}`,
      };
    }
    const key = input.key as string;
    if (!key) return { content: "请指定要读取的 key", is_error: true };
    const val = localStorage.getItem(key);
    return {
      content: val === null ? `key "${key}" 不存在` : `key "${key}" 的值：\n${val.slice(0, 500)}${val.length > 500 ? "\n（已截断）" : ""}`,
    };
  },

  send_notification: async (input) => {
    const title = (input.title as string) || "通知";
    const body = (input.body as string) || "";
    try {
      const { requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
      const perm = await requestPermission();
      if (perm !== "granted") {
        return {
          content: "通知权限未授予，请在 Android 设置 → 应用 → Polaris Pocket → 权限 → 通知 中开启。",
          is_error: true,
        };
      }
      await sendNotification({ title, body });
      return { content: `通知已发送：\n标题：${title}\n内容：${body}` };
    } catch {
      // 非 Tauri 环境回退：用浏览器 Web Notification API
      if (!("Notification" in window)) {
        return { content: "此环境不支持系统通知", is_error: true };
      }
      if (Notification.permission !== "granted") {
        return { content: "通知权限未授予", is_error: true };
      }
      new Notification(title, { body });
      return { content: `通知已发送：\n标题：${title}\n内容：${body}` };
    }
  },

  open_url: async (input) => {
    const url = (input.url as string) || "";
    if (!url) return { content: "URL 为空", is_error: true };
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return { content: `已打开：${url}` };
    } catch {
      window.open(url, "_blank");
      return { content: `已在浏览器中打开：${url}` };
    }
  },

  get_applications: async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const apps = await invoke("get_applications");
      return { content: String(apps ?? "") };
    } catch {
      return { content: "get_applications 命令不可用" };
    }
  },

  // ---- 前端新工具 handler ----

  get_network_info: async () => {
    const conn = (navigator as any)?.connection;
    let info = `在线状态：${navigator.onLine ? "✅ 在线" : "❌ 离线"}`;
    if (conn) {
      info += `\n连接类型：${conn.effectiveType || "未知"}（${conn.type || "未知"}）`;
      info += `\n下行带宽：${conn.downlink || "未知"} Mbps`;
      info += `\n往返时延：${conn.rtt || "未知"} ms`;
      if (conn.saveData !== undefined) {
        info += `\n省流模式：${conn.saveData ? "开启" : "关闭"}`;
      }
    } else {
      info += "\n（Network Information API 不可用，仅返回在线状态）";
    }
    return { content: info };
  },

  evaluate_math: async (input) => {
    const expr = (input.expression as string) || "";
    if (!expr) return { content: "表达式为空", is_error: true };
    // 安全校验：只允许数学运算
    const safe = expr.replace(/\s/g, "");
    // 禁止调用非 Math 对象
    if (/[^0-9+\-*/.%()eE ,MathPIsinconasqtalgbxpfh]/.test(safe)) {
      return { content: "不安全的表达式，仅允许数学运算", is_error: true };
    }
    try {
      const result = Function(`"use strict"; return (${expr})`)();
      if (typeof result === "number" && !Number.isFinite(result)) {
        return { content: `结果不是有限数：${result}`, is_error: true };
      }
      return { content: `表达式：${expr}\n结果：${result}` };
    } catch (e: unknown) {
      return { content: `计算失败：${(e as Error).message}`, is_error: true };
    }
  },

  get_battery_advanced: async () => {
    if (!("getBattery" in navigator)) {
      return { content: "此浏览器不支持 Battery Status API", is_error: true };
    }
    const battery = await (navigator as any).getBattery?.();
    if (!battery) return { content: "获取电池信息失败", is_error: true };
    let info = `电量：${Math.round((battery.level ?? 0) * 100)}%`;
    info += `\n充电中：${battery.charging ? "是" : "否"}`;
    if (battery.chargingTime !== Infinity && battery.chargingTime != null) {
      const min = Math.round(battery.chargingTime / 60);
      info += `\n充满还需：约 ${min} 分钟`;
    }
    if (battery.dischargingTime !== Infinity && battery.dischargingTime != null) {
      const min = Math.round(battery.dischargingTime / 60);
      info += `\n剩余使用：约 ${min} 分钟`;
    }
    return { content: info };
  },

  memory_info: async () => {
    const mem = (navigator as any)?.deviceMemory;
    if (mem) {
      return { content: `设备内存：${mem} GB` };
    }
    // 通过 performance.memory（Chrome 特有）获取更多信息
    const perfMem = (performance as any)?.memory;
    if (perfMem) {
      const total = Math.round(perfMem.jsHeapSizeLimit / 1024 / 1024);
      const used = Math.round(perfMem.usedJSHeapSize / 1024 / 1024);
      const pct = total > 0 ? Math.round((used / total) * 100) : 0;
      return { content: `JS 堆内存限制：${total} MB\n已用：${used} MB（${pct}%）` };
    }
    return { content: "内存信息 API 不可用（device-memory）" };
  },

  screen_info: async () => {
    const s = window.screen;
    const dpr = window.devicePixelRatio || 1;
    return {
      content: `分辨率：${s.width} × ${s.height}\n像素比：${dpr}\n色深：${s.colorDepth || "未知"} bit\n视口：${window.innerWidth} × ${window.innerHeight}\n可用区域：${s.availWidth} × ${s.availHeight}`,
    };
  },

  language_info: async () => {
    const langs = navigator.languages?.length
      ? navigator.languages.join(", ")
      : navigator.language || "未知";
    return {
      content: `首选语言：${navigator.language || "未知"}\n所有语言偏好：${langs}\n系统语言：${Intl.DateTimeFormat().resolvedOptions().locale}`,
    };
  },

  get_online_status: async () => {
    return {
      content: `当前在线状态：${navigator.onLine ? "✅ 在线" : "❌ 离线"}`,
    };
  },

  vibrate_native: async (input) => {
    const duration = (input.duration as number) ?? 100;
    const style = (input.style as string) ?? "vibrate";
    try {
      const { vibrate, impactFeedback, notificationFeedback, selectionFeedback } = await import("@tauri-apps/plugin-haptics");
      switch (style) {
        case "vibrate":
          await vibrate(Math.min(Math.max(duration, 1), 1000));
          break;
        case "impact":
          await impactFeedback("medium");
          break;
        case "notification":
          await notificationFeedback("warning");
          break;
        case "selection":
          await selectionFeedback();
          break;
      }
      return { content: `原生震动反馈：${style}（${duration}ms）` };
    } catch {
      // 回退到 navigator.vibrate
      if ("vibrate" in navigator) {
        (navigator as { vibrate?: (d: number) => void }).vibrate?.(Math.min(duration, 1000));
        return { content: `震动（浏览器回退）：${duration}ms` };
      }
      return { content: "此设备不支持震动", is_error: true };
    }
  },

  scan_barcode: async () => {
    try {
      const { scan, Format } = await import("@tauri-apps/plugin-barcode-scanner");
      const result = await scan({ formats: [Format.QRCode], windowed: false });
      return {
        content: `条码扫描结果：\n格式：${result?.format ?? "未知"}\n内容：${result?.content ?? "未识别"}`,
      };
    } catch (e: unknown) {
      return { content: `条码扫描失败：${(e as Error).message}`, is_error: true };
    }
  },

  // ---- 生活助手工具 handler ----

  todo_add: async (input) => {
    const text = (input.text as string) || "";
    const dueAt = input.dueAt ? new Date(input.dueAt as string).getTime() : undefined;
    if (!text) return { content: "待办内容不能为空", is_error: true };
    const todos = loadTodos();
    const id = crypto.randomUUID?.() ?? `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    todos.push({ id, text, done: false, createdAt: Date.now(), dueAt });
    saveTodos(todos);
    const suffix = dueAt ? `\n截止时间：${new Date(dueAt).toLocaleString("zh-CN")}` : "";
    return { content: `已添加待办：${text}${suffix}` };
  },

  todo_list: async () => {
    const todos = loadTodos();
    if (todos.length === 0) return { content: "当前没有待办事项" };
    const doneCount = todos.filter((t) => t.done).length;
    let lines = todos.map(
      (t) =>
        `• [${t.done ? "✅" : "⬜"}] ${t.text}${t.dueAt ? `（截止：${new Date(t.dueAt).toLocaleString("zh-CN")}）` : ""}  [id=${t.id}]`
    );
    return {
      content: `共 ${todos.length} 项待办（已完成 ${doneCount} 项）\n${lines.join("\n")}`,
    };
  },

  todo_done: async (input) => {
    const todo_id = (input.todo_id as string) || "";
    if (!todo_id) return { content: "请指定 todo_id", is_error: true };
    const todos = loadTodos();
    const item = todos.find((t) => t.id === todo_id);
    if (!item) return { content: `未找到 id 为 ${todo_id} 的待办`, is_error: true };
    if (item.done) return { content: `该待办 ${item.text} 已完成，无需重复操作` };
    item.done = true;
    saveTodos(todos);
    return { content: `已标记完成：${item.text}` };
  },

  todo_delete: async (input) => {
    const todo_id = (input.todo_id as string) || "";
    if (!todo_id) return { content: "请指定 todo_id", is_error: true };
    const todos = loadTodos();
    const item = todos.find((t) => t.id === todo_id);
    if (!item) return { content: `未找到 id 为 ${todo_id} 的待办`, is_error: true };
    const removed = item.text;
    const updated = todos.filter((t) => t.id !== todo_id);
    saveTodos(updated);
    return { content: `已删除待办：${removed}` };
  },

  generate_document: async (input) => {
    const content = (input.content as string) || "";
    const filename = (input.filename as string) || "文档";
    if (!content.trim()) return { content: "文档内容为空，请提供正文内容", is_error: true };
    try {
      const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
      type DocxParagraph = InstanceType<typeof Paragraph>;
      const children: DocxParagraph[] = content
        .split("\n")
        .map((line) => {
          if (line.startsWith("# ")) {
            return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: line.slice(2), size: 32, bold: true })] });
          }
          if (line.startsWith("## ")) {
            return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: line.slice(3), size: 26, bold: true })] });
          }
          return new Paragraph({ children: [new TextRun({ text: line, size: 22 })] });
        });
      const doc = new Document({ sections: [{ properties: {}, children }] });
      const blob = await Packer.toBlob(doc);
      const file = new File([blob], `${filename}.docx`, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      // 移动端 Tauri 环境：触发浏览器下载
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filename}.docx`;
      a.click();
      URL.revokeObjectURL(url);
      return { content: `文档已生成并下载：${filename}.docx` };
    } catch (e: unknown) {
      // docx 未安装时的友好降级：把内容存为 txt 文件
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("write_file", { path: `${filename}.txt`, content });
        return { content: `docx 库未安装，已降级保存为文本文件：${filename}.txt（请构建 APK 前运行 npm install docx）` };
      } catch {
        return { content: `生成文档失败：${(e as Error).message}，请确认已安装 docx 库（npm install docx）`, is_error: true };
      }
    }
  },

  alarm_schedule: async (input) => {
    const delaySeconds = Number(input.delay_seconds) || 0;
    const title = (input.title as string) || "提醒";
    const message = (input.message as string) || "";
    if (delaySeconds < 60 || delaySeconds > 86400) {
      return { content: "delay_seconds 必须在 60-86400 之间（1 分钟到 24 小时）", is_error: true };
    }
    try {
      const { requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
      const perm = await requestPermission();
      if (perm !== "granted") {
        return {
          content: "通知权限未授予，请在 Android 设置 → 应用 → Polaris Pocket → 权限 → 通知 中开启。",
          is_error: true,
        };
      }
      setTimeout(async () => {
        await sendNotification({ title, body: message });
      }, delaySeconds * 1000);
      const fireTime = new Date(Date.now() + delaySeconds * 1000);
      return {
        content: `提醒已设置：${fireTime.toLocaleString("zh-CN")}\n标题：${title}\n内容：${message}\n（注：此提醒在 App 前台时触发；App 完全关闭时需后台闹钟服务，后续版本支持）`,
      };
    } catch (e: unknown) {
      return { content: `设置提醒失败：${(e as Error).message}`, is_error: true };
    }
  },

  // ---- 文件管理 handler ----

  file_list: async (input) => {
    const path = (input.path as string) || "";
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const raw = await invoke("file_manager_ls", { path });
      const entries: Array<{ name: string; is_dir: boolean; size: number; modified: number }> = JSON.parse(String(raw));
      if (entries.length === 0) return { content: `目录为空：${path || "根目录"}` };
      const lines = entries.map((e) => {
        const size = e.size < 1024 ? `${e.size}B` : e.size < 1024 * 1024 ? `${(e.size / 1024).toFixed(1)}KB` : `${(e.size / (1024 * 1024)).toFixed(1)}MB`;
        return `${e.is_dir ? "📁" : "📄"} ${e.name}  ${size}`;
      });
      return { content: `目录 ${path || "根目录"}（${entries.length} 项）：\n${lines.join("\n")}` };
    } catch (e: unknown) {
      return { content: `读取目录失败：${(e as Error).message}`, is_error: true };
    }
  },

  file_read: async (input) => {
    const path = (input.path as string) || "";
    if (!path) return { content: "请指定文件路径", is_error: true };
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const raw = await invoke("file_read_base64", { path });
      const data: { content: string; size: number; mime: string } = JSON.parse(String(raw));
      // 尝试解码为文本
      const bytes = Uint8Array.from(atob(data.content), (c) => c.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      // 截断过长的内容
      const maxLength = 4000;
      if (text.length > maxLength) {
        return { content: `${text.slice(0, maxLength)}\n\n...（文件共 ${text.length} 字符，已截断）` };
      }
      return { content: text };
    } catch (e: unknown) {
      // base64 解码失败说明不是文本文件
      if (e instanceof Error && e.message.includes("Invalid character")) {
        return { content: `该文件不是文本文件，无法直接读取（尝试用"发送到 AI"功能处理）`, is_error: true };
      }
      return { content: `读取文件失败：${(e as Error).message}`, is_error: true };
    }
  },
};

const SYSTEM_TOOL_HANDLERS: Record<string, ToolHandler> = {};

const SYSTEM_TOOL_NAMES = [
  "get_device_info",
  "take_photo",
  "copy_to_device_storage",
  "get_applications",
  "read_file",
  "write_file",
  "list_files",
  "delete_file",
  "create_directory",
  "file_exists",
  "get_file_size",
  "send_sms",
  "get_contacts",
  // contact_lookup → 底层复用 get_contacts（前端过滤 phone_hint）
  "contact_lookup",
] as const;

async function invokeSystemTool(
  toolName: string,
  input: Record<string, unknown>,
  _signal?: AbortSignal
): Promise<{ content: string; is_error?: boolean }> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // contact_lookup 底层复用 get_contacts 命令，前端做 phone_hint 过滤
    if (toolName === "contact_lookup") {
      const phoneHint = (input.phone_hint as string) || "";
      const result = await invoke("get_contacts");
      const text = String(result ?? "");
      if (phoneHint) {
        const lines = text.split("\n").filter((l) => l.includes(phoneHint));
        return {
          content: lines.length ? `匹配 ${phoneHint} 的联系人：\n${lines.join("\n")}` : `未找到包含 ${phoneHint} 的联系人`,
        };
      }
      return { content: text || "联系人列表为空" };
    }
    const result = await invoke(toolName, input);
    return { content: String(result ?? "") };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("command not found") || msg.includes("unknown command")) {
      return {
        content: `工具 ${toolName} 的 Tauri 命令尚未实现。请重新构建 Pocket APK（需编译 Rust 后端）。`,
        is_error: true,
      };
    }
    return { content: `工具 ${toolName} 执行失败：${msg}`, is_error: true };
  }
}

function getSystemHandler(name: string): ToolHandler | null {
  if ((SYSTEM_TOOL_NAMES as readonly string[]).includes(name)) {
    return async (input, signal) => invokeSystemTool(name, input, signal);
  }
  return null;
}

// ============================================================================
// 运行时可用性探测
// ============================================================================

async function probeFrontendTool(name: string): Promise<ToolCapability> {
  switch (name) {
    case "get_time":
    case "get_date":
      return "available";

    case "read_clipboard":
    case "write_clipboard": {
      try {
        await navigator.clipboard.readText();
        return "available";
      } catch {
        return "unavailable";
      }
    }

    case "get_location": {
      // Android 端通过 probeSystemTool 检测 get_location_probe 命令（原生 FusedLocationProviderClient）
      // 桌面端降级为 navigator.geolocation
      return navigator.geolocation ? "available" : "unavailable";
    }

    case "get_device_orientation":
      return typeof window !== "undefined" && "DeviceOrientationEvent" in window ? "available" : "unavailable";

    case "get_battery":
      return "getBattery" in navigator ? "available" : "unavailable";

    case "speak_text":
      return "speechSynthesis" in window ? "available" : "unavailable";

    case "vibrate":
      return "vibrate" in navigator ? "available" : "unavailable";

    case "play_sound":
      return typeof Audio !== "undefined" ? "available" : "unavailable";

    case "get_local_storage":
      return typeof localStorage !== "undefined" ? "available" : "unavailable";

    case "send_notification":
      // Tauri 环境：用 @tauri-apps/plugin-notification；回退浏览器 Notification API
      try {
        const { requestPermission } = await import("@tauri-apps/plugin-notification");
        return "available";
      } catch {
        return "Notification" in window ? "available" : "unavailable";
      }

    case "open_url":
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        return "available";
      } catch {
        return "available";
      }

    case "get_network_info":
      return "available";

    case "evaluate_math":
      return "available";

    case "get_online_status":
      return "available";

    case "screen_info":
      return "available";

    case "language_info":
      return "available";

    case "get_battery_advanced":
      return "getBattery" in navigator ? "available" : "unavailable";

    case "memory_info": {
      const mem = (navigator as any)?.deviceMemory;
      const perfMem = (performance as any)?.memory;
      return mem || perfMem ? "available" : "unavailable";
    }

    case "vibrate_native": {
      try {
        const { vibrate } = await import("@tauri-apps/plugin-haptics");
        return "available";
      } catch {
        return "vibrate" in navigator ? "available" : "unavailable";
      }
    }

    case "scan_barcode": {
      try {
        const { scan } = await import("@tauri-apps/plugin-barcode-scanner");
        return "available";
      } catch {
        return "unavailable";
      }
    }

    case "todo_add":
    case "todo_list":
    case "todo_done":
    case "todo_delete":
      return typeof localStorage !== "undefined" ? "available" : "unavailable";

    case "generate_document": {
      // docx 库是外部依赖，未安装时不可用
      try {
        const { Document, Packer } = await import("docx");
        return typeof Document !== "undefined" && typeof Packer !== "undefined" ? "available" : "unavailable";
      } catch {
        return "unavailable";
      }
    }

    case "alarm_schedule": {
      try {
        const { requestPermission } = await import("@tauri-apps/plugin-notification");
        return "available";
      } catch {
        return typeof setTimeout !== "undefined" ? "available" : "unavailable";
      }
    }

    case "file_list":
    case "file_read": {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("file_manager_probe");
        return "available";
      } catch {
        return "unavailable";
      }
    }

    default:
      return "available";
  }
}

async function probeSystemTool(name: string): Promise<ToolCapability> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // 文件系统工具共享同一个 probe 命令
    const probeBase =
      ["read_file", "write_file", "list_files", "delete_file", "create_directory", "file_exists", "get_file_size"].includes(
        name
      )
        ? "file_system"
        : name;
    // contact_lookup 复用 get_contacts 的 probe
    const probeCmd = probeBase === "contact_lookup" ? "get_contacts" : probeBase;
    await invoke(`${probeCmd}_probe`);
    return "available";
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("command not found") || msg.includes("unknown")) {
      return "unavailable";
    }
    return "unavailable";
  }
}

export async function getAvailableTools(): Promise<ToolAvailability[]> {
  const results = await Promise.all(
    TOOL_REGISTRY.map(async (def) => {
      const cap =
        def.category === "frontend"
          ? await probeFrontendTool(def.name)
          : await probeSystemTool(def.name);
      return { definition: def, capability: cap };
    })
  );
  return results;
}

export function getEnabledToolDefinitions(
  availabilities: ToolAvailability[]
): ToolDefinition[] {
  return availabilities
    .filter((a) => a.capability === "available")
    .map((a) => a.definition);
}

// ============================================================================
// 协议适配器
// ============================================================================

/**
 * 检测 wireApi 是否支持 Tool Use。
 * - anthropic-messages: 原生支持 ✅
 * - openai-chat-completions: 支持（字段名不同）✅
 * - openai-responses: 不支持 ❌
 * - 未配置 wireApi（旧配置）: 默认不支持 ❌
 */
export function supportsToolUse(wireApi: WireApi | undefined | null): boolean {
  return (
    wireApi === "anthropic-messages" || wireApi === "openai-chat-completions"
  );
}

/** Anthropic Messages 协议适配器 */
export const AnthropicAdapter: ProtocolAdapter = {
  formatTool(tool: ToolDefinition): Record<string, unknown> {
    // 端点始终是 /chat/completions（OpenAI 兼容），tools 参数用 OpenAI 格式
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  },

  formatMessages(
    messages: { role: string; content: ContentValue }[]
  ): Record<string, unknown>[] {
    return messages.map(({ role, content }) => {
      // Anthropic API 没有 role: "tool"，tool_result 必须在 role: "user" 中
      const mappedRole = role === "tool" ? "user" : role;

      // 纯文本 string → 直接传
      if (typeof content === "string") {
        return { role: mappedRole, content };
      }

      // Array<MsgBlock> → 转为 Anthropic 内容块
      const blocks: Array<Record<string, unknown>> = [];
      for (const block of content) {
        if (block.type === "text") {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          });
        } else if (block.type === "tool_result") {
          const tr: Record<string, unknown> = {
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            content: block.content,
          };
          // Anthropic tool_result 必须携带 is_error，否则错误结果会被当成功处理
          if (block.is_error) {
            tr.is_error = true;
          }
          blocks.push(tr);
        }
      }
      return { role: mappedRole, content: blocks };
    });
  },
};

/** OpenAI Chat Completions 协议适配器 */
export const OpenAIAdapter: ProtocolAdapter = {
  formatTool(tool: ToolDefinition): Record<string, unknown> {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  },

  formatMessages(
    messages: { role: string; content: ContentValue }[]
  ): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];

    for (const { role, content } of messages) {
      if (typeof content === "string") {
        result.push({ role, content });
        continue;
      }

      const hasToolUse = content.some((b) => b.type === "tool_use");
      const hasToolResult = content.some((b) => b.type === "tool_result");

      if (hasToolUse) {
        // OpenAI 的 tool_calls 是消息级字段，不在 content 数组里
        const text = content.find((b) => b.type === "text")?.text || "";
        const toolCalls = content
          .filter((b): b is ToolUseBlock => b.type === "tool_use")
          .map((b, i) => ({
            index: i,
            id: b.id,
            type: "function",
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input),
            },
          }));
        result.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls,
        });
      } else if (hasToolResult) {
        // OpenAI 用 role: "tool" + tool_call_id，不是 role: "user" + content 数组
        // 每个 tool_result 拆成一条独立的 role: "tool" 消息
        const toolResults = content.filter(
          (b): b is ToolResultBlock => b.type === "tool_result"
        );
        for (const tr of toolResults) {
          result.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: tr.content,
          });
        }
      } else {
        // 纯文本块，合并为一条消息
        const texts = content.filter((b): b is TextBlock => b.type === "text");
        result.push({
          role,
          content: texts.map((b) => b.text).join("\n"),
        });
      }
    }

    return result;
  },
};

export const PROTOCOL_ADAPTERS: Record<string, ProtocolAdapter> = {
  "anthropic-messages": AnthropicAdapter,
  "openai-chat-completions": OpenAIAdapter,
};

export function getProtocolAdapter(wireApi: WireApi | undefined | null): ProtocolAdapter | null {
  return (wireApi && PROTOCOL_ADAPTERS[wireApi]) ?? null;
}

// ============================================================================
// 工具执行
// ============================================================================

/**
 * 执行单个工具调用。
 * @param toolName 工具名
 * @param input 工具输入参数
 * @param signal 超时信号（由调用方控制）
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ content: string; is_error?: boolean }> {
  // 1. 找到处理器
  const frontendHandler = FRONTEND_TOOL_HANDLERS[toolName];
  if (frontendHandler) {
    return frontendHandler(input, signal);
  }

  const systemHandler = getSystemHandler(toolName);
  if (systemHandler) {
    return systemHandler(input, signal);
  }

  return {
    content: `未知工具 "${toolName}"，当前未注册此工具。`,
    is_error: true,
  };
}

/**
 * 并行执行多个工具调用，按原始 tool_use 顺序重排结果。
 * @returns 结果数组（与 toolCalls 顺序一一对应）
 */
export async function executeToolsInOrder(
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  signal?: AbortSignal
): Promise<Array<{ tool_use_id: string; content: string; is_error: boolean }>> {
  // 并行执行
  const pending = toolCalls.map((tc) =>
    executeTool(tc.name, tc.input, signal).then((r) => ({
      tool_use_id: tc.id,
      content: r.content,
      is_error: !!r.is_error,
    }))
  );

  // 等待全部完成
  const results = await Promise.allSettled(pending);

  // 按原始顺序重排
  return results.map((r, idx) => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    return {
      tool_use_id: toolCalls[idx].id,
      content: `工具执行异常：${(r as PromiseRejectedResult).reason?.message ?? "未知错误"}`,
      is_error: true,
    };
  });
}

// ============================================================================
// 循环防护
// ============================================================================

/**
 * 生成工具调用签名的哈希字符串，用于检测重复调用。
 */
function toolCallKey(name: string, input: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(input).slice(0, 200)}`;
}

export interface LoopGuard {
  isTooLong: (count: number) => boolean;
  hasDuplicate: (name: string, input: Record<string, unknown>) => boolean;
  record: (name: string, input: Record<string, unknown>) => void;
  reset: () => void;
}

const MAX_TOOL_TURNS = 6;

export function createLoopGuard(): LoopGuard {
  const seen = new Set<string>();

  return {
    isTooLong(count: number) {
      return count >= MAX_TOOL_TURNS;
    },
    hasDuplicate(name: string, input: Record<string, unknown>) {
      return seen.has(toolCallKey(name, input));
    },
    record(name: string, input: Record<string, unknown>) {
      seen.add(toolCallKey(name, input));
    },
    reset() {
      seen.clear();
    },
  };
}

// ============================================================================
// 消息格式化辅助
// ============================================================================

/** 检测内容是否为结构化块格式 */
export function isBlockContent(content: unknown): content is MsgBlock[] {
  return Array.isArray(content);
}

/** 将任意内容统一为 Block 数组 */
export function normalizeToBlocks(content: ContentValue): MsgBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

/** 从块数组中提取纯文本（用于展示摘要） */
export function extractText(blocks: MsgBlock[]): string {
  const texts = blocks.filter((b): b is TextBlock => b.type === "text");
  return texts.map((b) => b.text).join("\n");
}

/** 从块数组中取出工具调用 */
export function extractToolCalls(blocks: MsgBlock[]): ToolUseBlock[] {
  return blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

/** 从块数组中取出工具结果 */
export function extractToolResults(blocks: MsgBlock[]): ToolResultBlock[] {
  return blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
}

/** 构建 system prompt，引导模型使用工具 */
export function buildSystemPromptWithTools(
  availableTools: ToolDefinition[]
): string {
  if (availableTools.length === 0) return "";

  const toolList = availableTools
    .map((t) => `- ${t.name}：${t.description}`)
    .join("\n");

  return `你是一个运行在 Android 手机上的智能助手。你可以调用工具来操作手机。

## 可用工具
${toolList}

## 使用工具时的要求
1. 先简洁解释你要做什么，再调用工具（让用户知道你的意图）
2. 工具执行后，对结果进行简要总结
3. 不要同时调用太多工具（一次 1-3 个）
4. 如果一个工具失败，不要无限重试同一个调用
5. 回复使用中文，除非用户明确要求其他语言`;
}
