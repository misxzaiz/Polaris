//! Knowledge MCP Server library.
//!
//! Provides MCP server functionality for project knowledge management.

pub mod error;
pub mod handler;
pub mod models;
pub mod protocol;
pub mod server;
pub mod tools;

pub use error::{KnowledgeError, Result};
pub use models::{KnowledgeIndex, ModuleEntry};
pub use server::{run_server, run_server_with_workspace};
