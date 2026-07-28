//! Personal Hub MCP Server
//!
//! MCP server for managing Personal Hub links (bookmarks, todos, notes, navigation).
//! Uses Supabase REST API directly (via reqwest) with the session token from config.
//!
//! 工具:
//! - `ph_list` — 列出条目，支持过滤器
//! - `ph_create` — 创建条目
//! - `ph_get` — 查看单条
//! - `ph_update` — 更新条目
//! - `ph_delete` — 删除条目
//!
//! 认证: 从 config 读取 session_token，以 Bearer token 形式附加到 Supabase REST 请求。

use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::models::config::PersonalHubConfig;
use crate::services::data_root::data_root;

const SERVER_NAME: &str = "polaris-ph-mcp";
const SERVER_VERSION: &str = "0.1.0";
const PROTOCOL_VERSION: &str = "2024-11-05";

/// Supabase REST API 默认配置
const DEFAULT_SUPABASE_URL: &str = "https://nynpqrwsautudqblxoir.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55bnBxcndzYXV0dWRxYmx4b2lyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI3MDkzMDksImV4cCI6MjA3ODI4NTMwOX0.rz79QkbbSEQPsrSdbYYFL-nuV_MwdAWhf4-gQ0j_fz4";

/// 从 config 加载 PersonalHub 配置
fn load_ph_config() -> PersonalHubConfig {
    let config_dir = data_root().config_dir();
    let config_path = config_dir.join("config.json");
    match std::fs::read_to_string(&config_path) {
        Ok(content) => {
            serde_json::from_str::<crate::models::config::Config>(&content)
                .map(|c| c.personal_hub)
                .unwrap_or_default()
        }
        Err(_) => PersonalHubConfig::default(),
    }
}

/// Supabase 客户端持有者
struct PhClient {
    supabase_url: String,
    anon_key: String,
    session_token: String,
    encryption_key: String,
    http: reqwest::blocking::Client,
}

impl PhClient {
    fn from_config() -> Self {
        let cfg = load_ph_config();
        let supabase_url = if cfg.supabase_url.trim().is_empty() {
            DEFAULT_SUPABASE_URL.to_string()
        } else {
            cfg.supabase_url.trim().to_string()
        };
        let anon_key = if cfg.supabase_anon_key.trim().is_empty() {
            DEFAULT_SUPABASE_ANON_KEY.to_string()
        } else {
            cfg.supabase_anon_key.trim().to_string()
        };
        Self {
            supabase_url: supabase_url.trim_end_matches('/').to_string(),
            anon_key,
            session_token: cfg.session_token.clone(),
            encryption_key: cfg.encryption_key.clone(),
            http: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .unwrap_or_default(),
        }
    }

    /// 检查是否已认证（有 session token）
    fn is_authenticated(&self) -> bool {
        !self.session_token.is_empty()
    }

    /// 构建 Supabase REST URL
    fn rest_url(&self, path: &str) -> String {
        format!("{}/rest/v1/{}", self.supabase_url, path)
    }

    /// 发送 GET 请求到 Supabase REST API
    fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        let url = self.rest_url(path);
        let mut req = self
            .http
            .get(&url)
            .header("apikey", &self.anon_key)
            .header("Content-Type", "application/json");

        if !self.session_token.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", self.session_token));
        }

        for (k, v) in query {
            req = req.query(&[(*k, *v)]);
        }

        let resp = req
            .send()
            .map_err(|e| AppError::ProcessError(format!("Supabase 请求失败: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .map_err(|e| AppError::ProcessError(format!("读取响应失败: {e}")))?;

        if !status.is_success() {
            return Err(AppError::ProcessError(format!(
                "Supabase 返回错误 {}: {}",
                status,
                text.chars().take(300).collect::<String>()
            )));
        }

        serde_json::from_str(&text)
            .map_err(|e| AppError::ProcessError(format!("解析 JSON 失败: {e}\n{text}")))
    }

    /// 发送 POST 请求到 Supabase REST API
    fn post(&self, path: &str, body: &Value) -> Result<Value> {
        let url = self.rest_url(path);
        let mut req = self
            .http
            .post(&url)
            .header("apikey", &self.anon_key)
            .header("Content-Type", "application/json")
            .header("Prefer", "return=representation");

        if !self.session_token.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", self.session_token));
        }

        let resp = req
            .json(body)
            .send()
            .map_err(|e| AppError::ProcessError(format!("Supabase 请求失败: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .map_err(|e| AppError::ProcessError(format!("读取响应失败: {e}")))?;

        if !status.is_success() {
            return Err(AppError::ProcessError(format!(
                "Supabase 返回错误 {}: {}",
                status,
                text.chars().take(300).collect::<String>()
            )));
        }

        serde_json::from_str(&text)
            .map_err(|e| AppError::ProcessError(format!("解析 JSON 失败: {e}\n{text}")))
    }

    /// 发送 PATCH 请求到 Supabase REST API
    fn patch(&self, path: &str, body: &Value) -> Result<Value> {
        let url = self.rest_url(path);
        let mut req = self
            .http
            .patch(&url)
            .header("apikey", &self.anon_key)
            .header("Content-Type", "application/json")
            .header("Prefer", "return=representation");

        if !self.session_token.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", self.session_token));
        }

        let resp = req
            .json(body)
            .send()
            .map_err(|e| AppError::ProcessError(format!("Supabase 请求失败: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .map_err(|e| AppError::ProcessError(format!("读取响应失败: {e}")))?;

        if !status.is_success() {
            return Err(AppError::ProcessError(format!(
                "Supabase 返回错误 {}: {}",
                status,
                text.chars().take(300).collect::<String>()
            )));
        }

        serde_json::from_str(&text)
            .map_err(|e| AppError::ProcessError(format!("解析 JSON 失败: {e}\n{text}")))
    }

    /// 发送 DELETE 请求到 Supabase REST API
    fn delete(&self, path: &str) -> Result<()> {
        let url = self.rest_url(path);
        let mut req = self
            .http
            .delete(&url)
            .header("apikey", &self.anon_key)
            .header("Content-Type", "application/json");

        if !self.session_token.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", self.session_token));
        }

        let resp = req
            .send()
            .map_err(|e| AppError::ProcessError(format!("Supabase 请求失败: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .map_err(|e| AppError::ProcessError(format!("读取响应失败: {e}")))?;

        if !status.is_success() {
            return Err(AppError::ProcessError(format!(
                "Supabase 返回错误 {}: {}",
                status,
                text.chars().take(300).collect::<String>()
            )));
        }

        Ok(())
    }

    /// 解密 description（如果已加密且配置了 encryption_key）
    fn decrypt_description(&self, _text: Option<&str>, _is_encrypted: bool) -> String {
        if self.encryption_key.is_empty() {
            return crate::services::personal_hub_crypto::decrypt_description(
                _text,
                _is_encrypted,
                "",
            );
        }
        crate::services::personal_hub_crypto::decrypt_description(
            _text,
            _is_encrypted,
            &self.encryption_key,
        )
    }
}

// ============================================================================
// JSON-RPC types
// ============================================================================

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse<'a> {
    jsonrpc: &'a str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

// ============================================================================
// Server loop
// ============================================================================

/// Run the Personal Hub MCP server: stdio JSON-RPC loop.
pub fn run_ph_mcp_server(config_dir: &str, _workspace_path: Option<&str>) -> Result<()> {
    // 预加载 config，确保路径存在
    let _config_dir = PathBuf::from(config_dir);

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();

    let mut line = String::new();
    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line)?;
        if bytes_read == 0 {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<JsonRpcRequest>(trimmed) {
            // JSON-RPC 2.0 §4.1: Notification 不回复
            Ok(request) if request.id.is_none() => continue,
            Ok(request) => handle_request(request),
            Err(error) => JsonRpcResponse {
                jsonrpc: "2.0",
                id: Value::Null,
                result: None,
                error: Some(JsonRpcError {
                    code: -32700,
                    message: format!("Parse error: {error}"),
                }),
            },
        };

        serde_json::to_writer(&mut writer, &response)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }

    Ok(())
}

// ============================================================================
// Request handling
// ============================================================================

fn handle_request(request: JsonRpcRequest) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(id, -32600, "Invalid Request: jsonrpc must be 2.0".to_string());
    }

    let result = match request.method.as_str() {
        "initialize" => Ok(handle_initialize()),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => handle_tools_call(request.params),
        other => Err(AppError::ValidationError(format!(
            "Unsupported method: {other}"
        ))),
    };

    match result {
        Ok(result) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        },
        Err(error) => error_response(id, -32000, error.to_message()),
    }
}

fn handle_initialize() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
    })
}

// ============================================================================
// Tool definitions
// ============================================================================

fn handle_tools_list() -> Value {
    json!({ "tools": [
        {
            "name": "ph_list",
            "description": "列出 Personal Hub 条目（bookmarks/todos/notes/navigation）。支持按类型和完成状态过滤。需要先登录个人空间（设置 → 个人空间）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "enum": ["navigation", "bookmark", "todo", "note"],
                        "description": "按类型筛选"
                    },
                    "status": {
                        "type": "string",
                        "enum": ["all", "pending", "completed"],
                        "description": "按完成状态筛选（仅 todo 类型有效）"
                    },
                    "tags": {
                        "type": "string",
                        "description": "标签关键词（逗号分隔，逻辑 OR）"
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100,
                        "description": "返回条数上限，默认 50"
                    },
                    "sortBy": {
                        "type": "string",
                        "enum": ["created_at", "updated_at", "title", "priority", "due_date"],
                        "description": "排序字段，默认 created_at"
                    },
                    "sortOrder": {
                        "type": "string",
                        "enum": ["asc", "desc"],
                        "description": "排序方向，默认 desc"
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "ph_create",
            "description": "在 Personal Hub 中创建一条新条目。需要先登录个人空间（设置 → 个人空间）。",
            "inputSchema": {
                "type": "object",
                "required": ["title", "type"],
                "properties": {
                    "title": {
                        "type": "string",
                        "minLength": 1,
                        "description": "标题"
                    },
                    "type": {
                        "type": "string",
                        "enum": ["navigation", "bookmark", "todo", "note"],
                        "description": "条目类型"
                    },
                    "url": {
                        "type": "string",
                        "description": "链接地址（navigation/bookmark 类型必填）"
                    },
                    "description": {
                        "type": "string",
                        "description": "详细描述"
                    },
                    "tags": {
                        "type": "array",
                        "items": { "type": "string", "minLength": 1 },
                        "description": "标签列表"
                    },
                    "priority": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "优先级"
                    },
                    "dueDate": {
                        "type": "string",
                        "description": "截止日期（ISO 8601）"
                    },
                    "completed": {
                        "type": "boolean",
                        "description": "是否已完成（仅 todo 类型有效）"
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "ph_get",
            "description": "查看 Personal Hub 单条条目的详细信息。需要先登录个人空间。",
            "inputSchema": {
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": {
                        "type": "string",
                        "minLength": 1,
                        "description": "条目 ID（UUID）"
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "ph_update",
            "description": "更新 Personal Hub 中已有的条目。需要先登录个人空间。",
            "inputSchema": {
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": {
                        "type": "string",
                        "minLength": 1,
                        "description": "条目 ID（UUID）"
                    },
                    "title": {
                        "type": "string",
                        "description": "更新标题"
                    },
                    "url": {
                        "type": "string",
                        "description": "更新链接地址"
                    },
                    "description": {
                        "type": "string",
                        "description": "更新描述"
                    },
                    "tags": {
                        "type": "array",
                        "items": { "type": "string", "minLength": 1 },
                        "description": "更新标签列表"
                    },
                    "priority": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "更新优先级"
                    },
                    "dueDate": {
                        "type": "string",
                        "description": "更新截止日期（ISO 8601）"
                    },
                    "completed": {
                        "type": "boolean",
                        "description": "更新完成状态"
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "ph_delete",
            "description": "删除 Personal Hub 中的一条条目。需要先登录个人空间。",
            "inputSchema": {
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": {
                        "type": "string",
                        "minLength": 1,
                        "description": "条目 ID（UUID）"
                    }
                },
                "additionalProperties": false
            }
        }
    ] })
}

// ============================================================================
// Tool dispatch
// ============================================================================

fn handle_tools_call(params: Value) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("tools/call 缺少 name".to_string()))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    // 每次调用刷新配置，使前端对 config 的修改即时生效
    let client = PhClient::from_config();

    match name {
        "ph_list" => execute_ph_list(arguments, &client),
        "ph_create" => execute_ph_create(arguments, &client),
        "ph_get" => execute_ph_get(arguments, &client),
        "ph_update" => execute_ph_update(arguments, &client),
        "ph_delete" => execute_ph_delete(arguments, &client),
        other => Err(AppError::ValidationError(format!("未知工具: {other}"))),
    }
}

// ============================================================================
// Tool implementations
// ============================================================================

fn ensure_auth(client: &PhClient) -> Result<()> {
    if !client.is_authenticated() {
        return Err(AppError::ValidationError(
            "未登录 Personal Hub。请先在 Polaris 设置 → 个人空间中登录，然后重试。".to_string(),
        ));
    }
    Ok(())
}

/// 构建 Supabase 过滤器查询参数
fn build_filters(arguments: &Value) -> Vec<String> {
    let mut filters: Vec<String> = Vec::new();

    // type 过滤
    if let Some(typ) = arguments.get("type").and_then(Value::as_str) {
        filters.push(format!("type=eq.{}", typ));
    }

    // completed 状态过滤
    if let Some(status) = arguments.get("status").and_then(Value::as_str) {
        match status {
            "completed" => filters.push("completed=eq.true".to_string()),
            "pending" => filters.push("or=(completed.is.null,completed.eq.false)".to_string()),
            _ => {}
        }
    }

    // tags 过滤（JSON array contains）
    if let Some(tags) = arguments.get("tags").and_then(Value::as_str) {
        for tag in tags.split(',') {
            let tag = tag.trim();
            if !tag.is_empty() {
                filters.push(format!("tags=cs.{{\"{}\"}}", tag));
            }
        }
    }

    filters
}

fn execute_ph_list(arguments: Value, client: &PhClient) -> Result<Value> {
    ensure_auth(client)?;

    // 构建查询
    let mut query_params: Vec<(String, String)> = Vec::new();

    // 选择字段
    query_params.push(("select".to_string(), "*".to_string()));

    // 过滤器
    let filters = build_filters(&arguments);
    for f in &filters {
        query_params.push(("".to_string(), f.clone()));
    }

    // 排序
    let sort_by = arguments
        .get("sortBy")
        .and_then(Value::as_str)
        .unwrap_or("created_at");
    let sort_order = arguments
        .get("sortOrder")
        .and_then(Value::as_str)
        .unwrap_or("desc");
    query_params.push(("order".to_string(), format!("{}.{}", sort_by, sort_order)));

    // limit
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(50)
        .min(100);
    query_params.push(("limit".to_string(), limit.to_string()));

    // 转换为 &str 切片
    let query_refs: Vec<(&str, &str)> = query_params
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    let result = client.get("links", &query_refs)?;

    let items = result.as_array().cloned().unwrap_or_default();
    let count = items.len();

    Ok(json!({
        "structuredContent": {
            "count": count,
            "items": items,
            "hasSessionToken": true
        },
        "content": [{
            "type": "text",
            "text": format!("共 {} 条记录", count)
        }]
    }))
}

fn execute_ph_create(arguments: Value, client: &PhClient) -> Result<Value> {
    ensure_auth(client)?;

    let title = arguments
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| AppError::ValidationError("title 不能为空".to_string()))?;

    let typ = arguments
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ValidationError("type 不能为空".to_string()))?;

    // 校验 type 值
    match typ {
        "navigation" | "bookmark" | "todo" | "note" => {}
        _ => {
            return Err(AppError::ValidationError(format!(
                "无效的 type: {typ}，可选值: navigation, bookmark, todo, note"
            )));
        }
    }

    let mut body = json!({
        "title": title,
        "type": typ,
    });

    if let Some(url) = arguments.get("url").and_then(Value::as_str) {
        body["url"] = json!(url);
    }
    if let Some(desc) = arguments.get("description").and_then(Value::as_str) {
        body["description"] = json!(desc);
    }
    if let Some(tags) = arguments.get("tags").and_then(Value::as_array) {
        let tag_strs: Vec<String> = tags
            .iter()
            .filter_map(|t| t.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect();
        if !tag_strs.is_empty() {
            body["tags"] = json!(tag_strs);
        }
    }
    if let Some(priority) = arguments.get("priority").and_then(Value::as_str) {
        body["priority"] = json!(priority);
    }
    if let Some(due_date) = arguments.get("dueDate").and_then(Value::as_str) {
        body["due_date"] = json!(due_date);
    }
    if let Some(completed) = arguments.get("completed").and_then(Value::as_bool) {
        body["completed"] = json!(completed);
    }

    let result = client.post("links", &body)?;

    Ok(json!({
        "structuredContent": {
            "item": result,
            "action": "created"
        },
        "content": [{
            "type": "text",
            "text": format!("已创建 【{title}】({typ})")
        }]
    }))
}

fn execute_ph_get(arguments: Value, client: &PhClient) -> Result<Value> {
    ensure_auth(client)?;

    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|i| !i.is_empty())
        .ok_or_else(|| AppError::ValidationError("id 不能为空".to_string()))?;

    let query_refs: [(&str, &str); 1] = [("select", "*")];
    let result = client.get(&format!("links?id=eq.{}", id), &query_refs)?;

    let items = result.as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        return Err(AppError::ValidationError(format!("未找到条目: {id}")));
    }

    let item = &items[0];

    // 解密 description（如果已加密）
    let is_encrypted = item
        .get("is_encrypted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let description = item
        .get("description")
        .and_then(Value::as_str);
    let decrypted_desc = client.decrypt_description(description, is_encrypted);

    let mut item_display = item.clone();
    if is_encrypted {
        item_display["description"] = json!(decrypted_desc);
    }

    Ok(json!({
        "structuredContent": {
            "item": item_display,
            "isEncrypted": is_encrypted
        },
        "content": [{
            "type": "text",
            "text": format!(
                "【{}】({})",
                item.get("title").and_then(Value::as_str).unwrap_or(""),
                item.get("type").and_then(Value::as_str).unwrap_or("")
            )
        }]
    }))
}

fn execute_ph_update(arguments: Value, client: &PhClient) -> Result<Value> {
    ensure_auth(client)?;

    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|i| !i.is_empty())
        .ok_or_else(|| AppError::ValidationError("id 不能为空".to_string()))?;

    let mut body = json!({});

    if let Some(title) = arguments.get("title").and_then(Value::as_str) {
        body["title"] = json!(title);
    }
    if let Some(url) = arguments.get("url").and_then(Value::as_str) {
        body["url"] = json!(url);
    }
    if let Some(desc) = arguments.get("description").and_then(Value::as_str) {
        body["description"] = json!(desc);
    }
    if let Some(tags) = arguments.get("tags").and_then(Value::as_array) {
        let tag_strs: Vec<String> = tags
            .iter()
            .filter_map(|t| t.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect();
        if !tag_strs.is_empty() {
            body["tags"] = json!(tag_strs);
        }
    }
    if let Some(priority) = arguments.get("priority").and_then(Value::as_str) {
        body["priority"] = json!(priority);
    }
    if let Some(due_date) = arguments.get("dueDate").and_then(Value::as_str) {
        body["due_date"] = json!(due_date);
    }
    if let Some(completed) = arguments.get("completed").and_then(Value::as_bool) {
        body["completed"] = json!(completed);
    }

    // 更新时间戳
    body["updated_at"] = json!("now()");

    let result = client.patch(&format!("links?id=eq.{}", id), &body)?;

    Ok(json!({
        "structuredContent": {
            "item": result,
            "action": "updated"
        },
        "content": [{
            "type": "text",
            "text": format!("已更新条目: {id}")
        }]
    }))
}

fn execute_ph_delete(arguments: Value, client: &PhClient) -> Result<Value> {
    ensure_auth(client)?;

    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|i| !i.is_empty())
        .ok_or_else(|| AppError::ValidationError("id 不能为空".to_string()))?;

    client.delete(&format!("links?id=eq.{}", id))?;

    Ok(json!({
        "structuredContent": {
            "id": id,
            "action": "deleted"
        },
        "content": [{
            "type": "text",
            "text": format!("已删除条目: {id}")
        }]
    }))
}

// ============================================================================
// Helpers
// ============================================================================

fn error_response(id: Value, code: i32, message: String) -> JsonRpcResponse<'static> {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError { code, message }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_returns_protocol_metadata() {
        let value = handle_initialize();
        assert_eq!(
            value["protocolVersion"],
            Value::String(PROTOCOL_VERSION.to_string())
        );
        assert_eq!(
            value["serverInfo"]["name"],
            Value::String(SERVER_NAME.to_string())
        );
    }

    #[test]
    fn tools_list_contains_expected_tools() {
        let value = handle_tools_list();
        let tools = value["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"ph_list"));
        assert!(names.contains(&"ph_create"));
        assert!(names.contains(&"ph_get"));
        assert!(names.contains(&"ph_update"));
        assert!(names.contains(&"ph_delete"));
        assert_eq!(tools.len(), 5);
    }

    #[test]
    fn create_requires_title_and_type() {
        let params = json!({ "name": "ph_create", "arguments": {} });
        let result = handle_tools_call(params);
        assert!(result.is_err());

        let params = json!({ "name": "ph_create", "arguments": { "title": "test" } });
        let result = handle_tools_call(params);
        assert!(result.is_err());

        let params = json!({ "name": "ph_create", "arguments": { "type": "todo" } });
        let result = handle_tools_call(params);
        assert!(result.is_err());
    }

    #[test]
    fn get_requires_id() {
        let params = json!({ "name": "ph_get", "arguments": {} });
        let result = handle_tools_call(params);
        assert!(result.is_err());
    }

    #[test]
    fn delete_requires_id() {
        let params = json!({ "name": "ph_delete", "arguments": {} });
        let result = handle_tools_call(params);
        assert!(result.is_err());
    }

    #[test]
    fn unknown_tool_returns_error() {
        let params = json!({ "name": "unknown_tool", "arguments": {} });
        let result = handle_tools_call(params);
        assert!(result.is_err());
    }

    #[test]
    fn notification_is_detected_when_id_field_is_absent() {
        let payload = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let request: JsonRpcRequest = serde_json::from_str(payload).unwrap();
        assert!(request.id.is_none());
    }

    #[test]
    fn build_filters_handles_all_types() {
        let args = json!({
            "type": "bookmark",
            "status": "completed",
            "tags": "rust,node"
        });
        let filters = build_filters(&args);
        assert!(filters.contains(&"type=eq.bookmark".to_string()));
        assert!(filters.contains(&"completed=eq.true".to_string()));
        assert!(filters.contains(&"tags=cs.{\"rust\"}".to_string()));
        assert!(filters.contains(&"tags=cs.{\"node\"}".to_string()));
    }

    #[test]
    fn build_filters_pending_status() {
        let args = json!({ "status": "pending" });
        let filters = build_filters(&args);
        assert!(filters.contains(&"or=(completed.is.null,completed.eq.false)".to_string()));
    }

    #[test]
    fn load_ph_config_uses_defaults_on_missing_file() {
        // 不存在的文件应该返回默认配置，不会 panic
        let cfg = load_ph_config();
        // 默认配置应该有 session_token 为空
        assert!(cfg.session_token.is_empty());
    }
}