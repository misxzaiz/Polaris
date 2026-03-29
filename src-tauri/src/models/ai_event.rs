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
    /// 文本内容
    pub value: String,
}

impl TokenEvent {
    pub fn new(value: String) -> Self {
        Self {
            event_type: "token".to_string(),
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
    /// 思考内容
    pub content: String,
}

impl ThinkingEvent {
    pub fn new(content: impl Into<String>) -> Self {
        Self {
            event_type: "thinking".to_string(),
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
    /// 工具调用 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    /// 工具名称
    pub tool: String,
    /// 工具参数
    pub args: HashMap<String, serde_json::Value>,
}

impl ToolCallStartEvent {
    pub fn new(tool: String, args: HashMap<String, serde_json::Value>) -> Self {
        Self {
            event_type: "tool_call_start".to_string(),
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
    pub fn new(tool: String, success: bool) -> Self {
        Self {
            event_type: "tool_call_end".to_string(),
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
    /// 进度消息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// 进度百分比 0-100
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u32>,
}

impl ProgressEvent {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            event_type: "progress".to_string(),
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
    /// 任务输出结果
    pub output: serde_json::Value,
}

impl ResultEvent {
    pub fn new(output: serde_json::Value) -> Self {
        Self {
            event_type: "result".to_string(),
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
    /// 错误信息
    pub error: String,
    /// 错误码（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl ErrorEvent {
    pub fn new(error: impl Into<String>) -> Self {
        Self {
            event_type: "error".to_string(),
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
    /// 用户消息内容
    pub content: String,
    /// 关联的文件
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
}

impl UserMessageEvent {
    pub fn new(content: impl Into<String>) -> Self {
        Self {
            event_type: "user_message".to_string(),
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
    /// 消息内容（可能是部分内容）
    pub content: String,
    /// 是否为增量更新
    pub is_delta: bool,
    /// 消息中包含的工具调用
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallInfo>>,
}

impl AssistantMessageEvent {
    pub fn new(content: impl Into<String>, is_delta: bool) -> Self {
        Self {
            event_type: "assistant_message".to_string(),
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
    pub fn new(task_id: impl Into<String>, status: TaskStatus) -> Self {
        Self {
            event_type: "task_metadata".to_string(),
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
    pub fn new(task_id: impl Into<String>) -> Self {
        Self {
            event_type: "task_progress".to_string(),
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
    pub fn new(task_id: impl Into<String>, status: TaskStatus) -> Self {
        Self {
            event_type: "task_completed".to_string(),
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
// 统一 AIEvent 枚举
// ============================================================================

/// 统一 AI 事件类型
///
/// 与前端 AIEvent 完全对齐，后端直接发送此类型给前端。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
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
        }
    }

    // ========================================================================
    // 便捷构造方法
    // ========================================================================

    /// 创建 Token 事件
    pub fn token(value: impl Into<String>) -> Self {
        AIEvent::Token(TokenEvent::new(value.into()))
    }

    /// 创建思考事件
    pub fn thinking(content: impl Into<String>) -> Self {
        AIEvent::Thinking(ThinkingEvent::new(content))
    }

    /// 创建工具调用开始事件
    pub fn tool_call_start(tool: impl Into<String>, args: HashMap<String, serde_json::Value>) -> Self {
        AIEvent::ToolCallStart(ToolCallStartEvent::new(tool.into(), args))
    }

    /// 创建工具调用结束事件
    pub fn tool_call_end(tool: impl Into<String>, success: bool) -> Self {
        AIEvent::ToolCallEnd(ToolCallEndEvent::new(tool.into(), success))
    }

    /// 创建进度事件
    pub fn progress(message: impl Into<String>) -> Self {
        AIEvent::Progress(ProgressEvent::new(message))
    }

    /// 创建错误事件
    pub fn error(error: impl Into<String>) -> Self {
        AIEvent::Error(ErrorEvent::new(error))
    }

    /// 创建会话开始事件
    pub fn session_start(session_id: impl Into<String>) -> Self {
        AIEvent::SessionStart(SessionStartEvent::new(session_id))
    }

    /// 创建会话结束事件
    pub fn session_end(session_id: impl Into<String>) -> Self {
        AIEvent::SessionEnd(SessionEndEvent::new(session_id))
    }

    /// 创建用户消息事件
    pub fn user_message(content: impl Into<String>) -> Self {
        AIEvent::UserMessage(UserMessageEvent::new(content))
    }

    /// 创建 AI 消息事件
    pub fn assistant_message(content: impl Into<String>, is_delta: bool) -> Self {
        AIEvent::AssistantMessage(AssistantMessageEvent::new(content, is_delta))
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
