//! MCP Server main loop and request handling.

use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;

use serde_json::json;
use serde_json::Value;

use crate::error::{KnowledgeError, Result};
use crate::handler::handle_tools_call;
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
            Ok(request) => handle_request(request, &index_path, &modules_dir),
            Err(error) => error_response(
                Value::Null,
                -32700,
                format!("Parse error: {}", error),
            ),
        };

        serde_json::to_writer(&mut writer, &response)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }

    Ok(())
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
    let _config_dir = normalize_path(config_dir)?;
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

    run_server(knowledge_dir.to_str().unwrap_or(""))
}

/// Handle a JSON-RPC request.
fn handle_request(
    request: JsonRpcRequest,
    index_path: &PathBuf,
    modules_dir: &PathBuf,
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
        "tools/call" => handle_tools_call(request.params, index_path, modules_dir),
        _ => Err(KnowledgeError::Validation(format!(
            "Unsupported method: {}",
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
    let mut buf = PathBuf::from(path);
    // Remove trailing separator for consistency
    if buf.as_os_str().to_string_lossy().ends_with('\\')
        || buf.as_os_str().to_string_lossy().ends_with('/')
    {
        buf.pop();
    }
    Ok(buf)
}
