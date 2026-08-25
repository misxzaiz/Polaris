use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::commands::browser_scripts;
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
static BROWSER_AGENT_BINDINGS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static BROWSER_ACQUIRE_PENDING: OnceLock<Mutex<HashMap<String, BrowserAcquireSender>>> =
    OnceLock::new();

const DEFAULT_EVAL_TIMEOUT_MS: u64 = 2_500;
const MAX_EVAL_TIMEOUT_MS: u64 = 15_000;
const BROWSER_ACQUIRE_TIMEOUT_SECS: u64 = 15;
const BROWSER_ACQUIRE_RETRY_DELAY: Duration = Duration::from_millis(1_500);
const BROWSER_ACQUIRE_MAX_RETRIES: u32 = 1;
const MARQUEE_MIN_DIM: usize = 20;

type BrowserAcquireSender =
    oneshot::Sender<std::result::Result<BrowserAcquireFrontendResult, String>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionInfo {
    pub label: String,
    pub tab_id: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub updated_at: u64,
    /// 绑定的 agent key(若有),用于所有权审计显示
    #[serde(default)]
    pub bound_agent_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAcquireRequest {
    pub request_id: String,
    pub agent_key: Option<String>,
    pub url: String,
    pub title: Option<String>,
    pub activate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAcquireResult {
    pub label: String,
    pub tab_id: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub created: bool,
    pub bound_agent_key: Option<String>,
}

#[derive(Debug, Clone)]
struct BrowserAcquireFrontendResult {
    label: String,
    tab_id: Option<String>,
    url: Option<String>,
    title: Option<String>,
    created: bool,
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
    #[serde(default)]
    pub rel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSelectOption {
    pub value: String,
    pub text: String,
    #[serde(default)]
    pub selected: bool,
    #[serde(default)]
    pub disabled: bool,
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
    // P0: 坐标、状态、选项、稳定定位
    #[serde(default)]
    pub rect: Option<BrowserRect>,
    #[serde(default)]
    pub checked: Option<bool>,
    #[serde(default)]
    pub selected: Option<bool>,
    #[serde(default)]
    pub options: Option<Vec<BrowserSelectOption>>,
    #[serde(default)]
    pub selector: Option<String>,
    // P1: 工具提示、展开/按下态、只读、表单约束
    #[serde(default)]
    pub tooltip: Option<String>,
    #[serde(default)]
    pub expanded: Option<bool>,
    #[serde(default)]
    pub pressed: Option<bool>,
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub required: Option<bool>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub step: Option<f64>,
    #[serde(default)]
    pub cross_origin: bool,
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
    // P0: 结构化内容
    #[serde(default)]
    pub tables: Vec<BrowserTable>,
    #[serde(default)]
    pub code_blocks: Vec<BrowserCodeBlock>,
    #[serde(default)]
    pub images: Vec<BrowserImage>,
    #[serde(default)]
    pub structured_data: Vec<serde_json::Value>,
    // P1: 扩展 meta & 列表/表单
    #[serde(default)]
    pub lists: Vec<BrowserList>,
    #[serde(default)]
    pub forms: Vec<BrowserForm>,
    #[serde(default)]
    pub canonical: Option<String>,
    #[serde(default)]
    pub og_title: Option<String>,
    #[serde(default)]
    pub og_image: Option<String>,
    #[serde(default)]
    pub favicon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTable {
    pub rows: Vec<Vec<String>>,
    #[serde(default)]
    pub caption: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCodeBlock {
    pub language: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImage {
    pub src: String,
    #[serde(default)]
    pub alt: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserList {
    pub ordered: bool,
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserForm {
    pub action: String,
    pub method: String,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHistoryState {
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

/// 圈选区域筛选结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRegionResult {
    pub url: String,
    pub count: usize,
    pub elements: Vec<BrowserRegionElement>,
    pub html_snippet: String,
    #[serde(default)]
    pub text_snippet: Option<String>,
    #[serde(default)]
    pub screenshot: Option<BrowserScreenshot>,
}

/// 圈选区域内元素
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRegionElement {
    pub index: usize,
    pub kind: String,
    pub text: String,
    pub rect: BrowserRect,
    pub fillable: bool,
    pub disabled: bool,
    #[serde(default)]
    pub selector: Option<String>,
}

/// 圈选 overlay 结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserMarqueeResult {
    pub enabled: bool,
    pub count: usize,
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
    // P1: 状态信息
    #[serde(default)]
    pub checked: Option<bool>,
    #[serde(default)]
    pub selected: Option<bool>,
    #[serde(default)]
    pub selector: Option<String>,
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

fn agent_bindings() -> &'static Mutex<HashMap<String, String>> {
    BROWSER_AGENT_BINDINGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn acquire_pending() -> &'static Mutex<HashMap<String, BrowserAcquireSender>> {
    BROWSER_ACQUIRE_PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn optional_trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_acquire_mode(mode: Option<&str>) -> Result<&'static str> {
    match optional_trimmed(mode).as_deref().unwrap_or("auto") {
        "auto" => Ok("auto"),
        "create" => Ok("create"),
        "reuse" => Ok("reuse"),
        other => Err(AppError::ValidationError(format!(
            "browser acquire mode 无效: {other}"
        ))),
    }
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

fn ensure_ai_navigation_url_allowed(url: &url::Url) -> Result<()> {
    if url.scheme() == "file" {
        return Err(AppError::ValidationError(
            "AI/MCP 浏览器导航暂不允许 file:// URL；请使用文件工具读取本地文件，或由用户手动打开。"
                .to_string(),
        ));
    }
    Ok(())
}

fn normalize_ai_navigation_url(input: &str) -> Result<url::Url> {
    let url = normalize_url(input)?;
    ensure_ai_navigation_url_allowed(&url)?;
    Ok(url)
}

pub fn resolve_browser_label(label: Option<&str>) -> Result<String> {
    resolve_browser_label_for_agent(label, None)
}

pub fn resolve_browser_label_for_agent(
    label: Option<&str>,
    agent_key: Option<&str>,
) -> Result<String> {
    if let Some(label) = optional_trimmed(label) {
        return Ok(label);
    }

    if let Some(agent_key) = optional_trimmed(agent_key) {
        let bound_label = agent_bindings()
            .lock()
            .map_err(|e| AppError::Unknown(format!("浏览器 agent 绑定表锁异常: {e}")))?
            .get(&agent_key)
            .cloned();

        if let Some(bound_label) = bound_label {
            if session_for_label(&bound_label)?.is_some() {
                return Ok(bound_label);
            }
            if let Ok(mut guard) = agent_bindings().lock() {
                guard.remove(&agent_key);
            }
        }
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

pub fn bind_browser_agent(agent_key: Option<&str>, label: &str) -> Result<()> {
    let Some(agent_key) = optional_trimmed(agent_key) else {
        return Ok(());
    };
    agent_bindings()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器 agent 绑定表锁异常: {e}")))?
        .insert(agent_key, label.to_string());
    Ok(())
}

fn bound_browser_label_for_agent(agent_key: Option<&str>) -> Result<Option<String>> {
    let Some(agent_key) = optional_trimmed(agent_key) else {
        return Ok(None);
    };
    let bound_label = agent_bindings()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器 agent 绑定表锁异常: {e}")))?
        .get(&agent_key)
        .cloned();
    if let Some(bound_label) = bound_label {
        if session_for_label(&bound_label)?.is_some() {
            return Ok(Some(bound_label));
        }
        if let Ok(mut guard) = agent_bindings().lock() {
            guard.remove(&agent_key);
        }
    }
    Ok(None)
}

fn unbind_browser_label(label: &str) {
    if let Ok(mut guard) = agent_bindings().lock() {
        guard.retain(|_, bound_label| bound_label != label);
    }
}

fn forget_browser_session_state(label: &str) -> Result<()> {
    sessions()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器会话表锁异常: {e}")))?
        .remove(label);
    forget_browser_bounds(label);
    unbind_browser_label(label);
    Ok(())
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
    if let Some(webview) = app.get_webview(label) {
        return Ok(webview);
    }
    let _ = forget_browser_session_state(label);
    Err(AppError::ValidationError(format!(
        "浏览器 WebView 不存在: {label}"
    )))
}

#[cfg(feature = "tauri-app")]
fn prune_stale_browser_sessions_with_app(app: &AppHandle) -> Result<()> {
    let labels: Vec<String> = sessions()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器会话表锁异常: {e}")))?
        .keys()
        .cloned()
        .collect();

    for label in labels {
        if app.get_webview(&label).is_none() {
            forget_browser_session_state(&label)?;
        }
    }
    Ok(())
}

#[cfg(feature = "tauri-app")]
pub fn browser_list_registered_sessions_with_app(
    app: &AppHandle,
) -> Result<Vec<BrowserSessionInfo>> {
    prune_stale_browser_sessions_with_app(app)?;
    browser_list_registered_sessions()
}

#[cfg(feature = "tauri-app")]
pub fn resolve_browser_label_for_agent_with_app(
    app: &AppHandle,
    label: Option<&str>,
    agent_key: Option<&str>,
) -> Result<String> {
    if let Some(label) = optional_trimmed(label) {
        if app.get_webview(&label).is_some() {
            return Ok(label);
        }
        let _ = forget_browser_session_state(&label);
        return Err(AppError::ValidationError(format!(
            "浏览器 WebView 不存在: {label}"
        )));
    }

    prune_stale_browser_sessions_with_app(app)?;
    resolve_browser_label_for_agent(None, agent_key)
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
    // 保留已绑定的 agent key(upsert 不应清除所有权)
    let bound_agent_key = existing
        .as_ref()
        .and_then(|s| s.bound_agent_key.clone())
        .or_else(|| lookup_bound_agent_for_label(&label));
    let session = BrowserSessionInfo {
        label: label.clone(),
        tab_id: tab_id.or_else(|| existing.as_ref().and_then(|s| s.tab_id.clone())),
        url: url.or_else(|| existing.as_ref().and_then(|s| s.url.clone())),
        title: title.or_else(|| existing.as_ref().and_then(|s| s.title.clone())),
        updated_at: now_ms(),
        bound_agent_key,
    };
    guard.insert(label, session.clone());
    Ok(session)
}

/// 反查 label 对应的 agent key(从 agent_bindings 表)
fn lookup_bound_agent_for_label(label: &str) -> Option<String> {
    let guard = agent_bindings().lock().ok()?;
    for (agent_key, bound_label) in guard.iter() {
        if bound_label == label {
            return Some(agent_key.clone());
        }
    }
    None
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
        tracing::info!(
            "[Browser] apply_webview_bounds: HIDE (bounds={:?})",
            bounds
        );
        webview.hide()?;
        return Ok(());
    }

    tracing::info!(
        "[Browser] apply_webview_bounds: SET ({:.0},{:.0} {:.0}x{:.0})",
        bounds.x, bounds.y, bounds.width, bounds.height
    );

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
fn emit_activate_tab_request(app: &AppHandle, tab_id: Option<&str>) {
    if let Some(tab_id) = tab_id.map(str::trim).filter(|tab_id| !tab_id.is_empty()) {
        let _ = app.emit("browser://activate-tab-request", json!({ "tabId": tab_id }));
    }
}

fn acquire_result_from_session(
    session: BrowserSessionInfo,
    created: bool,
    agent_key: Option<&str>,
) -> BrowserAcquireResult {
    BrowserAcquireResult {
        label: session.label,
        tab_id: session.tab_id,
        url: session.url,
        title: session.title,
        created,
        bound_agent_key: optional_trimmed(agent_key),
    }
}

#[cfg(feature = "tauri-app")]
pub async fn browser_acquire_with_app(
    app: &AppHandle,
    agent_key: Option<&str>,
    label: Option<&str>,
    url: Option<&str>,
    title: Option<&str>,
    mode: Option<&str>,
    activate: bool,
) -> Result<BrowserAcquireResult> {
    let agent_key = optional_trimmed(agent_key);
    let mode = normalize_acquire_mode(mode)?;
    let title = optional_trimmed(title).unwrap_or_else(|| "Browser".to_string());
    prune_stale_browser_sessions_with_app(app)?;
    let normalized_url = match optional_trimmed(url) {
        Some(url) => Some(normalize_ai_navigation_url(&url)?.to_string()),
        None => None,
    };

    if let Some(label) = optional_trimmed(label) {
        let session = session_for_label(&label)?
            .ok_or_else(|| AppError::ValidationError(format!("浏览器 WebView 不存在: {label}")))?;
        bind_browser_agent(agent_key.as_deref(), &label)?;
        if let Some(url) = normalized_url.as_deref() {
            let navigated = browser_navigate_ai_with_app(app, &label, url)?;
            let session = upsert_session_and_emit(
                app,
                label.clone(),
                None,
                Some(navigated),
                Some(title.clone()),
            )?;
            if activate {
                emit_activate_tab_request(app, session.tab_id.as_deref());
            }
            return Ok(acquire_result_from_session(
                session,
                false,
                agent_key.as_deref(),
            ));
        }
        if activate {
            emit_activate_tab_request(app, session.tab_id.as_deref());
        }
        return Ok(acquire_result_from_session(
            session,
            false,
            agent_key.as_deref(),
        ));
    }

    if mode != "create" {
        if let Some(agent_key_value) = agent_key.as_deref() {
            if let Some(bound_label) = bound_browser_label_for_agent(Some(agent_key_value))? {
                if let Some(url) = normalized_url.as_deref() {
                    let navigated = browser_navigate_ai_with_app(app, &bound_label, url)?;
                    let session = upsert_session_and_emit(
                        app,
                        bound_label.clone(),
                        None,
                        Some(navigated),
                        Some(title.clone()),
                    )?;
                    if activate {
                        emit_activate_tab_request(app, session.tab_id.as_deref());
                    }
                    return Ok(acquire_result_from_session(
                        session,
                        false,
                        agent_key.as_deref(),
                    ));
                }
                let session = session_for_label(&bound_label)?.ok_or_else(|| {
                    AppError::ValidationError(format!("浏览器 WebView 不存在: {bound_label}"))
                })?;
                if activate {
                    emit_activate_tab_request(app, session.tab_id.as_deref());
                }
                return Ok(acquire_result_from_session(
                    session,
                    false,
                    agent_key.as_deref(),
                ));
            }
        }
    }

    if mode == "reuse" {
        if let Ok(reused_label) = resolve_browser_label_for_agent_with_app(app, None, None) {
            let session = if let Some(url) = normalized_url.as_deref() {
                let navigated = browser_navigate_ai_with_app(app, &reused_label, url)?;
                upsert_session_and_emit(
                    app,
                    reused_label.clone(),
                    None,
                    Some(navigated),
                    Some(title.clone()),
                )?
            } else {
                session_for_label(&reused_label)?.ok_or_else(|| {
                    AppError::ValidationError(format!("浏览器 WebView 不存在: {reused_label}"))
                })?
            };
            bind_browser_agent(agent_key.as_deref(), &reused_label)?;
            if activate {
                emit_activate_tab_request(app, session.tab_id.as_deref());
            }
            return Ok(acquire_result_from_session(
                session,
                false,
                agent_key.as_deref(),
            ));
        }
    }

    let request_id = Uuid::new_v4().to_string();
    let request = BrowserAcquireRequest {
        request_id: request_id.clone(),
        agent_key: agent_key.clone(),
        url: normalized_url.unwrap_or_else(|| "https://www.bing.com/".to_string()),
        title: Some(title),
        // A newly-created native WebView is mounted by the active BrowserPanel.
        activate: true,
    };
    let mut last_timeout_error = None;
    for attempt in 0..=BROWSER_ACQUIRE_MAX_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(BROWSER_ACQUIRE_RETRY_DELAY).await;
        }

        // 每次重试都重新 emit 事件（新 request_id 让前端重新创建 tab）
        if let Err(error) = app.emit("browser://acquire-request", &request) {
            if let Ok(mut guard) = acquire_pending().lock() {
                guard.remove(&request_id);
            }
            return Err(error.into());
        }

        let (tx, rx) = oneshot::channel();
        acquire_pending()
            .lock()
            .map_err(|e| AppError::Unknown(format!("浏览器 acquire 等待表锁异常: {e}")))?
            .insert(request_id.clone(), tx);

        match tokio::time::timeout(Duration::from_secs(BROWSER_ACQUIRE_TIMEOUT_SECS), rx).await {
            Ok(Ok(Ok(result))) => {
                // 成功：清理重试状态
                if let Ok(mut guard) = acquire_pending().lock() {
                    guard.remove(&request_id);
                }
                bind_browser_agent(agent_key.as_deref(), &result.label)?;
                return Ok(BrowserAcquireResult {
                    label: result.label,
                    tab_id: result.tab_id,
                    url: result.url,
                    title: result.title,
                    created: result.created,
                    bound_agent_key: agent_key,
                });
            }
            Ok(Ok(Err(error))) => {
                if let Ok(mut guard) = acquire_pending().lock() {
                    guard.remove(&request_id);
                }
                return Err(AppError::ProcessError(error));
            }
            Ok(Err(_)) => {
                if let Ok(mut guard) = acquire_pending().lock() {
                    guard.remove(&request_id);
                }
                return Err(AppError::ProcessError(
                    "浏览器 acquire 请求被取消".to_string(),
                ));
            }
            Err(_) => {
                // 超时：记录错误，清理 pending 表，准备重试
                if let Ok(mut guard) = acquire_pending().lock() {
                    guard.remove(&request_id);
                }
                last_timeout_error = Some((
                    attempt,
                    BROWSER_ACQUIRE_MAX_RETRIES,
                    BROWSER_ACQUIRE_TIMEOUT_SECS,
                ));
                // 继续循环重试
            }
        }
    }

    // 所有重试耗尽
    let (attempt, max_retries, timeout_secs) = last_timeout_error.unwrap_or((0, 0, 15));
    let msg = format!(
        "浏览器 acquire 超时（已重试 {attempt}/{max_retries} 次，每次 {timeout_secs}s）：\n\
        \t- 请确保 Polaris 主窗口处于可见/前台状态，MCP 工具通过 app.emit 等待前端创建 WebView；\n\
        \t- 如果从未打开过内置浏览器面板，请先在侧边栏打开「浏览器」面板；\n\
        \t- 极少数情况下，主窗口最小化会导致前端未响应事件，请恢复窗口后重试。"
    );
    return Err(AppError::TimeoutWithMessage(msg));
}

#[cfg(feature = "tauri-app")]
pub fn browser_navigate_with_app(app: &AppHandle, label: &str, url: &str) -> Result<String> {
    let normalized = normalize_url(url)?;
    browser_navigate_normalized_with_app(app, label, normalized)
}

#[cfg(feature = "tauri-app")]
pub fn browser_navigate_ai_with_app(app: &AppHandle, label: &str, url: &str) -> Result<String> {
    let normalized = normalize_ai_navigation_url(url)?;
    browser_navigate_normalized_with_app(app, label, normalized)
}

#[cfg(feature = "tauri-app")]
fn browser_navigate_normalized_with_app(
    app: &AppHandle,
    label: &str,
    normalized: url::Url,
) -> Result<String> {
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
    let raw = browser_eval_with_app(app, label, browser_scripts::PAGE_CONTEXT_SCRIPT, Some(5_000)).await?;
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
    let script = browser_scripts::interactive_elements_script();
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

    let script = browser_scripts::click_element_script(index, text.unwrap_or_default());
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

    let script = browser_scripts::fill_element_script(index, text.unwrap_or_default(), value);
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
    let script = browser_scripts::ai_overlay_script(enabled);
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
    let script = browser_scripts::diagnostics_script();
    let raw = browser_eval_with_app(app, label, &script, Some(5_000)).await?;
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

    // ADR 0004 P2 #2: 检测窗口当前所在显示器而非假设 monitor 0
    // 用窗口中心点定位所在 monitor,避免多屏坐标偏差
    let window_center_x = (position.x as f64) + bounds.x + bounds.width / 2.0;
    let window_center_y = (position.y as f64) + bounds.y + bounds.height / 2.0;
    let monitor_index = detect_monitor_index(window_center_x, window_center_y);

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
    let shot = controller.screenshot(Some(monitor_index), Some((x, y, width, height)), Some(scale))?;
    Ok(Some(BrowserScreenshot {
        mime_type: "image/png".to_string(),
        data: shot.png_base64,
        width: shot.width,
        height: shot.height,
        scale,
    }))
}

/// 根据屏幕坐标判断所在显示器索引(Windows 多屏支持)
///
/// 使用 Win32 EnumDisplayMonitors 枚举所有显示器，
/// 根据窗口中心点坐标找出包含该点的显示器索引。
#[cfg(all(feature = "tauri-app", windows))]
fn detect_monitor_index(x: f64, y: f64) -> usize {
    use windows_sys::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, MONITORINFOEXW, HMONITOR, HDC, MONITORENUMPROC,
    };
    use windows_sys::Win32::Foundation::{RECT, LPARAM, BOOL};

    let mut monitor_rects: Vec<(i32, i32, i32, i32)> = Vec::new();
    let ctx = &mut monitor_rects as *mut Vec<(i32, i32, i32, i32)>;

    unsafe extern "system" fn enum_proc(
        _hmonitor: HMONITOR,
        _hdc: HDC,
        _lprc_clip: *mut RECT,
        dw_data: LPARAM,
    ) -> BOOL {
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(_hmonitor, &mut info as *mut _ as *mut _) != 0 {
            let rect = &info.monitorInfo.rcMonitor;
            let rects = &mut *(dw_data as *mut Vec<(i32, i32, i32, i32)>);
            rects.push((rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top));
        }
        1
    }

    // SAFETY: Win32 callback — we pass a valid pointer to a Vec
    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            Some(enum_proc),
            ctx as LPARAM,
        );
    }

    // 找到包含该点的显示器
    let cx = x as i32;
    let cy = y as i32;
    for (idx, (mx, my, mw, mh)) in monitor_rects.iter().enumerate() {
        if cx >= *mx && cx < mx + mw && cy >= *my && cy < my + mh {
            return idx;
        }
    }

    0
}

#[cfg(all(feature = "tauri-app", not(windows)))]
fn capture_browser_screenshot(
    _app: &AppHandle,
    _label: &str,
    _scale: f32,
) -> Result<Option<BrowserScreenshot>> {
    // 非 Windows 平台:computer_control 截图后端尚未实现
    // 返回结构化错误而非静默 None,让诊断面板明确告知"当前平台不支持"
    Err(AppError::ValidationError(
        "当前平台暂不支持内置浏览器区域截图；Windows 平台可用 computer_control 截图".to_string(),
    ))
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

    tracing::info!(
        "[Browser] reuse_browser_webview: label={}, same_url={}, bounds=({:.0},{:.0} {:.0}x{:.0})",
        label, is_same_url, bounds.x, bounds.y, bounds.width, bounds.height
    );

    if !is_same_url {
        existing.navigate(normalized)?;
    }

    // 先隐藏再重设 bounds，避免 hide→show 帧窗口期黑屏
    let _ = existing.hide();
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
        tracing::info!(
            "[Browser] browser_create_with_app: reusing existing webview label={}",
            label
        );
        return reuse_browser_webview(app, label, tab_id, normalized, title, bounds, existing);
    }

    tracing::info!(
        "[Browser] browser_create_with_app: creating new webview label={} url={}",
        label, normalized
    );

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
    forget_browser_session_state(&label)
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
    forget_browser_session_state(&label)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_list_sessions(app: AppHandle) -> Result<Vec<BrowserSessionInfo>> {
    browser_list_registered_sessions_with_app(&app)
}

/// 清理所有残留的浏览器 WebView 及其会话状态。
///
/// 页面刷新 / HMR 重挂载时，BrowserPanel cleanup 的 browserSetBounds(0,0,0,0) 调用
/// 可能因 IPC 连接中断而被取消，导致 native WebView 子窗口残留且可见（"置顶关不掉"）。
/// 此命令在应用启动时被调用，确保旧的 WebView 被关闭。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_clear_orphaned_sessions(app: AppHandle) -> Result<usize> {
    let labels: Vec<String> = sessions()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器会话表锁异常: {e}")))?
        .keys()
        .cloned()
        .collect();

    let mut count = 0usize;
    for label in &labels {
        if let Some(webview) = app.get_webview(label) {
            let _ = webview.close();
            count += 1;
        }
        let _ = forget_browser_session_state(label);
    }
    Ok(count)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_acquire(
    app: AppHandle,
    agent_key: Option<String>,
    label: Option<String>,
    url: Option<String>,
    title: Option<String>,
    mode: Option<String>,
    activate: Option<bool>,
) -> Result<BrowserAcquireResult> {
    browser_acquire_with_app(
        &app,
        agent_key.as_deref(),
        label.as_deref(),
        url.as_deref(),
        title.as_deref(),
        mode.as_deref(),
        activate.unwrap_or(true),
    )
    .await
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_acquire_complete(
    request_id: String,
    label: Option<String>,
    tab_id: Option<String>,
    url: Option<String>,
    title: Option<String>,
    created: Option<bool>,
    error: Option<String>,
) -> Result<()> {
    let sender = acquire_pending()
        .lock()
        .map_err(|e| AppError::Unknown(format!("浏览器 acquire 等待表锁异常: {e}")))?
        .remove(&request_id);

    let Some(sender) = sender else {
        return Ok(());
    };

    let outcome = if let Some(error) = optional_trimmed(error.as_deref()) {
        Err(error)
    } else {
        match optional_trimmed(label.as_deref()) {
            Some(label) => Ok(BrowserAcquireFrontendResult {
                label,
                tab_id: optional_trimmed(tab_id.as_deref()),
                url: optional_trimmed(url.as_deref()),
                title: optional_trimmed(title.as_deref()),
                created: created.unwrap_or(true),
            }),
            None => Err("browser_acquire_complete 缺少 label".to_string()),
        }
    };

    let _ = sender.send(outcome);
    Ok(())
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

/// 获取浏览器历史状态：通过注入 JS 读取 history.length 和 __polaris_can_go_forward__ 标记
#[cfg(feature = "tauri-app")]
pub async fn browser_get_history_state_with_app(app: &AppHandle, label: &str) -> Result<BrowserHistoryState> {
    let script = r#"
      (() => {
        try {
          // history.length 为当前导航栈中页面数
          return JSON.stringify({
            canGoBack: history.length > 1,
            canGoForward: window.__polaris_can_go_forward__ === true
          });
        } catch { return '{"canGoBack":false,"canGoForward":false}'; }
      })();
    "#;
    let raw = browser_eval_with_app(app, label, script, Some(DEFAULT_EVAL_TIMEOUT_MS)).await?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| AppError::ValidationError(format!("浏览器历史状态解析失败: {e}")))?;

    let can_go_back = value.get("canGoBack").and_then(|v| v.as_bool()).unwrap_or(false);
    let can_go_forward = value.get("canGoForward").and_then(|v| v.as_bool()).unwrap_or(false);

    Ok(BrowserHistoryState {
        can_go_back,
        can_go_forward,
    })
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_get_history_state(app: AppHandle, label: String) -> Result<BrowserHistoryState> {
    browser_get_history_state_with_app(&app, &label).await
}

// ── browser_wait ──────────────────────────────────────────────────────────
/// 等待条件满足（文本出现、元素出现、URL变化、网络空闲、导航完成、固定延迟）
#[cfg(feature = "tauri-app")]
pub async fn browser_wait_with_app(
    app: &AppHandle,
    label: &str,
    condition: &str,
    text: Option<&str>,
    index: Option<usize>,
    ms: Option<u64>,
    timeout_ms: Option<u64>,
) -> Result<BrowserInteractionResult> {
    let timeout = timeout_ms.unwrap_or_else(|| match condition {
        "network_idle" | "navigation" => 30_000,
        _ => 15_000,
    });
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);
    let poll_interval = Duration::from_millis(200);
    let initial_url = {
        // 先获取当前 URL
        let script = "JSON.stringify({ url: String(location.href) });";
        let raw = browser_eval_with_app(app, label, script, Some(DEFAULT_EVAL_TIMEOUT_MS)).await?;
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
        v.get("url").and_then(Value::as_str).unwrap_or("").to_string()
    };

    loop {
        let check_script = build_wait_check_script(condition, text, index, ms, &initial_url);
        let raw = browser_eval_with_app(app, label, &check_script, Some(3_500)).await?;
        let value = parse_eval_json(&raw)?;
        let result: BrowserInteractionResult = serde_json::from_value(value.clone())?;

        if result.ok {
            return Ok(result);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(BrowserInteractionResult {
                ok: false,
                action: "wait".to_string(),
                index: None,
                text: condition.to_string(),
                url: initial_url,
                message: format!("等待条件 '{condition}' 超时 ({timeout}ms)"),
            });
        }
        tokio::time::sleep(poll_interval).await;
        if tokio::time::Instant::now() >= deadline {
            return Ok(BrowserInteractionResult {
                ok: false,
                action: "wait".to_string(),
                index: None,
                text: condition.to_string(),
                url: initial_url,
                message: format!("等待条件 '{condition}' 超时 ({timeout}ms)"),
            });
        }
    }
}

/// 构建 wait 检查脚本（单次检查，Rust 侧轮询）
#[cfg(feature = "tauri-app")]
fn build_wait_check_script(
    condition: &str,
    text: Option<&str>,
    index: Option<usize>,
    ms: Option<u64>,
    initial_url: &str,
) -> String {
    let wait_text = text.unwrap_or_default();
    let wait_index = index.map(|i| i.to_string()).unwrap_or_else(|| "null".to_string());
    let wait_ms = ms.unwrap_or(0);
    let escaped_initial = initial_url.replace('\'', "\\'");

    format!(
        r#"(function() {{
            const condition = '{cond}';
            const waitText = '{wt}';
            const waitIndex = {wi};
            const waitMs = {wms};
            const initialUrl = '{init}';
            try {{
                let satisfied = false;
                let detail = '';
                switch (condition) {{
                    case 'url_change':
                        satisfied = String(location.href) !== initialUrl;
                        detail = String(location.href);
                        break;
                    case 'text_appear':
                        if (!waitText) {{ satisfied = true; break; }}
                        satisfied = (document.body?.innerText || '').toLowerCase().includes(waitText.toLowerCase());
                        detail = satisfied ? 'text found' : '';
                        break;
                    case 'element_appear': {{
                        const entries = collectPolarisInteractiveElements({{ viewportOnly: false, maxElements: 240 }});
                        if (Number.isInteger(waitIndex) && waitIndex >= 0) {{
                            satisfied = waitIndex < entries.length;
                        }} else if (waitText) {{
                            const q = waitText.toLowerCase();
                            satisfied = entries.some(e => e.searchText.includes(q));
                        }}
                        break;
                    }}
                    case 'network_idle':
                        satisfied = document.readyState === 'complete'
                            && performance.getEntriesByType('resource').filter(r => !r.responseEnd).length === 0;
                        break;
                    case 'navigation':
                        satisfied = document.readyState === 'complete';
                        break;
                    case 'timeout':
                        satisfied = true;
                        break;
                    default:
                        return JSON.stringify({{ ok: false, action: 'wait', index: null, text: condition, url: String(location.href), message: '未知等待条件: ' + condition }});
                }}
                return JSON.stringify({{ ok: satisfied, action: 'wait', index: {wi}, text: condition, url: String(location.href), message: satisfied ? detail : 'pending' }});
            }} catch(e) {{
                return JSON.stringify({{ ok: false, action: 'wait', index: null, text: condition, url: String(location.href), message: 'wait 检查失败: ' + e.message }});
            }}
        }})()"#,
        cond = condition,
        wt = wait_text.replace('\'', "\\'").replace('\n', "\\n"),
        wi = wait_index,
        wms = wait_ms,
        init = escaped_initial,
    )
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_wait(
    app: AppHandle,
    label: String,
    condition: String,
    text: Option<String>,
    index: Option<usize>,
    ms: Option<u64>,
    timeout_ms: Option<u64>,
) -> Result<BrowserInteractionResult> {
    browser_wait_with_app(&app, &label, &condition, text.as_deref(), index, ms, timeout_ms).await
}

// ── browser_scroll ────────────────────────────────────────────────────────
/// 滚动页面到指定位置、元素或方向
#[cfg(feature = "tauri-app")]
pub async fn browser_scroll_with_app(
    app: &AppHandle,
    label: &str,
    mode: &str,
    index: Option<usize>,
    text: Option<&str>,
    x: Option<f64>,
    y: Option<f64>,
    amount: Option<f64>,
) -> Result<BrowserInteractionResult> {
    let script = build_scroll_script(mode, index, text, x, y, amount);
    let raw = browser_eval_with_app(app, label, &script, Some(3_500)).await?;
    let value = parse_eval_json(&raw)?;
    serde_json::from_value(value)
        .map_err(|e| AppError::ValidationError(format!("浏览器滚动结果格式错误: {e}")))
}

#[cfg(feature = "tauri-app")]
fn build_scroll_script(
    mode: &str,
    index: Option<usize>,
    text: Option<&str>,
    x: Option<f64>,
    y: Option<f64>,
    amount: Option<f64>,
) -> String {
    let scroll_index = index.map(|i| i.to_string()).unwrap_or_else(|| "null".to_string());
    let scroll_text = text.unwrap_or_default().replace('\'', "\\'").replace('\n', "\\n");
    let scroll_x = x.unwrap_or(0.0);
    let scroll_y = y.unwrap_or(0.0);
    let scroll_amount = amount.unwrap_or(0.0);

    format!(
        r#"(function() {{
            const mode = '{mode}';
            const scrollIndex = {idx};
            const scrollText = '{txt}';
            const scrollX = {sx};
            const scrollY = {sy};
            const scrollAmount = {amt};
            const behavior = 'smooth';
            try {{
                switch (mode) {{
                    case 'to_element':
                    case 'to': {{
                        let target = null;
                        if (Number.isInteger(scrollIndex) && scrollIndex >= 0) {{
                            const entries = collectPolarisInteractiveElements({{ viewportOnly: false, maxElements: 240 }});
                            target = entries[scrollIndex]?.element || null;
                        }}
                        if (!target && scrollText) {{
                            const q = scrollText.toLowerCase();
                            const entries = collectPolarisInteractiveElements({{ viewportOnly: false, maxElements: 240 }});
                            const idx = entries.findIndex(e => e.searchText.includes(q));
                            if (idx >= 0) target = entries[idx].element;
                        }}
                        if (target) {{
                            target.scrollIntoView({{ behavior, block: 'center', inline: 'center' }});
                            return JSON.stringify({{ ok: true, action: 'scroll', index: {idx}, text: '{txt}', url: String(location.href), message: '已滚动到目标元素' }});
                        }}
                        window.scrollTo({{ left: scrollX, top: scrollY, behavior }});
                        return JSON.stringify({{ ok: true, action: 'scroll', index: null, text: mode, url: String(location.href), message: '已滚动到 (' + scrollX + ', ' + scrollY + ')' }});
                    }}
                    case 'by':
                        window.scrollBy({{ left: scrollX, top: scrollY, behavior }});
                        return JSON.stringify({{ ok: true, action: 'scroll', index: null, text: mode, url: String(location.href), message: '已滚动偏移' }});
                    case 'top':
                        window.scrollTo({{ top: 0, behavior }});
                        return JSON.stringify({{ ok: true, action: 'scroll', index: null, text: 'top', url: String(location.href), message: '已滚动到顶部' }});
                    case 'bottom':
                        window.scrollTo({{ top: document.body.scrollHeight, behavior }});
                        return JSON.stringify({{ ok: true, action: 'scroll', index: null, text: 'bottom', url: String(location.href), message: '已滚动到底部' }});
                    case 'up': {{
                        const amt = scrollAmount || window.innerHeight;
                        window.scrollBy({{ top: -amt, behavior }});
                        return JSON.stringify({{ ok: true, action: 'scroll', index: null, text: 'up', url: String(location.href), message: '已向上滚动 ' + amt + 'px' }});
                    }}
                    case 'down': {{
                        const amt = scrollAmount || window.innerHeight;
                        window.scrollBy({{ top: amt, behavior }});
                        return JSON.stringify({{ ok: true, action: 'scroll', index: null, text: 'down', url: String(location.href), message: '已向下滚动 ' + amt + 'px' }});
                    }}
                    case 'left':
                        window.scrollBy({{ left: -(scrollAmount || window.innerWidth), behavior }});
                        return JSON.stringify({{ ok: true, action: 'scroll', index: null, text: 'left', url: String(location.href), message: '已向左滚动' }});
                    case 'right':
                        window.scrollBy({{ left: scrollAmount || window.innerWidth, behavior }});
                        return JSON.stringify({{ ok: true, action: 'scroll', index: null, text: 'right', url: String(location.href), message: '已向右滚动' }});
                    default:
                        return JSON.stringify({{ ok: false, action: 'scroll', index: null, text: mode, url: String(location.href), message: '未知滚动模式: ' + mode }});
                }}
            }} catch(e) {{
                return JSON.stringify({{ ok: false, action: 'scroll', index: null, text: mode, url: String(location.href), message: '滚动失败: ' + e.message }});
            }}
        }})()"#,
        mode = mode,
        idx = scroll_index,
        txt = scroll_text,
        sx = scroll_x,
        sy = scroll_y,
        amt = scroll_amount,
    )
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_scroll(
    app: AppHandle,
    label: String,
    mode: String,
    index: Option<usize>,
    text: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    amount: Option<f64>,
) -> Result<BrowserInteractionResult> {
    browser_scroll_with_app(&app, &label, &mode, index, text.as_deref(), x, y, amount).await
}

// ── browser_press_key ─────────────────────────────────────────────────────
/// 发送键盘快捷键到浏览器
#[cfg(feature = "tauri-app")]
pub async fn browser_press_key_with_app(
    app: &AppHandle,
    label: &str,
    keys: &str,
    index: Option<usize>,
    text: Option<&str>,
) -> Result<BrowserInteractionResult> {
    if keys.trim().is_empty() {
        return Err(AppError::ValidationError("press_key 需要 keys 参数".to_string()));
    }
    validate_keys(keys)?;
    let script = build_press_key_script(keys, index, text);
    let raw = browser_eval_with_app(app, label, &script, Some(3_500)).await?;
    let value = parse_eval_json(&raw)?;
    serde_json::from_value(value)
        .map_err(|e| AppError::ValidationError(format!("浏览器按键结果格式错误: {e}")))
}

const VALID_KEY_NAMES: &[&str] = &[
    "Enter", "Escape", "Tab", "Backspace", "Delete", "Space", " ",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Home", "End", "PageUp", "PageDown", "Insert",
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
];

const MODIFIER_NAMES: &[&str] = &["Control", "Ctrl", "Shift", "Alt", "Meta", "Command", "Cmd", "Win", "Option"];

#[cfg(feature = "tauri-app")]
fn validate_keys(keys: &str) -> Result<()> {
    let parts: Vec<&str> = keys.split('+').map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Err(AppError::ValidationError("keys 不能为空".to_string()));
    }
    let non_modifiers: Vec<&&str> = parts.iter().filter(|p| !MODIFIER_NAMES.contains(p)).collect();
    if non_modifiers.is_empty() {
        return Err(AppError::ValidationError("keys 不能仅包含修饰键".to_string()));
    }
    // 检查主键是否合法
    for nm in &non_modifiers {
        let upper = nm.to_uppercase();
        if upper.len() == 1 { continue; } // 单字符始终合法
        if !VALID_KEY_NAMES.iter().any(|k| k.eq_ignore_ascii_case(nm)) {
            return Err(AppError::ValidationError(format!("未知按键: {nm}")));
        }
    }
    Ok(())
}

#[cfg(feature = "tauri-app")]
fn build_press_key_script(keys: &str, index: Option<usize>, text: Option<&str>) -> String {
    let req_index = index.map(|i| i.to_string()).unwrap_or_else(|| "null".to_string());
    let req_text = text.unwrap_or_default().replace('\'', "\\'").replace('\n', "\\n");
    let escaped_keys = keys.replace('\'', "\\'");

    format!(
        r#"(function() {{
            const requestedKeys = '{keys}';
            const requestedIndex = {idx};
            const requestedText = '{txt}';
            try {{
                if (Number.isInteger(requestedIndex) && requestedIndex >= 0) {{
                    const entries = collectPolarisInteractiveElements({{ viewportOnly: false, maxElements: 240 }});
                    const entry = entries[requestedIndex];
                    if (entry) {{
                        entry.element.scrollIntoView({{ block: 'center', inline: 'center' }});
                        entry.element.focus({{ preventScroll: true }});
                    }}
                }} else if (requestedText) {{
                    const q = requestedText.toLowerCase();
                    const entries = collectPolarisInteractiveElements({{ viewportOnly: false, maxElements: 240 }});
                    const idx = entries.findIndex(e => e.searchText.includes(q));
                    if (idx >= 0) {{
                        entries[idx].element.scrollIntoView({{ block: 'center', inline: 'center' }});
                        entries[idx].element.focus({{ preventScroll: true }});
                    }}
                }}
                const parts = requestedKeys.split('+').map(p => p.trim());
                const modifiers = {{
                    ctrlKey: parts.some(p => /^control$/i.test(p) || /^ctrl$/i.test(p)),
                    shiftKey: parts.some(p => /^shift$/i.test(p)),
                    altKey: parts.some(p => /^alt$/i.test(p) || /^option$/i.test(p)),
                    metaKey: parts.some(p => /^meta$/i.test(p) || /^command$/i.test(p) || /^cmd$/i.test(p) || /^win$/i.test(p)),
                }};
                const key = parts.find(p => !/^(control|ctrl|shift|alt|option|meta|command|cmd|win)$/i.test(p)) || '';
                const keyMap = {{
                    'enter': 'Enter', 'escape': 'Escape', 'esc': 'Escape', 'tab': 'Tab',
                    'backspace': 'Backspace', 'delete': 'Delete', 'del': 'Delete',
                    'space': ' ', ' ': ' ',
                    'arrowup': 'ArrowUp', 'arrowdown': 'ArrowDown', 'arrowleft': 'ArrowLeft', 'arrowright': 'ArrowRight',
                    'up': 'ArrowUp', 'down': 'ArrowDown', 'left': 'ArrowLeft', 'right': 'ArrowRight',
                    'home': 'Home', 'end': 'End', 'pageup': 'PageUp', 'pagedown': 'PageDown',
                    'insert': 'Insert',
                    'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4', 'f5': 'F5', 'f6': 'F6',
                    'f7': 'F7', 'f8': 'F8', 'f9': 'F9', 'f10': 'F10', 'f11': 'F11', 'f12': 'F12',
                }};
                const resolvedKey = keyMap[key.toLowerCase()] || key;
                const activeEl = document.activeElement || document.body;
                const view = ownerWindowOf(activeEl);
                const eventOpts = {{
                    bubbles: true, cancelable: true, view, key: resolvedKey, code: resolvedKey,
                    ...modifiers, repeat: false, composed: true,
                }};
                activeEl.dispatchEvent(new KeyboardEvent('keydown', eventOpts));
                if (resolvedKey.length === 1 && !modifiers.ctrlKey && !modifiers.altKey && !modifiers.metaKey) {{
                    activeEl.dispatchEvent(new KeyboardEvent('keypress', {{ ...eventOpts, charCode: resolvedKey.charCodeAt(0) }}));
                    const target = activeEl;
                    if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {{
                        const start = target.selectionStart || target.value?.length || 0;
                        const end = target.selectionEnd || start;
                        const newValue = (target.value || '').slice(0, start) + resolvedKey + (target.value || '').slice(end);
                        const proto = target instanceof view.HTMLTextAreaElement ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
                        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                        if (desc?.set) desc.set.call(target, newValue); else target.value = newValue;
                        target.dispatchEvent(new InputEvent('input', {{ bubbles: true, inputType: 'insertText', data: resolvedKey }}));
                    }}
                }}
                activeEl.dispatchEvent(new KeyboardEvent('keyup', eventOpts));
                return JSON.stringify({{ ok: true, action: 'press_key', index: {idx}, text: '{keys}', url: String(location.href), message: '已发送按键: ' + requestedKeys }});
            }} catch(e) {{
                return JSON.stringify({{ ok: false, action: 'press_key', index: {idx}, text: '{keys}', url: String(location.href), message: '按键失败: ' + e.message }});
            }}
        }})()"#,
        keys = escaped_keys,
        idx = req_index,
        txt = req_text,
    )
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_press_key(
    app: AppHandle,
    label: String,
    keys: String,
    index: Option<usize>,
    text: Option<String>,
) -> Result<BrowserInteractionResult> {
    browser_press_key_with_app(&app, &label, &keys, index, text.as_deref()).await
}

// ── browser_type_text ─────────────────────────────────────────────────────
/// 逐字输入文本到聚焦元素
#[cfg(feature = "tauri-app")]
pub async fn browser_type_text_with_app(
    app: &AppHandle,
    label: &str,
    input_text: &str,
    index: Option<usize>,
    element_text: Option<&str>,
    delay_ms: Option<u64>,
) -> Result<BrowserInteractionResult> {
    if input_text.is_empty() {
        return Err(AppError::ValidationError("type_text 需要 text 参数".to_string()));
    }
    let delay = delay_ms.unwrap_or(10).min(200);
    let max_chars = 1000;
    let text_slice = if input_text.len() > max_chars {
        &input_text[..max_chars]
    } else {
        input_text
    };

    // 第一步：聚焦目标元素
    let focus_script = build_type_focus_script(index, element_text);
    let raw = browser_eval_with_app(app, label, &focus_script, Some(3_500)).await?;
    let value = parse_eval_json(&raw)?;
    let focus_result: BrowserInteractionResult = serde_json::from_value(value.clone())?;
    if !focus_result.ok {
        return Ok(focus_result);
    }

    // 逐字符输入
    for ch in text_slice.chars() {
        let char_script = build_type_char_script(ch);
        browser_eval_with_app(app, label, &char_script, Some(2_000)).await?;
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
    }

    // 触发 change
    browser_eval_with_app(app, label, r#"(function(){ try { document.activeElement?.dispatchEvent(new Event('change', { bubbles: true })); } catch {} return '{}'; })()"#, Some(2_000)).await?;

    Ok(BrowserInteractionResult {
        ok: true,
        action: "type_text".to_string(),
        index,
        text: text_slice.to_string(),
        url: String::new(),
        message: format!("已逐字输入 {} 个字符", text_slice.chars().count()),
    })
}

#[cfg(feature = "tauri-app")]
fn build_type_focus_script(index: Option<usize>, element_text: Option<&str>) -> String {
    let req_index = index.map(|i| i.to_string()).unwrap_or_else(|| "null".to_string());
    let req_text = element_text.unwrap_or_default().replace('\'', "\\'").replace('\n', "\\n");

    format!(
        r#"(function() {{
            const requestedIndex = {idx};
            const requestedText = '{txt}';
            try {{
                let target = document.activeElement;
                if (Number.isInteger(requestedIndex) && requestedIndex >= 0) {{
                    const entries = collectPolarisInteractiveElements({{ viewportOnly: false, maxElements: 240 }});
                    const entry = entries[requestedIndex];
                    if (entry) target = entry.element;
                }} else if (requestedText) {{
                    const q = requestedText.toLowerCase();
                    const entries = collectPolarisInteractiveElements({{ viewportOnly: false, maxElements: 240 }});
                    const idx = entries.findIndex(e => e.searchText.includes(q));
                    if (idx >= 0) target = entries[idx].element;
                }}
                if (!target || !(target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {{
                    if (document.activeElement && (document.activeElement.isContentEditable || document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {{
                        target = document.activeElement;
                    }} else {{
                        return JSON.stringify({{ ok: false, action: 'type_text', index: {idx}, text: '{txt}', url: String(location.href), message: '没有可输入的聚焦元素' }});
                    }}
                }}
                target.scrollIntoView({{ block: 'center', inline: 'center' }});
                target.focus({{ preventScroll: true }});
                if (target.select) target.select();
                return JSON.stringify({{ ok: true, action: 'type_text', index: {idx}, text: '{txt}', url: String(location.href), message: '已聚焦' }});
            }} catch(e) {{
                return JSON.stringify({{ ok: false, action: 'type_text', index: {idx}, text: '{txt}', url: String(location.href), message: '聚焦失败: ' + e.message }});
            }}
        }})()"#,
        idx = req_index,
        txt = req_text,
    )
}

#[cfg(feature = "tauri-app")]
fn build_type_char_script(ch: char) -> String {
    let key = match ch {
        '\'' => "\\'",
        '\\' => "\\\\",
        '\n' => "\\n",
        '\r' => "\\r",
        '\t' => "\\t",
        c => {
            let s = c.to_string();
            if s.contains('\'') || s.contains('\\') {
                Box::leak(s.into_boxed_str())
            } else {
                Box::leak(s.into_boxed_str())
            }
        }
    };

    // 使用字符串字面量避免转义问题
    format!(
        r#"(function() {{
            const key = '{key}';
            const target = document.activeElement || document.body;
            const view = ownerWindowOf(target);
            target.dispatchEvent(new KeyboardEvent('keydown', {{ bubbles: true, cancelable: true, view, key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, composed: true }}));
            if (key.length === 1) {{
                target.dispatchEvent(new KeyboardEvent('keypress', {{ bubbles: true, cancelable: true, view, key, charCode: key.charCodeAt(0), composed: true }}));
                if (target.isContentEditable) {{
                    const sel = view.getSelection();
                    if (sel && sel.rangeCount) {{
                        const range = sel.getRangeAt(0);
                        range.deleteContents();
                        range.insertNode(document.createTextNode(key));
                        range.collapse(false);
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }} else {{
                        target.textContent = (target.textContent || '') + key;
                    }}
                }} else if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {{
                    const start = target.selectionStart ?? target.value?.length ?? 0;
                    const end = target.selectionEnd ?? start;
                    const newValue = (target.value || '').slice(0, start) + key + (target.value || '').slice(end);
                    const proto = target instanceof view.HTMLTextAreaElement ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
                    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (desc?.set) desc.set.call(target, newValue); else target.value = newValue;
                    target.setSelectionRange(start + 1, start + 1);
                }}
                target.dispatchEvent(new InputEvent('input', {{ bubbles: true, inputType: 'insertText', data: key }}));
            }}
            target.dispatchEvent(new KeyboardEvent('keyup', {{ bubbles: true, cancelable: true, view, key, composed: true }}));
            return '{{}}';
        }})()"#,
        key = key
    )
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_type_text(
    app: AppHandle,
    label: String,
    text: String,
    index: Option<usize>,
    element_text: Option<String>,
    delay_ms: Option<u64>,
) -> Result<BrowserInteractionResult> {
    browser_type_text_with_app(&app, &label, &text, index, element_text.as_deref(), delay_ms).await
}

// ── browser_find / browser_find_next ────────────────────────────────────────
/// 在页面中查找文本，返回匹配数量和首条匹配信息
#[cfg(feature = "tauri-app")]
pub async fn browser_find_with_app(
    app: &AppHandle,
    label: &str,
    query: &str,
    case_sensitive: bool,
) -> Result<BrowserInteractionResult> {
    if query.trim().is_empty() {
        return Err(AppError::ValidationError("find 需要非空 query".to_string()));
    }
    let escaped = serde_json::to_string(&query).unwrap_or_else(|_| "\"\"".to_string());
    let script = format!(
        r#"(function() {{
            const query = {escaped};
            const caseSensitive = {cs};
            try {{
                window.__POLARIS_FIND_QUERY__ = query;
                window.__POLARIS_FIND_CASE_SENSITIVE__ = caseSensitive;
                window.__POLARIS_FIND_MATCH_COUNT__ = 0;
                window.__POLARIS_FIND_CURRENT__ = 0;
                const body = document.body;
                if (!body) return JSON.stringify({{ ok: false, action: 'find', index: null, text: query, url: String(location.href), message: '没有页面内容' }});
                let count = 0;
                if (window.find) {{
                    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null, false);
                    let node;
                    while (node = walker.nextNode()) {{
                        const text = node.textContent || '';
                        const searchText = caseSensitive ? text : text.toLowerCase();
                        const searchQuery = caseSensitive ? query : query.toLowerCase();
                        let idx = 0;
                        while ((idx = searchText.indexOf(searchQuery, idx)) !== -1) {{
                            count++;
                            idx += searchQuery.length;
                        }}
                    }}
                }}
                window.__POLARIS_FIND_MATCH_COUNT__ = count;
                if (count > 0) {{
                    const found = window.find(query, caseSensitive, false, true, false, false);
                    window.__POLARIS_FIND_CURRENT__ = found ? 1 : count;
                }}
                return JSON.stringify({{ ok: true, action: 'find', index: null, text: query, url: String(location.href), message: '找到 ' + count + ' 个匹配' }});
            }} catch(e) {{
                return JSON.stringify({{ ok: false, action: 'find', index: null, text: query, url: String(location.href), message: '查找失败: ' + e.message }});
            }}
        }})()"#,
        escaped = escaped,
        cs = case_sensitive,
    );
    let raw = browser_eval_with_app(&app, &label, &script, Some(3_500)).await?;
    let value = parse_eval_json(&raw)?;
    serde_json::from_value(value)
        .map_err(|e| AppError::ValidationError(format!("浏览器查找结果格式错误: {e}")))
}

/// 页面内查找（tauri::command 入口）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_find(
    app: AppHandle,
    label: String,
    query: String,
    case_sensitive: Option<bool>,
) -> Result<BrowserInteractionResult> {
    browser_find_with_app(&app, &label, &query, case_sensitive.unwrap_or(false)).await
}

/// 跳到下一个/上一个匹配
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_find_next(
    app: AppHandle,
    label: String,
    forward: Option<bool>,
) -> Result<BrowserInteractionResult> {
    let is_forward = forward.unwrap_or(true);
    let script = format!(
        r#"(function() {{
            const query = window.__POLARIS_FIND_QUERY__;
            const caseSensitive = window.__POLARIS_FIND_CASE_SENSITIVE__;
            if (!query) return JSON.stringify({{ ok: false, action: 'find_next', index: null, text: '', url: String(location.href), message: '没有查找历史' }});
            try {{
                const found = window.find(query, caseSensitive, {backward}, true, false, false);
                return JSON.stringify({{ ok: !!found, action: 'find_next', index: null, text: query, url: String(location.href), message: found ? '找到下一个匹配' : '没有更多匹配' }});
            }} catch(e) {{
                return JSON.stringify({{ ok: false, action: 'find_next', index: null, text: query, url: String(location.href), message: '查找失败: ' + e.message }});
            }}
        }})()"#,
        backward = if is_forward { "false" } else { "true" },
    );
    let raw = browser_eval_with_app(&app, &label, &script, Some(3_500)).await?;
    let value = parse_eval_json(&raw)?;
    serde_json::from_value(value)
        .map_err(|e| AppError::ValidationError(format!("浏览器查找结果格式错误: {e}")))
}

// ── browser_zoom ────────────────────────────────────────────────────────────
/// 设置页面缩放比例（0.25 ~ 5.0）
#[cfg(feature = "tauri-app")]
pub async fn browser_zoom_with_app(
    app: &AppHandle,
    label: &str,
    scale: f64,
) -> Result<BrowserInteractionResult> {
    let scale = scale.clamp(0.25, 5.0);
    let script = format!(
        r#"(function() {{
            try {{
                const scale = {scale};
                document.documentElement.style.transformOrigin = '0 0';
                document.documentElement.style.transform = 'scale(' + scale + ')';
                document.documentElement.style.width = (100 / scale) + '%';
                document.body.style.width = (100 / scale) + '%';
                return JSON.stringify({{ ok: true, action: 'zoom', index: null, text: String(scale), url: String(location.href), message: '缩放已设为 ' + Math.round(scale * 100) + '%' }});
            }} catch(e) {{
                return JSON.stringify({{ ok: false, action: 'zoom', index: null, text: String(scale), url: String(location.href), message: '缩放失败: ' + e.message }});
            }}
        }})()"#,
        scale = scale,
    );
    let raw = browser_eval_with_app(&app, &label, &script, Some(2_000)).await?;
    let value = parse_eval_json(&raw)?;
    serde_json::from_value(value)
        .map_err(|e| AppError::ValidationError(format!("浏览器缩放结果格式错误: {e}")))
}

/// 页面缩放（tauri::command 入口）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_zoom(
    app: AppHandle,
    label: String,
    scale: f64,
) -> Result<BrowserInteractionResult> {
    browser_zoom_with_app(&app, &label, scale).await
}

/// 获取页面网络信息（加载时间、资源数量、传输大小等）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_get_network_info(
    app: AppHandle,
    label: String,
) -> Result<Value> {
    let raw = browser_eval_with_app(&app, &label, browser_scripts::NETWORK_INFO_SCRIPT, Some(2_000)).await?;
    parse_eval_json(&raw)
}

/// 在指定屏幕坐标位置弹出原生上下文菜单，显示在 WebView 之上。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_show_overflow_menu(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
) -> Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::{LogicalPosition, Position};

    let devtools = MenuItemBuilder::with_id("browser-overflow-devtools", "开发者工具")
        .build(&app)?;
    let copy_url = MenuItemBuilder::with_id("browser-overflow-copyUrl", "复制地址")
        .accelerator("CmdOrCtrl+L")
        .build(&app)?;
    let open_external =
        MenuItemBuilder::with_id("browser-overflow-openExternal", "外部浏览器打开")
            .build(&app)?;
    let clear_data = MenuItemBuilder::with_id("browser-overflow-clearData", "清理浏览数据")
        .build(&app)?;

    let menu = MenuBuilder::new(&app)
        .item(&devtools)
        .item(&copy_url)
        .item(&open_external)
        .separator()
        .item(&clear_data)
        .build()?;

    if let Some(window) = app.get_webview_window("main") {
        let app_clone = app.clone();
        let label_clone = label.clone();

        window.on_menu_event(move |_window, event: tauri::menu::MenuEvent| {
            let id = event.id().0.clone();
            let action = id.replace("browser-overflow-", "");
            let _ = app_clone.emit(
                "browser://overflow-menu-action",
                serde_json::json!({
                    "label": label_clone,
                    "action": action,
                }),
            );
        });

        window.popup_menu_at(&menu, Position::Logical(LogicalPosition::new(x, y)))?;
    }

    Ok(())
}

#[cfg(feature = "tauri-app")]
pub async fn browser_set_marquee_with_app(
    app: &AppHandle,
    label: &str,
    enabled: bool,
) -> Result<BrowserMarqueeResult> {
    let script = browser_scripts::marquee_overlay_script(enabled);
    let raw = browser_eval_with_app(app, label, &script, Some(3_500)).await?;
    let value = parse_eval_json(&raw)?;
    let count = value.get("count").and_then(Value::as_u64).unwrap_or(0) as usize;
    Ok(BrowserMarqueeResult { enabled, count })
}


#[cfg(feature = "tauri-app")]
pub async fn browser_get_marquee_result_with_app(
    app: &AppHandle,
    label: &str,
) -> Result<Value> {
    let raw = browser_eval_with_app(app, label, browser_scripts::MARQUEE_GET_RESULT_SCRIPT, Some(1_000)).await?;
    parse_eval_json(&raw)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_get_marquee_result(
    app: AppHandle,
    label: String,
) -> Result<Value> {
    browser_get_marquee_result_with_app(&app, &label).await
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_set_marquee(
    app: AppHandle,
    label: String,
    enabled: bool,
) -> Result<BrowserMarqueeResult> {
    browser_set_marquee_with_app(&app, &label, enabled).await
}


#[cfg(feature = "tauri-app")]
pub async fn browser_select_region_with_app(
    app: &AppHandle,
    label: &str,
    rect: &BrowserRect,
) -> Result<BrowserRegionResult> {
    if rect.width < MARQUEE_MIN_DIM as f64 || rect.height < MARQUEE_MIN_DIM as f64 {
        return Err(AppError::ValidationError(format!(
            "圈选区域过小（{:.0}×{:.0}），请重新圈选（最小 {:.0}×{:.0}）",
            rect.width, rect.height, MARQUEE_MIN_DIM, MARQUEE_MIN_DIM
        )));
    }
    let script = browser_scripts::region_select_script(rect);
    let raw = browser_eval_with_app(app, label, &script, Some(5_000)).await?;
    let value = parse_eval_json(&raw)?;
    let result: BrowserRegionResult = serde_json::from_value(value)
        .map_err(|e| AppError::ValidationError(format!("圈选区域筛选格式错误: {e}")))?;
    Ok(result)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_select_region(
    app: AppHandle,
    label: String,
    region: BrowserRect,
) -> Result<BrowserRegionResult> {
    browser_select_region_with_app(&app, &label, &region).await
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn browser_get_region_screenshot(
    app: AppHandle,
    label: String,
    region: BrowserRect,
) -> Result<BrowserScreenshot> {
    browser_get_region_screenshot_with_app(&app, &label, &region)
}

#[cfg(all(feature = "tauri-app", windows))]
fn browser_get_region_screenshot_with_app(
    app: &AppHandle,
    label: &str,
    rect: &BrowserRect,
) -> Result<BrowserScreenshot> {
    let window = app
        .get_window("main")
        .ok_or_else(|| AppError::ValidationError("主窗口不存在，无法截图".to_string()))?;
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let position = window
        .outer_position()
        .map_err(|e| AppError::ProcessError(format!("读取窗口位置失败: {e}")))?;
    // rect 是视口坐标(逻辑像素); WebView bounds 也是逻辑像素
    // 屏幕坐标 = window_position + (bounds + region) × scale_factor
    let opt_bounds = browser_bounds(label).ok().flatten();
    let (bw, bh) = match opt_bounds {
        Some(b) => (b.x as f64, b.y as f64),
        None => (0.0, 0.0),
    };
    let x = ((position.x as f64) + (bw + rect.x) * scale_factor).round().max(0.0) as u32;
    let y = ((position.y as f64) + (bh + rect.y) * scale_factor).round().max(0.0) as u32;
    let width = (rect.width * scale_factor).round().max(1.0) as u32;
    let height = (rect.height * scale_factor).round().max(1.0) as u32;

    let controller_config = crate::services::computer_control::ComputerConfig::from_env();
    let controller = crate::services::computer_control::ComputerController::new(controller_config)?;
    let shot = controller.screenshot(Some(0), Some((x, y, width, height)), Some(1.0))?;
    Ok(BrowserScreenshot {
        mime_type: "image/png".to_string(),
        data: shot.png_base64,
        width: shot.width,
        height: shot.height,
        scale: 1.0,
    })
}

#[cfg(all(feature = "tauri-app", not(windows)))]
fn browser_get_region_screenshot_with_app(
    _app: &AppHandle,
    _label: &str,
    _rect: &BrowserRect,
) -> Result<BrowserScreenshot> {
    Err(AppError::ValidationError(
        "当前平台暂不支持内置浏览器区域截图；Windows 平台可用 computer_control 截图".to_string(),
    ))
}

// ──────────────────────────────────────────────────────────────────────────
// BrowserActionDispatcher: 统一 SimpleAI / ask-listener / MCP 三路分派
// (ADR 0004 P0 #2 落地)
// ──────────────────────────────────────────────────────────────────────────

/// 浏览器动作分发器:将 action 参数解析、agent_key fallback、label 解析、
/// 动作执行、操作事件、结果塑形统一到一处,SimpleAI/MCP/ask-listener 都走这条路径。
#[cfg(feature = "tauri-app")]
pub struct BrowserActionDispatcher {
    app: AppHandle,
}

/// 分派来源标识,用于操作日志区分
#[derive(Debug, Clone, Copy)]
pub enum BrowserActionSource {
    /// SimpleAI 原生工具调用
    SimpleAi,
    /// ask-listener / MCP 帧调用
    Mcp,
}

impl BrowserActionSource {
    fn label(self) -> &'static str {
        match self {
            BrowserActionSource::SimpleAi => "AI",
            BrowserActionSource::Mcp => "Claude/MCP",
        }
    }
}

#[cfg(feature = "tauri-app")]
impl BrowserActionDispatcher {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    /// 从已注册的 AppHandle 构造(等价于 browser_app_handle + new)
    pub fn from_app_handle() -> Result<Self> {
        Ok(Self::new(browser_app_handle()?))
    }

    /// 主入口:解析 action 并执行,返回 JSON Value 结果
    pub async fn dispatch(&self, args: &Value, source: BrowserActionSource) -> Result<Value> {
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::ValidationError("browser 缺少 action".to_string()))?;

        // agent_key 解析:显式传入 > session_id > 空
        let agent_key = args
            .get("agentKey")
            .or_else(|| args.get("agent_key"))
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .or_else(|| {
                args.get("sessionId")
                    .or_else(|| args.get("session_id"))
                    .and_then(Value::as_str)
                    .filter(|v| !v.trim().is_empty())
            });

        // list 不需要 label
        if action == "list" {
            return serde_json::to_value(browser_list_registered_sessions_with_app(&self.app)?)
                .map_err(Into::into);
        }

        // acquire 走 acquire 路径
        if action == "acquire" {
            let result = browser_acquire_with_app(
                &self.app,
                agent_key,
                args.get("label").and_then(Value::as_str),
                args.get("url").and_then(Value::as_str),
                args.get("title").and_then(Value::as_str),
                args.get("mode").and_then(Value::as_str),
                args.get("activate").and_then(Value::as_bool).unwrap_or(true),
            )
            .await?;
            return serde_json::to_value(result).map_err(Into::into);
        }

        // 其余 action 都需要 label
        let label = resolve_browser_label_for_agent_with_app(
            &self.app,
            args.get("label").and_then(Value::as_str),
            agent_key,
        )?;

        let source_label = source.label();
        match action {
            "navigate" => {
                let url = args
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| AppError::ValidationError("navigate 缺少 url".to_string()))?;
                let normalized = browser_navigate_ai_with_app(&self.app, &label, url)?;
                emit_browser_operation_with_app(
                    &self.app,
                    &label,
                    "navigate",
                    "success",
                    format!("{source_label} 导航到 {normalized}"),
                    None,
                    Some(normalized.clone()),
                );
                Ok(json!({ "label": label, "url": normalized }))
            }
            "context" => {
                let context = browser_get_page_context_with_app(&self.app, &label).await?;
                emit_browser_operation_with_app(
                    &self.app,
                    &label,
                    "context",
                    "success",
                    if context.title.trim().is_empty() {
                        format!("{source_label} 读取页面上下文")
                    } else {
                        format!(
                            "{source_label} 读取页面上下文：{}",
                            truncate_chars_for_log(&context.title, 80)
                        )
                    },
                    None,
                    Some(context.url.clone()),
                );
                serde_json::to_value(context).map_err(Into::into)
            }
            "diagnostics" => {
                let include_screenshot = args
                    .get("includeScreenshot")
                    .or_else(|| args.get("include_screenshot"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let diagnostics =
                    browser_get_diagnostics_with_app(&self.app, &label, include_screenshot)
                        .await?;
                serde_json::to_value(diagnostics).map_err(Into::into)
            }
            "inspect" => {
                let elements = browser_get_interactive_elements_with_app(&self.app, &label).await?;
                emit_browser_operation_with_app(
                    &self.app,
                    &label,
                    "inspect",
                    "success",
                    format!("{source_label} 检查到 {} 个可操作元素", elements.len()),
                    None,
                    None,
                );
                serde_json::to_value(elements).map_err(Into::into)
            }
            "click" => {
                let index = parse_action_index(args)?;
                let text = args.get("text").and_then(Value::as_str);
                let result = browser_click_with_app(&self.app, &label, index, text).await?;
                emit_browser_operation_with_app(
                    &self.app,
                    &label,
                    "click",
                    if result.ok { "success" } else { "warning" },
                    result.message.clone(),
                    non_empty_target(&result.text),
                    Some(result.url.clone()),
                );
                serde_json::to_value(result).map_err(Into::into)
            }
            "fill" => {
                let value = args
                    .get("value")
                    .and_then(Value::as_str)
                    .ok_or_else(|| AppError::ValidationError("fill 缺少 value".to_string()))?;
                let index = parse_action_index(args)?;
                let text = args.get("text").and_then(Value::as_str);
                let result = browser_fill_with_app(&self.app, &label, index, text, value).await?;
                emit_browser_operation_with_app(
                    &self.app,
                    &label,
                    "fill",
                    if result.ok { "success" } else { "warning" },
                    result.message.clone(),
                    non_empty_target(&result.text),
                    Some(result.url.clone()),
                );
                serde_json::to_value(result).map_err(Into::into)
            }
            "reload" => {
                browser_reload_with_app(&self.app, &label)?;
                emit_browser_operation_with_app(
                    &self.app,
                    &label,
                    "reload",
                    "success",
                    format!("{source_label} 刷新了当前页面"),
                    None,
                    None,
                );
                Ok(json!({ "label": label, "reloaded": true }))
            }
            "back" => {
                browser_history_with_app(&self.app, &label, "back")?;
                emit_browser_operation_with_app(
                    &self.app,
                    &label,
                    "back",
                    "success",
                    format!("{source_label} 后退到上一页"),
                    None,
                    None,
                );
                Ok(json!({ "label": label, "direction": "back" }))
            }
            "forward" => {
                browser_history_with_app(&self.app, &label, "forward")?;
                emit_browser_operation_with_app(
                    &self.app,
                    &label,
                    "forward",
                    "success",
                    format!("{source_label} 前进到下一页"),
                    None,
                    None,
                );
                Ok(json!({ "label": label, "direction": "forward" }))
            }
            "historyState" | "history_state" => {
                let state = browser_get_history_state_with_app(&self.app, &label).await?;
                serde_json::to_value(state).map_err(Into::into)
            }
            "wait" => {
                let condition = args.get("condition").and_then(Value::as_str).unwrap_or("navigation");
                let text = args.get("text").and_then(Value::as_str);
                let index = parse_action_index(args)?;
                let ms = args.get("ms").and_then(Value::as_u64);
                let timeout_ms = args.get("timeoutMs").or_else(|| args.get("timeout_ms")).and_then(Value::as_u64);
                let result = browser_wait_with_app(&self.app, &label, condition, text, index, ms, timeout_ms).await?;
                emit_browser_operation_with_app(&self.app, &label, "wait",
                    if result.ok { "success" } else { "warning" },
                    result.message.clone(), None, Some(result.url.clone()));
                serde_json::to_value(result).map_err(Into::into)
            }
            "scroll" => {
                let mode = args.get("mode").and_then(Value::as_str).unwrap_or("down");
                let index = parse_action_index(args)?;
                let text = args.get("text").and_then(Value::as_str);
                let x = args.get("x").and_then(Value::as_f64);
                let y = args.get("y").and_then(Value::as_f64);
                let amount = args.get("amount").and_then(Value::as_f64);
                let result = browser_scroll_with_app(&self.app, &label, mode, index, text, x, y, amount).await?;
                emit_browser_operation_with_app(&self.app, &label, "scroll",
                    if result.ok { "success" } else { "warning" },
                    result.message.clone(), None, Some(result.url.clone()));
                serde_json::to_value(result).map_err(Into::into)
            }
            "press_key" | "pressKey" => {
                let keys = args.get("keys").and_then(Value::as_str).ok_or_else(|| AppError::ValidationError("press_key 缺少 keys".to_string()))?;
                let index = parse_action_index(args)?;
                let text = args.get("text").and_then(Value::as_str);
                let result = browser_press_key_with_app(&self.app, &label, keys, index, text).await?;
                emit_browser_operation_with_app(&self.app, &label, "press_key",
                    if result.ok { "success" } else { "warning" },
                    result.message.clone(), None, Some(result.url.clone()));
                serde_json::to_value(result).map_err(Into::into)
            }
            "type_text" | "typeText" => {
                let input_text = args.get("text").and_then(Value::as_str).ok_or_else(|| AppError::ValidationError("type_text 缺少 text".to_string()))?;
                let index = parse_action_index(args)?;
                let element_text = args.get("elementText").or_else(|| args.get("element_text")).and_then(Value::as_str);
                let delay_ms = args.get("delayMs").or_else(|| args.get("delay_ms")).and_then(Value::as_u64);
                let result = browser_type_text_with_app(&self.app, &label, input_text, index, element_text, delay_ms).await?;
                emit_browser_operation_with_app(&self.app, &label, "type_text",
                    if result.ok { "success" } else { "warning" },
                    result.message.clone(), None, Some(result.url.clone()));
                serde_json::to_value(result).map_err(Into::into)
            }
            "marquee" => {
                let enabled = args
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let result = browser_set_marquee_with_app(&self.app, &label, enabled).await?;
                serde_json::to_value(result).map_err(Into::into)
            }
            "select_region" | "selectRegion" => {
                let rect_val = args
                    .get("region")
                    .ok_or_else(|| AppError::ValidationError("select_region 缺少 region".to_string()))?;
                let rect: BrowserRect = serde_json::from_value(rect_val.clone())
                    .map_err(|e| AppError::ValidationError(format!("region 格式错误: {e}")))?;
                let result = browser_select_region_with_app(&self.app, &label, &rect).await?;
                serde_json::to_value(result).map_err(Into::into)
            }
            "find" => {
                let query = args.get("text").or_else(|| args.get("query")).and_then(Value::as_str)
                    .ok_or_else(|| AppError::ValidationError("find 缺少 query".to_string()))?;
                let case_sensitive = args.get("caseSensitive").or_else(|| args.get("case_sensitive")).and_then(Value::as_bool).unwrap_or(false);
                let result = browser_find_with_app(&self.app, &label, query, case_sensitive).await?;
                serde_json::to_value(result).map_err(Into::into)
            }
            "zoom" => {
                let scale = args.get("scale").and_then(Value::as_f64).unwrap_or(1.0);
                let result = browser_zoom_with_app(&self.app, &label, scale).await?;
                serde_json::to_value(result).map_err(Into::into)
            }
            "network_info" | "networkInfo" => {
                let raw = browser_eval_with_app(&self.app, &label, browser_scripts::NETWORK_INFO_SCRIPT, Some(2_000)).await?;
                serde_json::from_str::<Value>(&raw).map_err(|e| AppError::ValidationError(format!("网络信息解析失败: {e}")))
            }
            other => Err(AppError::ValidationError(format!(
                "未知 browser action: {other}"
            ))),
        }
    }
}

/// 从 Value 参数中解析 index,拒绝负数
#[cfg(feature = "tauri-app")]
fn parse_action_index(args: &Value) -> Result<Option<usize>> {
    match args.get("index").and_then(Value::as_i64) {
        Some(index) if index >= 0 => Ok(Some(index as usize)),
        Some(_) => Err(AppError::ValidationError("index 不能为负数".to_string())),
        None => Ok(None),
    }
}

/// 操作日志用的 target 文本(空值返回 None)
#[cfg(feature = "tauri-app")]
fn non_empty_target(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(truncate_chars_for_log(trimmed, 120))
    }
}

/// 操作日志用的字符截断
#[cfg(feature = "tauri-app")]
fn truncate_chars_for_log(value: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for ch in value.chars().take(max_chars) {
        out.push(ch);
    }
    if value.chars().count() > max_chars {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod browser_script_tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    static TEST_STATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    #[test]
    fn collector_covers_modern_interactive_patterns() {
        let script = browser_scripts::interactive_elements_script();
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
        assert!(script.contains("maxElements: 300"));
        assert!(script.contains("styleCache"));
        assert!(script.contains("POLARIS_SHADOW_MAX_DEPTH"));
        assert!(!script.contains("slice(0, 80)"));
    }

    #[test]
    fn all_browser_actions_share_the_collector() {
        assert!(browser_scripts::diagnostics_script().contains("collectPolarisInteractiveElements"));
        assert!(
            browser_scripts::click_element_script(Some(1), "Search").contains("collectPolarisInteractiveElements")
        );
        assert!(browser_scripts::fill_element_script(None, "Search", "Polaris")
            .contains("collectPolarisInteractiveElements"));
        assert!(browser_scripts::ai_overlay_script(true).contains("collectPolarisInteractiveElements"));
    }

    #[test]
    fn agent_binding_takes_precedence_over_recent_session() {
        let _guard = TEST_STATE_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        sessions().lock().unwrap().clear();
        agent_bindings().lock().unwrap().clear();

        upsert_session(
            "browser-agent".to_string(),
            Some("tab-agent".to_string()),
            Some("https://agent.example/".to_string()),
            Some("Agent".to_string()),
        )
        .unwrap();
        bind_browser_agent(Some("agent-1"), "browser-agent").unwrap();
        upsert_session(
            "browser-recent".to_string(),
            Some("tab-recent".to_string()),
            Some("https://recent.example/".to_string()),
            Some("Recent".to_string()),
        )
        .unwrap();

        assert_eq!(
            resolve_browser_label_for_agent(None, Some("agent-1")).unwrap(),
            "browser-agent"
        );
    }

    #[test]
    fn stale_agent_binding_falls_back_to_available_session() {
        let _guard = TEST_STATE_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        sessions().lock().unwrap().clear();
        agent_bindings().lock().unwrap().clear();

        bind_browser_agent(Some("agent-1"), "browser-missing").unwrap();
        upsert_session(
            "browser-only".to_string(),
            Some("tab-only".to_string()),
            Some("https://only.example/".to_string()),
            Some("Only".to_string()),
        )
        .unwrap();

        assert_eq!(
            resolve_browser_label_for_agent(None, Some("agent-1")).unwrap(),
            "browser-only"
        );
        assert!(bound_browser_label_for_agent(Some("agent-1"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn acquire_mode_rejects_invalid_values() {
        assert_eq!(normalize_acquire_mode(None).unwrap(), "auto");
        assert_eq!(normalize_acquire_mode(Some(" create ")).unwrap(), "create");
        assert!(normalize_acquire_mode(Some("unexpected")).is_err());
    }

    #[test]
    fn ai_navigation_rejects_file_urls() {
        assert!(normalize_ai_navigation_url("https://example.com").is_ok());
        assert!(normalize_ai_navigation_url("localhost:3000").is_ok());

        let error = normalize_ai_navigation_url("file:///C:/Users/example/secret.txt")
            .expect_err("file URLs must be rejected for AI/MCP navigation");
        assert!(error.to_message().contains("file://"));
    }

    #[test]
    fn parse_action_index_rejects_negative() {
        assert_eq!(parse_action_index(&serde_json::json!({})).unwrap(), None);
        assert_eq!(
            parse_action_index(&serde_json::json!({ "index": 5 })).unwrap(),
            Some(5)
        );
        assert!(parse_action_index(&serde_json::json!({ "index": -1 })).is_err());
    }

    #[test]
    fn non_empty_target_trims_and_truncates() {
        assert_eq!(non_empty_target("   "), None);
        let long = "x".repeat(200);
        let target = non_empty_target(&long).unwrap();
        assert!(target.ends_with('…'));
        assert!(target.chars().count() <= 121);
    }

    #[test]
    fn bound_agent_key_preserved_across_upsert() {
        let _guard = TEST_STATE_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        sessions().lock().unwrap().clear();
        agent_bindings().lock().unwrap().clear();

        bind_browser_agent(Some("agent-p3"), "browser-own-test").unwrap();
        upsert_session(
            "browser-own-test".to_string(),
            Some("tab-1".to_string()),
            Some("https://example.com/".to_string()),
            Some("Example".to_string()),
        )
        .unwrap();

        let session = session_for_label("browser-own-test").unwrap().unwrap();
        assert_eq!(session.bound_agent_key.as_deref(), Some("agent-p3"));
    }

    #[test]
    fn forget_browser_session_state_removes_related_state() {
        let _guard = TEST_STATE_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        sessions().lock().unwrap().clear();
        bounds_store().lock().unwrap().clear();
        agent_bindings().lock().unwrap().clear();

        upsert_session(
            "browser-stale".to_string(),
            Some("tab-stale".to_string()),
            Some("https://stale.example/".to_string()),
            Some("Stale".to_string()),
        )
        .unwrap();
        remember_browser_bounds(
            "browser-stale",
            BrowserBounds {
                x: 10.0,
                y: 10.0,
                width: 320.0,
                height: 240.0,
            },
        )
        .unwrap();
        bind_browser_agent(Some("agent-1"), "browser-stale").unwrap();

        forget_browser_session_state("browser-stale").unwrap();

        assert!(session_for_label("browser-stale").unwrap().is_none());
        assert!(browser_bounds("browser-stale").unwrap().is_none());
        assert!(bound_browser_label_for_agent(Some("agent-1"))
            .unwrap()
            .is_none());
    }
}
