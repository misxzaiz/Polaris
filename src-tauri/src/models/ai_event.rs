/*! 统一 AI 事件类型
 *
 * 与前端 AIEvent 完全对齐，后端直接发送标准事件给前端。
 * 所有 CLI Engine 的原始输出都在后端转换为 AIEvent。
 */

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================================
// Tool Call 信息
// ============================================================================

/// 工具调用状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ToolCallStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

/// 工具调用信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallInfo {
    /// 工具唯一 ID
    pub id: String,
    /// 工具名称
    pub name: String,
    /// 工具参数
    pub args: HashMap<String, serde_json::Value>,
    /// 执行状态
    pub status: ToolCallStatus,
    /// 执行结果
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

// ============================================================================
// Task 状态
// ============================================================================

/// Task 状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    Running,
    Success,
    Error,
    Canceled,
}

// ============================================================================
// AI Event 类型
// ============================================================================

/// Token 事件 - 文本增量输出
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 文本内容
    pub value: String,
}

impl TokenEvent {
    pub fn new(session_id: impl Into<String>, value: String) -> Self {
        Self {
            event_type: "token".to_string(),
            session_id: session_id.into(),
            value,
        }
    }
}

/// 思考过程事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 思考内容
    pub content: String,
}

impl ThinkingEvent {
    pub fn new(session_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            event_type: "thinking".to_string(),
            session_id: session_id.into(),
            content: content.into(),
        }
    }
}

/// 工具调用开始事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallStartEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 工具调用 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    /// 工具名称
    pub tool: String,
    /// 工具参数
    pub args: HashMap<String, serde_json::Value>,
}

impl ToolCallStartEvent {
    pub fn new(session_id: impl Into<String>, tool: String, args: HashMap<String, serde_json::Value>) -> Self {
        Self {
            event_type: "tool_call_start".to_string(),
            session_id: session_id.into(),
            call_id: None,
            tool,
            args,
        }
    }

    pub fn with_call_id(mut self, call_id: String) -> Self {
        self.call_id = Some(call_id);
        self
    }
}

/// 工具调用结束事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallEndEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 工具调用 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    /// 工具名称
    pub tool: String,
    /// 工具执行结果
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// 是否成功
    pub success: bool,
}

impl ToolCallEndEvent {
    pub fn new(session_id: impl Into<String>, tool: String, success: bool) -> Self {
        Self {
            event_type: "tool_call_end".to_string(),
            session_id: session_id.into(),
            call_id: None,
            tool,
            result: None,
            success,
        }
    }

    pub fn with_result(mut self, result: serde_json::Value) -> Self {
        self.result = Some(result);
        self
    }

    pub fn with_call_id(mut self, call_id: String) -> Self {
        self.call_id = Some(call_id);
        self
    }
}

/// 进度事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 进度消息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// 进度百分比 0-100
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u32>,
}

impl ProgressEvent {
    pub fn new(session_id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            event_type: "progress".to_string(),
            session_id: session_id.into(),
            message: Some(message.into()),
            percent: None,
        }
    }

    pub fn with_percent(mut self, percent: u32) -> Self {
        self.percent = Some(percent);
        self
    }
}

/// 结果事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 任务输出结果
    pub output: serde_json::Value,
}

impl ResultEvent {
    pub fn new(session_id: impl Into<String>, output: serde_json::Value) -> Self {
        Self {
            event_type: "result".to_string(),
            session_id: session_id.into(),
            output,
        }
    }
}

/// 错误事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 错误信息
    pub error: String,
    /// 错误码（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl ErrorEvent {
    pub fn new(session_id: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            event_type: "error".to_string(),
            session_id: session_id.into(),
            error: error.into(),
            code: None,
        }
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }
}

/// 会话开始事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
}

impl SessionStartEvent {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            event_type: "session_start".to_string(),
            session_id: session_id.into(),
        }
    }
}

/// 会话结束原因
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SessionEndReason {
    Completed,
    Aborted,
    Error,
}

/// 会话结束事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEndEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
    /// 结束原因
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<SessionEndReason>,
}

impl SessionEndEvent {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            event_type: "session_end".to_string(),
            session_id: session_id.into(),
            reason: None,
        }
    }

    pub fn with_reason(mut self, reason: SessionEndReason) -> Self {
        self.reason = Some(reason);
        self
    }
}

/// 用户消息事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessageEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 用户消息内容
    pub content: String,
    /// 关联的文件
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
}

impl UserMessageEvent {
    pub fn new(session_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            event_type: "user_message".to_string(),
            session_id: session_id.into(),
            content: content.into(),
            files: None,
        }
    }

    pub fn with_files(mut self, files: Vec<String>) -> Self {
        self.files = Some(files);
        self
    }
}

/// AI 消息事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessageEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 消息内容（可能是部分内容）
    pub content: String,
    /// 是否为增量更新
    pub is_delta: bool,
    /// 消息中包含的工具调用
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallInfo>>,
}

impl AssistantMessageEvent {
    pub fn new(session_id: impl Into<String>, content: impl Into<String>, is_delta: bool) -> Self {
        Self {
            event_type: "assistant_message".to_string(),
            session_id: session_id.into(),
            content: content.into(),
            is_delta,
            tool_calls: None,
        }
    }

    pub fn with_tool_calls(mut self, tool_calls: Vec<ToolCallInfo>) -> Self {
        self.tool_calls = Some(tool_calls);
        self
    }
}

/// Task 元数据事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMetadataEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 任务 ID
    pub task_id: String,
    /// 任务状态
    pub status: TaskStatus,
    /// 任务开始时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_time: Option<u64>,
    /// 任务结束时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<u64>,
    /// 执行时长（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
    /// 错误信息（失败时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TaskMetadataEvent {
    pub fn new(session_id: impl Into<String>, task_id: impl Into<String>, status: TaskStatus) -> Self {
        Self {
            event_type: "task_metadata".to_string(),
            session_id: session_id.into(),
            task_id: task_id.into(),
            status,
            start_time: None,
            end_time: None,
            duration: None,
            error: None,
        }
    }
}

/// Task 进度事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgressEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 任务 ID
    pub task_id: String,
    /// 进度消息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// 进度百分比 0-100
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u32>,
}

impl TaskProgressEvent {
    pub fn new(session_id: impl Into<String>, task_id: impl Into<String>) -> Self {
        Self {
            event_type: "task_progress".to_string(),
            session_id: session_id.into(),
            task_id: task_id.into(),
            message: None,
            percent: None,
        }
    }

    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }

    pub fn with_percent(mut self, percent: u32) -> Self {
        self.percent = Some(percent);
        self
    }
}

/// Task 完成事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletedEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 任务 ID
    pub task_id: String,
    /// 最终状态
    pub status: TaskStatus,
    /// 执行时长（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
    /// 错误信息（失败时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TaskCompletedEvent {
    pub fn new(session_id: impl Into<String>, task_id: impl Into<String>, status: TaskStatus) -> Self {
        Self {
            event_type: "task_completed".to_string(),
            session_id: session_id.into(),
            task_id: task_id.into(),
            status,
            duration: None,
            error: None,
        }
    }
}

// ============================================================================
// PlanMode 相关类型和事件
// ============================================================================

/// PlanMode 状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    /// 正在起草计划
    Drafting,
    /// 等待审批
    PendingApproval,
    /// 已批准
    Approved,
    /// 已拒绝
    Rejected,
    /// 正在执行
    Executing,
    /// 已完成
    Completed,
    /// 已取消
    Canceled,
}

/// 计划任务状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PlanTaskStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Skipped,
}

/// 计划阶段状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PlanStageStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

/// 计划任务
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTask {
    /// 任务 ID
    pub task_id: String,
    /// 任务描述
    pub description: String,
    /// 任务状态
    pub status: PlanTaskStatus,
}

/// 计划阶段
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStage {
    /// 阶段 ID
    pub stage_id: String,
    /// 阶段名称
    pub name: String,
    /// 阶段描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 阶段状态
    pub status: PlanStageStatus,
    /// 阶段内的任务列表
    pub tasks: Vec<PlanTask>,
}

/// Plan 开始事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStartEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
    /// 计划 ID
    pub plan_id: String,
}

impl PlanStartEvent {
    pub fn new(session_id: impl Into<String>, plan_id: impl Into<String>) -> Self {
        Self {
            event_type: "plan_start".to_string(),
            session_id: session_id.into(),
            plan_id: plan_id.into(),
        }
    }
}

/// Plan 内容事件 - 发送完整的计划内容
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanContentEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
    /// 计划 ID
    pub plan_id: String,
    /// 计划标题
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 计划描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 阶段列表
    pub stages: Vec<PlanStage>,
    /// 当前计划状态
    pub status: PlanStatus,
}

impl PlanContentEvent {
    pub fn new(
        session_id: impl Into<String>,
        plan_id: impl Into<String>,
        stages: Vec<PlanStage>,
        status: PlanStatus,
    ) -> Self {
        Self {
            event_type: "plan_content".to_string(),
            session_id: session_id.into(),
            plan_id: plan_id.into(),
            title: None,
            description: None,
            stages,
            status,
        }
    }

    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }
}

/// Plan 阶段更新事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStageUpdateEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
    /// 计划 ID
    pub plan_id: String,
    /// 阶段 ID
    pub stage_id: String,
    /// 阶段状态
    pub status: PlanStageStatus,
    /// 更新的任务列表（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tasks: Option<Vec<PlanTask>>,
}

impl PlanStageUpdateEvent {
    pub fn new(
        session_id: impl Into<String>,
        plan_id: impl Into<String>,
        stage_id: impl Into<String>,
        status: PlanStageStatus,
    ) -> Self {
        Self {
            event_type: "plan_stage_update".to_string(),
            session_id: session_id.into(),
            plan_id: plan_id.into(),
            stage_id: stage_id.into(),
            status,
            tasks: None,
        }
    }

    pub fn with_tasks(mut self, tasks: Vec<PlanTask>) -> Self {
        self.tasks = Some(tasks);
        self
    }
}

/// Plan 审批请求事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanApprovalRequestEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
    /// 计划 ID
    pub plan_id: String,
    /// 请求消息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl PlanApprovalRequestEvent {
    pub fn new(session_id: impl Into<String>, plan_id: impl Into<String>) -> Self {
        Self {
            event_type: "plan_approval_request".to_string(),
            session_id: session_id.into(),
            plan_id: plan_id.into(),
            message: None,
        }
    }

    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }
}

/// Plan 审批结果事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanApprovalResultEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
    /// 计划 ID
    pub plan_id: String,
    /// 审批结果
    pub approved: bool,
    /// 修改建议（拒绝时可能有）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
}

impl PlanApprovalResultEvent {
    pub fn new(
        session_id: impl Into<String>,
        plan_id: impl Into<String>,
        approved: bool,
    ) -> Self {
        Self {
            event_type: "plan_approval_result".to_string(),
            session_id: session_id.into(),
            plan_id: plan_id.into(),
            approved,
            feedback: None,
        }
    }

    pub fn with_feedback(mut self, feedback: impl Into<String>) -> Self {
        self.feedback = Some(feedback.into());
        self
    }
}

/// Plan 结束事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEndEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
    /// 计划 ID
    pub plan_id: String,
    /// 结束状态
    pub status: PlanStatus,
    /// 结束原因
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl PlanEndEvent {
    pub fn new(
        session_id: impl Into<String>,
        plan_id: impl Into<String>,
        status: PlanStatus,
    ) -> Self {
        Self {
            event_type: "plan_end".to_string(),
            session_id: session_id.into(),
            plan_id: plan_id.into(),
            status,
            reason: None,
        }
    }

    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }
}

// ============================================================================
// PermissionRequest 相关类型和事件
// ============================================================================

/// 权限拒绝详情
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDenial {
    /// 工具名称
    pub tool_name: String,
    /// 拒绝原因
    pub reason: String,
    /// 额外信息
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

impl PermissionDenial {
    pub fn new(tool_name: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            tool_name: tool_name.into(),
            reason: reason.into(),
            extra: HashMap::new(),
        }
    }

    pub fn with_extra(mut self, extra: HashMap<String, serde_json::Value>) -> Self {
        self.extra = extra;
        self
    }
}

/// 权限请求事件 - 工具调用被拒绝，需要用户确认
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
    /// 拒绝详情列表
    pub denials: Vec<PermissionDenial>,
}

impl PermissionRequestEvent {
    pub fn new(session_id: impl Into<String>, denials: Vec<PermissionDenial>) -> Self {
        Self {
            event_type: "permission_request".to_string(),
            session_id: session_id.into(),
            denials,
        }
    }
}

// ============================================================================
// AgentRun 相关类型和事件
// ============================================================================

/// AgentRun 开始事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunStartEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
    /// 任务 ID
    pub task_id: String,
    /// Agent 类型
    pub agent_type: String,
    /// Agent 能力列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
}

impl AgentRunStartEvent {
    pub fn new(session_id: impl Into<String>, task_id: impl Into<String>, agent_type: impl Into<String>) -> Self {
        Self {
            event_type: "agent_run_start".to_string(),
            session_id: session_id.into(),
            task_id: task_id.into(),
            agent_type: agent_type.into(),
            capabilities: None,
        }
    }

    pub fn with_capabilities(mut self, capabilities: Vec<String>) -> Self {
        self.capabilities = Some(capabilities);
        self
    }
}

/// AgentRun 结束事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunEndEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
    /// 任务 ID
    pub task_id: String,
    /// 是否成功
    pub success: bool,
    /// 结果摘要
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

impl AgentRunEndEvent {
    pub fn new(session_id: impl Into<String>, task_id: impl Into<String>, success: bool) -> Self {
        Self {
            event_type: "agent_run_end".to_string(),
            session_id: session_id.into(),
            task_id: task_id.into(),
            success,
            result: None,
        }
    }

    pub fn with_result(mut self, result: impl Into<String>) -> Self {
        self.result = Some(result.into());
        self
    }
}

// ============================================================================
// Question 相关类型和事件
// ============================================================================

/// Question 选项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOptionData {
    /// 选项值
    pub value: String,
    /// 选项标签
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// 选项描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 选项预览
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

impl QuestionOptionData {
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            label: None,
            description: None,
            preview: None,
        }
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn with_preview(mut self, preview: impl Into<String>) -> Self {
        self.preview = Some(preview.into());
        self
    }
}

/// 单条问题（与 state::QuestionItem 对齐，但属于事件层）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItemData {
    /// 问题正文（卡片主标题）
    pub question: String,
    /// 短标签（≤12 字，类别 chip）
    pub header: String,
    /// 选项列表
    pub options: Vec<QuestionOptionData>,
    /// 是否多选
    #[serde(default)]
    pub multi_select: bool,
    /// 是否允许自定义输入
    #[serde(default = "default_true_bool")]
    pub allow_custom_input: bool,
    /// 类别标签（多为 header 同步值）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_label: Option<String>,
}

fn default_true_bool() -> bool {
    true
}

/// Question 事件 - AI 询问用户问题
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
    /// 问题 ID（= callId）
    pub question_id: String,
    /// 同一 call 内的全部问题（1-4）
    #[serde(default)]
    pub questions: Vec<QuestionItemData>,
    // ===== 兼容字段：填充首题摘要，供旧消费方使用 =====
    /// 首题正文/标题
    pub header: String,
    /// 首题选项列表
    pub options: Vec<QuestionOptionData>,
    /// 首题是否多选
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
    /// 首题是否允许自定义输入
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_custom_input: Option<bool>,
    /// 首题分类标签
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_label: Option<String>,
}

impl QuestionEvent {
    pub fn new(session_id: impl Into<String>, question_id: impl Into<String>, header: impl Into<String>, options: Vec<QuestionOptionData>) -> Self {
        Self {
            event_type: "question".to_string(),
            session_id: session_id.into(),
            question_id: question_id.into(),
            questions: Vec::new(),
            header: header.into(),
            options,
            multi_select: None,
            allow_custom_input: None,
            category_label: None,
        }
    }

    pub fn with_questions(mut self, questions: Vec<QuestionItemData>) -> Self {
        self.questions = questions;
        self
    }

    pub fn with_multi_select(mut self, multi_select: bool) -> Self {
        self.multi_select = Some(multi_select);
        self
    }

    pub fn with_allow_custom_input(mut self, allow_custom_input: bool) -> Self {
        self.allow_custom_input = Some(allow_custom_input);
        self
    }

    pub fn with_category_label(mut self, category_label: impl Into<String>) -> Self {
        self.category_label = Some(category_label.into());
        self
    }
}

/// 单条已回答内容
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAnswerData {
    /// 该题选中的选项
    #[serde(default)]
    pub selected: Vec<String>,
    /// 该题自定义输入
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_input: Option<String>,
    /// 该题是否被单独跳过
    #[serde(default)]
    pub declined: bool,
}

/// QuestionAnswered 事件 - 用户回答问题
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnsweredEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
    /// 问题 ID（= callId）
    pub question_id: String,
    /// 每题答案数组
    #[serde(default)]
    pub answers: Vec<SubAnswerData>,
    /// 是否整体跳过
    #[serde(default)]
    pub declined: bool,
}

impl QuestionAnsweredEvent {
    pub fn new(session_id: impl Into<String>, question_id: impl Into<String>, answers: Vec<SubAnswerData>) -> Self {
        Self {
            event_type: "question_answered".to_string(),
            session_id: session_id.into(),
            question_id: question_id.into(),
            answers,
            declined: false,
        }
    }

    pub fn declined(session_id: impl Into<String>, question_id: impl Into<String>) -> Self {
        Self {
            event_type: "question_answered".to_string(),
            session_id: session_id.into(),
            question_id: question_id.into(),
            answers: Vec::new(),
            declined: true,
        }
    }
}

/// CLI Init 事件 - 包含会话初始化的动态数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInitEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID
    pub session_id: String,
    /// 可用工具列表
    #[serde(default)]
    pub tools: Vec<String>,
    /// MCP 服务器状态
    #[serde(default)]
    pub mcp_servers: Vec<McpServerStatus>,
    /// 可用 Agent 列表
    #[serde(default)]
    pub agents: Vec<String>,
    /// 可用技能列表
    #[serde(default)]
    pub skills: Vec<String>,
    /// 当前模型
    #[serde(default)]
    pub model: Option<String>,
    /// CLI 版本
    #[serde(default)]
    pub claude_code_version: Option<String>,
    /// 可用斜杠命令列表（内置命令 + skill + 自定义命令，来自 init 事件 slash_commands 字段）
    #[serde(default)]
    pub slash_commands: Vec<String>,
}

/// MCP 服务器状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    /// 服务器名称
    pub name: String,
    /// 连接状态
    pub status: String,
}

impl CliInitEvent {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            event_type: "cli_init".to_string(),
            session_id: session_id.into(),
            tools: Vec::new(),
            mcp_servers: Vec::new(),
            agents: Vec::new(),
            skills: Vec::new(),
            model: None,
            claude_code_version: None,
            slash_commands: Vec::new(),
        }
    }

    pub fn with_tools(mut self, tools: Vec<String>) -> Self {
        self.tools = tools;
        self
    }

    pub fn with_mcp_servers(mut self, mcp_servers: Vec<McpServerStatus>) -> Self {
        self.mcp_servers = mcp_servers;
        self
    }

    pub fn with_agents(mut self, agents: Vec<String>) -> Self {
        self.agents = agents;
        self
    }

    pub fn with_skills(mut self, skills: Vec<String>) -> Self {
        self.skills = skills;
        self
    }

    pub fn with_model(mut self, model: String) -> Self {
        self.model = Some(model);
        self
    }

    pub fn with_version(mut self, version: String) -> Self {
        self.claude_code_version = Some(version);
        self
    }

    pub fn with_slash_commands(mut self, slash_commands: Vec<String>) -> Self {
        self.slash_commands = slash_commands;
        self
    }
}

// ============================================================================
// 上下文压缩事件
// ============================================================================

/// 上下文压缩完成事件
///
/// 来自 Claude CLI stream-json 的 `system/compact_boundary`，
/// 手动 `/compact` 与 CLI autoCompact 自动压缩均会触发。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCompactedEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 触发方式："manual"（/compact）| "auto"（自动压缩）
    pub trigger: String,
    /// 压缩前 token 数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_tokens: Option<u64>,
    /// 压缩后 token 数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_tokens: Option<u64>,
}

impl ContextCompactedEvent {
    pub fn new(
        session_id: impl Into<String>,
        trigger: impl Into<String>,
        pre_tokens: Option<u64>,
        post_tokens: Option<u64>,
    ) -> Self {
        Self {
            event_type: "context_compacted".to_string(),
            session_id: session_id.into(),
            trigger: trigger.into(),
            pre_tokens,
            post_tokens,
        }
    }
}

// ============================================================================
// 用量事件
// ============================================================================

/// 单个模型的用量明细
///
/// 对应 Claude CLI result 事件里 `modelUsage[model]` 对象，是**本轮所有 API 调用
/// 对该模型的累计值**（区别于 `result.usage` 顶层字段，后者只是最后一次调用）。
/// 前端可据此按模型维度展示用量，也是核对水位条与 `/context` 口径的基准。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageBreakdown {
    /// 未命中缓存的输入 token（全价）
    pub input_tokens: u64,
    /// 输出 token
    pub output_tokens: u64,
    /// 从缓存读取的 token（~0.1×）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,
    /// 写入缓存的 token（~1.25×）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u64>,
    /// 推理输出 token
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_output_tokens: Option<u64>,
    /// 该模型的上下文窗口
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// 该模型单次最大输出 token
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    /// 该模型本轮花费（美元）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    /// web 搜索请求次数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_search_requests: Option<u64>,
}

impl ModelUsageBreakdown {
    pub fn new(input_tokens: u64, output_tokens: u64) -> Self {
        Self {
            input_tokens,
            output_tokens,
            cache_read_input_tokens: None,
            cache_creation_input_tokens: None,
            reasoning_output_tokens: None,
            context_window: None,
            max_output_tokens: None,
            cost_usd: None,
            web_search_requests: None,
        }
    }
}

/// Token 用量事件
///
/// 每轮对话结束时携带本轮的 token 分类用量，供前端计算上下文水位与成本。
/// 上下文占用 = input + cacheCreation + cacheRead（三项之和，非单一 input）。
///
/// **口径基准**（Claude Code 引擎）：`modelUsage` 字段为本轮所有模型所有 API 调用
/// 的**累计值**，是水位条分子基准；`model_usage` 为 None 时退化到顶层 `usage`
/// 字段（仅最后一次调用，偏小，仅作兜底）。`raw_payload` 保留原始 result 事件
/// 报文，供前端"查看原始请求/响应"调试链路使用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 未命中缓存的输入 token（全价）。基准 = modelUsage 累计，退化 = usage 顶层
    pub input_tokens: u64,
    /// 写入缓存的 token（~1.25×）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u64>,
    /// 从缓存读取的 token（~0.1×）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,
    /// 输出 token
    pub output_tokens: u64,
    /// 推理输出 token（Codex 有；其余引擎可能无）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_output_tokens: Option<u64>,
    /// 上下文窗口大小；后端已知则填，否则前端从 ModelProfile 取
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// 按模型维度的用量明细（Claude Code 的 result.modelUsage；其余引擎为 None）。
    /// 前端据此做按模型区分用量展示与核对。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_usage: Option<HashMap<String, ModelUsageBreakdown>>,
    /// 原始 result 事件报文（含 headers/usage/modelUsage 等全字段），供调试查看。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_payload: Option<serde_json::Value>,
}

impl UsageEvent {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        session_id: impl Into<String>,
        input_tokens: u64,
        cache_creation_input_tokens: Option<u64>,
        cache_read_input_tokens: Option<u64>,
        output_tokens: u64,
        reasoning_output_tokens: Option<u64>,
        context_window: Option<u64>,
    ) -> Self {
        Self {
            event_type: "usage".to_string(),
            session_id: session_id.into(),
            input_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
            output_tokens,
            reasoning_output_tokens,
            context_window,
            model_usage: None,
            raw_payload: None,
        }
    }

    /// 附加按模型维度用量明细
    pub fn with_model_usage(mut self, model_usage: HashMap<String, ModelUsageBreakdown>) -> Self {
        self.model_usage = if model_usage.is_empty() { None } else { Some(model_usage) };
        self
    }

    /// 附加原始报文（供前端查看请求/响应原文）
    pub fn with_raw_payload(mut self, raw_payload: serde_json::Value) -> Self {
        self.raw_payload = Some(raw_payload);
        self
    }
}

// ============================================================================
// Hook 事件
// ============================================================================

/// Hook 生命周期事件
///
/// 来自 CLI stream-json 的 `system/hook_started` 与 `system/hook_response`，
/// 启用 `--include-hook-events` 后覆盖完整 hook 生命周期（PreToolUse/PostToolUse 等）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// hook 名称，如 "SessionStart:startup" / "PreToolUse:Bash"
    pub hook_name: String,
    /// hook 事件类别，如 "SessionStart" / "PreToolUse" / "PostToolUse"
    pub hook_event: String,
    /// 阶段："started" | "completed"
    pub phase: String,
    /// 执行结果（仅 completed），如 "success" / "cancelled"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// 退出码（仅 completed）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
}

impl HookEvent {
    pub fn started(
        session_id: impl Into<String>,
        hook_name: impl Into<String>,
        hook_event: impl Into<String>,
    ) -> Self {
        Self {
            event_type: "hook".to_string(),
            session_id: session_id.into(),
            hook_name: hook_name.into(),
            hook_event: hook_event.into(),
            phase: "started".to_string(),
            outcome: None,
            exit_code: None,
        }
    }

    pub fn completed(
        session_id: impl Into<String>,
        hook_name: impl Into<String>,
        hook_event: impl Into<String>,
        outcome: Option<String>,
        exit_code: Option<i64>,
    ) -> Self {
        Self {
            event_type: "hook".to_string(),
            session_id: session_id.into(),
            hook_name: hook_name.into(),
            hook_event: hook_event.into(),
            phase: "completed".to_string(),
            outcome,
            exit_code,
        }
    }
}

// ============================================================================
// PromptSuggestion 事件
// ============================================================================

/// 提示建议事件（--prompt-suggestions）
///
/// CLI 在每轮结束后发送，预测下一条用户输入，用于输入框快捷气泡。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSuggestionEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// 会话 ID - 用于事件路由
    pub session_id: String,
    /// 建议的下一条用户输入
    pub suggestion: String,
}

impl PromptSuggestionEvent {
    pub fn new(session_id: impl Into<String>, suggestion: impl Into<String>) -> Self {
        Self {
            event_type: "prompt_suggestion".to_string(),
            session_id: session_id.into(),
            suggestion: suggestion.into(),
        }
    }
}

// ============================================================================
// AI Event 枚举
// ============================================================================

/// 统一 AI 事件类型
///
/// 与前端 AIEvent 完全对齐，后端直接发送此类型给前端。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AIEvent {
    Token(TokenEvent),
    Thinking(ThinkingEvent),
    ToolCallStart(ToolCallStartEvent),
    ToolCallEnd(ToolCallEndEvent),
    Progress(ProgressEvent),
    Result(ResultEvent),
    Error(ErrorEvent),
    SessionStart(SessionStartEvent),
    SessionEnd(SessionEndEvent),
    UserMessage(UserMessageEvent),
    AssistantMessage(AssistantMessageEvent),
    TaskMetadata(TaskMetadataEvent),
    TaskProgress(TaskProgressEvent),
    TaskCompleted(TaskCompletedEvent),
    // PlanMode 事件
    PlanStart(PlanStartEvent),
    PlanContent(PlanContentEvent),
    PlanStageUpdate(PlanStageUpdateEvent),
    PlanApprovalRequest(PlanApprovalRequestEvent),
    PlanApprovalResult(PlanApprovalResultEvent),
    PlanEnd(PlanEndEvent),
    // PermissionRequest 事件
    PermissionRequest(PermissionRequestEvent),
    // AgentRun 事件
    AgentRunStart(AgentRunStartEvent),
    AgentRunEnd(AgentRunEndEvent),
    // Question 事件
    Question(QuestionEvent),
    QuestionAnswered(QuestionAnsweredEvent),
    // CLI Init 事件
    CliInit(CliInitEvent),
    // 上下文压缩事件
    ContextCompacted(ContextCompactedEvent),
    // Token 用量事件
    Usage(UsageEvent),
    // Hook 生命周期事件
    Hook(HookEvent),
    // 提示建议事件
    PromptSuggestion(PromptSuggestionEvent),
}

impl AIEvent {
    /// 获取事件类型名称
    pub fn event_type(&self) -> &str {
        match self {
            AIEvent::Token(e) => &e.event_type,
            AIEvent::Thinking(e) => &e.event_type,
            AIEvent::ToolCallStart(e) => &e.event_type,
            AIEvent::ToolCallEnd(e) => &e.event_type,
            AIEvent::Progress(e) => &e.event_type,
            AIEvent::Result(e) => &e.event_type,
            AIEvent::Error(e) => &e.event_type,
            AIEvent::SessionStart(e) => &e.event_type,
            AIEvent::SessionEnd(e) => &e.event_type,
            AIEvent::UserMessage(e) => &e.event_type,
            AIEvent::AssistantMessage(e) => &e.event_type,
            AIEvent::TaskMetadata(e) => &e.event_type,
            AIEvent::TaskProgress(e) => &e.event_type,
            AIEvent::TaskCompleted(e) => &e.event_type,
            AIEvent::PlanStart(e) => &e.event_type,
            AIEvent::PlanContent(e) => &e.event_type,
            AIEvent::PlanStageUpdate(e) => &e.event_type,
            AIEvent::PlanApprovalRequest(e) => &e.event_type,
            AIEvent::PlanApprovalResult(e) => &e.event_type,
            AIEvent::PlanEnd(e) => &e.event_type,
            AIEvent::PermissionRequest(e) => &e.event_type,
            AIEvent::AgentRunStart(e) => &e.event_type,
            AIEvent::AgentRunEnd(e) => &e.event_type,
            AIEvent::Question(e) => &e.event_type,
            AIEvent::QuestionAnswered(e) => &e.event_type,
            AIEvent::CliInit(e) => &e.event_type,
            AIEvent::ContextCompacted(e) => &e.event_type,
            AIEvent::Usage(e) => &e.event_type,
            AIEvent::Hook(e) => &e.event_type,
            AIEvent::PromptSuggestion(e) => &e.event_type,
        }
    }

    // ========================================================================
    // 便捷构造方法（所有方法都需要 session_id 参数）
    // ========================================================================

    /// 创建 Token 事件
    pub fn token(session_id: impl Into<String>, value: impl Into<String>) -> Self {
        AIEvent::Token(TokenEvent::new(session_id, value.into()))
    }

    /// 创建思考事件
    pub fn thinking(session_id: impl Into<String>, content: impl Into<String>) -> Self {
        AIEvent::Thinking(ThinkingEvent::new(session_id, content))
    }

    /// 创建工具调用开始事件
    pub fn tool_call_start(session_id: impl Into<String>, tool: impl Into<String>, args: HashMap<String, serde_json::Value>) -> Self {
        AIEvent::ToolCallStart(ToolCallStartEvent::new(session_id, tool.into(), args))
    }

    /// 创建工具调用结束事件
    pub fn tool_call_end(session_id: impl Into<String>, tool: impl Into<String>, success: bool) -> Self {
        AIEvent::ToolCallEnd(ToolCallEndEvent::new(session_id, tool.into(), success))
    }

    /// 创建进度事件
    pub fn progress(session_id: impl Into<String>, message: impl Into<String>) -> Self {
        AIEvent::Progress(ProgressEvent::new(session_id, message))
    }

    /// 创建错误事件
    pub fn error(session_id: impl Into<String>, error: impl Into<String>) -> Self {
        AIEvent::Error(ErrorEvent::new(session_id, error))
    }

    /// 创建会话开始事件
    pub fn session_start(session_id: impl Into<String>) -> Self {
        AIEvent::SessionStart(SessionStartEvent::new(session_id))
    }

    /// 创建会话结束事件
    pub fn session_end(session_id: impl Into<String>) -> Self {
        AIEvent::SessionEnd(SessionEndEvent::new(session_id))
    }

    /// 创建用量事件
    #[allow(clippy::too_many_arguments)]
    pub fn usage(
        session_id: impl Into<String>,
        input_tokens: u64,
        cache_creation_input_tokens: Option<u64>,
        cache_read_input_tokens: Option<u64>,
        output_tokens: u64,
        reasoning_output_tokens: Option<u64>,
        context_window: Option<u64>,
    ) -> Self {
        AIEvent::Usage(UsageEvent::new(
            session_id,
            input_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
            output_tokens,
            reasoning_output_tokens,
            context_window,
        ))
    }

    /// 创建用户消息事件
    pub fn user_message(session_id: impl Into<String>, content: impl Into<String>) -> Self {
        AIEvent::UserMessage(UserMessageEvent::new(session_id, content))
    }

    /// 创建 AI 消息事件
    pub fn assistant_message(session_id: impl Into<String>, content: impl Into<String>, is_delta: bool) -> Self {
        AIEvent::AssistantMessage(AssistantMessageEvent::new(session_id, content, is_delta))
    }

    /// 获取事件的 session_id
    pub fn session_id(&self) -> &str {
        match self {
            AIEvent::Token(e) => &e.session_id,
            AIEvent::Thinking(e) => &e.session_id,
            AIEvent::ToolCallStart(e) => &e.session_id,
            AIEvent::ToolCallEnd(e) => &e.session_id,
            AIEvent::Progress(e) => &e.session_id,
            AIEvent::Result(e) => &e.session_id,
            AIEvent::Error(e) => &e.session_id,
            AIEvent::SessionStart(e) => &e.session_id,
            AIEvent::SessionEnd(e) => &e.session_id,
            AIEvent::UserMessage(e) => &e.session_id,
            AIEvent::AssistantMessage(e) => &e.session_id,
            AIEvent::TaskMetadata(e) => &e.session_id,
            AIEvent::TaskProgress(e) => &e.session_id,
            AIEvent::TaskCompleted(e) => &e.session_id,
            AIEvent::PlanStart(e) => &e.session_id,
            AIEvent::PlanContent(e) => &e.session_id,
            AIEvent::PlanStageUpdate(e) => &e.session_id,
            AIEvent::PlanApprovalRequest(e) => &e.session_id,
            AIEvent::PlanApprovalResult(e) => &e.session_id,
            AIEvent::PlanEnd(e) => &e.session_id,
            AIEvent::PermissionRequest(e) => &e.session_id,
            AIEvent::AgentRunStart(e) => &e.session_id,
            AIEvent::AgentRunEnd(e) => &e.session_id,
            AIEvent::Question(e) => &e.session_id,
            AIEvent::QuestionAnswered(e) => &e.session_id,
            AIEvent::CliInit(e) => &e.session_id,
            AIEvent::ContextCompacted(e) => &e.session_id,
            AIEvent::Usage(e) => &e.session_id,
            AIEvent::Hook(e) => &e.session_id,
            AIEvent::PromptSuggestion(e) => &e.session_id,
        }
    }

    /// 从事件中提取文本内容
    ///
    /// 用于将 AI 响应发送到外部平台（如 QQ Bot）
    pub fn extract_text(&self) -> Option<String> {
        match self {
            AIEvent::Token(e) => Some(e.value.clone()),
            AIEvent::AssistantMessage(e) => Some(e.content.clone()),
            AIEvent::Result(e) => {
                // 尝试从 output 中提取文本
                e.output.as_str().map(|s| s.to_string())
            }
            AIEvent::Progress(e) => e.message.clone(),
            _ => None,
        }
    }

    /// 判断是否为会话结束事件
    pub fn is_session_end(&self) -> bool {
        matches!(self, AIEvent::SessionEnd(_))
    }

    /// 判断是否为错误事件
    pub fn is_error(&self) -> bool {
        matches!(self, AIEvent::Error(_))
    }

    /// 判断是否为思考事件
    pub fn is_thinking(&self) -> bool {
        matches!(self, AIEvent::Thinking(_))
    }

    /// 判断是否为工具调用事件
    pub fn is_tool_call(&self) -> bool {
        matches!(self, AIEvent::ToolCallStart(_) | AIEvent::ToolCallEnd(_))
    }

    /// 提取思考内容
    pub fn extract_thinking(&self) -> Option<&str> {
        match self {
            AIEvent::Thinking(e) => Some(&e.content),
            _ => None,
        }
    }

    /// 提取工具调用信息
    pub fn extract_tool_info(&self) -> Option<ToolCallInfo> {
        match self {
            AIEvent::ToolCallStart(e) => Some(ToolCallInfo {
                id: e.call_id.clone().unwrap_or_default(),
                name: e.tool.clone(),
                args: e.args.clone(),
                status: ToolCallStatus::Running,
                result: None,
            }),
            AIEvent::ToolCallEnd(e) => Some(ToolCallInfo {
                id: e.call_id.clone().unwrap_or_default(),
                name: e.tool.clone(),
                args: HashMap::new(),
                status: if e.success { ToolCallStatus::Completed } else { ToolCallStatus::Failed },
                result: e.result.clone(),
            }),
            _ => None,
        }
    }
}
