//! Auto-Mode 数据模型
//!
//! 用于 Claude CLI 自动模式配置的数据结构

use serde::{Deserialize, Serialize};

/// 自动模式配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoModeConfig {
    /// 允许规则列表
    pub allow: Vec<String>,
    /// 拒绝规则列表（软拒绝，需确认）
    pub soft_deny: Vec<String>,
    /// 环境配置
    pub environment: Vec<String>,
}

/// 自动模式默认配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoModeDefaults {
    /// 默认允许规则
    pub allow: Vec<String>,
    /// 默认拒绝规则
    pub soft_deny: Vec<String>,
    /// 默认环境配置
    pub environment: Vec<String>,
}
