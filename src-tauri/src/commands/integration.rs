/*! 集成相关 Tauri 命令
 *
 * 提供平台集成的启动、停止、状态查询、消息发送等命令。
 */

use std::collections::HashMap;
#[cfg(feature = "tauri-app")]
use tauri::State;

use crate::error::{Result, AppError};
use crate::integrations::types::*;
use crate::integrations::instance_registry::{PlatformInstance, InstanceId};
use crate::models::config::{
    QQBotConfig, QQBotInstanceConfig, FeishuConfig, FeishuInstanceConfig,
};

/// 启动集成平台
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn start_integration(
    platform: String,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| AppError::ValidationError(e))?;

    let mut manager = state.integration_manager.lock().await;
    manager.start(platform).await
}

/// 停止集成平台
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn stop_integration(
    platform: String,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| AppError::ValidationError(e))?;

    let mut manager = state.integration_manager.lock().await;
    manager.stop(platform).await
}

/// 获取集成状态
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn get_integration_status(
    platform: String,
    state: State<'_, crate::AppState>,
) -> Result<Option<IntegrationStatus>> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| AppError::ValidationError(e))?;

    let manager = state.integration_manager.lock().await;
    Ok(manager.status(platform).await)
}

/// 获取所有集成状态
#[cfg(feature = "tauri-app")]
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
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn send_integration_message(
    platform: String,
    target: SendTarget,
    content: MessageContent,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| AppError::ValidationError(e))?;

    let manager = state.integration_manager.lock().await;
    manager.send(platform, target, content).await
}

/// 获取集成会话列表
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn get_integration_sessions(
    state: State<'_, crate::AppState>,
) -> Result<Vec<IntegrationSession>> {
    let manager = state.integration_manager.lock().await;
    Ok(manager.sessions().into_iter().cloned().collect())
}

/// 初始化集成管理器
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn init_integration(
    qqbot_config: Option<QQBotConfig>,
    feishu_config: Option<FeishuConfig>,
    app_handle: tauri::AppHandle,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    let mut manager = state.integration_manager.lock().await;
    manager.init(qqbot_config, feishu_config, app_handle).await;
    Ok(())
}

// ==================== 实例管理命令 ====================

/// 添加实例
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn add_integration_instance(
    instance: PlatformInstance,
    state: State<'_, crate::AppState>,
) -> Result<InstanceId> {
    let id = {
        let manager = state.integration_manager.lock().await;
        manager.add_instance(instance).await
    };
    sync_instances_to_config(&state).await?;
    Ok(id)
}

/// 移除实例
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn remove_integration_instance(
    instance_id: String,
    state: State<'_, crate::AppState>,
) -> Result<Option<PlatformInstance>> {
    let removed = {
        let manager = state.integration_manager.lock().await;
        manager.remove_instance(&instance_id).await
    };
    sync_instances_to_config(&state).await?;
    Ok(removed)
}

/// 获取所有实例
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn list_integration_instances(
    state: State<'_, crate::AppState>,
) -> Result<Vec<PlatformInstance>> {
    let manager = state.integration_manager.lock().await;
    Ok(manager.list_instances().await)
}

/// 按平台获取实例列表
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn list_integration_instances_by_platform(
    platform: String,
    state: State<'_, crate::AppState>,
) -> Result<Vec<PlatformInstance>> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| AppError::ValidationError(e))?;

    let manager = state.integration_manager.lock().await;
    Ok(manager.list_instances_by_platform(platform).await)
}

/// 获取当前激活的实例
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn get_active_integration_instance(
    platform: String,
    state: State<'_, crate::AppState>,
) -> Result<Option<PlatformInstance>> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| AppError::ValidationError(e))?;

    let manager = state.integration_manager.lock().await;
    Ok(manager.get_active_instance(platform).await)
}

/// 切换实例
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn switch_integration_instance(
    instance_id: String,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    {
        let mut manager = state.integration_manager.lock().await;
        manager.switch_instance(&instance_id).await?;
    }
    sync_instances_to_config(&state).await?;
    Ok(())
}

/// 断开当前实例
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn disconnect_integration_instance(
    platform: String,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    let platform: Platform = platform
        .parse()
        .map_err(|e: String| AppError::ValidationError(e))?;

    {
        let mut manager = state.integration_manager.lock().await;
        manager.disconnect_instance(platform).await?;
    }
    sync_instances_to_config(&state).await?;
    Ok(())
}

/// 更新实例配置
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn update_integration_instance(
    instance: PlatformInstance,
    state: State<'_, crate::AppState>,
) -> Result<()> {
    {
        let mut manager = state.integration_manager.lock().await;
        manager.update_instance(instance).await?;
    }
    sync_instances_to_config(&state).await?;
    Ok(())
}

// ==================== 持久化同步 ====================

/// 将 InstanceRegistry 中的实例数据同步写回 ConfigStore（config.json）
///
/// 每次 add/update/remove/switch/disconnect 操作后调用，
/// 确保实例配置在应用重启后不丢失。
#[cfg(feature = "tauri-app")]
async fn sync_instances_to_config(state: &State<'_, crate::AppState>) -> Result<()> {
    // Step 1: 从 InstanceRegistry 读取数据（async lock，用完立即释放）
    let (qqbot_instances, feishu_instances, qqbot_active_id, feishu_active_id) = {
        let manager = state.integration_manager.lock().await;
        let instances = manager.list_instances().await;

        let qqbot_instances: Vec<QQBotInstanceConfig> = instances
            .iter()
            .filter(|i| i.platform == Platform::QQBot)
            .filter_map(platform_instance_to_qqbot)
            .collect();

        let feishu_instances: Vec<FeishuInstanceConfig> = instances
            .iter()
            .filter(|i| i.platform == Platform::Feishu)
            .filter_map(platform_instance_to_feishu)
            .collect();

        let qqbot_active_id = manager
            .get_active_instance(Platform::QQBot)
            .await
            .map(|i| i.id);
        let feishu_active_id = manager
            .get_active_instance(Platform::Feishu)
            .await
            .map(|i| i.id);

        (qqbot_instances, feishu_instances, qqbot_active_id, feishu_active_id)
    };
    // manager async lock 已释放

    // Step 2: 更新 ConfigStore（sync lock）
    let mut config_store = state.config_store.lock()
        .map_err(|_| AppError::StateError("ConfigStore lock poisoned".to_string()))?;
    let mut config = config_store.get().clone();

    config.qqbot.instances = qqbot_instances;
    config.qqbot.active_instance_id = qqbot_active_id;
    config.feishu.instances = feishu_instances;
    config.feishu.active_instance_id = feishu_active_id;

    config_store.update(config)?;
    Ok(())
}

/// 将 PlatformInstance 转换回 QQBotInstanceConfig（配置格式）
fn platform_instance_to_qqbot(instance: &PlatformInstance) -> Option<QQBotInstanceConfig> {
    let cfg = instance.config.as_qqbot()?;
    Some(QQBotInstanceConfig {
        id: instance.id.clone(),
        name: instance.name.clone(),
        enabled: instance.enabled,
        app_id: cfg.app_id.clone(),
        client_secret: cfg.client_secret.clone(),
        sandbox: cfg.sandbox,
        display_mode: cfg.display_mode.clone(),
        auto_connect: cfg.auto_connect,
        created_at: Some(instance.created_at.to_rfc3339()),
        last_active: instance.last_active.map(|dt| dt.to_rfc3339()),
        work_dir: cfg.work_dir.clone(),
    })
}

/// 将 PlatformInstance 转换回 FeishuInstanceConfig（配置格式）
fn platform_instance_to_feishu(instance: &PlatformInstance) -> Option<FeishuInstanceConfig> {
    let cfg = instance.config.as_feishu()?;
    Some(FeishuInstanceConfig {
        id: instance.id.clone(),
        name: instance.name.clone(),
        enabled: instance.enabled,
        app_id: cfg.app_id.clone(),
        app_secret: cfg.app_secret.clone(),
        verification_token: cfg.verification_token.clone(),
        encrypt_key: cfg.encrypt_key.clone(),
        display_mode: cfg.display_mode.clone(),
        auto_connect: cfg.auto_connect,
        created_at: Some(instance.created_at.to_rfc3339()),
        last_active: instance.last_active.map(|dt| dt.to_rfc3339()),
        work_dir: cfg.work_dir.clone(),
    })
}
