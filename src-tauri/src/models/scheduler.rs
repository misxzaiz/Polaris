//! Scheduler Models (Simplified)
//!
//! Simplified data models for scheduled task management.

use serde::{Deserialize, Serialize};

// ============================================================================
// Core Types
// ============================================================================

/// 触发类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TriggerType {
    /// 单次执行
    Once,
    /// Cron 表达式
    Cron,
    /// 间隔执行（支持 s/m/h/d）
    #[default]
    Interval,
}

/// 任务状态
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Running,
    Success,
    Failed,
}

// ============================================================================
// Task Model
// ============================================================================

/// 定时任务（精简版）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    /// 任务 ID
    pub id: String,
    /// 任务名称
    pub name: String,
    /// 是否启用
    pub enabled: bool,
    /// 触发类型
    pub trigger_type: TriggerType,
    /// 触发值
    /// - once: ISO 时间戳字符串 (如 "2024-03-16T14:00:00Z")
    /// - cron: Cron 表达式 (如 "0 9 * * 1-5")
    /// - interval: 间隔表达式 (如 "30s", "5m", "2h", "1d")
    pub trigger_value: String,
    /// 使用的引擎 ID
    pub engine_id: String,
    /// 提示词
    pub prompt: String,
    /// 工作目录（可选）
    pub work_dir: Option<String>,
    /// 任务描述（可选）
    pub description: Option<String>,

    // 状态字段
    /// 上次执行时间
    pub last_run_at: Option<i64>,
    /// 上次执行状态
    pub last_run_status: Option<TaskStatus>,
    /// 下次执行时间
    pub next_run_at: Option<i64>,
    /// 创建时间
    pub created_at: i64,
    /// 更新时间
    pub updated_at: i64,

    // 工作区关联
    /// 所属工作区路径
    #[serde(default)]
    pub workspace_path: Option<String>,
    /// 所属工作区名称
    #[serde(default)]
    pub workspace_name: Option<String>,
}

/// 创建任务参数（精简版）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskParams {
    /// 任务名称
    pub name: String,
    /// 是否启用
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 触发类型
    pub trigger_type: TriggerType,
    /// 触发值
    pub trigger_value: String,
    /// 使用的引擎 ID
    pub engine_id: String,
    /// 提示词
    pub prompt: String,
    /// 工作目录（可选）
    pub work_dir: Option<String>,
    /// 任务描述（可选）
    pub description: Option<String>,
}

fn default_enabled() -> bool {
    true
}

/// 任务存储
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskStore {
    pub tasks: Vec<ScheduledTask>,
}

// ============================================================================
// Helper Methods
// ============================================================================

impl TriggerType {
    /// 解析触发值，计算下次执行时间
    pub fn calculate_next_run(&self, trigger_value: &str, now: i64) -> Option<i64> {
        match self {
            TriggerType::Once => {
                // 解析 ISO 时间戳
                chrono::DateTime::parse_from_rfc3339(trigger_value)
                    .ok()
                    .map(|dt| dt.timestamp())
                    .filter(|&ts| ts > now)
            }
            TriggerType::Cron => {
                // 解析 Cron 表达式
                use cron::Schedule;
                use std::str::FromStr;

                Schedule::from_str(trigger_value)
                    .ok()
                    .and_then(|schedule| {
                        schedule
                            .upcoming(chrono::Utc)
                            .next()
                            .map(|dt| dt.timestamp())
                    })
            }
            TriggerType::Interval => {
                // 解析间隔表达式 (30s, 5m, 2h, 1d)
                parse_interval(trigger_value)
                    .map(|interval_secs| now + interval_secs)
            }
        }
    }
}

/// 解析间隔表达式，返回秒数
/// 支持格式: 30s, 5m, 2h, 1d
pub fn parse_interval(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }

    let (num_str, unit) = value.split_at(value.len() - 1);
    let num: i64 = num_str.parse().ok()?;

    let multiplier = match unit.to_lowercase().as_str() {
        "s" => 1,           // 秒
        "m" => 60,          // 分钟
        "h" => 3600,        // 小时
        "d" => 86400,       // 天
        _ => return None,
    };

    Some(num * multiplier)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_interval() {
        assert_eq!(parse_interval("30s"), Some(30));
        assert_eq!(parse_interval("5m"), Some(300));
        assert_eq!(parse_interval("2h"), Some(7200));
        assert_eq!(parse_interval("1d"), Some(86400));
        assert_eq!(parse_interval("invalid"), None);
    }

    #[test]
    fn test_calculate_next_run_interval() {
        let now = 1000i64;
        let next = TriggerType::Interval.calculate_next_run("5m", now);
        assert_eq!(next, Some(1000 + 300));
    }
}
