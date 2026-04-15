pub mod ai_event;
pub mod config;
pub mod events;
pub mod git;
pub mod plugin;
pub mod prompt;
pub mod prompt_snippet;
pub mod scheduler;
pub mod todo;
pub mod requirement;

pub use ai_event::{
    AIEvent, ToolCallInfo, ToolCallStatus,
    ToolCallStartEvent, ToolCallEndEvent, ProgressEvent,
    ResultEvent, ErrorEvent, SessionEndEvent,
    UserMessageEvent, AssistantMessageEvent, SessionEndReason,
    ThinkingEvent,
    // PlanMode 类型
    PlanStatus, PlanTaskStatus, PlanStageStatus, PlanTask, PlanStage,
    PlanStartEvent, PlanContentEvent, PlanStageUpdateEvent,
    PlanApprovalRequestEvent, PlanApprovalResultEvent, PlanEndEvent,
    // PermissionRequest 类型
    PermissionDenial, PermissionRequestEvent,
};
pub mod auto_mode;
pub use auto_mode::{AutoModeConfig, AutoModeDefaults};

pub mod cli_info;
pub use cli_info::{CliAgentInfo, CliAuthStatus, CliDynamicInfo};
