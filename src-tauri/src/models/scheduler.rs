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
    /// 分组名称（可选）
    pub group: Option<String>,
    /// 任务描述/备注（可选，用于记录任务用途、注意事项等）
    pub description: Option<String>,
    /// 任务目标（protocol 模式使用）
    pub mission: Option<String>,
    /// 最大执行轮次（可选，None 表示不限）
    pub max_runs: Option<u32>,
    /// 是否复用上次会话
    #[serde(default)]
    pub reuse_session: bool,
    /// 是否成功后立即继续执行
    #[serde(default)]
    pub continue_immediately: bool,
    /// 最大连续执行次数（可选，None 表示不限）
    pub max_continuous_runs: Option<u32>,
    /// 是否在终端中执行（便于用户查看过程）
    #[serde(default)]
    pub run_in_terminal: bool,
    /// 使用的协议模板ID（protocol 模式使用，用于编辑时回显）
    pub template_id: Option<String>,
    /// 模板参数值（protocol 模式使用，用于编辑时回显）
    pub template_param_values: Option<HashMap<String, String>>,
    /// 最大重试次数（None 表示不重试，默认 None）
    pub max_retries: Option<u32>,
    /// 重试间隔（如 "30s", "5m", "1h"）
    pub retry_interval: Option<String>,
    /// 任务完成后是否发送桌面通知
    #[serde(default = "default_notify_on_complete")]
    pub notify_on_complete: bool,
    /// 执行超时时间（分钟，None 或 0 表示不限）
    pub timeout_minutes: Option<u32>,
    /// 用户补充内容（一次性提示词，每次执行时可以修改）
    pub user_supplement: Option<String>,
    /// 任务文档模板（task.md 内容，用于自定义协议文档）
    pub task_template: Option<String>,
    /// 记忆系统模板（memory/index.md 内容）
    pub memory_template: Option<String>,
    /// 任务队列模板（memory/tasks.md 内容）
    pub tasks_template: Option<String>,
    /// 执行轮次模板（memory/runs.md 内容）
    pub runs_template: Option<String>,
    /// 用户补充模板（user-supplement.md 内容）
    pub supplement_template: Option<String>,
}

fn default_notify_on_complete() -> bool {
    true
}

fn default_enabled() -> bool {
    false
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
    /// 分组名称（可选）
    #[serde(default)]
    pub group: Option<String>,
    /// 任务描述/备注（可选，用于记录任务用途、注意事项等）
    #[serde(default)]
    pub description: Option<String>,
    /// 任务路径 (protocol 模式使用，相对于 workDir)
    pub task_path: Option<String>,
    /// 任务目标 (protocol 模式使用，保存协议文档中的任务目标)
    #[serde(default)]
    pub mission: Option<String>,
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
    /// 是否复用上次会话
    #[serde(default)]
    pub reuse_session: bool,
    /// 已保存的对话会话 ID
    #[serde(default)]
    pub conversation_session_id: Option<String>,
    /// 是否成功后立即继续执行
    #[serde(default)]
    pub continue_immediately: bool,
    /// 最大连续执行次数（可选，None 表示不限）
    #[serde(default)]
    pub max_continuous_runs: Option<u32>,
    /// 是否在终端中执行（便于用户查看过程）
    #[serde(default)]
    pub run_in_terminal: bool,
    /// 使用的协议模板ID（protocol 模式使用，用于编辑时回显）
    #[serde(default)]
    pub template_id: Option<String>,
    /// 模板参数值（protocol 模式使用，用于编辑时回显）
    #[serde(default)]
    pub template_param_values: Option<HashMap<String, String>>,
    /// 订阅的上下文 ID（持久化订阅状态，定时执行时会发送事件到该上下文）
    #[serde(default)]
    pub subscribed_context_id: Option<String>,
    /// 最大重试次数（None 表示不重试，默认 None）
    #[serde(default)]
    pub max_retries: Option<u32>,
    /// 当前已重试次数
    #[serde(default)]
    pub retry_count: u32,
    /// 重试间隔（如 "30s", "5m", "1h"）
    #[serde(default)]
    pub retry_interval: Option<String>,
    /// 任务完成后是否发送桌面通知
    #[serde(default = "default_notify_on_complete")]
    pub notify_on_complete: bool,
    /// 执行超时时间（分钟，None 或 0 表示不限）
    #[serde(default)]
    pub timeout_minutes: Option<u32>,
    /// 用户补充内容（一次性提示词，每次执行时可以修改）
    #[serde(default)]
    pub user_supplement: Option<String>,
    /// 任务文档模板（task.md 内容）
    #[serde(default)]
    pub task_template: Option<String>,
    /// 记忆系统模板（memory/index.md 内容）
    #[serde(default)]
    pub memory_template: Option<String>,
    /// 任务队列模板（memory/tasks.md 内容）
    #[serde(default)]
    pub tasks_template: Option<String>,
    /// 执行轮次模板（memory/runs.md 内容）
    #[serde(default)]
    pub runs_template: Option<String>,
    /// 用户补充模板（user-supplement.md 内容）
    #[serde(default)]
    pub supplement_template: Option<String>,
    /// 任务是否被阻塞
    #[serde(default)]
    pub blocked: bool,
    /// 阻塞原因
    #[serde(default)]
    pub blocked_reason: Option<String>,
    /// 当前阶段（分析/设计/开发/测试/修复/验收）
    #[serde(default)]
    pub current_phase: Option<String>,
    /// 最近一次有效进展的时间戳
    #[serde(default)]
    pub last_effective_progress_at: Option<i64>,
    /// 协议版本号
    #[serde(default)]
    pub protocol_version: Option<u32>,
    /// 会话最近使用时间
    #[serde(default)]
    pub session_last_used_at: Option<i64>,
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
            group: params.group,
            description: params.description,
            task_path: None, // 将在创建任务目录后设置
            mission: params.mission,
            last_run_at: None,
            last_run_status: None,
            next_run_at: None,
            created_at: 0,
            updated_at: 0,
            max_runs: params.max_runs,
            current_runs: 0,
            reuse_session: params.reuse_session,
            conversation_session_id: None,
            continue_immediately: params.continue_immediately,
            max_continuous_runs: params.max_continuous_runs,
            run_in_terminal: params.run_in_terminal,
            template_id: params.template_id,
            template_param_values: params.template_param_values,
            subscribed_context_id: None,
            max_retries: params.max_retries,
            retry_count: 0,
            retry_interval: params.retry_interval,
            notify_on_complete: params.notify_on_complete,
            timeout_minutes: params.timeout_minutes,
            user_supplement: params.user_supplement,
            task_template: params.task_template,
            memory_template: params.memory_template,
            tasks_template: params.tasks_template,
            runs_template: params.runs_template,
            supplement_template: params.supplement_template,
            blocked: false,
            blocked_reason: None,
            current_phase: None,
            last_effective_progress_at: None,
            protocol_version: None,
            session_last_used_at: None,
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

/// 日志保留配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRetentionConfig {
    /// 保留天数（0 表示不限）
    #[serde(default = "default_retention_days")]
    pub retention_days: u32,
    /// 每任务最大日志数（0 表示不限）
    #[serde(default = "default_max_logs_per_task")]
    pub max_logs_per_task: u32,
    /// 是否启用自动清理
    #[serde(default = "default_auto_cleanup_enabled")]
    pub auto_cleanup_enabled: bool,
    /// 自动清理间隔（小时）
    #[serde(default = "default_auto_cleanup_interval_hours")]
    pub auto_cleanup_interval_hours: u32,
}

fn default_retention_days() -> u32 {
    30
}

fn default_max_logs_per_task() -> u32 {
    100
}

fn default_auto_cleanup_enabled() -> bool {
    true
}

fn default_auto_cleanup_interval_hours() -> u32 {
    24
}

impl Default for LogRetentionConfig {
    fn default() -> Self {
        Self {
            retention_days: default_retention_days(),
            max_logs_per_task: default_max_logs_per_task(),
            auto_cleanup_enabled: default_auto_cleanup_enabled(),
            auto_cleanup_interval_hours: default_auto_cleanup_interval_hours(),
        }
    }
}

/// 日志存储
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LogStore {
    /// 按任务 ID 分组的日志
    pub logs: HashMap<String, Vec<TaskLog>>,
    /// 所有日志（按时间倒序）
    pub all_logs: Vec<TaskLog>,
    /// 保留配置
    #[serde(default)]
    pub retention_config: LogRetentionConfig,
    /// 上次自动清理时间
    #[serde(default)]
    pub last_cleanup_at: Option<i64>,
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
