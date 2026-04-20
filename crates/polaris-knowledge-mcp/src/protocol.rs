//! JSON-RPC types for MCP protocol.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON-RPC request.
#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// JSON-RPC response.
#[derive(Debug, Serialize)]
pub struct JsonRpcResponse<'a> {
    pub jsonrpc: &'a str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

/// JSON-RPC error.
#[derive(Debug, Serialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
}

/// Create an error response.
pub fn error_response(id: Value, code: i32, message: String) -> JsonRpcResponse<'static> {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError { code, message }),
    }
}
