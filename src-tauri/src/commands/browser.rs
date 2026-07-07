use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, Result};

#[cfg(feature = "tauri-app")]
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    AppHandle, Emitter, Manager, WebviewUrl,
};

#[cfg(feature = "tauri-app")]
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

static BROWSER_SESSIONS: OnceLock<Mutex<HashMap<String, BrowserSessionInfo>>> = OnceLock::new();
static BROWSER_BOUNDS: OnceLock<Mutex<HashMap<String, BrowserBounds>>> = OnceLock::new();

const DEFAULT_EVAL_TIMEOUT_MS: u64 = 2_500;
const MAX_EVAL_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionInfo {
    pub label: String,
    pub tab_id: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHeading {
    pub level: u8,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLink {
    pub text: String,
    pub href: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInteractiveElement {
    pub index: usize,
    pub kind: String,
    pub text: String,
    pub value: String,
    pub placeholder: String,
    pub href: String,
    pub disabled: bool,
    pub fillable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInteractionResult {
    pub ok: bool,
    pub action: String,
    pub index: Option<usize>,
    pub text: String,
    pub url: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOperationEvent {
    pub label: String,
    pub source: String,
    pub action: String,
    pub status: String,
    pub message: String,
    pub target: Option<String>,
    pub url: Option<String>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOverlayResult {
    pub enabled: bool,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageContext {
    pub title: String,
    pub url: String,
    pub selected_text: String,
    pub meta_description: String,
    pub text: String,
    pub headings: Vec<BrowserHeading>,
    pub links: Vec<BrowserLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewport {
    pub width: f64,
    pub height: f64,
    pub device_pixel_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsoleMessage {
    pub level: String,
    pub message: String,
    pub url: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVisualElement {
    pub index: usize,
    pub kind: String,
    pub text: String,
    pub rect: BrowserRect,
    pub fillable: bool,
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshot {
    pub mime_type: String,
    pub data: String,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVisualSnapshot {
    pub title: String,
    pub url: String,
    pub viewport: BrowserViewport,
    pub elements: Vec<BrowserVisualElement>,
    #[serde(default)]
    pub screenshot: Option<BrowserScreenshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDiagnostics {
    pub session: Option<BrowserSessionInfo>,
    pub context: BrowserPageContext,
    pub elements: Vec<BrowserInteractiveElement>,
    pub visual: BrowserVisualSnapshot,
    pub console_messages: Vec<BrowserConsoleMessage>,
    pub screenshot_error: Option<String>,
}

fn sessions() -> &'static Mutex<HashMap<String, BrowserSessionInfo>> {
    BROWSER_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn bounds_store() -> &'static Mutex<HashMap<String, BrowserBounds>> {
    BROWSER_BOUNDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn normalize_url(input: &str) -> Result<url::Url> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::ValidationError("URL 不能为空".to_string()));
    }

    if let Ok(url) = url::Url::parse(trimmed) {
        if matches!(url.scheme(), "http" | "https" | "file") {
            return Ok(url);
        }
    }

    let lower = trimmed.to_ascii_lowercase();
    let candidate = if lower.starts_with("localhost")
        || lower.starts_with("127.0.0.1")
        || lower.starts_with("[::1]")
    {
        format!("http://{}", trimmed)
    } else if trimmed.chars().any(char::is_whitespace) || !trimmed.contains('.') {
        format!(
            "https://www.bing.com/search?q={}",
            urlencoding::encode(trimmed)
        )
    } else {
        format!("https://{}", trimmed)
    };

    url::Url::parse(&candidate).map_err(|e| AppError::ValidationError(format!("URL 无效: {e}")))
}

pub fn resolve_browser_label(label: Option<&str>) -> Result<String> {
    if let Some(label) = label.map(str::trim).filter(|label| !label.is_empty()) {
        return Ok(label.to_string());
    }

    let guard = sessions()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器会话表锁异常: {e}")))?;

    guard
        .values()
        .max_by_key(|session| session.updated_at)
        .map(|session| session.label.clone())
        .ok_or_else(|| AppError::ValidationError("当前没有打开的内置浏览器".to_string()))
}

pub fn browser_list_registered_sessions() -> Result<Vec<BrowserSessionInfo>> {
    let mut list: Vec<_> = sessions()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器会话表锁异常: {e}")))?
        .values()
        .cloned()
        .collect();
    list.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    Ok(list)
}

#[cfg(feature = "tauri-app")]
pub fn set_browser_app_handle(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
}

#[cfg(feature = "tauri-app")]
pub fn browser_app_handle() -> Result<AppHandle> {
    APP_HANDLE
        .get()
        .cloned()
        .ok_or_else(|| AppError::Unknown("浏览器控制尚未初始化".to_string()))
}

#[cfg(feature = "tauri-app")]
fn get_webview(app: &AppHandle, label: &str) -> Result<tauri::Webview> {
    app.get_webview(label)
        .ok_or_else(|| AppError::ValidationError(format!("浏览器 WebView 不存在: {label}")))
}

fn upsert_session(
    label: String,
    tab_id: Option<String>,
    url: Option<String>,
    title: Option<String>,
) -> Result<BrowserSessionInfo> {
    let mut guard = sessions()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器会话表锁异常: {e}")))?;

    let existing = guard.get(&label).cloned();
    let session = BrowserSessionInfo {
        label: label.clone(),
        tab_id: tab_id.or_else(|| existing.as_ref().and_then(|s| s.tab_id.clone())),
        url: url.or_else(|| existing.as_ref().and_then(|s| s.url.clone())),
        title: title.or_else(|| existing.as_ref().and_then(|s| s.title.clone())),
        updated_at: now_ms(),
    };
    guard.insert(label, session.clone());
    Ok(session)
}

fn session_for_label(label: &str) -> Result<Option<BrowserSessionInfo>> {
    Ok(sessions()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器会话表锁异常: {e}")))?
        .get(label)
        .cloned())
}

fn remember_browser_bounds(label: &str, bounds: BrowserBounds) -> Result<()> {
    let mut guard = bounds_store()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器边界表锁异常: {e}")))?;
    if bounds.width < 1.0 || bounds.height < 1.0 {
        guard.remove(label);
    } else {
        guard.insert(label.to_string(), bounds);
    }
    Ok(())
}

fn forget_browser_bounds(label: &str) {
    if let Ok(mut guard) = bounds_store().lock() {
        guard.remove(label);
    }
}

fn browser_bounds(label: &str) -> Result<Option<BrowserBounds>> {
    Ok(bounds_store()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器边界表锁异常: {e}")))?
        .get(label)
        .copied())
}

#[cfg(feature = "tauri-app")]
fn apply_webview_bounds(webview: &tauri::Webview, bounds: BrowserBounds) -> Result<()> {
    if bounds.width < 1.0 || bounds.height < 1.0 {
        webview.hide()?;
        return Ok(());
    }

    webview.set_position(tauri::LogicalPosition::new(
        bounds.x.round(),
        bounds.y.round(),
    ))?;
    webview.set_size(tauri::LogicalSize::new(
        bounds.width.round().max(1.0),
        bounds.height.round().max(1.0),
    ))?;
    webview.show()?;
    Ok(())
}

#[cfg(feature = "tauri-app")]
fn emit_session_update(app: &AppHandle, session: &BrowserSessionInfo) {
    let _ = app.emit("browser://session-updated", session);
}

#[cfg(feature = "tauri-app")]
fn upsert_session_and_emit(
    app: &AppHandle,
    label: String,
    tab_id: Option<String>,
    url: Option<String>,
    title: Option<String>,
) -> Result<BrowserSessionInfo> {
    let session = upsert_session(label, tab_id, url, title)?;
    emit_session_update(app, &session);
    Ok(session)
}

#[cfg(feature = "tauri-app")]
pub fn emit_browser_operation_with_app(
    app: &AppHandle,
    label: &str,
    action: &str,
    status: &str,
    message: String,
    target: Option<String>,
    url: Option<String>,
) {
    let event = BrowserOperationEvent {
        label: label.to_string(),
        source: "ai".to_string(),
        action: action.to_string(),
        status: status.to_string(),
        message,
        target,
        url,
        timestamp: now_ms(),
    };
    let _ = app.emit("browser://operation", event);
}

#[cfg(feature = "tauri-app")]
pub fn browser_navigate_with_app(app: &AppHandle, label: &str, url: &str) -> Result<String> {
    let normalized = normalize_url(url)?;
    let webview = get_webview(app, label)?;
    webview.navigate(normalized.clone())?;
    let normalized = normalized.to_string();
    let _ = upsert_session_and_emit(app, label.to_string(), None, Some(normalized.clone()), None);
    Ok(normalized)
}

#[cfg(feature = "tauri-app")]
pub fn browser_reload_with_app(app: &AppHandle, label: &str) -> Result<()> {
    get_webview(app, label)?.reload()?;
    let _ = upsert_session_and_emit(app, label.to_string(), None, None, None);
    Ok(())
}

#[cfg(feature = "tauri-app")]
pub fn browser_history_with_app(app: &AppHandle, label: &str, direction: &str) -> Result<()> {
    let script = match direction {
        "back" => "history.back();",
        "forward" => "history.forward();",
        other => {
            return Err(AppError::ValidationError(format!(
                "未知浏览器历史方向: {other}"
            )));
        }
    };
    get_webview(app, label)?.eval(script)?;
    let _ = upsert_session_and_emit(app, label.to_string(), None, None, None);
    Ok(())
}

#[cfg(feature = "tauri-app")]
pub async fn browser_eval_with_app(
    app: &AppHandle,
    label: &str,
    script: &str,
    timeout_ms: Option<u64>,
) -> Result<String> {
    let webview = get_webview(app, label)?;
    let timeout_ms = timeout_ms
        .unwrap_or(DEFAULT_EVAL_TIMEOUT_MS)
        .clamp(100, MAX_EVAL_TIMEOUT_MS);

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let tx_cb = tx.clone();

    webview.eval_with_callback(script.to_string(), move |result| {
        if let Ok(mut guard) = tx_cb.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(result);
            }
        }
    })?;

    tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), rx)
        .await
        .map_err(|_| AppError::ProcessError("浏览器脚本执行超时".to_string()))?
        .map_err(|_| AppError::ProcessError("浏览器脚本回调已取消".to_string()))
}

fn parse_eval_json(raw: &str) -> Result<Value> {
    let trimmed = raw.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(inner) = value.as_str() {
            return serde_json::from_str::<Value>(inner)
                .map_err(|e| AppError::ValidationError(format!("浏览器 JSON 解析失败: {e}")));
        }
        return Ok(value);
    }

    serde_json::from_str::<Value>(trimmed)
        .map_err(|e| AppError::ValidationError(format!("浏览器 JSON 解析失败: {e}")))
}

#[cfg(feature = "tauri-app")]
pub async fn browser_get_page_context_with_app(
    app: &AppHandle,
    label: &str,
) -> Result<BrowserPageContext> {
    let raw = browser_eval_with_app(app, label, PAGE_CONTEXT_SCRIPT, Some(3_500)).await?;
    let value = parse_eval_json(&raw)?;
    let context: BrowserPageContext = serde_json::from_value(value)
        .map_err(|e| AppError::ValidationError(format!("浏览器上下文格式错误: {e}")))?;
    let _ = upsert_session_and_emit(
        app,
        label.to_string(),
        None,
        Some(context.url.clone()),
        Some(context.title.clone()),
    );
    Ok(context)
}

#[cfg(feature = "tauri-app")]
pub async fn browser_get_interactive_elements_with_app(
    app: &AppHandle,
    label: &str,
) -> Result<Vec<BrowserInteractiveElement>> {
    let raw = browser_eval_with_app(app, label, INTERACTIVE_ELEMENTS_SCRIPT, Some(3_500)).await?;
    let value = parse_eval_json(&raw)?;
    serde_json::from_value(value)
        .map_err(|e| AppError::ValidationError(format!("浏览器可操作元素格式错误: {e}")))
}

#[cfg(feature = "tauri-app")]
pub async fn browser_click_with_app(
    app: &AppHandle,
    label: &str,
    index: Option<usize>,
    text: Option<&str>,
) -> Result<BrowserInteractionResult> {
    if index.is_none() && text.map(str::trim).unwrap_or_default().is_empty() {
        return Err(AppError::ValidationError(
            "click 需要 index 或 text".to_string(),
        ));
    }

    let script = format!(
        "(() => {{ const requestedIndex = {}; const requestedText = {}; {} }})()",
        index
            .map(|value| value.to_string())
            .unwrap_or_else(|| "null".to_string()),
        serde_json::to_string(&text.unwrap_or_default()).unwrap_or_else(|_| "\"\"".to_string()),
        CLICK_ELEMENT_SCRIPT_BODY
    );
    let raw = browser_eval_with_app(app, label, &script, Some(3_500)).await?;
    let value = parse_eval_json(&raw)?;
    serde_json::from_value(value)
        .map_err(|e| AppError::ValidationError(format!("浏览器点击结果格式错误: {e}")))
}

#[cfg(feature = "tauri-app")]
pub async fn browser_fill_with_app(
    app: &AppHandle,
    label: &str,
    index: Option<usize>,
    text: Option<&str>,
    value: &str,
) -> Result<BrowserInteractionResult> {
    if index.is_none() && text.map(str::trim).unwrap_or_default().is_empty() {
        return Err(AppError::ValidationError(
            "fill 需要 index 或 text".to_string(),
        ));
    }

    let script = format!(
        "(() => {{ const requestedIndex = {}; const requestedText = {}; const fillValue = {}; {} }})()",
        index
            .map(|value| value.to_string())
            .unwrap_or_else(|| "null".to_string()),
        serde_json::to_string(&text.unwrap_or_default()).unwrap_or_else(|_| "\"\"".to_string()),
        serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string()),
        FILL_ELEMENT_SCRIPT_BODY
    );
    let raw = browser_eval_with_app(app, label, &script, Some(3_500)).await?;
    let value = parse_eval_json(&raw)?;
    serde_json::from_value(value)
        .map_err(|e| AppError::ValidationError(format!("浏览器输入结果格式错误: {e}")))
}

#[cfg(feature = "tauri-app")]
pub async fn browser_set_ai_overlay_with_app(
    app: &AppHandle,
    label: &str,
    enabled: bool,
) -> Result<BrowserOverlayResult> {
    let script = format!(
        "(() => {{ const overlayEnabled = {}; {} }})()",
        if enabled { "true" } else { "false" },
        AI_OVERLAY_SCRIPT_BODY
    );
    let raw = browser_eval_with_app(app, label, &script, Some(3_500)).await?;
    let value = parse_eval_json(&raw)?;
    serde_json::from_value(value)
        .map_err(|e| AppError::ValidationError(format!("浏览器高亮结果格式错误: {e}")))
}

#[cfg(feature = "tauri-app")]
pub async fn browser_get_diagnostics_with_app(
    app: &AppHandle,
    label: &str,
    include_screenshot: bool,
) -> Result<BrowserDiagnostics> {
    let context = browser_get_page_context_with_app(app, label).await?;
    let elements = browser_get_interactive_elements_with_app(app, label).await?;
    let raw = browser_eval_with_app(app, label, DIAGNOSTICS_SCRIPT, Some(3_500)).await?;
    let value = parse_eval_json(&raw)?;
    let mut visual: BrowserVisualSnapshot = serde_json::from_value(
        value
            .get("visual")
            .cloned()
            .ok_or_else(|| AppError::ValidationError("浏览器诊断缺少 visual".to_string()))?,
    )
    .map_err(|e| AppError::ValidationError(format!("浏览器视觉诊断格式错误: {e}")))?;
    let console_messages: Vec<BrowserConsoleMessage> = serde_json::from_value(
        value
            .get("consoleMessages")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    )
    .map_err(|e| AppError::ValidationError(format!("浏览器 Console 诊断格式错误: {e}")))?;

    let mut screenshot_error = None;
    if include_screenshot {
        match capture_browser_screenshot(app, label, 0.75) {
            Ok(Some(screenshot)) => {
                visual.screenshot = Some(screenshot);
            }
            Ok(None) => {
                screenshot_error = Some("当前平台暂不支持内置浏览器区域截图".to_string());
            }
            Err(error) => {
                screenshot_error = Some(error.to_message());
            }
        }
    }

    let diagnostics = BrowserDiagnostics {
        session: session_for_label(label)?,
        context,
        elements,
        visual,
        console_messages,
        screenshot_error,
    };

    emit_browser_operation_with_app(
        app,
        label,
        "diagnostics",
        "success",
        format!(
            "AI 读取浏览器诊断：{} 个可操作元素，{} 条 Console",
            diagnostics.elements.len(),
            diagnostics.console_messages.len()
        ),
        None,
        Some(diagnostics.context.url.clone()),
    );

    Ok(diagnostics)
}

#[cfg(all(feature = "tauri-app", windows))]
fn capture_browser_screenshot(
    app: &AppHandle,
    label: &str,
    scale: f32,
) -> Result<Option<BrowserScreenshot>> {
    let Some(bounds) = browser_bounds(label)? else {
        return Err(AppError::ValidationError(
            "缺少浏览器位置，暂时无法截图".to_string(),
        ));
    };
    if bounds.width < 1.0 || bounds.height < 1.0 {
        return Err(AppError::ValidationError(
            "浏览器区域不可见，暂时无法截图".to_string(),
        ));
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| AppError::ValidationError("主窗口不存在，无法截图".to_string()))?;
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let position = window
        .outer_position()
        .map_err(|e| AppError::ProcessError(format!("读取窗口位置失败: {e}")))?;
    let x = ((position.x as f64) + bounds.x * scale_factor)
        .round()
        .max(0.0) as u32;
    let y = ((position.y as f64) + bounds.y * scale_factor)
        .round()
        .max(0.0) as u32;
    let width = (bounds.width * scale_factor).round().max(1.0) as u32;
    let height = (bounds.height * scale_factor).round().max(1.0) as u32;

    let controller_config = crate::services::computer_control::ComputerConfig::from_env();
    let controller = crate::services::computer_control::ComputerController::new(controller_config)?;
    let shot = controller.screenshot(Some(0), Some((x, y, width, height)), Some(scale))?;
    Ok(Some(BrowserScreenshot {
        mime_type: "image/png".to_string(),
        data: shot.png_base64,
        width: shot.width,
        height: shot.height,
        scale,
    }))
}

#[cfg(all(feature = "tauri-app", not(windows)))]
fn capture_browser_screenshot(
    _app: &AppHandle,
    _label: &str,
    _scale: f32,
) -> Result<Option<BrowserScreenshot>> {
    Ok(None)
}

#[cfg(feature = "tauri-app")]
pub fn browser_toggle_devtools_with_app(app: &AppHandle, label: &str) -> Result<()> {
    let webview = get_webview(app, label)?;
    if webview.is_devtools_open() {
        webview.close_devtools();
    } else {
        webview.open_devtools();
    }
    Ok(())
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_create(
    app: AppHandle,
    label: String,
    tab_id: Option<String>,
    url: String,
    title: Option<String>,
    bounds: BrowserBounds,
) -> Result<BrowserSessionInfo> {
    let normalized = normalize_url(&url)?;

    if let Some(existing) = app.get_webview(&label) {
        let normalized_string = normalized.to_string();
        let current_url = existing
            .url()
            .ok()
            .map(|url| url.to_string())
            .unwrap_or_else(|| normalized_string.clone());

        let is_same_url = current_url == normalized_string;

        if !is_same_url {
            existing.navigate(normalized.clone())?;
        }

        apply_webview_bounds(&existing, bounds)?;
        remember_browser_bounds(&label, bounds)?;
        return upsert_session_and_emit(
            &app,
            label,
            tab_id,
            Some(if is_same_url {
                current_url
            } else {
                normalized_string
            }),
            if is_same_url {
                None
            } else {
                title.or_else(|| Some("Browser".to_string()))
            },
        );
    }

    let host_window = app
        .get_window("main")
        .ok_or_else(|| AppError::ValidationError("主窗口不存在，无法创建内置浏览器".to_string()))?;

    let nav_app = app.clone();
    let nav_label = label.clone();
    let title_app = app.clone();
    let title_label = label.clone();
    let new_window_app = app.clone();
    let new_window_label = label.clone();

    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(normalized.clone()))
        .devtools(true)
        .focused(false)
        .on_navigation(move |next_url| {
            let _ = upsert_session_and_emit(
                &nav_app,
                nav_label.clone(),
                None,
                Some(next_url.to_string()),
                None,
            );
            true
        })
        .on_document_title_changed(move |_webview, next_title| {
            let _ = upsert_session_and_emit(
                &title_app,
                title_label.clone(),
                None,
                None,
                Some(next_title),
            );
        })
        .on_new_window(move |next_url, _features| {
            if let Some(webview) = new_window_app.get_webview(&new_window_label) {
                let _ = webview.navigate(next_url.clone());
                let _ = upsert_session_and_emit(
                    &new_window_app,
                    new_window_label.clone(),
                    None,
                    Some(next_url.to_string()),
                    None,
                );
            }
            NewWindowResponse::Deny
        });

    host_window.add_child(
        builder,
        tauri::LogicalPosition::new(bounds.x, bounds.y),
        tauri::LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
    )?;

    remember_browser_bounds(&label, bounds)?;
    upsert_session_and_emit(
        &app,
        label,
        tab_id,
        Some(normalized.to_string()),
        title.or_else(|| Some("Browser".to_string())),
    )
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    label: String,
    bounds: BrowserBounds,
) -> Result<()> {
    let webview = get_webview(&app, &label)?;
    apply_webview_bounds(&webview, bounds)?;
    remember_browser_bounds(&label, bounds)?;
    Ok(())
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_set_ai_overlay(
    app: AppHandle,
    label: String,
    enabled: bool,
) -> Result<BrowserOverlayResult> {
    browser_set_ai_overlay_with_app(&app, &label, enabled).await
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_close(app: AppHandle, label: String) -> Result<()> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.close();
    }
    let mut guard = sessions()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器会话表锁异常: {e}")))?;
    guard.remove(&label);
    forget_browser_bounds(&label);
    Ok(())
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_clear_data(app: AppHandle, label: String) -> Result<()> {
    get_webview(&app, &label)?.clear_all_browsing_data()?;
    Ok(())
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_register(
    label: String,
    tab_id: Option<String>,
    url: Option<String>,
    title: Option<String>,
) -> Result<BrowserSessionInfo> {
    let session = upsert_session(label, tab_id, url, title)?;
    Ok(session)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_unregister(label: String) -> Result<()> {
    let mut guard = sessions()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器会话表锁异常: {e}")))?;
    guard.remove(&label);
    forget_browser_bounds(&label);
    Ok(())
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_list_sessions() -> Result<Vec<BrowserSessionInfo>> {
    browser_list_registered_sessions()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<String> {
    browser_navigate_with_app(&app, &label, &url)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_reload(app: AppHandle, label: String) -> Result<()> {
    browser_reload_with_app(&app, &label)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_history(app: AppHandle, label: String, direction: String) -> Result<()> {
    browser_history_with_app(&app, &label, &direction)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_get_page_context(app: AppHandle, label: String) -> Result<BrowserPageContext> {
    browser_get_page_context_with_app(&app, &label).await
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_get_diagnostics(
    app: AppHandle,
    label: String,
    include_screenshot: Option<bool>,
) -> Result<BrowserDiagnostics> {
    browser_get_diagnostics_with_app(&app, &label, include_screenshot.unwrap_or(false)).await
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_toggle_devtools(app: AppHandle, label: String) -> Result<()> {
    browser_toggle_devtools_with_app(&app, &label)
}

#[cfg(feature = "tauri-app")]
const PAGE_CONTEXT_SCRIPT: &str = r#"
(() => {
  const clean = (value, max = 12000) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  const selectedText = clean(window.getSelection ? window.getSelection().toString() : '', 6000);
  const metaDescription = clean(
    document.querySelector('meta[name="description"], meta[property="og:description"]')?.content || '',
    1000
  );
  const articleText = document.querySelector('article')?.innerText || '';
  const bodyText = document.body?.innerText || '';
  const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
    .slice(0, 30)
    .map((node) => ({
      level: Number(node.tagName.slice(1)),
      text: clean(node.textContent || '', 240)
    }))
    .filter((item) => item.text);
  const links = Array.from(document.querySelectorAll('a[href]'))
    .slice(0, 40)
    .map((node) => ({
      text: clean(node.textContent || node.getAttribute('aria-label') || '', 160),
      href: String(node.href || '')
    }))
    .filter((item) => item.href);
  return JSON.stringify({
    title: clean(document.title || '', 300),
    url: String(location.href),
    selectedText,
    metaDescription,
    text: clean(articleText || bodyText, 12000),
    headings,
    links
  });
})()
"#;

#[cfg(feature = "tauri-app")]
const INTERACTIVE_ELEMENTS_SCRIPT: &str = r#"
(() => {
  const clean = (value, max = 220) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  const selector = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== 'hidden'
      && style.display !== 'none'
      && element.getAttribute('aria-hidden') !== 'true';
  };
  const kindOf = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute('role');
    const type = element.getAttribute('type');
    if (tag === 'a') return 'link';
    if (tag === 'input') return type ? `input:${type}` : 'input';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag === 'button') return 'button';
    if (role) return role;
    if (element.isContentEditable) return 'editable';
    return tag;
  };
  const labelOf = (element) => clean(
    element.innerText
      || element.value
      || element.getAttribute('aria-label')
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || element.href
      || ''
  );
  const isFillable = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute('role');
    const type = (element.getAttribute('type') || '').toLowerCase();
    const nonTextInputTypes = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'];
    return element.isContentEditable
      || tag === 'textarea'
      || tag === 'select'
      || role === 'textbox'
      || (tag === 'input' && !nonTextInputTypes.includes(type));
  };
  const isDisabled = (element) => Boolean(
    element.disabled
      || element.readOnly
      || element.getAttribute('aria-disabled') === 'true'
  );
  const elements = Array.from(document.querySelectorAll(selector))
    .filter((element) => isVisible(element))
    .filter((element) => labelOf(element) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))
    .slice(0, 80)
    .map((element, index) => ({
      index,
      kind: kindOf(element),
      text: labelOf(element),
      value: clean(element.value || ''),
      placeholder: clean(element.getAttribute('placeholder') || ''),
      href: clean(element.href || '', 500),
      disabled: isDisabled(element),
      fillable: isFillable(element) && !isDisabled(element)
    }));
  return JSON.stringify(elements);
})()
"#;

#[cfg(feature = "tauri-app")]
const DIAGNOSTICS_SCRIPT: &str = r#"
(() => {
  const clean = (value, max = 220) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  const now = () => Date.now();

  if (!window.__POLARIS_BROWSER_CONSOLE__) {
    const buffer = [];
    const push = (level, args) => {
      try {
        buffer.push({
          level,
          message: Array.from(args || []).map((item) => {
            if (typeof item === 'string') return item;
            try { return JSON.stringify(item); } catch { return String(item); }
          }).join(' ').slice(0, 2000),
          url: String(location.href),
          timestamp: now()
        });
        if (buffer.length > 120) buffer.splice(0, buffer.length - 120);
      } catch {}
    };
    const original = {};
    ['debug', 'log', 'info', 'warn', 'error'].forEach((level) => {
      original[level] = console[level];
      console[level] = function(...args) {
        push(level, args);
        return original[level]?.apply(this, args);
      };
    });
    window.addEventListener('error', (event) => {
      push('error', [event.message || 'Script error', event.filename || '', event.lineno || '']);
    });
    window.addEventListener('unhandledrejection', (event) => {
      push('error', ['Unhandled promise rejection', event.reason || '']);
    });
    Object.defineProperty(window, '__POLARIS_BROWSER_CONSOLE__', {
      value: buffer,
      configurable: true
    });
  }

  const selector = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width > 0
      && rect.height > 0
      && rect.bottom >= 0
      && rect.right >= 0
      && rect.top <= window.innerHeight
      && rect.left <= window.innerWidth
      && style.visibility !== 'hidden'
      && style.display !== 'none'
      && element.getAttribute('aria-hidden') !== 'true';
  };
  const kindOf = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute('role');
    const type = element.getAttribute('type');
    if (tag === 'a') return 'link';
    if (tag === 'input') return type ? `input:${type}` : 'input';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag === 'button') return 'button';
    if (role) return role;
    if (element.isContentEditable) return 'editable';
    return tag;
  };
  const labelOf = (element) => clean(
    element.innerText
      || element.value
      || element.getAttribute('aria-label')
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || element.href
      || ''
  );
  const isFillable = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute('role');
    const type = (element.getAttribute('type') || '').toLowerCase();
    const nonTextInputTypes = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'];
    return element.isContentEditable
      || tag === 'textarea'
      || tag === 'select'
      || role === 'textbox'
      || (tag === 'input' && !nonTextInputTypes.includes(type));
  };
  const isDisabled = (element) => Boolean(
    element.disabled
      || element.readOnly
      || element.getAttribute('aria-disabled') === 'true'
  );

  const elements = Array.from(document.querySelectorAll(selector))
    .filter(isVisible)
    .filter((element) => labelOf(element) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))
    .slice(0, 80)
    .map((element, index) => {
      const rect = element.getBoundingClientRect();
      const disabled = isDisabled(element);
      return {
        index,
        kind: kindOf(element),
        text: labelOf(element),
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        fillable: isFillable(element) && !disabled,
        disabled
      };
    });

  return JSON.stringify({
    visual: {
      title: clean(document.title || '', 300),
      url: String(location.href),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      elements,
      screenshot: null
    },
    consoleMessages: (window.__POLARIS_BROWSER_CONSOLE__ || []).slice(-80)
  });
})()
"#;

#[cfg(feature = "tauri-app")]
const CLICK_ELEMENT_SCRIPT_BODY: &str = r#"
const clean = (value, max = 220) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const selector = ['a[href]', 'button', 'input', 'textarea', 'select', '[role="button"]', '[role="link"]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'].join(',');
const isVisible = (element) => {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && element.getAttribute('aria-hidden') !== 'true';
};
const labelOf = (element) => clean(element.innerText || element.value || element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || element.href || '');
const elements = Array.from(document.querySelectorAll(selector)).filter(isVisible).filter((element) => labelOf(element) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)).slice(0, 80);
const query = clean(requestedText).toLowerCase();
let index = Number.isInteger(requestedIndex) ? requestedIndex : -1;
let target = index >= 0 ? elements[index] : null;
if (!target && query) {
  index = elements.findIndex((element) => labelOf(element).toLowerCase().includes(query));
  target = index >= 0 ? elements[index] : null;
}
if (!target) {
  return JSON.stringify({ ok: false, action: 'click', index: null, text: requestedText || '', url: String(location.href), message: '未找到可点击元素' });
}
if (target.disabled || target.getAttribute('aria-disabled') === 'true') {
  return JSON.stringify({ ok: false, action: 'click', index, text: labelOf(target), url: String(location.href), message: '目标元素已禁用' });
}
target.scrollIntoView({ block: 'center', inline: 'center' });
if (target.tagName === 'A') {
  target.setAttribute('target', '_self');
}
target.focus({ preventScroll: true });
target.click();
return JSON.stringify({ ok: true, action: 'click', index, text: labelOf(target), url: String(location.href), message: '已点击目标元素' });
"#;

#[cfg(feature = "tauri-app")]
const FILL_ELEMENT_SCRIPT_BODY: &str = r#"
const clean = (value, max = 220) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const selector = ['a[href]', 'button', 'input', 'textarea', 'select', '[role="button"]', '[role="link"]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'].join(',');
const isVisible = (element) => {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && element.getAttribute('aria-hidden') !== 'true';
};
const labelOf = (element) => clean(element.innerText || element.value || element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || element.href || '');
const isFillable = (element) => {
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute('role');
  const type = (element.getAttribute('type') || '').toLowerCase();
  const nonTextInputTypes = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'];
  return element.isContentEditable
    || tag === 'textarea'
    || tag === 'select'
    || role === 'textbox'
    || (tag === 'input' && !nonTextInputTypes.includes(type));
};
const setNativeValue = (element, value) => {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor && descriptor.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
};
const elements = Array.from(document.querySelectorAll(selector)).filter(isVisible).filter((element) => labelOf(element) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)).slice(0, 80);
const query = clean(requestedText).toLowerCase();
let index = Number.isInteger(requestedIndex) ? requestedIndex : -1;
let target = index >= 0 ? elements[index] : null;
if (!target && query) {
  index = elements.findIndex((element) => labelOf(element).toLowerCase().includes(query));
  target = index >= 0 ? elements[index] : null;
}
if (!target) {
  return JSON.stringify({ ok: false, action: 'fill', index: null, text: requestedText || '', url: String(location.href), message: '未找到可输入元素' });
}
const targetLabel = labelOf(target);
if (!isFillable(target)) {
  return JSON.stringify({ ok: false, action: 'fill', index, text: targetLabel, url: String(location.href), message: '目标元素不可输入' });
}
if (target.disabled || target.readOnly || target.getAttribute('aria-disabled') === 'true') {
  return JSON.stringify({ ok: false, action: 'fill', index, text: targetLabel, url: String(location.href), message: '目标元素不可输入' });
}
target.scrollIntoView({ block: 'center', inline: 'center' });
target.focus({ preventScroll: true });
if (target.isContentEditable) {
  target.textContent = fillValue;
} else if (target.tagName === 'SELECT') {
  const option = Array.from(target.options).find((item) => item.value === fillValue || clean(item.textContent).includes(fillValue));
  setNativeValue(target, option ? option.value : fillValue);
} else {
  setNativeValue(target, fillValue);
}
target.dispatchEvent(new Event('input', { bubbles: true }));
target.dispatchEvent(new Event('change', { bubbles: true }));
return JSON.stringify({ ok: true, action: 'fill', index, text: targetLabel, url: String(location.href), message: '已填写目标元素' });
"#;

#[cfg(feature = "tauri-app")]
const AI_OVERLAY_SCRIPT_BODY: &str = r#"
const existingCleanup = window.__POLARIS_AI_OVERLAY_CLEANUP__;
if (typeof existingCleanup === 'function') {
  existingCleanup();
}

if (!overlayEnabled) {
  return JSON.stringify({ enabled: false, count: 0 });
}

const clean = (value, max = 80) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const selector = ['a[href]', 'button', 'input', 'textarea', 'select', '[role="button"]', '[role="link"]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'].join(',');
const root = document.createElement('div');
root.id = '__polaris_ai_overlay__';
root.style.position = 'fixed';
root.style.inset = '0';
root.style.pointerEvents = 'none';
root.style.zIndex = '2147483646';
root.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
document.documentElement.appendChild(root);

const isVisible = (element) => {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return rect.width > 0
    && rect.height > 0
    && rect.bottom >= 0
    && rect.right >= 0
    && rect.top <= window.innerHeight
    && rect.left <= window.innerWidth
    && style.visibility !== 'hidden'
    && style.display !== 'none'
    && element.getAttribute('aria-hidden') !== 'true';
};
const labelOf = (element) => clean(
  element.innerText
    || element.value
    || element.getAttribute('aria-label')
    || element.getAttribute('title')
    || element.getAttribute('placeholder')
    || element.href
    || ''
);
const isFillable = (element) => {
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute('role');
  const type = (element.getAttribute('type') || '').toLowerCase();
  const nonTextInputTypes = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'];
  return element.isContentEditable
    || tag === 'textarea'
    || tag === 'select'
    || role === 'textbox'
    || (tag === 'input' && !nonTextInputTypes.includes(type));
};
const render = () => {
  const elements = Array.from(document.querySelectorAll(selector))
    .filter(isVisible)
    .filter((element) => labelOf(element) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))
    .slice(0, 80);
  const nodes = elements.map((element, index) => {
    const rect = element.getBoundingClientRect();
    const box = document.createElement('div');
    const fillable = isFillable(element);
    box.style.position = 'fixed';
    box.style.left = `${Math.max(rect.left, 0)}px`;
    box.style.top = `${Math.max(rect.top, 0)}px`;
    box.style.width = `${Math.max(rect.width, 8)}px`;
    box.style.height = `${Math.max(rect.height, 8)}px`;
    box.style.border = fillable ? '2px solid rgba(34, 197, 94, 0.95)' : '2px solid rgba(59, 130, 246, 0.95)';
    box.style.background = fillable ? 'rgba(34, 197, 94, 0.10)' : 'rgba(59, 130, 246, 0.10)';
    box.style.borderRadius = '6px';
    box.style.boxSizing = 'border-box';
    box.style.boxShadow = '0 0 0 1px rgba(15, 23, 42, 0.35)';
    const badge = document.createElement('div');
    badge.textContent = String(index);
    badge.title = labelOf(element);
    badge.style.position = 'absolute';
    badge.style.left = '-1px';
    badge.style.top = '-18px';
    badge.style.minWidth = '18px';
    badge.style.height = '18px';
    badge.style.padding = '0 5px';
    badge.style.borderRadius = '5px';
    badge.style.background = fillable ? 'rgb(22, 163, 74)' : 'rgb(37, 99, 235)';
    badge.style.color = 'white';
    badge.style.fontSize = '11px';
    badge.style.fontWeight = '650';
    badge.style.lineHeight = '18px';
    badge.style.textAlign = 'center';
    box.appendChild(badge);
    return box;
  });
  root.replaceChildren(...nodes);
  return elements.length;
};

let animationFrame = 0;
const scheduleRender = () => {
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame);
  }
  animationFrame = window.requestAnimationFrame(() => {
    animationFrame = 0;
    render();
  });
};
const cleanup = () => {
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame);
  }
  window.removeEventListener('scroll', scheduleRender, true);
  window.removeEventListener('resize', scheduleRender);
  root.remove();
  delete window.__POLARIS_AI_OVERLAY_CLEANUP__;
};
window.__POLARIS_AI_OVERLAY_CLEANUP__ = cleanup;
window.addEventListener('scroll', scheduleRender, true);
window.addEventListener('resize', scheduleRender);

const count = render();
return JSON.stringify({ enabled: true, count });
"#;
