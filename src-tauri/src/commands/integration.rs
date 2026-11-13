/*! 集成域配置持久化（原 Tauri 命令层残留）
 *
 * L0 cap 化（plans/im-integration-extraction-spec.md）：16 个 `integration_*`
 * Tauri 命令已删除，统一走 `cap.integration`（services/router/integration_capability.rs）。
 * 本文件仅保留实例配置写回（sync_instances_to_config）与三个转换 helper——
 * cap 的实例写动作（add/remove/switch/update/disconnect）与旧命令层共用同一
 * 持久化语义，避免双写路径漂移。
 */

use crate::error::{Result, AppError};
use crate::integrations::types::Platform;
use crate::integrations::instance_registry::PlatformInstance;
use crate::models::config::{
    QQBotInstanceConfig, FeishuInstanceConfig, DingTalkInstanceConfig,
};

/// 将 InstanceRegistry 中的实例数据同步写回 ConfigStore（config.json）
///
/// 每次 add/update/remove/switch/disconnect 操作后调用，
/// 确保实例配置在应用重启后不丢失。
///
/// L0 cap 化：签名从 `&State<'_, AppState>` 放宽为 `&AppState`——cap.integration
/// 的实例写动作（add/remove/switch/update/disconnect）同样必须经此同步配置；
/// tauri 命令层 `&state` 自动 deref，双轨期两条路径共用同一实现。
pub(crate) async fn sync_instances_to_config(state: &crate::AppState) -> Result<()> {
    // Step 1: 从 InstanceRegistry 读取数据（async lock，用完立即释放）
    let (qqbot_instances, feishu_instances, dingtalk_instances, qqbot_active_id, feishu_active_id, dingtalk_active_id) = {
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

        let dingtalk_instances: Vec<DingTalkInstanceConfig> = instances
            .iter()
            .filter(|i| i.platform == Platform::DingTalk)
            .filter_map(platform_instance_to_dingtalk)
            .collect();

        let qqbot_active_id = manager
            .get_active_instance(Platform::QQBot)
            .await
            .map(|i| i.id);
        let feishu_active_id = manager
            .get_active_instance(Platform::Feishu)
            .await
            .map(|i| i.id);
        let dingtalk_active_id = manager
            .get_active_instance(Platform::DingTalk)
            .await
            .map(|i| i.id);

        (qqbot_instances, feishu_instances, dingtalk_instances, qqbot_active_id, feishu_active_id, dingtalk_active_id)
    };
    // manager async lock 已释放

    // Step 2: 更新 ConfigStore（sync lock）
    let mut config_store = state.config_store.lock()
        .map_err(|_| AppError::StateError("ConfigStore lock poisoned".to_string()))?;
    let qqbot_enabled = config_store.get().qqbot.enabled;
    let feishu_enabled = config_store.get().feishu.enabled;
    let dingtalk_enabled = config_store.get().dingtalk.enabled;

    config_store.patch(serde_json::json!({
        "qqbot": {
            "enabled": qqbot_enabled,
            "instances": qqbot_instances,
            "activeInstanceId": qqbot_active_id,
        },
        "feishu": {
            "enabled": feishu_enabled,
            "instances": feishu_instances,
            "activeInstanceId": feishu_active_id,
        },
        "dingtalk": {
            "enabled": dingtalk_enabled,
            "instances": dingtalk_instances,
            "activeInstanceId": dingtalk_active_id,
        },
    }))?;
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

/// 将 PlatformInstance 转换回 DingTalkInstanceConfig（配置格式）
fn platform_instance_to_dingtalk(instance: &PlatformInstance) -> Option<DingTalkInstanceConfig> {
    let cfg = instance.config.as_dingtalk()?;
    Some(DingTalkInstanceConfig {
        id: instance.id.clone(),
        name: instance.name.clone(),
        enabled: instance.enabled,
        app_key: cfg.app_id.clone(),
        app_secret: cfg.app_secret.clone(),
        webhook_url: cfg.webhook_url.clone(),
        display_mode: cfg.display_mode.clone(),
        auto_connect: cfg.auto_connect,
        created_at: Some(instance.created_at.to_rfc3339()),
        last_active: instance.last_active.map(|dt| dt.to_rfc3339()),
        work_dir: cfg.work_dir.clone(),
    })
}
