pub mod ai_event;
pub mod config;
pub mod events;
pub mod git;
pub mod plugin;
pub mod plugin_state;
pub mod prompt;
pub mod prompt_snippet;
pub mod requirement;
pub mod scheduler;
pub mod todo;

pub use ai_event::{
    AIEvent,
    AssistantMessageEvent,
    // CliInit 类型
    CliInitEvent,
    // 上下文压缩类型
    ContextCompactedEvent,
    ContextCompactionFailedEvent,
    ContextRestoredEvent,
    ErrorEvent,
    // Hook 类型
    HookEvent,
    McpServerStatus,
    // PermissionRequest 类型
    PermissionDenial,
    PermissionRequestEvent,
    PlanApprovalRequestEvent,
    PlanApprovalResultEvent,
    PlanContentEvent,
    PlanEndEvent,
    PlanStage,
    PlanStageStatus,
    PlanStageUpdateEvent,
    PlanStartEvent,
    // PlanMode 类型
    PlanStatus,
    PlanTask,
    PlanTaskStatus,
    ProgressEvent,
    // PromptSuggestion 类型
    PromptSuggestionEvent,
    ResultEvent,
    SessionEndEvent,
    SessionEndReason,
    ThinkingEvent,
    ToolCallEndEvent,
    ToolCallInfo,
    ToolCallStartEvent,
    ToolCallStatus,
    UserMessageEvent,
};
pub mod auto_mode;
pub use auto_mode::{AutoModeConfig, AutoModeDefaults};

pub mod cli_info;
pub use cli_info::{CliAgentInfo, CliAuthStatus, CliDynamicInfo};
