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

    if !knowledge_dir.exists() {
        return Err(KnowledgeError::Validation(format!(
            "知识目录不存在: {}",
            knowledge_dir.display()
        )));
    }

    let index_path = knowledge_dir.join("index.json");
    let modules_dir = knowledge_dir.join("modules");
    run_event_loop(&index_path, &modules_dir, workspace_path.as_deref())
}

/// Worker pool size for concurrent request processing.
const WORKER_POOL_SIZE: usize = 4;

/// Shared JSON-RPC event loop with thread pool for concurrent request processing.
/// Main thread reads requests from stdin, dispatches to worker threads,
/// collects responses via channel, and writes to stdout.
fn run_event_loop(
    index_path: &PathBuf,
    modules_dir: &PathBuf,
    workspace_root: Option<&std::path::Path>,
) -> Result<()> {
    // Pre-flight: verify index.json exists before entering the event loop.
    if !index_path.exists() {
        return Err(KnowledgeError::Validation(format!(
            "知识索引文件不存在: {}。请确保 .polaris/knowledge/index.json 存在",
            index_path.display()
        )));
    }

    let cache: SharedCache = Arc::new(RwLock::new(KnowledgeCache::new()));
    let write_lock: WriteLock = Arc::new(std::sync::Mutex::new(()));

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
        let cache = Arc::clone(&cache);
        let write_lock = Arc::clone(&write_lock);
        let index_path = index_path.clone();
        let modules_dir = modules_dir.clone();
        let workspace_root = workspace_root.map(|p| p.to_path_buf());

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
                    Ok(request) => handle_request(
                        request,
                        &index_path,
                        &modules_dir,
                        workspace_root.as_deref(),
                        &cache,
                        &write_lock,
                    ),
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

        // Dispatch request to worker pool
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
fn handle_request(
    request: JsonRpcRequest,
    index_path: &PathBuf,
    modules_dir: &PathBuf,
    workspace_root: Option<&std::path::Path>,
    cache: &SharedCache,
    write_lock: &WriteLock,
) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(id, -32600, "Invalid Request: jsonrpc must be 2.0".to_string());
    }

    let result = match request.method.as_str() {
        "initialize" => Ok(tools::get_initialize_response()),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(tools::get_tools_list()),
        "tools/call" => handle_tools_call(request.params, index_path, modules_dir, workspace_root, cache, write_lock),
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

    fn default_cache() -> SharedCache {
        Arc::new(RwLock::new(KnowledgeCache::new()))
    }

    fn default_write_lock() -> WriteLock {
        Arc::new(std::sync::Mutex::new(()))
    }

    #[test]
    fn handle_request_initialize() {
        let req = make_request("initialize", json!(1));
        let dir = setup_temp_knowledge_dir();
        let index_path = knowledge_path(&dir).join("index.json");
        let modules_dir = knowledge_path(&dir).join("modules");
        let cache = default_cache();

        let resp = handle_request(req, &index_path, &modules_dir, None, &cache, &default_write_lock());

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
        let index_path = knowledge_path(&dir).join("index.json");
        let modules_dir = knowledge_path(&dir).join("modules");
        let cache = default_cache();

        let resp = handle_request(req, &index_path, &modules_dir, None, &cache, &default_write_lock());

        assert_eq!(resp.id, json!("test-id"));
        assert_eq!(resp.result, Some(json!({})));
    }

    #[test]
    fn handle_request_tools_list_returns_array() {
        let req = make_request("tools/list", json!(2));
        let dir = setup_temp_knowledge_dir();
        let index_path = knowledge_path(&dir).join("index.json");
        let modules_dir = knowledge_path(&dir).join("modules");
        let cache = default_cache();

        let resp = handle_request(req, &index_path, &modules_dir, None, &cache, &default_write_lock());

        let result = resp.result.unwrap();
        let tools = result["tools"].as_array().unwrap();
        assert!(!tools.is_empty());
    }

    #[test]
    fn handle_request_notifications_initialized() {
        let req = make_request("notifications/initialized", json!(3));
        let dir = setup_temp_knowledge_dir();
        let index_path = knowledge_path(&dir).join("index.json");
        let modules_dir = knowledge_path(&dir).join("modules");
        let cache = default_cache();

        let resp = handle_request(req, &index_path, &modules_dir, None, &cache, &default_write_lock());

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
        let index_path = knowledge_path(&dir).join("index.json");
        let modules_dir = knowledge_path(&dir).join("modules");
        let cache = default_cache();

        let resp = handle_request(req, &index_path, &modules_dir, None, &cache, &default_write_lock());

        assert!(resp.error.is_some());
        assert_eq!(resp.error.unwrap().code, -32600);
    }

    #[test]
    fn handle_request_unknown_method() {
        let req = make_request("nonexistent/method", json!(99));
        let dir = setup_temp_knowledge_dir();
        let index_path = knowledge_path(&dir).join("index.json");
        let modules_dir = knowledge_path(&dir).join("modules");
        let cache = default_cache();

        let resp = handle_request(req, &index_path, &modules_dir, None, &cache, &default_write_lock());

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
        let index_path = knowledge_path(&dir).join("index.json");
        let modules_dir = knowledge_path(&dir).join("modules");
        let cache = default_cache();

        let resp = handle_request(req, &index_path, &modules_dir, None, &cache, &default_write_lock());

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

    #[test]
    fn run_server_with_workspace_rejects_nonexistent_workspace() {
        let result = run_server_with_workspace("", Some("/nonexistent/workspace"));
        assert!(result.is_err());
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
