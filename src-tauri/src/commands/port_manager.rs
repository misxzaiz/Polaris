//! 端口管理 Tauri 命令
//!
//! 提供端口查询、端口释放等 API 接口

use crate::error::Result;
use crate::services::port_manager_service::{
    self, is_port_available, KillResult, PortInfo, PortSummary,
};

/// 获取监听端口列表
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn port_list() -> Result<Vec<PortInfo>> {
    port_manager_service::list_listening_ports()
}

/// 查找指定端口的占用进程
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn port_find(port: u16) -> Result<Option<PortInfo>> {
    port_manager_service::find_port_owner(port)
}

/// 检查端口是否可用
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn port_check(port: u16) -> Result<bool> {
    is_port_available(port)
}

/// 终止占用指定端口的进程
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn port_kill(port: u16) -> Result<KillResult> {
    port_manager_service::kill_process_by_port(port)
}

/// 获取端口统计摘要
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn port_summary() -> Result<PortSummary> {
    port_manager_service::get_port_summary()
}
