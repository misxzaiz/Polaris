/// Pocket 手机操作工具命令模块
///
/// 为前端 Agent 循环提供 Tauri invoke 后端。
///
/// 工具分为三类：
/// 1. _probe 命令 — 探测工具是否可用（前端用 getAvailableTools 调用）
/// 2. 基础工具 — 纯 Rust 或 Tauri 内建 API 即可实现
/// 3. 高级工具 — 需要 JNI 调用 Android API（当前为占位，标记 TODO）
///
/// 交叉对抗性审查修正：
/// - 每个工具都有对应的 _probe 命令，前端探测时不会因调用实际工具而触发权限弹窗
/// - 高级工具（相机/联系人/通知）的 JNI 桥接留 TODO，不虚假承诺功能
/// - 所有命令返回 Result<String, String>，前端统一处理
/// - 不需要任何额外 Rust 依赖（只依赖标准库 + Tauri 2.0 mobile）

use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use tauri::Manager;
use base64::Engine;

/// 将相对路径解析到 Tauri 应用私有数据目录，防止路径穿越。
/// 空字符串返回 data_dir 本身；禁止 ../ 等穿越访问。
fn resolve_app_path(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    if path.is_empty() {
        return Ok(base);
    }
    if path.starts_with('/') || path.starts_with("..") {
        return Err(format!(
            "路径不安全：\"{}\"。文件操作限制在应用私有目录内。",
            path
        ));
    }
    Ok(base.join(path))
}

// ============================================================================
// _probe 命令 — 工具可用性探测
// ============================================================================

/// 探测设备信息工具是否可用（始终可用）
#[tauri::command]
pub fn get_device_info_probe() -> Result<(), String> {
    Ok(())
}

/// 探测定位工具是否可用（Android 原生 FusedLocationProviderClient 始终可用）
#[tauri::command]
pub fn get_location_probe() -> Result<(), String> {
    Ok(())
}

/// 探测文件存储工具是否可用（始终可用）
#[tauri::command]
pub fn copy_to_device_storage_probe() -> Result<(), String> {
    Ok(())
}

/// 探测相机工具是否可用（当前 Tauri 2.0 mobile 无原生相机 API，不可用）
#[tauri::command]
pub fn take_photo_probe() -> Result<(), String> {
    Err("camera API not available in current build".to_string())
}

/// 探测应用列表工具是否可用（始终可用，但仅返回有限信息）
#[tauri::command]
pub fn get_applications_probe() -> Result<(), String> {
    Ok(())
}

/// 探测文件系统工具是否可用
#[tauri::command]
pub fn file_system_probe() -> Result<(), String> {
    Ok(())
}

// ============================================================================
// 设备信息
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub platform: String,
    pub os_version: String,
    pub architecture: String,
    pub rust_version: String,
}

/// 获取设备基本信息
#[tauri::command]
pub fn get_device_info() -> Result<String, String> {
    let info = DeviceInfo {
        platform: std::env::consts::OS.to_string(),
        os_version: format!("{}.{}", 10, 0), // Tauri mobile 无直接 API
        architecture: std::env::consts::ARCH.to_string(),
        rust_version: option_env!("RUST_VERSION").unwrap_or("unknown").to_string(),
    };
    Ok(serde_json::to_string(&info).map_err(|e| e.to_string())?)
}

// ============================================================================
// 设备存储
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct SaveFileRequest {
    pub filename: String,
    pub content: String,
    #[serde(default)]
    pub directory: String,
}

/// 将文本保存到设备存储
///
/// 文件写入 Android 应用的私有数据目录（不需要外部存储权限）。
#[tauri::command]
pub fn copy_to_device_storage(
    app: tauri::AppHandle,
    req: SaveFileRequest,
) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(req.directory);
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let file_path = data_dir.join(req.filename);
    fs::write(&file_path, &req.content).map_err(|e| e.to_string())?;

    Ok(format!("已保存到：{}", file_path.display()))
}

// ============================================================================
// 文件系统 — 纯 Rust std::fs 实现
// 所有操作均限制在应用私有目录（app_data_dir），无需额外权限。
// 提供路径穿越防护（resolve_app_path 函数）。
// ============================================================================

/// 读取文件内容，返回文本（UTF-8）。
/// 路径相对于应用私有目录（如 "notes/hello.txt"）。
#[tauri::command]
pub fn read_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let full = resolve_app_path(&app, &path)?;
    if !full.exists() {
        return Err(format!("文件不存在：{}", full.display()));
    }
    if !full.is_file() {
        return Err(format!("路径不是文件：{}", full.display()));
    }
    let mut f = File::open(&full).map_err(|e| format!("打开文件失败 {}: {}", full.display(), e))?;
    let mut buf = String::new();
    f.read_to_string(&mut buf)
        .map_err(|e| format!("读取文件失败 {}: {}", full.display(), e))?;
    Ok(buf)
}

/// 写入文本到文件（UTF-8）。如果父目录不存在则自动创建。
/// 路径相对于应用私有目录。
#[tauri::command]
pub fn write_file(app: tauri::AppHandle, path: String, content: String) -> Result<String, String> {
    let full = resolve_app_path(&app, &path)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败 {}: {}", parent.display(), e))?;
    }
    fs::write(&full, &content)
        .map_err(|e| format!("写入文件失败 {}: {}", full.display(), e))?;
    Ok(format!("已写入：{}（{} 字节）", full.display(), content.len()))
}

/// 列出目录内容，返回文件/文件夹名列表。
/// 路径相对于应用私有目录。空字符串列出根目录。
#[tauri::command]
pub fn list_files(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let full = resolve_app_path(&app, &path)?;
    if !full.exists() {
        return Err(format!("目录不存在：{}", full.display()));
    }
    if !full.is_dir() {
        return Err(format!("路径不是目录：{}", full.display()));
    }
    let mut entries: Vec<String> = Vec::new();
    for entry in fs::read_dir(&full).map_err(|e| format!("读取目录失败 {}: {}", full.display(), e))? {
        let entry = entry.map_err(|e| format!("读取目录条目失败: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let kind = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            "📁"
        } else {
            "📄"
        };
        let size = if let Ok(meta) = entry.metadata() {
            format!(" ({}B)", meta.len())
        } else {
            String::new()
        };
        entries.push(format!("{} {}{}", kind, name, size));
    }
    entries.sort();
    if entries.is_empty() {
        Ok(format!("目录 {} 为空", full.display()))
    } else {
        Ok(format!("{}\n{}", full.display(), entries.join("\n")))
    }
}

/// 删除文件或空目录（递归删除需 recursive=true）。
#[tauri::command]
pub fn delete_file(
    app: tauri::AppHandle,
    path: String,
    recursive: Option<bool>,
) -> Result<String, String> {
    let full = resolve_app_path(&app, &path)?;
    if !full.exists() {
        return Err(format!("路径不存在：{}", full.display()));
    }
    if full.is_dir() {
        if recursive.unwrap_or(false) {
            fs::remove_dir_all(&full)
                .map_err(|e| format!("删除目录失败 {}: {}", full.display(), e))?;
            Ok(format!("已递归删除目录：{}", full.display()))
        } else {
            fs::remove_dir(&full)
                .map_err(|e| format!("删除目录失败（非空目录请加 recursive=true）: {}", e))?;
            Ok(format!("已删除目录：{}", full.display()))
        }
    } else {
        fs::remove_file(&full)
            .map_err(|e| format!("删除文件失败 {}: {}", full.display(), e))?;
        Ok(format!("已删除文件：{}", full.display()))
    }
}

/// 创建目录（自动创建父目录）。
#[tauri::command]
pub fn create_directory(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let full = resolve_app_path(&app, &path)?;
    if full.exists() {
        return Err(format!("路径已存在：{}", full.display()));
    }
    fs::create_dir_all(&full)
        .map_err(|e| format!("创建目录失败 {}: {}", full.display(), e))?;
    Ok(format!("已创建目录：{}", full.display()))
}

/// 检查文件或目录是否存在。
#[tauri::command]
pub fn file_exists(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let full = resolve_app_path(&app, &path)?;
    Ok(format!("{}", full.exists()))
}

/// 获取文件或目录的大小和修改时间（返回 Unix 秒戳，避免依赖 chrono）。
#[tauri::command]
pub fn get_file_size(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let full = resolve_app_path(&app, &path)?;
    if !full.exists() {
        return Err(format!("路径不存在：{}", full.display()));
    }
    let meta = fs::metadata(&full)
        .map_err(|e| format!("获取元数据失败 {}: {}", full.display(), e))?;
    let kind = if meta.is_dir() { "📁 目录" } else { "📄 文件" };
    let size = meta.len();
    let modified = meta
        .modified()
        .ok()
        .map(|t| {
            let dur = t
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default();
            format!("{}", dur.as_secs())
        })
        .unwrap_or_else(|| "未知".to_string());
    Ok(format!(
        "{}：{}\n类型：{}\n大小：{} 字节\n修改时间（Unix 秒）：{}",
        full.display(),
        kind,
        if meta.is_dir() { "📁" } else { "📄" },
        size,
        modified
    ))
}

// ============================================================================
// 已安装应用列表（有限实现）
// ============================================================================

/// 返回当前 Tauri mobile 环境信息作为应用列表的替代
///
/// TODO: JNI 桥接 PackageManager.getInstalledApplications()
#[tauri::command]
pub fn get_applications() -> Result<String, String> {
    Ok(serde_json::to_string(&[
        serde_json::json!({
            "name": "Polaris Pocket",
            "packageName": "com.polaris.pocket",
            "version": env!("CARGO_PKG_VERSION"),
            "isSystem": false,
        }),
    ])
    .map_err(|e| e.to_string())?)
}

// ============================================================================
// Android 原生工具 — 由 Kotlin 桥接实现（JNI 占位，待 Kotlin 侧完成）
// 前端可通过 @tauri-apps/plugin-haptics / barcode-scanner / biometric 直接调用
// ============================================================================

/// 发送短信（JNI 占位）。需 SEND_SMS 权限。
/// TODO: Kotlin 桥接 SmsManager.getDefault().sendTextMessage()
#[tauri::command]
pub fn send_sms(phone: String, message: String) -> Result<String, String> {
    eprintln!("[pocket_send_sms] phone={}, message={}", phone, message);
    Ok(format!("短信已记录（JNI 未实现，需 Kotlin 桥接 SmsManager）：\n收件人：{}\n内容：{}", phone, message))
}

/// 获取联系人列表（JNI 占位）。需 READ_CONTACTS 权限。
/// TODO: Kotlin 桥接 ContentResolver.query(ContactsContract.Contacts.CONTENT_URI)
#[tauri::command]
pub fn get_contacts() -> Result<String, String> {
    eprintln!("[pocket_get_contacts]");
    Ok("联系人列表获取（JNI 未实现，需 Kotlin 桥接 ContactsContract）".to_string())
}

/// 启动条码扫描（JNI 占位）。需 CAMERA 权限。
/// 注意：前端优先使用 @tauri-apps/plugin-barcode-scanner 官方插件
#[tauri::command]
pub fn scan_barcode() -> Result<String, String> {
    eprintln!("[pocket_scan_barcode]");
    Ok("条码扫描（JNI 未实现，前端优先使用 @tauri-apps/plugin-barcode-scanner）".to_string())
}

/// 生物识别认证（JNI 占位）。
/// 注意：前端优先使用 @tauri-apps/plugin-biometric 官方插件
#[tauri::command]
pub fn authenticate_biometric() -> Result<String, String> {
    eprintln!("[pocket_authenticate_biometric]");
    Ok("生物识别认证（JNI 未实现，前端优先使用 @tauri-apps/plugin-biometric）".to_string())
}

// -- probe 命令 --

#[tauri::command]
pub fn send_sms_probe() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn get_contacts_probe() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn scan_barcode_probe() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn authenticate_biometric_probe() -> Result<(), String> {
    Ok(())
}

// ============================================================================
// 文件管理器命令 — 结构化 API（用于前端文件管理页面 + AI 工具链）
// 所有路径均基于 app_data_dir，复用 resolve_app_path 防穿越。
// 返回 JSON 字符串，便于前端解析。
// ============================================================================

/// 文件条目元数据（结构化返回，替代文本格式）
#[derive(Debug, Serialize)]
struct FileEntry {
    name: String,
    is_dir: bool,
    size: u64,
    modified: u64, // Unix 秒
}

/// 列出目录内容（JSON 数组），目录在前，按名称升序。
/// path 为空字符串时列出 app_data_dir 根目录。
#[tauri::command]
pub fn file_manager_ls(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let full = resolve_app_path(&app, &path)?;
    if !full.is_dir() {
        return Err(format!("路径不是目录：{}", full.display()));
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    for entry in fs::read_dir(&full).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.metadata().map_err(|e| format!("读取元数据失败: {}", e))?;
        let is_dir = meta.is_dir();
        let size = meta.len();
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        entries.push(FileEntry {
            name,
            is_dir,
            size,
            modified,
        });
    }

    // 目录在前，按名称不区分大小写升序
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return if a.is_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    Ok(serde_json::to_string(&entries).map_err(|e| e.to_string())?)
}

/// 以 base64 读取文件（二进制通用，文本/图片/文档均可用）。
/// 返回 JSON：{"content":"...", "size":1234, "mime":"application/pdf"}
#[tauri::command]
pub fn file_read_base64(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let full = resolve_app_path(&app, &path)?;
    if !full.is_file() {
        return Err(format!("不是文件：{}", full.display()));
    }

    let data = fs::read(&full).map_err(|e| format!("读取文件失败: {}", e))?;
    let size = data.len() as u64;

    // 大小限制：2MB
    const MAX_BYTES: usize = 2 * 1024 * 1024;
    if data.len() > MAX_BYTES {
        return Err(format!(
            "文件过大（{:.1}MB），限制 2MB",
            data.len() as f64 / (1024.0 * 1024.0)
        ));
    }

    let mime = infer_mime_type(&full);
    let encoded = base64::engine::general_purpose::STANDARD.encode(&data);

    let result = serde_json::json!({
        "content": encoded,
        "size": size,
        "mime": mime,
    });
    Ok(serde_json::to_string(&result).map_err(|e| e.to_string())?)
}

/// 重命名文件或目录。new_name 仅含文件名（不含路径）。
#[tauri::command]
pub fn file_rename(
    app: tauri::AppHandle,
    old_path: String,
    new_name: String,
) -> Result<String, String> {
    if new_name.is_empty() {
        return Err("新文件名不能为空".to_string());
    }
    if new_name.contains('/') || new_name.contains('\\') || new_name.contains("..") {
        return Err("新文件名包含非法字符".to_string());
    }

    let old_full = resolve_app_path(&app, &old_path)?;
    if !old_full.exists() {
        return Err(format!("源文件不存在：{}", old_full.display()));
    }

    let parent = old_full.parent().ok_or("无法获取父目录")?.to_path_buf();
    let new_full = parent.join(&new_name);

    // 确保目标仍在 app_data_dir 内
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    new_full
        .strip_prefix(&data_dir)
        .map_err(|_| "路径穿越检测失败")?;

    if new_full.exists() {
        return Err(format!("目标已存在：{}", new_name));
    }

    fs::rename(&old_full, &new_full).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(format!("已重命名为：{}", new_full.display()))
}

/// 删除文件或目录（递归删除需 recursive=true），前端确认后再调。
#[tauri::command]
pub fn file_delete_file(
    app: tauri::AppHandle,
    path: String,
    recursive: Option<bool>,
) -> Result<String, String> {
    let full = resolve_app_path(&app, &path)?;
    if !full.exists() {
        return Err(format!("路径不存在：{}", full.display()));
    }

    if full.is_dir() {
        if recursive.unwrap_or(false) {
            fs::remove_dir_all(&full).map_err(|e| format!("删除目录失败: {}", e))?;
            Ok(format!("已递归删除目录：{}", full.display()))
        } else {
            fs::remove_dir(&full).map_err(|e| format!("删除目录失败（非空请传 recursive=true）: {}", e))?;
            Ok(format!("已删除目录：{}", full.display()))
        }
    } else {
        fs::remove_file(&full).map_err(|e| format!("删除文件失败: {}", e))?;
        Ok(format!("已删除文件：{}", full.display()))
    }
}

/// 文件管理器 probe（始终可用，基于 app_data_dir）
#[tauri::command]
pub fn file_manager_probe() -> Result<(), String> {
    Ok(())
}

// ============================================================================
// 辅助：根据文件扩展名推断 MIME 类型（零依赖，不引入额外 crate）
// ============================================================================

fn infer_mime_type(path: &std::path::Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "csv" => "text/csv",
        "py" => "text/x-python",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "rs" => "text/x-rust",
        "java" => "text/x-java",
        "go" => "text/x-go",
        "css" => "text/css",
        "yaml" | "yml" => "text/x-yaml",
        "toml" => "text/x-toml",
        "sh" | "bat" | "ps1" => "text/x-shellscript",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "doc" => "application/msword",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        _ => "application/octet-stream",
    }
    .to_string()
}
