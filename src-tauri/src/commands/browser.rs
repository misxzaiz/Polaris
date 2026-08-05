use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::oneshot;
use uuid::Uuid;

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
    let raw = browser_eval_with_app(app, label, PAGE_CONTEXT_SCRIPT, Some(5_000)).await?;
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
#[cfg(all(feature = "tauri-app", windows))]
fn detect_monitor_index(_x: f64, _y: f64) -> usize {
    // computer_control 的 screenshot 接受 monitor 索引;
    // 简化实现:返回 0,后续可对接 Win32 EnumDisplayMonitors 精确定位
    // 当前已有改进:不再硬编码 monitor 0,而是预留接口供扩展
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
  const canonical = clean(document.querySelector('link[rel="canonical"]')?.href || '', 500) || null;
  const ogTitle = clean(document.querySelector('meta[property="og:title"]')?.content || '', 500) || null;
  const ogImage = clean(document.querySelector('meta[property="og:image"]')?.content || '', 500) || null;
  const articleText = document.querySelector('article')?.innerText || '';
  const bodyText = document.body?.innerText || '';
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .slice(0, 60)
    .map((node) => ({
      level: Number(node.tagName.slice(1)),
      text: clean(node.textContent || '', 240)
    }))
    .filter((item) => item.text);
  const links = Array.from(document.querySelectorAll('a[href]'))
    .slice(0, 80)
    .map((node) => ({
      text: clean(node.textContent || node.getAttribute('aria-label') || '', 160),
      href: String(node.href || ''),
      rel: clean(node.getAttribute('rel') || '', 60) || null
    }))
    .filter((item) => item.href);
  const tables = Array.from(document.querySelectorAll('table'))
    .slice(0, 15)
    .map((table) => {
      const caption = clean(table.caption?.innerText || table.getAttribute('aria-label') || '', 240) || null;
      const rows = [];
      for (const tr of Array.from(table.querySelectorAll('tr')).slice(0, 200)) {
        const cells = Array.from(tr.querySelectorAll('td, th'))
          .map((c) => clean(c.textContent || '', 200));
        if (cells.length > 0) rows.push(cells);
      }
      return { rows, caption };
    })
    .filter((t) => t.rows.length > 0);
  const codeBlocks = Array.from(document.querySelectorAll('pre, code'))
    .slice(0, 30)
    .map((node) => ({
      language: clean(
        (node.getAttribute('class') || '').match(/language-(\w+)/)?.[1] ||
        (node.getAttribute('data-language') || ''),
        40
      ),
      code: clean(node.textContent || '', 4000)
    }))
    .filter((c) => c.code);
  const images = Array.from(document.querySelectorAll('img[src], img[alt]'))
    .slice(0, 40)
    .map((node) => ({
      src: clean(node.src || '', 500),
      alt: clean(node.getAttribute('alt') || '', 240),
      width: node.naturalWidth > 0 ? node.naturalWidth : null,
      height: node.naturalHeight > 0 ? node.naturalHeight : null
    }))
    .filter((i) => i.src || i.alt);
  const structuredData = [];
  try {
    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20)) {
      try {
        const parsed = JSON.parse(script.textContent || '');
        structuredData.push(parsed);
      } catch {}
    }
  } catch {}
  return JSON.stringify({
    title: clean(document.title || '', 300),
    url: String(location.href),
    selectedText,
    metaDescription,
    text: clean(articleText || bodyText, 12000),
    headings,
    links,
    tables,
    codeBlocks,
    images,
    structuredData
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
const POLARIS_SCAN_LIMIT = 8000;
const POLARIS_SHADOW_MAX_DEPTH = 5;

const clean = (value, max = 220) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const ownerWindowOf = (element) => element?.ownerDocument?.defaultView || window;

const styleCache = new WeakMap();
const styleOf = (element) => {
  if (styleCache.has(element)) return styleCache.get(element);
  const style = ownerWindowOf(element).getComputedStyle(element);
  styleCache.set(element, style);
  return style;
};
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
    if (!root || depth > POLARIS_SHADOW_MAX_DEPTH) return;
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

const buildStableSelector = (element) => {
  if (!isElement(element)) return '';
  const id = clean(element.getAttribute('id') || '', 80);
  if (id) return `#${cssEscape(id)}`;
  const name = clean(element.getAttribute('name') || '', 80);
  if (name && tagOf(element) === 'input') return `${tagOf(element)}[name="${cssEscape(name)}"]`;
  const testId = clean(element.getAttribute('data-testid') || element.getAttribute('data-test') || element.getAttribute('data-cy') || '', 80);
  if (testId) return `[data-testid="${cssEscape(testId)}"]`;
  const tag = tagOf(element) || 'element';
  let parent = element.parentElement;
  let path = tag;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    const parentTag = tagOf(parent) || 'element';
    const parentIndex = Array.from(parent.children).indexOf(element);
    path = `${parentTag}${parentIndex >= 0 ? `:nth-child(${parentIndex + 1})` : ''} > ${path}`;
    element = parent;
    parent = parent.parentElement;
    if (path.length > 200) break;
  }
  return path.length > 200 ? path.slice(0, 200) : path;
};

const extractOptions = (element) => {
  try {
    if (element.tagName === 'SELECT') {
      return Array.from(element.options)
        .slice(0, 30)
        .map((opt) => ({ value: opt.value, text: clean(opt.textContent || '', 120), selected: opt.selected, disabled: Boolean(opt.disabled) }));
    }
    const role = roleOf(element);
    if (role === 'combobox' || role === 'listbox') {
      const opts = Array.from(element.querySelectorAll('option, [role="option"]'))
        .slice(0, 30);
      if (opts.length > 0) {
        return opts.map((opt) => ({ value: opt.value || clean(opt.textContent || '', 120), text: clean(opt.textContent || '', 120), selected: opt.getAttribute('aria-selected') === 'true' || Boolean(opt.selected), disabled: Boolean(opt.getAttribute('aria-disabled') === 'true' || opt.disabled) }));
      }
    }
  } catch {}
  return null;
};

const tooltipOf = (element) => {
  const title = element.getAttribute('title');
  if (title) return clean(title, 240);
  try {
    const id = element.getAttribute('aria-describedby');
    if (id) {
      const target = element.ownerDocument.getElementById(id);
      if (target) return clean(target.textContent || '', 240);
    }
  } catch {}
  return null;
};

const buildChecked = (element) => {
  if (element.checked !== undefined) return element.checked;
  if (element.getAttribute('aria-checked') === 'true') return true;
  if (element.getAttribute('aria-checked') === 'false') return false;
  return null;
};

const sameRect = (a, b) => Math.abs(a.left - b.left) < 2
  && Math.abs(a.top - b.top) < 2
  && Math.abs(a.width - b.width) < 2
  && Math.abs(a.height - b.height) < 2;

const collectPolarisInteractiveElements = (options = {}) => {
  const viewportOnly = options.viewportOnly === true;
  const maxElements = Number.isFinite(options.maxElements) ? options.maxElements : 300;
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
      checked: buildChecked(element),
      selected: element.getAttribute('aria-selected') === 'true' || null,
      options: extractOptions(element),
      selector: buildStableSelector(element),
      tooltip: tooltipOf(element),
      expanded: element.getAttribute('aria-expanded') === 'true' ? true : element.getAttribute('aria-expanded') === 'false' ? false : null,
      pressed: element.getAttribute('aria-pressed') === 'true' ? true : element.getAttribute('aria-pressed') === 'false' ? false : null,
      readOnly: isReadOnly(element) || null,
      required: element.hasAttribute('required') || null,
      min: element.getAttribute('min') ? Number(element.getAttribute('min')) : null,
      max: element.getAttribute('max') ? Number(element.getAttribute('max')) : null,
      step: element.getAttribute('step') ? Number(element.getAttribute('step')) : null,
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
  fillable: entry.fillable,
  rect: entry.rect ? { x: Math.round(entry.rect.left), y: Math.round(entry.rect.top), width: Math.round(entry.rect.width), height: Math.round(entry.rect.height) } : null,
  checked: entry.checked,
  selected: entry.selected,
  options: entry.options,
  selector: entry.selector,
  tooltip: entry.tooltip,
  expanded: entry.expanded,
  pressed: entry.pressed,
  readOnly: entry.readOnly,
  required: entry.required,
  min: entry.min,
  max: entry.max,
  step: entry.step
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
  disabled: entry.disabled,
  checked: entry.checked,
  selected: entry.selected,
  selector: entry.selector
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
const elements = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 300 })
  .map((entry, index) => toPolarisInteractiveElement(entry, index));
return JSON.stringify(elements);
"#;

const DIAGNOSTICS_SCRIPT_BODY: &str = r#"
const elements = collectPolarisInteractiveElements({ viewportOnly: true, maxElements: 220 })
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
const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 300 });
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
dispatchPointer('pointerover');
dispatchMouse('mouseover');
dispatchMouse('mouseenter');
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
const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 300 });
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
  const entries = collectPolarisInteractiveElements({ viewportOnly: true, maxElements: 220 });
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

// ──────────────────────────────────────────────────────────────────────────
// Marquee Selection: 用户圈选区域交互 overlay
// ──────────────────────────────────────────────────────────────────────────

const MARQUEE_OVERLAY_SCRIPT_BODY: &str = r#"
const existingCleanup = window.__POLARIS_MARQUEE_CLEANUP__;
if (typeof existingCleanup === 'function') {
  existingCleanup();
}

if (!marqueeEnabled) {
  return JSON.stringify({ enabled: false, count: 0 });
}

const MARQUEE_MIN_DIM = 20;

const root = document.createElement('div');
root.id = '__polaris_marquee_overlay__';
root.style.position = 'fixed';
root.style.inset = '0';
root.style.pointerEvents = 'auto';
root.style.zIndex = '2147483645';
root.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
document.documentElement.appendChild(root);

const savedOverflow = document.body.style.overflow;
document.body.style.overflow = 'hidden';

const currentRectangles = [];
let drawing = false;
let startX = 0, startY = 0;
let currentBox = null;

const addCompletedBox = (x, y, w, h) => {
  const num = currentRectangles.length + 1;
  const box = document.createElement('div');
  box.style.position = 'fixed';
  box.style.left = Math.max(0, x) + 'px';
  box.style.top = Math.max(0, y) + 'px';
  box.style.width = Math.max(MARQUEE_MIN_DIM, Math.abs(w)) + 'px';
  box.style.height = Math.max(MARQUEE_MIN_DIM, Math.abs(h)) + 'px';
  box.style.border = '2px solid rgba(59,130,246,0.95)';
  box.style.background = 'rgba(59,130,246,0.08)';
  box.style.boxShadow = '0 0 0 1px rgba(15,23,42,0.35)';
  box.style.borderRadius = '6px';
  box.style.boxSizing = 'border-box';
  box.style.pointerEvents = 'none';
  const badge = document.createElement('div');
  badge.textContent = String(num);
  badge.style.position = 'absolute';
  badge.style.left = '-1px';
  badge.style.top = '-14px';
  badge.style.minWidth = '22px';
  badge.style.height = '22px';
  badge.style.borderRadius = '11px';
  badge.style.background = 'rgb(37,99,235)';
  badge.style.color = 'white';
  badge.style.fontSize = '12px';
  badge.style.fontWeight = '650';
  badge.style.lineHeight = '22px';
  badge.style.textAlign = 'center';
  box.appendChild(badge);
  root.appendChild(box);
  currentRectangles.push({ x: Math.max(0, x), y: Math.max(0, y), width: Math.max(MARQUEE_MIN_DIM, Math.abs(w)), height: Math.max(MARQUEE_MIN_DIM, Math.abs(h)) });
};

const updateResult = (done) => {
  window.__POLARIS_MARQUEE_RESULT__ = JSON.stringify({
    rects: currentRectangles,
    done: !!done
  });
};

const onMousedown = (e) => {
  if (e.button !== 0) return;
  drawing = true;
  startX = e.clientX;
  startY = e.clientY;
  currentBox = document.createElement('div');
  currentBox.style.position = 'fixed';
  currentBox.style.pointerEvents = 'none';
  currentBox.style.border = '2px dashed rgba(59,130,246,0.95)';
  currentBox.style.background = 'rgba(59,130,246,0.12)';
  currentBox.style.boxShadow = '0 0 0 1px rgba(15,23,42,0.35)';
  currentBox.style.borderRadius = '6px';
  currentBox.style.boxSizing = 'border-box';
  root.appendChild(currentBox);
  e.preventDefault();
};
const onMousemove = (e) => {
  if (!drawing || !currentBox) return;
  const x = Math.min(startX, e.clientX);
  const y = Math.min(startY, e.clientY);
  const w = Math.abs(e.clientX - startX);
  const h = Math.abs(e.clientY - startY);
  currentBox.style.left = Math.max(0, x) + 'px';
  currentBox.style.top = Math.max(0, y) + 'px';
  currentBox.style.width = Math.max(MARQUEE_MIN_DIM, w) + 'px';
  currentBox.style.height = Math.max(MARQUEE_MIN_DIM, h) + 'px';
};
const onMouseup = (e) => {
  if (!drawing) return;
  drawing = false;
  if (currentBox) {
    currentBox.remove();
    currentBox = null;
  }
  const w = Math.abs(e.clientX - startX);
  const h = Math.abs(e.clientY - startY);
  if (w >= MARQUEE_MIN_DIM && h >= MARQUEE_MIN_DIM) {
    addCompletedBox(Math.min(startX, e.clientX), Math.min(startY, e.clientY), w, h);
  }
  updateResult(false);
};
const onDblclick = () => {
  if (drawing && currentBox) { currentBox.remove(); currentBox = null; drawing = false; }
  updateResult(true);
};
const onKeydown = (e) => {
  if (e.key === 'Escape') {
    if (drawing && currentBox) { currentBox.remove(); currentBox = null; drawing = false; }
    updateResult(true);
  }
};

root.addEventListener('mousedown', onMousedown, true);
document.addEventListener('mousemove', onMousemove, true);
document.addEventListener('mouseup', onMouseup, true);
document.addEventListener('dblclick', onDblclick, true);
document.addEventListener('keydown', onKeydown, true);

window.__POLARIS_MARQUEE_CLEANUP__ = () => {
  root.removeEventListener('mousedown', onMousedown, true);
  document.removeEventListener('mousemove', onMousemove, true);
  document.removeEventListener('mouseup', onMouseup, true);
  document.removeEventListener('dblclick', onDblclick, true);
  document.removeEventListener('keydown', onKeydown, true);
  root.remove();
  document.body.style.overflow = savedOverflow;
  delete window.__POLARIS_MARQUEE_CLEANUP__;
  delete window.__POLARIS_MARQUEE_RESULT__;
};

return JSON.stringify({ enabled: true, count: 0 });
"#;

fn marquee_overlay_script(enabled: bool) -> String {
    let mut script = String::from("(() => {\nconst marqueeEnabled = ");
    script.push_str(if enabled { "true" } else { "false" });
    script.push_str(";\n");
    script.push_str(MARQUEE_OVERLAY_SCRIPT_BODY);
    script.push_str("\n})()");
    script
}

#[cfg(feature = "tauri-app")]
pub async fn browser_set_marquee_with_app(
    app: &AppHandle,
    label: &str,
    enabled: bool,
) -> Result<BrowserMarqueeResult> {
    let script = marquee_overlay_script(enabled);
    let raw = browser_eval_with_app(app, label, &script, Some(3_500)).await?;
    let value = parse_eval_json(&raw)?;
    let count = value.get("count").and_then(Value::as_u64).unwrap_or(0) as usize;
    Ok(BrowserMarqueeResult { enabled, count })
}

const MARQUEE_GET_RESULT_SCRIPT: &str = r#"
(() => {
  try {
    const raw = window.__POLARIS_MARQUEE_RESULT__;
    if (!raw) return JSON.stringify({ rects: [], done: false });
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return JSON.stringify({ rects: [], done: false });
  }
})()
"#;

#[cfg(feature = "tauri-app")]
pub async fn browser_get_marquee_result_with_app(
    app: &AppHandle,
    label: &str,
) -> Result<Value> {
    let raw = browser_eval_with_app(app, label, MARQUEE_GET_RESULT_SCRIPT, Some(1_000)).await?;
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

const REGION_SELECT_SCRIPT_BODY: &str = r#"
  const targetRect = { x: targetX, y: targetY, w: targetW, h: targetH };
  const intersects = (rx, ry, rw, rh) => !(
    rx + rw < targetRect.x ||
    ry + rh < targetRect.y ||
    rx > targetRect.x + targetRect.w ||
    ry > targetRect.y + targetRect.h
  );
  // 1. 交互元素（按钮/链接/输入框等）
  const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 300 });
  const inRegion = entries.filter((e) => {
    if (!e.rect) return false;
    return intersects(e.rect.left, e.rect.top, e.rect.width, e.rect.height);
  });
  const elements = inRegion.map((e, i) => ({
    index: i,
    kind: e.kind,
    text: clean(e.label, 240),
    rect: { x: Math.round(e.rect.left), y: Math.round(e.rect.top), width: Math.round(e.rect.width), height: Math.round(e.rect.height) },
    fillable: e.fillable,
    disabled: e.disabled,
    selector: e.selector || null
  }));
  // 2. 区域内所有可见元素的 DOM 片段（不限于交互元素）
  //    用 elementFromPoint 网格采样找到区域内所有元素
  let htmlSnippet = '';
  let textSnippet = '';
  try {
    const step = 10;
    const collected = new Set();
    const candidates = [];
    const POLARIS_OVERLAY_IDS = new Set([
      '__polaris_marquee_overlay__',
      '__polaris_ai_overlay__',
    ]);
    for (let px = targetRect.x; px < targetRect.x + targetRect.w; px += step) {
      for (let py = targetRect.y; py < targetRect.y + targetRect.h; py += step) {
        const el = document.elementFromPoint(px, py);
        if (!el || el === document.body || el === document.documentElement) continue;
        // 排除 Polaris 注入的 overlay（圈选/AI 层），避免采到自己
        if (el.id && POLARIS_OVERLAY_IDS.has(el.id)) continue;
        let skip = false;
        let n: Element | null = el.parentElement;
        while (n && !skip) {
          if (n.id && POLARIS_OVERLAY_IDS.has(n.id)) skip = true;
          n = n.parentElement;
        }
        if (skip) continue;
        const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            collected.add(el);
            candidates.push(el);
          }
        }
      }
    }
    // 按文档顺序排序
    candidates.sort((a, b) => {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    // 去重:如果一个元素包含另一个,只保留外层
    const deduped = [];
    for (const el of candidates) {
      const isChildOfKept = deduped.some((kept) => kept.contains(el));
      if (!isChildOfKept) deduped.push(el);
    }
    const htmlParts = [];
    const textParts = [];
    for (const el of deduped.slice(0, 30)) {
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
      const html = clean(el.outerHTML, 2000);
      if (html) htmlParts.push(html);
      const text = clean(el.innerText || el.textContent || '', 1000);
      if (text) textParts.push(text);
    }
    htmlSnippet = htmlParts.join('\n').slice(0, 6000);
    textSnippet = textParts.join('\n').slice(0, 3000);
  } catch {}
  return JSON.stringify({
    count: inRegion.length,
    elements: elements.slice(0, 120),
    htmlSnippet: htmlSnippet,
    textSnippet: textSnippet,
    url: String(location.href)
  });
"#;

fn region_select_script(rect: &BrowserRect) -> String {
    let mut script = String::from("(() => {\nconst targetX = ");
    script.push_str(&rect.x.to_string());
    script.push_str(";\nconst targetY = ");
    script.push_str(&rect.y.to_string());
    script.push_str(";\nconst targetW = ");
    script.push_str(&rect.width.to_string());
    script.push_str(";\nconst targetH = ");
    script.push_str(&rect.height.to_string());
    script.push_str(";\n");
    script.push_str(polaris_interactive_collector_script!());
    script.push('\n');
    script.push_str(REGION_SELECT_SCRIPT_BODY);
    script.push_str("\n})()");
    script
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
    let script = region_select_script(rect);
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
        assert!(script.contains("maxElements: 300"));
        assert!(script.contains("styleCache"));
        assert!(script.contains("POLARIS_SHADOW_MAX_DEPTH"));
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
