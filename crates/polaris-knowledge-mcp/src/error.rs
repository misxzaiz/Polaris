//! Self-contained error types for the knowledge MCP server.
//!
//! No dependencies on polaris_lib - fully standalone.

use std::fmt;

/// Result type alias for knowledge operations.
pub type Result<T> = std::result::Result<T, KnowledgeError>;

/// Error type for knowledge MCP operations.
#[derive(Debug)]
pub enum KnowledgeError {
    /// I/O error (file read/write)
    Io(String),
    /// JSON parsing error
    Json(String),
    /// Validation error (invalid input)
    Validation(String),
    /// Module not found
    NotFound(String),
}

impl fmt::Display for KnowledgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KnowledgeError::Io(msg) => write!(f, "IO 错误: {}", msg),
            KnowledgeError::Json(msg) => write!(f, "JSON 错误: {}", msg),
            KnowledgeError::Validation(msg) => write!(f, "校验错误: {}", msg),
            KnowledgeError::NotFound(msg) => write!(f, "未找到: {}", msg),
        }
    }
}

impl std::error::Error for KnowledgeError {}

impl From<std::io::Error> for KnowledgeError {
    fn from(err: std::io::Error) -> Self {
        KnowledgeError::Io(err.to_string())
    }
}

impl From<serde_json::Error> for KnowledgeError {
    fn from(err: serde_json::Error) -> Self {
        KnowledgeError::Json(err.to_string())
    }
}

impl KnowledgeError {
    /// Convert to a message string for JSON-RPC error response.
    pub fn to_message(&self) -> String {
        self.to_string()
    }
}
