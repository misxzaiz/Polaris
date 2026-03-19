/*! 实例注册表
 *
 * 管理多个平台实例配置，支持实例切换和数据隔离。
 */

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use crate::models::config::QQBotConfig;
use super::types::Platform;

/// 实例 ID
pub type InstanceId = String;

/// 平台实例配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInstance {
    /// 实例 ID
    pub id: InstanceId,
    /// 显示名称
    pub name: String,
    /// 平台类型
    pub platform: Platform,
    /// 实例配置
    pub config: InstanceConfig,
    /// 创建时间
    pub created_at: DateTime<Utc>,
    /// 最后活跃时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_active: Option<DateTime<Utc>>,
    /// 是否启用
    pub enabled: bool,
}

impl PlatformInstance {
    /// 创建新的 QQ Bot 实例
    pub fn new_qqbot(name: impl Into<String>, config: QQBotConfig) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            platform: Platform::QQBot,
            config: InstanceConfig::QQBot(config),
            created_at: Utc::now(),
            last_active: None,
            enabled: true,
        }
    }

    /// 更新最后活跃时间
    pub fn touch(&mut self) {
        self.last_active = Some(Utc::now());
    }
}

/// 实例配置枚举
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum InstanceConfig {
    QQBot(QQBotConfig),
    // DingTalk(DingTalkConfig), // 未来扩展
}

impl InstanceConfig {
    /// 获取 QQ Bot 配置
    pub fn as_qqbot(&self) -> Option<&QQBotConfig> {
        match self {
            InstanceConfig::QQBot(config) => Some(config),
        }
    }

    /// 获取可变的 QQ Bot 配置
    pub fn as_qqbot_mut(&mut self) -> Option<&mut QQBotConfig> {
        match self {
            InstanceConfig::QQBot(config) => Some(config),
        }
    }
}

/// 实例注册表
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRegistry {
    /// 所有实例
    instances: Vec<PlatformInstance>,
    /// 当前激活的实例（按平台）
    /// 注意：激活状态不持久化，因为 WebSocket 连接无法持久化
    #[serde(skip)]
    active_instances: HashMap<String, InstanceId>,
}

impl InstanceRegistry {
    /// 创建新的注册表
    pub fn new() -> Self {
        Self::default()
    }

    /// 添加实例
    pub fn add(&mut self, instance: PlatformInstance) -> InstanceId {
        let id = instance.id.clone();
        self.instances.push(instance);
        id
    }

    /// 移除实例
    pub fn remove(&mut self, instance_id: &str) -> Option<PlatformInstance> {
        if let Some(pos) = self.instances.iter().position(|i| i.id == instance_id) {
            // 如果移除的是激活的实例，清除激活状态
            let instance = self.instances.remove(pos);
            self.active_instances.retain(|_, id| id != &instance.id);
            return Some(instance);
        }
        None
    }

    /// 获取实例
    pub fn get(&self, instance_id: &str) -> Option<&PlatformInstance> {
        self.instances.iter().find(|i| i.id == instance_id)
    }

    /// 获取可变实例
    pub fn get_mut(&mut self, instance_id: &str) -> Option<&mut PlatformInstance> {
        self.instances.iter_mut().find(|i| i.id == instance_id)
    }

    /// 获取所有实例
    pub fn all(&self) -> &[PlatformInstance] {
        &self.instances
    }

    /// 按平台获取实例列表
    pub fn get_by_platform(&self, platform: Platform) -> Vec<&PlatformInstance> {
        self.instances
            .iter()
            .filter(|i| i.platform == platform)
            .collect()
    }

    /// 激活实例
    pub fn activate(&mut self, instance_id: &str) -> bool {
        if let Some(instance) = self.get(instance_id) {
            let platform_key = format!("{:?}", instance.platform);
            self.active_instances.insert(platform_key, instance_id.to_string());
            true
        } else {
            false
        }
    }

    /// 停用实例
    pub fn deactivate(&mut self, platform: Platform) {
        let platform_key = format!("{:?}", platform);
        self.active_instances.remove(&platform_key);
    }

    /// 获取激活的实例 ID
    pub fn get_active_id(&self, platform: Platform) -> Option<&InstanceId> {
        let platform_key = format!("{:?}", platform);
        self.active_instances.get(&platform_key)
    }

    /// 获取激活的实例
    pub fn get_active(&self, platform: Platform) -> Option<&PlatformInstance> {
        let platform_key = format!("{:?}", platform);
        self.active_instances
            .get(&platform_key)
            .and_then(|id| self.get(id))
    }

    /// 检查实例是否激活
    pub fn is_active(&self, instance_id: &str) -> bool {
        self.active_instances.values().any(|id| id == instance_id)
    }

    /// 检查平台是否有激活实例
    pub fn has_active(&self, platform: Platform) -> bool {
        let platform_key = format!("{:?}", platform);
        self.active_instances.contains_key(&platform_key)
    }

    /// 获取实例数量
    pub fn count(&self) -> usize {
        self.instances.len()
    }

    /// 清空所有实例
    pub fn clear(&mut self) {
        self.instances.clear();
        self.active_instances.clear();
    }

    /// 从 JSON 加载
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// 导出为 JSON
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_instance_registry() {
        let mut registry = InstanceRegistry::new();

        // 创建 QQ Bot 实例
        let config = QQBotConfig {
            enabled: true,
            app_id: "test_app_id".to_string(),
            client_secret: "test_secret".to_string(),
            sandbox: true,
            display_mode: Default::default(),
            auto_connect: false,
        };

        let id = registry.add(PlatformInstance::new_qqbot("测试机器人", config));

        // 获取实例
        let instance = registry.get(&id).unwrap();
        assert_eq!(instance.name, "测试机器人");

        // 激活实例
        assert!(registry.activate(&id));
        assert!(registry.is_active(&id));

        // 获取激活实例
        let active = registry.get_active(Platform::QQBot).unwrap();
        assert_eq!(active.id, id);

        // 停用
        registry.deactivate(Platform::QQBot);
        assert!(!registry.has_active(Platform::QQBot));
    }

    #[test]
    fn test_json_serialization() {
        let mut registry = InstanceRegistry::new();
        let config = QQBotConfig {
            enabled: true,
            app_id: "test_app_id".to_string(),
            client_secret: "test_secret".to_string(),
            sandbox: false,
            display_mode: Default::default(),
            auto_connect: false,
        };
        registry.add(PlatformInstance::new_qqbot("正式机器人", config));

        // 序列化
        let json = registry.to_json().unwrap();
        println!("JSON: {}", json);

        // 反序列化
        let loaded = InstanceRegistry::from_json(&json).unwrap();
        assert_eq!(loaded.count(), 1);
    }
}
