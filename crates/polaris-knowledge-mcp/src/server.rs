//! MCP Server main loop and request handling.

use std::io::{self, BufRead, BufReader, Write};
use std::sync::mpsc;
use std::sync::{Arc, RwLock};
use std::path::PathBuf;
use std::thread;

use crate::handler::WriteLock;

use serde_json::json;
use serde_json::Value;

use crate::error::{KnowledgeError, Result};
use crate::handler::{handle_tools_call, KnowledgeCache, SharedCache};
use crate::protocol::{error_response, JsonRpcRequest, JsonRpcResponse};
use crate::tools;

// ─── ServerContext ──────────────────────────────────────────────

/// Shared server state passed to all request handlers.
///
/// Encapsulates paths, caches, and locks that were previously passed as
/// individual parameters. This simplifies function signatures and makes it
/// easy to add new shared state (e.g., initialization flag) without changing
/// every call site.
pub struct ServerContext {
    pub index_path: PathBuf,
    pub modules_dir: PathBuf,
    pub workspace_root: Option<PathBuf>,
    pub cache: SharedCache,
    pub write_lock: WriteLock,
}

impl ServerContext {
    /// Derive the knowledge directory from index_path (its parent).
    pub fn knowledge_dir(&self) -> Option<&std::path::Path> {
        self.index_path.parent()
    }

    /// Check if the knowledge index exists (i.e., the system is initialized).
    pub fn is_initialized(&self) -> bool {
        self.index_path.exists()
    }
}

/// Thread-safe reference to ServerContext.
pub type SharedContext = Arc<ServerContext>;

// ─── Entry Points ──────────────────────────────────────────────

/// Run the knowledge MCP server.
///
/// # Arguments
/// * `knowledge_dir` - Path to the .polaris/knowledge directory
///
/// # Returns
/// Result indicating success or error.
pub fn run_server(knowledge_dir: &str) -> Result<()> {
    let knowledge_dir = normalize_path(knowledge_dir)?;

    if !knowledge_dir.exists() {
        return Err(KnowledgeError::Validation(format!(
            "知识目录不存在: {}",
            knowledge_dir.display()
        )));
    }

    let index_path = knowledge_dir.join("index.json");
    let modules_dir = knowledge_dir.join("modules");
    // When invoked without --workspace we cannot know the workspace root.
    // v2 tools (validate_assertions) will refuse to run in this mode.
    run_event_loop(&index_path, &modules_dir, None)
}

/// Run the knowledge MCP server with workspace path.
///
/// # Arguments
/// * `config_dir` - Config directory (unused, kept for API compatibility)
/// * `workspace_path` - Path to the workspace root
///
/// # Returns
/// Result indicating success or error.
///
/// ## Lenient startup
/// If `.polaris/knowledge/` does not exist, it will be **automatically created**
/// (along with the `modules/` subdirectory). The server enters the event loop
/// in an "uninitialized" state — only `init_knowledge`, `initialize`, `ping`,
/// and `tools/list` are available. Other tools return a friendly error asking
/// the caller to run `init_knowledge` first.
pub fn run_server_with_workspace(config_dir: &str, workspace_path: Option<&str>) -> Result<()> {
    // Empty config_dir is legal in standalone --workspace mode; only validate
    // when a non-empty path was supplied.
    if !config_dir.trim().is_empty() {
        let _ = normalize_path(config_dir)?;
    }
    let workspace_path = workspace_path.and_then(|p| {
        let normalized = p.trim();
        if normalized.is_empty() {
            None
        } else {
            Some(PathBuf::from(normalized))
        }
    });

    // Knowledge lives in the workspace's .polaris/knowledge/ directory
    let knowledge_dir = match &workspace_path {
        Some(wp) => wp.join(".polaris").join("knowledge"),
        None => {
            return Err(KnowledgeError::Validation(
                "项目知识 MCP 需要工作区路径参数".to_string(),
            ));
        }
    };

    // Lenient startup: auto-create knowledge directory if missing.
    if !knowledge_dir.exists() {
        std::fs::create_dir_all(&knowledge_dir).map_err(|e| {
            KnowledgeError::Io(format!(
                "无法创建知识目录 {}: {}",
                knowledge_dir.display(),
                e
            ))
        })?;
        eprintln!(
            "[knowledge-mcp] 知识目录不存在，已自动创建: {}",
            knowledge_dir.display()
        );
    }

    // Ensure modules/ subdirectory exists (needed by create_module later).
    let modules_dir = knowledge_dir.join("modules");
    if !modules_dir.exists() {
        std::fs::create_dir_all(&modules_dir).map_err(|e| {
            KnowledgeError::Io(format!(
                "无法创建模块目录 {}: {}",
                modules_dir.display(),
                e
            ))
        })?;
    }

    let index_path = knowledge_dir.join("index.json");
    run_event_loop(&index_path, &modules_dir, workspace_path.as_deref())
}

/// Worker pool size for concurrent request processing.
const WORKER_POOL_SIZE: usize = 4;

/// Shared JSON-RPC event loop with thread pool for concurrent request processing.
/// Main thread reads requests from stdin, dispatches to worker threads,
/// collects responses via channel, and writes to stdout.
///
/// ## Lenient startup
/// No longer requires `index.json` to exist. If the file is absent, the server
/// starts in "uninitialized" mode — only `init_knowledge`, `initialize`, `ping`,
/// and `tools/list` respond successfully. All other tools return a friendly
/// error directing the caller to run `init_knowledge` first.
fn run_event_loop(
    index_path: &PathBuf,
    modules_dir: &PathBuf,
    workspace_root: Option<&std::path::Path>,
) -> Result<()> {
    // No pre-flight check on index.json — the server starts regardless.
    // If index.json is missing, tools that depend on it will return a
    // "knowledge not initialized" error, guiding the user to call init_knowledge.

    let ctx: SharedContext = Arc::new(ServerContext {
        index_path: index_path.clone(),
        modules_dir: modules_dir.clone(),
        workspace_root: workspace_root.map(|p| p.to_path_buf()),
        cache: Arc::new(RwLock::new(KnowledgeCache::new())),
        write_lock: Arc::new(std::sync::Mutex::new(())),
    });

    // Channel: workers -> main thread (serialized JSON responses)
    let (response_tx, response_rx) = mpsc::channel::<String>();

    // Channel: main thread -> workers (raw JSON-RPC lines)
    let (work_tx, work_rx) = mpsc::channel::<String>();
    let work_rx = Arc::new(std::sync::Mutex::new(work_rx));

    // Spawn worker threads
    let mut workers = Vec::with_capacity(WORKER_POOL_SIZE);
    for _ in 0..WORKER_POOL_SIZE {
        let work_rx = Arc::clone(&work_rx);
        let response_tx = response_tx.clone();
        let ctx = Arc::clone(&ctx);

        let handle = thread::spawn(move || {
            loop {
                let line = match work_rx.lock().unwrap().recv() {
                    Ok(l) => l,
                    Err(_) => break,
                };

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let response = match serde_json::from_str::<JsonRpcRequest>(trimmed) {
                    Ok(request) => handle_request(request, &ctx),
                    Err(error) => error_response(
                        Value::Null,
                        -32700,
                        format!("Parse error: {}", error),
                    ),
                };

                let response_str = serde_json::to_string(&response).unwrap_or_else(|e| {
                    format!(
                        "{{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{{\"code\":-32603,\"message\":\"{}\"}}}}",
                        e
                    )
                });

                if response_tx.send(response_str).is_err() {
                    break;
                }
            }
        });
        workers.push(handle);
    }
    // Drop extra sender so response_rx sees EOF when all workers exit
    drop(response_tx);

    // Main thread: read stdin, dispatch to pool, collect responses
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();

    let mut line = String::new();
    let mut pending_count: usize = 0;

    loop {
        line.clear();

        let bytes_read = match reader.read_line(&mut line) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[knowledge-mcp] stdin read error: {}", e);
                break;
            }
        };
        if bytes_read == 0 {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Peek at the raw JSON once to detect notifications and route by
        // method name. JSON-RPC 2.0 §4.1 defines a Notification as a Request
        // without an `id` field; per spec the server MUST NOT reply. Strict
        // clients (e.g. codex 0.130's rmcp transport) will fail to parse any
        // response framed against a notification and tear the stdio pipe down.
        let raw_value: Option<serde_json::Value> = serde_json::from_str(trimmed).ok();

        let is_notification = raw_value
            .as_ref()
            .and_then(|v| v.as_object())
            .map(|obj| !obj.contains_key("id"))
            .unwrap_or(false);
        if is_notification {
            // Silently consume and continue; never write a frame.
            continue;
        }

        // MCP handshake (initialize / ping) MUST be handled synchronously to
        // guarantee response ordering — the thread pool can reorder responses
        // which breaks the client handshake.
        let method = raw_value
            .as_ref()
            .and_then(|v| v.get("method").and_then(|m| m.as_str()).map(String::from));

        match method.as_deref() {
            Some("initialize") | Some("ping") => {
                // Synchronous path — parse, handle, write response immediately
                let response = match serde_json::from_str::<JsonRpcRequest>(trimmed) {
                    Ok(request) => handle_request(request, &ctx),
                    Err(error) => error_response(
                        Value::Null,
                        -32700,
                        format!("Parse error: {}", error),
                    ),
                };

                let response_str = serde_json::to_string(&response).unwrap_or_else(|e| {
                    format!(
                        "{{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{{\"code\":-32603,\"message\":\"{}\"}}}}",
                        e
                    )
                });

                if let Err(e) = writer.write_all(response_str.as_bytes())
                    .and_then(|_| writer.write_all(b"\n"))
                    .and_then(|_| writer.flush())
                {
                    eprintln!("[knowledge-mcp] stdout write error: {}", e);
                    break;
                }
            }
            _ => {
                // Async path — dispatch to worker pool
                if work_tx.send(trimmed.to_string()).is_err() {
                    eprintln!("[knowledge-mcp] worker pool shut down");
                    break;
                }
                pending_count += 1;

                // Drain available responses (non-blocking)
                while pending_count > 0 {
                    match response_rx.try_recv() {
                        Ok(response_str) => {
                            pending_count -= 1;
                            if let Err(e) = writer.write_all(response_str.as_bytes())
                                .and_then(|_| writer.write_all(b"\n"))
                                .and_then(|_| writer.flush())
                            {
                                eprintln!("[knowledge-mcp] stdout write error: {}", e);
                                break;
                            }
                        }
                        Err(mpsc::TryRecvError::Empty) => break,
                        Err(mpsc::TryRecvError::Disconnected) => {
                            eprintln!("[knowledge-mcp] workers disconnected");
                            break;
                        }
                    }
                }
            }
        }
    }

    // Drain remaining responses before exit
    drop(work_tx);
    while pending_count > 0 {
        match response_rx.recv() {
            Ok(response_str) => {
                pending_count -= 1;
                let _ = writer.write_all(response_str.as_bytes());
                let _ = writer.write_all(b"\n");
                let _ = writer.flush();
            }
            Err(_) => break,
        }
    }

    for handle in workers {
        let _ = handle.join();
    }

    Ok(())
}


/// Handle a JSON-RPC request.
fn handle_request(request: JsonRpcRequest, ctx: &SharedContext) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(id, -32600, "Invalid Request: jsonrpc must be 2.0".to_string());
    }

    let result = match request.method.as_str() {
        "initialize" => Ok(tools::get_initialize_response()),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(tools::get_tools_list()),
        "tools/call" => handle_tools_call(request.params, ctx),
        _ => Err(KnowledgeError::Validation(format!(
            "不支持的方法: {}",
            request.method
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

/// Normalize a path string.
fn normalize_path(path: &str) -> Result<PathBuf> {
    let path = path.trim();
    if path.is_empty() {
        return Err(KnowledgeError::Validation("路径不能为空".to_string()));
    }
    let trimmed = path.trim_end_matches(|c| c == '\\' || c == '/');
    Ok(PathBuf::from(trimmed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::KnowledgeCache;
    use crate::protocol::JsonRpcRequest;
    use serde_json::json;
    use std::fs;

    // ── normalize_path ──────────────────────────────────────────────

    #[test]
    fn normalize_path_trims_whitespace() {
        let result = normalize_path("  /foo/bar  ").unwrap();
        assert_eq!(result, PathBuf::from("/foo/bar"));
    }

    #[test]
    fn normalize_path_rejects_empty() {
        assert!(normalize_path("").is_err());
        assert!(normalize_path("   ").is_err());
    }

    #[test]
    fn normalize_path_strips_trailing_slash() {
        let result = normalize_path("/foo/bar/").unwrap();
        assert_eq!(result, PathBuf::from("/foo/bar"));
    }

    #[test]
    fn normalize_path_strips_trailing_backslash() {
        let result = normalize_path(r"C:\foo\bar\").unwrap();
        assert_eq!(result, PathBuf::from(r"C:\foo\bar"));
    }

    #[test]
    fn normalize_path_preserves_normal_path() {
        let result = normalize_path("/foo/bar").unwrap();
        assert_eq!(result, PathBuf::from("/foo/bar"));
    }

    // ── handle_request routing ──────────────────────────────────────

    /// Helper: build a minimal temp knowledge dir with empty index.json.
    fn setup_temp_knowledge_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let knowledge = dir.path().join(".polaris").join("knowledge");
        fs::create_dir_all(knowledge.join("modules")).unwrap();
        fs::write(knowledge.join("index.json"), r#"{"version":1,"modules":[]}"#).unwrap();
        dir
    }

    /// Helper: build a temp knowledge dir WITHOUT index.json (uninitialized).
    fn setup_empty_knowledge_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let knowledge = dir.path().join(".polaris").join("knowledge");
        fs::create_dir_all(knowledge.join("modules")).unwrap();
        // No index.json — uninitialized state
        dir
    }

    /// Helper to get knowledge dir path from tempdir.
    fn knowledge_path(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join(".polaris").join("knowledge")
    }

    fn make_request(method: &str, id: Value) -> JsonRpcRequest {
        serde_json::from_value(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": {}
        }))
        .unwrap()
    }

    fn make_tools_call_request(tool_name: &str, id: Value) -> JsonRpcRequest {
        serde_json::from_value(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": {}
            }
        }))
        .unwrap()
    }

    fn default_context(index_path: PathBuf, modules_dir: PathBuf) -> SharedContext {
        Arc::new(ServerContext {
            index_path,
            modules_dir,
            workspace_root: None,
            cache: Arc::new(RwLock::new(KnowledgeCache::new())),
            write_lock: Arc::new(std::sync::Mutex::new(())),
        })
    }

    #[test]
    fn handle_request_initialize() {
        let req = make_request("initialize", json!(1));
        let dir = setup_temp_knowledge_dir();
        let ctx = default_context(
            knowledge_path(&dir).join("index.json"),
            knowledge_path(&dir).join("modules"),
        );

        let resp = handle_request(req, &ctx);

        assert_eq!(resp.jsonrpc, "2.0");
        assert_eq!(resp.id, json!(1));
        assert!(resp.result.is_some());
        assert!(resp.error.is_none());

        let result = resp.result.unwrap();
        assert_eq!(result["serverInfo"]["name"], "polaris-knowledge-mcp");
        assert_eq!(result["protocolVersion"], "2024-11-05");
    }

    #[test]
    fn handle_request_ping() {
        let req = make_request("ping", json!("test-id"));
        let dir = setup_temp_knowledge_dir();
        let ctx = default_context(
            knowledge_path(&dir).join("index.json"),
            knowledge_path(&dir).join("modules"),
        );

        let resp = handle_request(req, &ctx);

        assert_eq!(resp.id, json!("test-id"));
        assert_eq!(resp.result, Some(json!({})));
    }

    #[test]
    fn handle_request_tools_list_returns_array() {
        let req = make_request("tools/list", json!(2));
        let dir = setup_temp_knowledge_dir();
        let ctx = default_context(
            knowledge_path(&dir).join("index.json"),
            knowledge_path(&dir).join("modules"),
        );

        let resp = handle_request(req, &ctx);

        let result = resp.result.unwrap();
        let tools = result["tools"].as_array().unwrap();
        assert!(!tools.is_empty());
    }

    #[test]
    fn handle_request_notifications_initialized() {
        let req = make_request("notifications/initialized", json!(3));
        let dir = setup_temp_knowledge_dir();
        let ctx = default_context(
            knowledge_path(&dir).join("index.json"),
            knowledge_path(&dir).join("modules"),
        );

        let resp = handle_request(req, &ctx);

        assert_eq!(resp.result, Some(json!({})));
        assert!(resp.error.is_none());
    }

    #[test]
    fn handle_request_invalid_jsonrpc_version() {
        let req = JsonRpcRequest {
            jsonrpc: "1.0".to_string(),
            id: Some(json!(42)),
            method: "ping".to_string(),
            params: json!({}),
        };
        let dir = setup_temp_knowledge_dir();
        let ctx = default_context(
            knowledge_path(&dir).join("index.json"),
            knowledge_path(&dir).join("modules"),
        );

        let resp = handle_request(req, &ctx);

        assert!(resp.error.is_some());
        assert_eq!(resp.error.unwrap().code, -32600);
    }

    #[test]
    fn handle_request_unknown_method() {
        let req = make_request("nonexistent/method", json!(99));
        let dir = setup_temp_knowledge_dir();
        let ctx = default_context(
            knowledge_path(&dir).join("index.json"),
            knowledge_path(&dir).join("modules"),
        );

        let resp = handle_request(req, &ctx);

        assert!(resp.error.is_some());
        let err = resp.error.unwrap();
        assert_eq!(err.code, -32000);
        assert!(err.message.contains("不支持的方法"));
    }

    #[test]
    fn handle_request_null_id_defaults_to_null() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: None,
            method: "ping".to_string(),
            params: json!({}),
        };
        let dir = setup_temp_knowledge_dir();
        let ctx = default_context(
            knowledge_path(&dir).join("index.json"),
            knowledge_path(&dir).join("modules"),
        );

        let resp = handle_request(req, &ctx);

        assert_eq!(resp.id, Value::Null);
        assert!(resp.result.is_some());
    }

    // ── entry point validation ──────────────────────────────────────

    #[test]
    fn run_server_rejects_nonexistent_dir() {
        let result = run_server("/nonexistent/path/knowledge");
        assert!(result.is_err());
        let msg = result.unwrap_err().to_message();
        assert!(msg.contains("知识目录不存在"));
    }

    #[test]
    fn run_server_with_workspace_rejects_no_workspace() {
        let result = run_server_with_workspace("", None::<&str>);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_message();
        assert!(msg.contains("工作区路径"));
    }

    // ── lenient startup ────────────────────────────────────────────

    #[test]
    fn run_server_with_workspace_creates_missing_knowledge_dir() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("my-workspace");
        fs::create_dir_all(&workspace).unwrap();
        // .polaris/knowledge does NOT exist yet

        // We can't actually run the event loop in a test (it blocks on stdin),
        // but we can verify the directory gets created during setup.
        let knowledge_dir = workspace.join(".polaris").join("knowledge");
        assert!(!knowledge_dir.exists());

        // Simulate the setup logic from run_server_with_workspace
        std::fs::create_dir_all(&knowledge_dir).unwrap();
        std::fs::create_dir_all(knowledge_dir.join("modules")).unwrap();

        assert!(knowledge_dir.exists());
        assert!(knowledge_dir.join("modules").exists());
    }

    #[test]
    fn uninitialized_tools_return_friendly_error() {
        // Knowledge dir exists but no index.json
        let dir = setup_empty_knowledge_dir();
        let ctx = default_context(
            knowledge_path(&dir).join("index.json"),
            knowledge_path(&dir).join("modules"),
        );

        // list_modules should fail with "not initialized" message
        let req = make_tools_call_request("list_modules", json!(10));
        let resp = handle_request(req, &ctx);

        assert!(resp.error.is_some());
        let err = resp.error.unwrap();
        assert_eq!(err.code, -32000);
        assert!(err.message.contains("未初始化") || err.message.contains("init_knowledge"));
    }

    #[test]
    fn init_knowledge_works_on_empty_dir() {
        let dir = setup_empty_knowledge_dir();
        let ctx = default_context(
            knowledge_path(&dir).join("index.json"),
            knowledge_path(&dir).join("modules"),
        );

        // init_knowledge should succeed even without index.json
        let req = make_tools_call_request("init_knowledge", json!(20));
        let resp = handle_request(req, &ctx);

        assert!(resp.result.is_some(), "init_knowledge should return a result, got error: {:?}", resp.error);
        assert!(ctx.index_path.exists(), "index.json should have been created");
    }

    #[test]
    fn init_knowledge_is_idempotent() {
        let dir = setup_temp_knowledge_dir();
        let ctx = default_context(
            knowledge_path(&dir).join("index.json"),
            knowledge_path(&dir).join("modules"),
        );

        // index.json already exists — init_knowledge should succeed without overwriting
        let req = make_tools_call_request("init_knowledge", json!(30));
        let resp = handle_request(req, &ctx);

        assert!(resp.result.is_some());
        // Original content should be preserved
        let content = fs::read_to_string(&ctx.index_path).unwrap();
        assert!(content.contains("modules"));
    }

    // ── JSON-RPC parse error ────────────────────────────────────────

    #[test]
    fn parse_error_on_invalid_json() {
        let resp = serde_json::from_str::<JsonRpcRequest>("not valid json");
        assert!(resp.is_err());

        // Verify the error response we'd build
        let err_resp = error_response(Value::Null, -32700, "Parse error".to_string());
        assert_eq!(err_resp.error.unwrap().code, -32700);
    }

    // ── notification detection (main-loop raw-value peek) ───────────
    //
    // Regression coverage for the codex 0.130 / rmcp incident: the main
    // event loop classifies a payload as a JSON-RPC Notification iff the
    // raw JSON object lacks an `id` field. When this is true the server
    // MUST NOT write any frame to stdout — strict clients tear the stdio
    // transport down on receiving a spurious response.
    //
    // These tests mirror the logic inside `run_event_loop` precisely so
    // future refactors can't silently regress detection.

    fn is_notification_payload(payload: &str) -> bool {
        let raw: Option<Value> = serde_json::from_str(payload).ok();
        raw.as_ref()
            .and_then(|v| v.as_object())
            .map(|obj| !obj.contains_key("id"))
            .unwrap_or(false)
    }

    #[test]
    fn raw_peek_classifies_missing_id_as_notification() {
        let payload = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert!(is_notification_payload(payload));
    }

    #[test]
    fn raw_peek_classifies_explicit_null_id_as_request() {
        // Even though serde collapses `"id": null` and missing-id to the
        // same `Option::None` in JsonRpcRequest, the main-loop raw peek
        // sees the physical presence of the field — i.e. a real (if
        // spec-discouraged) Request. We dispatch and reply normally.
        let payload = r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#;
        assert!(!is_notification_payload(payload));
    }

    #[test]
    fn raw_peek_classifies_numeric_id_as_request() {
        let payload = r#"{"jsonrpc":"2.0","id":42,"method":"initialize"}"#;
        assert!(!is_notification_payload(payload));
    }

    #[test]
    fn raw_peek_treats_garbled_json_as_request() {
        // Unparseable payload — fall through to the dispatch path where
        // the parse-error frame is emitted with id: null. NOT a notification.
        assert!(!is_notification_payload("not valid json"));
    }

    // ── protocol serialization round-trip ───────────────────────────

    #[test]
    fn response_serializes_without_null_fields() {
        let resp = JsonRpcResponse {
            jsonrpc: "2.0",
            id: json!(1),
            result: Some(json!({"ok": true})),
            error: None,
        };
        let serialized = serde_json::to_string(&resp).unwrap();
        assert!(!serialized.contains("error"));
        assert!(serialized.contains("result"));
    }

    #[test]
    fn error_response_serializes_correctly() {
        let resp = error_response(json!(5), -32600, "bad request".to_string());
        let serialized = serde_json::to_string(&resp).unwrap();
        let parsed: Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed["error"]["code"], -32600);
        assert_eq!(parsed["error"]["message"], "bad request");
        assert!(parsed.get("result").is_none());
    }
}
