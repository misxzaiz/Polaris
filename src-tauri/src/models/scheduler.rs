use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 创建任务参数
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
    /// 任务模式
    #[serde(default)]
    pub mode: TaskMode,
    /// 任务目标（protocol 模式使用）
    pub mission: Option<String>,
    /// 最大执行轮次（可选，None 表示不限）
    pub max_runs: Option<u32>,
    /// 是否在终端中执行（便于用户查看过程）
    #[serde(default)]
    pub run_in_terminal: bool,
    /// 使用的协议模板ID（protocol 模式使用，用于编辑时回显）
    pub template_id: Option<String>,
    /// 模板参数值（protocol 模式使用，用于编辑时回显）
    pub template_param_values: Option<HashMap<String, String>>,
}

fn default_enabled() -> bool {
    true
}

/// 任务模式
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TaskMode {
    /// 简单模式：直接使用 prompt
    #[default]
    Simple,
    /// 协议模式：读取 task.md + memory + supplement
    Protocol,
}

/// 定时任务
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
    /// 提示词 (simple 模式使用)
    pub prompt: String,
    /// 工作目录（可选）
    pub work_dir: Option<String>,
    /// 任务模式
    #[serde(default)]
    pub mode: TaskMode,
    /// 任务路径 (protocol 模式使用，相对于 workDir)
    pub task_path: Option<String>,
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
    /// 最大执行轮次（可选，None 表示不限）
    #[serde(default)]
    pub max_runs: Option<u32>,
    /// 当前已执行轮次
    #[serde(default)]
    pub current_runs: u32,
    /// 是否在终端中执行（便于用户查看过程）
    #[serde(default)]
    pub run_in_terminal: bool,
    /// 使用的协议模板ID（protocol 模式使用，用于编辑时回显）
    #[serde(default)]
    pub template_id: Option<String>,
    /// 模板参数值（protocol 模式使用，用于编辑时回显）
    #[serde(default)]
    pub template_param_values: Option<HashMap<String, String>>,
}

impl From<CreateTaskParams> for ScheduledTask {
    fn from(params: CreateTaskParams) -> Self {
        Self {
            id: String::new(),
            name: params.name,
            enabled: params.enabled,
            trigger_type: params.trigger_type,
            trigger_value: params.trigger_value,
            engine_id: params.engine_id,
            prompt: params.prompt,
            work_dir: params.work_dir,
            mode: params.mode,
            task_path: None, // 将在创建任务目录后设置
            last_run_at: None,
            last_run_status: None,
            next_run_at: None,
            created_at: 0,
            updated_at: 0,
            max_runs: params.max_runs,
            current_runs: 0,
            run_in_terminal: params.run_in_terminal,
            template_id: params.template_id,
            template_param_values: params.template_param_values,
        }
    }
}

/// 触发类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TriggerType {
    /// 单次执行
    Once,
    /// Cron 表达式
    Cron,
    /// 间隔执行（支持 s/m/h/d）
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

/// 执行日志
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLog {
    /// 日志 ID
    pub id: String,
    /// 任务 ID
    pub task_id: String,
    /// 任务名称
    pub task_name: String,
    /// 使用的引擎 ID
    pub engine_id: String,
    /// AI 会话 ID（可用于跳转查看详情）
    pub session_id: Option<String>,
    /// 开始时间
    pub started_at: i64,
    /// 结束时间
    pub finished_at: Option<i64>,
    /// 执行耗时（毫秒）
    pub duration_ms: Option<i64>,
    /// 状态
    pub status: TaskStatus,
    /// 执行时的提示词
    pub prompt: String,
    /// AI 返回内容（截取前 2000 字符）
    pub output: Option<String>,
    /// 错误信息
    pub error: Option<String>,
    /// 思考过程摘要
    pub thinking_summary: Option<String>,
    /// 工具调用次数
    pub tool_call_count: u32,
    /// Token 消耗
    pub token_count: Option<u32>,
}

/// 执行任务结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskResult {
    /// 日志 ID
    pub log_id: String,
    /// 提示信息
    pub message: String,
}

/// 分页日志结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedLogs {
    /// 日志列表
    pub logs: Vec<TaskLog>,
    /// 总数
    pub total: usize,
    /// 当前页（1-indexed）
    pub page: u32,
    /// 每页大小
    pub page_size: u32,
    /// 总页数
    pub total_pages: usize,
}

/// 任务存储
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskStore {
    pub tasks: Vec<ScheduledTask>,
}

/// 日志存储
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LogStore {
    /// 按任务 ID 分组的日志
    pub logs: HashMap<String, Vec<TaskLog>>,
    /// 所有日志（按时间倒序）
    pub all_logs: Vec<TaskLog>,
}

// ============================================================================
// 辅助函数
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
}
