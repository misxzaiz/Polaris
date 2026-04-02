//! Scheduler Services Module
//!
//! This module contains services for scheduled task management:
//! - `storage`: Storage abstraction trait
//! - `local_file_storage`: Local file system implementation
//! - `protocol_task`: Protocol mode document management
//! - (future) `template`: Task template management

pub mod storage;
pub mod local_file_storage;
pub mod protocol_task;

// Re-export main types for convenience
pub use storage::{TaskStorage, TaskUpdateParams, WorkspaceInfo, StorageBackend};
pub use local_file_storage::LocalFileStorage;
