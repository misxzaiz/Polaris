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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── JsonRpcRequest deserialization ──────────────────────────────

    #[test]
    fn request_parses_number_id() {
        let req: JsonRpcRequest = serde_json::from_value(json!({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "ping",
            "params": {}
        }))
        .unwrap();
        assert_eq!(req.jsonrpc, "2.0");
        assert_eq!(req.id, Some(json!(42)));
        assert_eq!(req.method, "ping");
    }

    #[test]
    fn request_parses_string_id() {
        let req: JsonRpcRequest = serde_json::from_value(json!({
            "jsonrpc": "2.0",
            "id": "abc-123",
            "method": "initialize",
            "params": {}
        }))
        .unwrap();
        assert_eq!(req.id, Some(json!("abc-123")));
    }

    #[test]
    fn request_explicit_null_id_is_none() {
        // serde deserializes JSON null → None for Option<T>
        let req: JsonRpcRequest = serde_json::from_value(json!({
            "jsonrpc": "2.0",
            "id": null,
            "method": "ping",
            "params": {}
        }))
        .unwrap();
        assert!(req.id.is_none());
    }

    #[test]
    fn request_missing_id_is_none() {
        let req: JsonRpcRequest = serde_json::from_value(json!({
            "jsonrpc": "2.0",
            "method": "ping",
            "params": {}
        }))
        .unwrap();
        assert!(req.id.is_none());
    }

    #[test]
    fn request_missing_params_defaults_to_null() {
        let req: JsonRpcRequest = serde_json::from_value(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "ping"
        }))
        .unwrap();
        assert!(req.params.is_null());
    }

    #[test]
    fn request_with_object_params() {
        let req: JsonRpcRequest = serde_json::from_value(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "get_module", "arguments": {"id": "chat-render"}}
        }))
        .unwrap();
        assert_eq!(req.params["name"], "get_module");
        assert_eq!(req.params["arguments"]["id"], "chat-render");
    }

    #[test]
    fn request_fails_without_method() {
        let result = serde_json::from_value::<JsonRpcRequest>(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "params": {}
        }));
        assert!(result.is_err());
    }

    #[test]
    fn request_fails_without_jsonrpc() {
        let result = serde_json::from_value::<JsonRpcRequest>(json!({
            "id": 1,
            "method": "ping",
            "params": {}
        }));
        assert!(result.is_err());
    }

    // ── JsonRpcResponse serialization ──────────────────────────────

    #[test]
    fn success_response_serializes() {
        let resp = JsonRpcResponse {
            jsonrpc: "2.0",
            id: json!(1),
            result: Some(json!({"tools": []})),
            error: None,
        };
        let s = serde_json::to_string(&resp).unwrap();
        let parsed: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["id"], 1);
        assert!(parsed.get("result").is_some());
        assert!(parsed.get("error").is_none());
    }

    #[test]
    fn error_response_skips_null_result() {
        let resp = error_response(json!(2), -32600, "Invalid Request".to_string());
        let s = serde_json::to_string(&resp).unwrap();
        let parsed: Value = serde_json::from_str(&s).unwrap();
        assert!(parsed.get("result").is_none());
        assert_eq!(parsed["error"]["code"], -32600);
        assert_eq!(parsed["error"]["message"], "Invalid Request");
    }

    #[test]
    fn response_null_result_is_skipped() {
        let resp = JsonRpcResponse {
            jsonrpc: "2.0",
            id: Value::Null,
            result: None,
            error: None,
        };
        let s = serde_json::to_string(&resp).unwrap();
        assert!(!s.contains("result"));
        assert!(!s.contains("error"));
    }

    #[test]
    fn response_with_string_id() {
        let resp = JsonRpcResponse {
            jsonrpc: "2.0",
            id: json!("uuid-42"),
            result: Some(json!({})),
            error: None,
        };
        let s = serde_json::to_string(&resp).unwrap();
        let parsed: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["id"], "uuid-42");
    }

    #[test]
    fn response_with_null_id() {
        let resp = JsonRpcResponse {
            jsonrpc: "2.0",
            id: Value::Null,
            result: Some(json!({"ok": true})),
            error: None,
        };
        let s = serde_json::to_string(&resp).unwrap();
        let parsed: Value = serde_json::from_str(&s).unwrap();
        assert!(parsed["id"].is_null());
    }

    // ── error_response helper ──────────────────────────────────────

    #[test]
    fn error_response_with_null_id() {
        let resp = error_response(Value::Null, -32700, "Parse error".to_string());
        assert_eq!(resp.jsonrpc, "2.0");
        assert_eq!(resp.id, Value::Null);
        assert!(resp.result.is_none());
        let err = resp.error.unwrap();
        assert_eq!(err.code, -32700);
        assert_eq!(err.message, "Parse error");
    }

    #[test]
    fn error_response_with_number_id() {
        let resp = error_response(json!(99), -32000, "Server error".to_string());
        assert_eq!(resp.id, json!(99));
        assert_eq!(resp.error.unwrap().code, -32000);
    }

    #[test]
    fn error_response_with_string_id() {
        let resp = error_response(json!("req-1"), -32601, "Method not found".to_string());
        assert_eq!(resp.id, json!("req-1"));
    }

    // ── Round-trip: deserialize request → handle → serialize response ─

    #[test]
    fn roundtrip_deserialize_request_to_response_structure() {
        let raw = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": "get_module", "arguments": {"id": "chat-render"}}
        });
        let req: JsonRpcRequest = serde_json::from_value(raw).unwrap();

        // Simulate handler producing a response
        let resp = JsonRpcResponse {
            jsonrpc: "2.0",
            id: req.id.unwrap_or(Value::Null),
            result: Some(json!({"content": [{"type": "text", "text": "module data"}]})),
            error: None,
        };

        let serialized = serde_json::to_string(&resp).unwrap();
        let parsed: Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed["id"], 7);
        assert_eq!(parsed["result"]["content"][0]["type"], "text");
    }

    #[test]
    fn roundtrip_error_request_to_error_response() {
        let raw = json!({
            "jsonrpc": "2.0",
            "id": "err-1",
            "method": "bad/method",
            "params": {}
        });
        let req: JsonRpcRequest = serde_json::from_value(raw).unwrap();
        let resp = error_response(
            req.id.unwrap_or(Value::Null),
            -32000,
            format!("Unsupported method: {}", req.method),
        );

        let serialized = serde_json::to_string(&resp).unwrap();
        let parsed: Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed["id"], "err-1");
        assert_eq!(parsed["error"]["code"], -32000);
        assert!(parsed["error"]["message"].as_str().unwrap().contains("bad/method"));
    }
}
