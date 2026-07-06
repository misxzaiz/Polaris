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
pub struct BrowserPageContext {
    pub title: String,
    pub url: String,
    pub selected_text: String,
    pub meta_description: String,
    pub text: String,
    pub headings: Vec<BrowserHeading>,
    pub links: Vec<BrowserLink>,
}

fn sessions() -> &'static Mutex<HashMap<String, BrowserSessionInfo>> {
    BROWSER_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
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

    url::Url::parse(&candidate)
        .map_err(|e| AppError::ValidationError(format!("URL 无效: {e}")))
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
    let _ = upsert_session(
        label.to_string(),
        None,
        Some(context.url.clone()),
        Some(context.title.clone()),
    );
    Ok(context)
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
        let _ = existing.close();
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
    if bounds.width < 1.0 || bounds.height < 1.0 {
        webview.hide()?;
        return Ok(());
    }

    webview.set_position(tauri::LogicalPosition::new(bounds.x.round(), bounds.y.round()))?;
    webview.set_size(tauri::LogicalSize::new(
        bounds.width.round().max(1.0),
        bounds.height.round().max(1.0),
    ))?;
    webview.show()?;
    Ok(())
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
pub async fn browser_get_page_context(
    app: AppHandle,
    label: String,
) -> Result<BrowserPageContext> {
    browser_get_page_context_with_app(&app, &label).await
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
