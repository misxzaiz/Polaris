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
static BROWSER_CREATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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

fn create_lock() -> &'static Mutex<()> {
    BROWSER_CREATE_LOCK.get_or_init(|| Mutex::new(()))
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
    let script = interactive_elements_script();
    let raw = browser_eval_with_app(app, label, &script, Some(3_500)).await?;
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

    let script = click_element_script(index, text.unwrap_or_default());
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

    let script = fill_element_script(index, text.unwrap_or_default(), value);
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
    let script = ai_overlay_script(enabled);
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
    let script = diagnostics_script();
    let raw = browser_eval_with_app(app, label, &script, Some(3_500)).await?;
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
fn reuse_browser_webview(
    app: &AppHandle,
    label: String,
    tab_id: Option<String>,
    normalized: url::Url,
    title: Option<String>,
    bounds: BrowserBounds,
    existing: tauri::Webview,
) -> Result<BrowserSessionInfo> {
    let normalized_string = normalized.to_string();
    let current_url = existing
        .url()
        .ok()
        .map(|url| url.to_string())
        .unwrap_or_else(|| normalized_string.clone());

    let is_same_url = current_url == normalized_string;

    if !is_same_url {
        existing.navigate(normalized)?;
    }

    apply_webview_bounds(&existing, bounds)?;
    remember_browser_bounds(&label, bounds)?;
    upsert_session_and_emit(
        app,
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
    )
}

#[cfg(feature = "tauri-app")]
fn browser_create_with_app(
    app: &AppHandle,
    label: String,
    tab_id: Option<String>,
    url: String,
    title: Option<String>,
    bounds: BrowserBounds,
) -> Result<BrowserSessionInfo> {
    let _create_guard = create_lock()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器创建锁异常: {e}")))?;
    let normalized = normalize_url(&url)?;

    if let Some(existing) = app.get_webview(&label) {
        return reuse_browser_webview(app, label, tab_id, normalized, title, bounds, existing);
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

    if let Err(error) = host_window.add_child(
        builder,
        tauri::LogicalPosition::new(bounds.x, bounds.y),
        tauri::LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
    ) {
        if let Some(existing) = app.get_webview(&label) {
            tracing::warn!(
                "[Browser] 创建 WebView 时发现 label 已存在，改为复用: {} ({})",
                label,
                error
            );
            return reuse_browser_webview(app, label, tab_id, normalized, title, bounds, existing);
        }
        return Err(error.into());
    }

    remember_browser_bounds(&label, bounds)?;
    upsert_session_and_emit(
        app,
        label,
        tab_id,
        Some(normalized.to_string()),
        title.or_else(|| Some("Browser".to_string())),
    )
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
    browser_create_with_app(&app, label, tab_id, url, title, bounds)
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

macro_rules! polaris_interactive_collector_script {
    () => {
        r#"
const POLARIS_INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'summary',
  'area[href]',
  'label[for]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[aria-pressed]',
  '[aria-selected]',
  '[aria-checked]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '[onclick]',
  '[jsaction]',
  '[aria-haspopup]',
  '[aria-expanded]',
  '[aria-controls]',
  '[popovertarget]',
  '[commandfor]',
  '[data-action]',
  '[data-click]',
  '[data-command]',
  '[data-href]',
  '[data-url]',
  '[data-route]'
].join(',');

const POLARIS_CLICKABLE_ROLES = new Set([
  'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'checkbox', 'radio', 'switch', 'combobox',
  'listbox', 'treeitem', 'gridcell', 'slider', 'spinbutton'
]);
const POLARIS_FILLABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
const POLARIS_SCAN_LIMIT = 5000;

const clean = (value, max = 220) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const ownerWindowOf = (element) => element?.ownerDocument?.defaultView || window;
const styleOf = (element) => ownerWindowOf(element).getComputedStyle(element);
const tagOf = (element) => String(element?.tagName || '').toLowerCase();
const roleOf = (element) => clean(element.getAttribute('role') || '', 80).toLowerCase();
const isElement = (value) => value && value.nodeType === 1;
const cssEscape = (value) => window.CSS?.escape
  ? window.CSS.escape(String(value))
  : String(value).replace(/["\\]/g, '\\$&');

const ariaLabelledByText = (element) => {
  const doc = element.ownerDocument || document;
  const ids = clean(element.getAttribute('aria-labelledby') || '', 500).split(' ').filter(Boolean);
  return clean(ids.map((id) => doc.getElementById(id)?.textContent || '').join(' '), 240);
};

const associatedLabelText = (element) => {
  const doc = element.ownerDocument || document;
  const id = element.getAttribute('id');
  let explicit = '';
  if (id) {
    try {
      explicit = Array.from(doc.querySelectorAll(`label[for="${cssEscape(id)}"]`)).map((label) => label.innerText || label.textContent || '').join(' ');
    } catch {}
  }
  const implicit = element.closest?.('label')?.innerText || '';
  return clean(`${explicit} ${implicit}`, 240);
};

const descriptorOf = (element) => {
  const tag = tagOf(element) || 'element';
  const id = clean(element.getAttribute('id') || '', 80);
  const name = clean(element.getAttribute('name') || '', 80);
  const testId = clean(
    element.getAttribute('data-testid')
      || element.getAttribute('data-test')
      || element.getAttribute('data-cy')
      || '',
    100
  );
  const className = clean(String(element.getAttribute('class') || '').split(/\s+/).slice(0, 2).join('.'), 80);
  return clean([
    tag,
    id ? `#${id}` : '',
    name ? `[name=${name}]` : '',
    testId ? `[testid=${testId}]` : '',
    !id && !name && !testId && className ? `.${className}` : ''
  ].filter(Boolean).join(''), 160);
};

const textAlternativeOf = (element) => {
  const svgTitle = element.querySelector?.('svg title, title')?.textContent || '';
  const labelled = ariaLabelledByText(element);
  const associated = associatedLabelText(element);
  return clean(
    element.innerText
      || element.value
      || element.getAttribute('aria-label')
      || labelled
      || associated
      || element.getAttribute('alt')
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || svgTitle
      || element.getAttribute('data-label')
      || element.getAttribute('data-testid')
      || element.getAttribute('data-test')
      || element.getAttribute('data-cy')
      || element.getAttribute('name')
      || element.getAttribute('id')
      || element.href
      || '',
    240
  );
};

const labelOf = (element) => textAlternativeOf(element) || descriptorOf(element);

const kindOf = (element) => {
  const tag = tagOf(element);
  const role = roleOf(element);
  const type = clean(element.getAttribute('type') || '', 40).toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'area') return 'link';
  if (tag === 'input') return type ? `input:${type}` : 'input';
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'button') return 'button';
  if (tag === 'summary') return 'summary';
  if (tag === 'label' && element.hasAttribute('for')) return 'label';
  if (role) return role;
  if (element.isContentEditable) return 'editable';
  return tag || 'element';
};

const isNativeInteractive = (element) => {
  const tag = tagOf(element);
  return tag === 'a' && element.hasAttribute('href')
    || tag === 'area' && element.hasAttribute('href')
    || tag === 'button'
    || tag === 'textarea'
    || tag === 'select'
    || tag === 'summary'
    || (tag === 'label' && element.hasAttribute('for'))
    || (tag === 'input' && (element.getAttribute('type') || '').toLowerCase() !== 'hidden');
};

const isFillable = (element) => {
  const tag = tagOf(element);
  const role = roleOf(element);
  const type = clean(element.getAttribute('type') || '', 40).toLowerCase();
  const nonTextInputTypes = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden', 'range', 'color'];
  return element.isContentEditable
    || tag === 'textarea'
    || tag === 'select'
    || POLARIS_FILLABLE_ROLES.has(role)
    || (tag === 'input' && !nonTextInputTypes.includes(type));
};

const isReadOnly = (element) => Boolean(
  element.readOnly || element.getAttribute('aria-readonly') === 'true'
);

const isDisabled = (element) => Boolean(
  element.disabled
    || element.closest?.('[disabled], [aria-disabled="true"], [inert]')
    || element.getAttribute('aria-disabled') === 'true'
);

const hasInteractiveAttribute = (element) => {
  const names = typeof element.getAttributeNames === 'function'
    ? element.getAttributeNames().map((name) => name.toLowerCase())
    : [];
  return Boolean(
    element.hasAttribute('onclick')
      || typeof element.onclick === 'function'
      || element.hasAttribute('jsaction')
      || element.hasAttribute('aria-haspopup')
      || element.hasAttribute('aria-expanded')
      || element.hasAttribute('aria-controls')
      || element.hasAttribute('aria-pressed')
      || element.hasAttribute('aria-selected')
      || element.hasAttribute('aria-checked')
      || element.hasAttribute('popovertarget')
      || element.hasAttribute('commandfor')
      || element.hasAttribute('data-action')
      || element.hasAttribute('data-click')
      || element.hasAttribute('data-command')
      || element.hasAttribute('data-href')
      || element.hasAttribute('data-url')
      || element.hasAttribute('data-route')
      || names.some((name) => [
        'ng-click',
        'x-on:click',
        'v-on:click',
        '@click',
        'wire:click',
        'data-bs-toggle',
        'data-toggle',
        'hx-get',
        'hx-post'
      ].includes(name))
  );
};

const rectOf = (element, offset) => {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left + offset.x,
    top: rect.top + offset.y,
    right: rect.right + offset.x,
    bottom: rect.bottom + offset.y,
    width: rect.width,
    height: rect.height
  };
};

const intersectsViewport = (rect) => rect.bottom >= 0
  && rect.right >= 0
  && rect.top <= window.innerHeight
  && rect.left <= window.innerWidth;

const isVisible = (element, offset, viewportOnly) => {
  if (!isElement(element)) return false;
  const tag = tagOf(element);
  if (['html', 'body', 'head', 'script', 'style', 'meta', 'link', 'noscript', 'template'].includes(tag)) {
    return false;
  }
  const style = styleOf(element);
  const rect = rectOf(element, offset);
  return rect.width > 0
    && rect.height > 0
    && (!viewportOnly || intersectsViewport(rect))
    && style.visibility !== 'hidden'
    && style.visibility !== 'collapse'
    && style.display !== 'none'
    && Number(style.opacity || '1') > 0.01
    && element.getAttribute('aria-hidden') !== 'true'
    && !element.closest?.('[hidden], [aria-hidden="true"]');
};

const looksInteractive = (element) => {
  const role = roleOf(element);
  const style = styleOf(element);
  return isNativeInteractive(element)
    || element.isContentEditable
    || POLARIS_CLICKABLE_ROLES.has(role)
    || POLARIS_FILLABLE_ROLES.has(role)
    || element.matches?.('[tabindex]:not([tabindex="-1"])')
    || hasInteractiveAttribute(element)
    || style.cursor === 'pointer';
};

const scoreOf = (element) => {
  const role = roleOf(element);
  const style = styleOf(element);
  let score = 0;
  if (isNativeInteractive(element)) score += 80;
  if (POLARIS_CLICKABLE_ROLES.has(role) || POLARIS_FILLABLE_ROLES.has(role)) score += 70;
  if (element.isContentEditable) score += 65;
  if (element.matches?.('[tabindex]:not([tabindex="-1"])')) score += 45;
  if (hasInteractiveAttribute(element)) score += 35;
  if (style.cursor === 'pointer') score += 25;
  if (textAlternativeOf(element)) score += 8;
  return score;
};

const buildSearchText = (element, label) => clean([
  label,
  element.value,
  element.getAttribute('placeholder'),
  element.getAttribute('aria-label'),
  ariaLabelledByText(element),
  associatedLabelText(element),
  element.getAttribute('title'),
  element.getAttribute('alt'),
  element.getAttribute('name'),
  element.getAttribute('id'),
  element.getAttribute('data-testid'),
  element.getAttribute('data-test'),
  element.getAttribute('data-cy'),
  element.href
].filter(Boolean).join(' '), 800).toLowerCase();

const collectRoots = () => {
  const roots = [];
  const visit = (root, offset, depth, frames) => {
    if (!root || depth > 3) return;
    roots.push({ root, offset, frames });
    let nodes = [];
    try {
      nodes = Array.from(root.querySelectorAll('*')).slice(0, POLARIS_SCAN_LIMIT);
    } catch {
      return;
    }
    for (const node of nodes) {
      if (node.shadowRoot) {
        visit(node.shadowRoot, offset, depth + 1, frames);
      }
      if (tagOf(node) === 'iframe') {
        try {
          const doc = node.contentDocument;
          if (doc) {
            const frameRect = node.getBoundingClientRect();
            visit(doc, { x: offset.x + frameRect.left, y: offset.y + frameRect.top }, depth + 1, frames.concat(node));
          }
        } catch {}
      }
    }
  };
  visit(document, { x: 0, y: 0 }, 0, []);
  return roots;
};

const sameRect = (a, b) => Math.abs(a.left - b.left) < 2
  && Math.abs(a.top - b.top) < 2
  && Math.abs(a.width - b.width) < 2
  && Math.abs(a.height - b.height) < 2;

const collectPolarisInteractiveElements = (options = {}) => {
  const viewportOnly = options.viewportOnly === true;
  const maxElements = Number.isFinite(options.maxElements) ? options.maxElements : 220;
  const candidates = [];
  const seen = new WeakSet();
  let order = 0;

  const addCandidate = (element, offset, frames) => {
    if (!isElement(element) || seen.has(element)) return;
    seen.add(element);
    if (!looksInteractive(element) || !isVisible(element, offset, viewportOnly)) return;
    const rect = rectOf(element, offset);
    const label = labelOf(element);
    candidates.push({
      element,
      rect,
      label,
      searchText: buildSearchText(element, label),
      kind: kindOf(element),
      value: clean(element.value || '', 220),
      placeholder: clean(element.getAttribute('placeholder') || '', 220),
      href: clean(element.href || element.getAttribute('data-href') || '', 500),
      disabled: isDisabled(element),
      fillable: isFillable(element) && !isDisabled(element) && !isReadOnly(element),
      frames,
      score: scoreOf(element),
      order: order++
    });
  };

  for (const { root, offset, frames } of collectRoots()) {
    let selected = [];
    try {
      selected = Array.from(root.querySelectorAll(POLARIS_INTERACTIVE_SELECTOR));
    } catch {}
    selected.forEach((element) => addCandidate(element, offset, frames));

    let all = [];
    try {
      all = Array.from(root.querySelectorAll('*')).slice(0, POLARIS_SCAN_LIMIT);
    } catch {}
    all.forEach((element) => {
      try {
        if (hasInteractiveAttribute(element) || styleOf(element).cursor === 'pointer' || typeof element.onclick === 'function') {
          addCandidate(element, offset, frames);
        }
      } catch {}
    });
  }

  const ranked = candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  const kept = [];
  for (const candidate of ranked) {
    const duplicate = kept.some((existing) => existing.element === candidate.element
      || (sameRect(existing.rect, candidate.rect) && existing.label === candidate.label && existing.kind === candidate.kind)
      || (existing.element.contains?.(candidate.element) && sameRect(existing.rect, candidate.rect)));
    if (!duplicate) kept.push(candidate);
  }

  kept.sort((a, b) => {
    const aInView = intersectsViewport(a.rect) ? 0 : 1;
    const bInView = intersectsViewport(b.rect) ? 0 : 1;
    return aInView - bInView
      || a.rect.top - b.rect.top
      || a.rect.left - b.rect.left
      || a.order - b.order;
  });

  return kept.slice(0, maxElements);
};

const toPolarisInteractiveElement = (entry, index) => ({
  index,
  kind: entry.kind,
  text: clean(entry.label, 240),
  value: entry.value,
  placeholder: entry.placeholder,
  href: entry.href,
  disabled: entry.disabled,
  fillable: entry.fillable
});

const toPolarisVisualElement = (entry, index) => ({
  index,
  kind: entry.kind,
  text: clean(entry.label, 240),
  rect: {
    x: Math.round(entry.rect.left),
    y: Math.round(entry.rect.top),
    width: Math.round(entry.rect.width),
    height: Math.round(entry.rect.height)
  },
  fillable: entry.fillable,
  disabled: entry.disabled
});
"#
    };
}

const CONSOLE_CAPTURE_SCRIPT: &str = r#"
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
"#;

const INTERACTIVE_ELEMENTS_SCRIPT_BODY: &str = r#"
const elements = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 220 })
  .map((entry, index) => toPolarisInteractiveElement(entry, index));
return JSON.stringify(elements);
"#;

const DIAGNOSTICS_SCRIPT_BODY: &str = r#"
const elements = collectPolarisInteractiveElements({ viewportOnly: true, maxElements: 180 })
  .map((entry, index) => toPolarisVisualElement(entry, index));
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
"#;

const CLICK_ELEMENT_SCRIPT_BODY: &str = r#"
const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 240 });
const query = clean(requestedText, 240).toLowerCase();
let index = Number.isInteger(requestedIndex) ? requestedIndex : -1;
let entry = index >= 0 ? entries[index] : null;
if (!entry && query) {
  index = entries.findIndex((item) => item.searchText.includes(query));
  entry = index >= 0 ? entries[index] : null;
}
if (!entry) {
  return JSON.stringify({ ok: false, action: 'click', index: null, text: requestedText || '', url: String(location.href), message: '未找到可点击元素' });
}
if (entry.disabled) {
  return JSON.stringify({ ok: false, action: 'click', index, text: entry.label, url: String(location.href), message: '目标元素已禁用' });
}
const target = entry.element;
for (const frame of entry.frames || []) {
  try { frame.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
}
target.scrollIntoView({ block: 'center', inline: 'center' });
if (tagOf(target) === 'a') {
  target.setAttribute('target', '_self');
}
try { target.focus({ preventScroll: true }); } catch {}
const view = ownerWindowOf(target);
const targetRect = target.getBoundingClientRect();
const clientX = targetRect.left + Math.max(1, Math.min(targetRect.width / 2, targetRect.width - 1));
const clientY = targetRect.top + Math.max(1, Math.min(targetRect.height / 2, targetRect.height - 1));
const dispatchMouse = (type) => {
  try {
    target.dispatchEvent(new view.MouseEvent(type, { bubbles: true, cancelable: true, view, clientX, clientY, button: 0, buttons: type === 'mouseup' ? 0 : 1 }));
  } catch {}
};
const dispatchPointer = (type) => {
  try {
    if (view.PointerEvent) {
      target.dispatchEvent(new view.PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', clientX, clientY, button: 0, buttons: type === 'pointerup' ? 0 : 1, view }));
    }
  } catch {}
};
dispatchPointer('pointerdown');
dispatchMouse('mousedown');
dispatchPointer('pointerup');
dispatchMouse('mouseup');
if (typeof target.click === 'function') {
  target.click();
} else {
  dispatchMouse('click');
}
return JSON.stringify({ ok: true, action: 'click', index, text: entry.label, url: String(location.href), message: '已点击目标元素' });
"#;

const FILL_ELEMENT_SCRIPT_BODY: &str = r#"
const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 240 });
const query = clean(requestedText, 240).toLowerCase();
let index = Number.isInteger(requestedIndex) ? requestedIndex : -1;
let entry = index >= 0 ? entries[index] : null;
if (!entry && query) {
  index = entries.findIndex((item) => item.searchText.includes(query));
  entry = index >= 0 ? entries[index] : null;
}
if (!entry) {
  return JSON.stringify({ ok: false, action: 'fill', index: null, text: requestedText || '', url: String(location.href), message: '未找到可输入元素' });
}
const target = entry.element;
if (!entry.fillable) {
  return JSON.stringify({ ok: false, action: 'fill', index, text: entry.label, url: String(location.href), message: '目标元素不可输入' });
}
if (entry.disabled) {
  return JSON.stringify({ ok: false, action: 'fill', index, text: entry.label, url: String(location.href), message: '目标元素不可输入' });
}
const setNativeValue = (element, value) => {
  const view = ownerWindowOf(element);
  const prototype = element instanceof view.HTMLTextAreaElement
    ? view.HTMLTextAreaElement.prototype
    : element instanceof view.HTMLSelectElement
      ? view.HTMLSelectElement.prototype
      : view.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor && descriptor.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
};
for (const frame of entry.frames || []) {
  try { frame.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
}
target.scrollIntoView({ block: 'center', inline: 'center' });
try { target.focus({ preventScroll: true }); } catch {}
if (target.isContentEditable) {
  target.textContent = fillValue;
} else if (tagOf(target) === 'select') {
  const option = Array.from(target.options).find((item) => item.value === fillValue || clean(item.textContent).includes(fillValue));
  setNativeValue(target, option ? option.value : fillValue);
} else if ('value' in target) {
  setNativeValue(target, fillValue);
} else {
  target.textContent = fillValue;
}
const view = ownerWindowOf(target);
target.dispatchEvent(new view.Event('input', { bubbles: true }));
target.dispatchEvent(new view.Event('change', { bubbles: true }));
return JSON.stringify({ ok: true, action: 'fill', index, text: entry.label, url: String(location.href), message: '已填写目标元素' });
"#;

const AI_OVERLAY_SCRIPT_BODY: &str = r#"
const existingCleanup = window.__POLARIS_AI_OVERLAY_CLEANUP__;
if (typeof existingCleanup === 'function') {
  existingCleanup();
}

if (!overlayEnabled) {
  return JSON.stringify({ enabled: false, count: 0 });
}

const root = document.createElement('div');
root.id = '__polaris_ai_overlay__';
root.style.position = 'fixed';
root.style.inset = '0';
root.style.pointerEvents = 'none';
root.style.zIndex = '2147483646';
root.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
document.documentElement.appendChild(root);

const render = () => {
  const entries = collectPolarisInteractiveElements({ viewportOnly: true, maxElements: 180 });
  const nodes = entries.map((entry, index) => {
    const rect = entry.rect;
    const box = document.createElement('div');
    box.style.position = 'fixed';
    box.style.left = `${Math.max(rect.left, 0)}px`;
    box.style.top = `${Math.max(rect.top, 0)}px`;
    box.style.width = `${Math.max(rect.width, 8)}px`;
    box.style.height = `${Math.max(rect.height, 8)}px`;
    box.style.border = entry.fillable ? '2px solid rgba(34, 197, 94, 0.95)' : '2px solid rgba(59, 130, 246, 0.95)';
    box.style.background = entry.fillable ? 'rgba(34, 197, 94, 0.10)' : 'rgba(59, 130, 246, 0.10)';
    box.style.borderRadius = '6px';
    box.style.boxSizing = 'border-box';
    box.style.boxShadow = '0 0 0 1px rgba(15, 23, 42, 0.35)';
    const badge = document.createElement('div');
    badge.textContent = String(index);
    badge.title = entry.label;
    badge.style.position = 'absolute';
    badge.style.left = '-1px';
    badge.style.top = '-18px';
    badge.style.minWidth = '18px';
    badge.style.height = '18px';
    badge.style.padding = '0 5px';
    badge.style.borderRadius = '5px';
    badge.style.background = entry.fillable ? 'rgb(22, 163, 74)' : 'rgb(37, 99, 235)';
    badge.style.color = 'white';
    badge.style.fontSize = '11px';
    badge.style.fontWeight = '650';
    badge.style.lineHeight = '18px';
    badge.style.textAlign = 'center';
    box.appendChild(badge);
    return box;
  });
  root.replaceChildren(...nodes);
  return entries.length;
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

fn script_with_collector(body: &str) -> String {
    let mut script = String::from("(() => {\n");
    script.push_str(polaris_interactive_collector_script!());
    script.push('\n');
    script.push_str(body);
    script.push_str("\n})()");
    script
}

fn interactive_elements_script() -> String {
    script_with_collector(INTERACTIVE_ELEMENTS_SCRIPT_BODY)
}

fn diagnostics_script() -> String {
    let mut script = String::from("(() => {\n");
    script.push_str(CONSOLE_CAPTURE_SCRIPT);
    script.push('\n');
    script.push_str(polaris_interactive_collector_script!());
    script.push('\n');
    script.push_str(DIAGNOSTICS_SCRIPT_BODY);
    script.push_str("\n})()");
    script
}

fn click_element_script(index: Option<usize>, text: &str) -> String {
    let mut script = String::from("(() => {\nconst requestedIndex = ");
    script.push_str(
        &index
            .map(|value| value.to_string())
            .unwrap_or_else(|| "null".to_string()),
    );
    script.push_str(";\nconst requestedText = ");
    script.push_str(&serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string()));
    script.push_str(";\n");
    script.push_str(polaris_interactive_collector_script!());
    script.push('\n');
    script.push_str(CLICK_ELEMENT_SCRIPT_BODY);
    script.push_str("\n})()");
    script
}

fn fill_element_script(index: Option<usize>, text: &str, value: &str) -> String {
    let mut script = String::from("(() => {\nconst requestedIndex = ");
    script.push_str(
        &index
            .map(|value| value.to_string())
            .unwrap_or_else(|| "null".to_string()),
    );
    script.push_str(";\nconst requestedText = ");
    script.push_str(&serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string()));
    script.push_str(";\nconst fillValue = ");
    script.push_str(&serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string()));
    script.push_str(";\n");
    script.push_str(polaris_interactive_collector_script!());
    script.push('\n');
    script.push_str(FILL_ELEMENT_SCRIPT_BODY);
    script.push_str("\n})()");
    script
}

fn ai_overlay_script(enabled: bool) -> String {
    let mut script = String::from("(() => {\nconst overlayEnabled = ");
    script.push_str(if enabled { "true" } else { "false" });
    script.push_str(";\n");
    script.push_str(polaris_interactive_collector_script!());
    script.push('\n');
    script.push_str(AI_OVERLAY_SCRIPT_BODY);
    script.push_str("\n})()");
    script
}

#[cfg(test)]
mod browser_script_tests {
    use super::*;

    #[test]
    fn collector_covers_modern_interactive_patterns() {
        let script = interactive_elements_script();
        assert!(script.contains("[role=\"menuitem\"]"));
        assert!(script.contains("label[for]"));
        assert!(script.contains("[aria-expanded]"));
        assert!(script.contains("[jsaction]"));
        assert!(script.contains("[data-command]"));
        assert!(script.contains("style.cursor === 'pointer'"));
        assert!(script.contains("node.shadowRoot"));
        assert!(script.contains("contentDocument"));
        assert!(script.contains("frames.concat(node)"));
        assert!(script.contains("isReadOnly(element)"));
        assert!(script.contains("maxElements: 220"));
        assert!(!script.contains("slice(0, 80)"));
    }

    #[test]
    fn all_browser_actions_share_the_collector() {
        assert!(diagnostics_script().contains("collectPolarisInteractiveElements"));
        assert!(
            click_element_script(Some(1), "Search").contains("collectPolarisInteractiveElements")
        );
        assert!(fill_element_script(None, "Search", "Polaris")
            .contains("collectPolarisInteractiveElements"));
        assert!(ai_overlay_script(true).contains("collectPolarisInteractiveElements"));
    }
}
