/*! 集成相关 Tauri 命令
 *
 * 提供平台集成的启动、停止、状态查询、消息发送等命令。
 */

use std::collections::HashMap;
use tauri::State;

use crate::error::Result;
use crate::integrations::types::*;
use crate::integrations::instance_registry::{PlatformInstance, InstanceId};
use crate::models::config::QQBotConfig;

/// 启动集成平台
#[tauri::command]
pub async fn start_integration(
    platform: String,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| crate::error::AppError::ValidationError(e))?;

    let mut manager = state.integration_manager.lock().await;
    manager.start(platform).await
}

/// 停止集成平台
#[tauri::command]
pub async fn stop_integration(
    platform: String,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| crate::error::AppError::ValidationError(e))?;

    let mut manager = state.integration_manager.lock().await;
    manager.stop(platform).await
}

/// 获取集成状态
#[tauri::command]
pub async fn get_integration_status(
    platform: String,
    state: State<'_, crate::AppState>,
) -> Result<Option<IntegrationStatus>> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| crate::error::AppError::ValidationError(e))?;

    let manager = state.integration_manager.lock().await;
    Ok(manager.status(platform).await)
}

/// 获取所有集成状态
#[tauri::command]
pub async fn get_all_integration_status(
    state: State<'_, crate::AppState>,
) -> Result<HashMap<String, IntegrationStatus>> {
    let manager = state.integration_manager.lock().await;
    Ok(manager
        .all_status()
        .await
        .into_iter()
        .map(|(p, s)| (p.to_string(), s))
        .collect())
}

/// 发送集成消息
#[tauri::command]
pub async fn send_integration_message(
    platform: String,
    target: SendTarget,
    content: MessageContent,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| crate::error::AppError::ValidationError(e))?;

    let manager = state.integration_manager.lock().await;
    manager.send(platform, target, content).await
}

/// 获取集成会话列表
#[tauri::command]
pub async fn get_integration_sessions(
    state: State<'_, crate::AppState>,
) -> Result<Vec<IntegrationSession>> {
    let manager = state.integration_manager.lock().await;
    Ok(manager.sessions().into_iter().cloned().collect())
}

/// 初始化集成管理器
#[tauri::command]
pub async fn init_integration(
    qqbot_config: Option<QQBotConfig>,
    app_handle: tauri::AppHandle,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    let mut manager = state.integration_manager.lock().await;
    manager.init(qqbot_config, app_handle).await;
    Ok(())
}

// ==================== 实例管理命令 ====================

/// 添加实例
#[tauri::command]
pub async fn add_integration_instance(
    instance: PlatformInstance,
    state: State<'_, crate::AppState>,
) -> Result<InstanceId> {
    let manager = state.integration_manager.lock().await;
    Ok(manager.add_instance(instance).await)
}

/// 移除实例
#[tauri::command]
pub async fn remove_integration_instance(
    instance_id: String,
    state: State<'_, crate::AppState>,
) -> Result<Option<PlatformInstance>> {
    let manager = state.integration_manager.lock().await;
    Ok(manager.remove_instance(&instance_id).await)
}

/// 获取所有实例
#[tauri::command]
pub async fn list_integration_instances(
    state: State<'_, crate::AppState>,
) -> Result<Vec<PlatformInstance>> {
    let manager = state.integration_manager.lock().await;
    Ok(manager.list_instances().await)
}

/// 按平台获取实例列表
#[tauri::command]
pub async fn list_integration_instances_by_platform(
    platform: String,
    state: State<'_, crate::AppState>,
) -> Result<Vec<PlatformInstance>> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| crate::error::AppError::ValidationError(e))?;

    let manager = state.integration_manager.lock().await;
    Ok(manager.list_instances_by_platform(platform).await)
}

/// 获取当前激活的实例
#[tauri::command]
pub async fn get_active_integration_instance(
    platform: String,
    state: State<'_, crate::AppState>,
) -> Result<Option<PlatformInstance>> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| crate::error::AppError::ValidationError(e))?;

    let manager = state.integration_manager.lock().await;
    Ok(manager.get_active_instance(platform).await)
}

/// 切换实例
#[tauri::command]
pub async fn switch_integration_instance(
    instance_id: String,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    let mut manager = state.integration_manager.lock().await;
    manager.switch_instance(&instance_id).await
}

/// 断开当前实例
#[tauri::command]
pub async fn disconnect_integration_instance(
    platform: String,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| crate::error::AppError::ValidationError(e))?;

    let mut manager = state.integration_manager.lock().await;
    manager.disconnect_instance(platform).await
}

/// 更新实例配置
#[tauri::command]
pub async fn update_integration_instance(
    instance: PlatformInstance,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    let mut manager = state.integration_manager.lock().await;
    manager.update_instance(instance).await
}
