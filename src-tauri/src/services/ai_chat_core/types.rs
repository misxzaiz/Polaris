//! 附件与聊天请求类型（K-R6 自 ai_chat_core.rs 迁入）

use crate::models::config::ProfileMode;

// ============================================================================
// 附件相关结构体
// ============================================================================

/// 附件类型
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// 附件类型 ("image" | "file")
    #[serde(rename = "type")]
    pub attachment_type: String,
    /// 文件名
    pub file_name: String,
    /// MIME 类型
    pub mime_type: String,
    /// 二进制内容 (base64 data URL，用于图片和二进制文件)
    #[serde(default)]
    pub content: String,
    /// 文本内容（前端直接读取的文本，用于文本/代码文件，避免 base64 膨胀）
    #[serde(default)]
    pub text_content: Option<String>,
}

/// 聊天请求的可选参数
/// 用于减少 start_chat 和 continue_chat 函数的参数数量
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequestOptions {
    /// 工作目录
    #[serde(default)]
    pub work_dir: Option<String>,
    /// 引擎 ID
    #[serde(default)]
    pub engine_id: Option<String>,
    /// 系统提示词（用户自定义，会覆盖默认部分）
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// 追加到默认系统提示词的内容（工作区信息等，始终追加）
    #[serde(default)]
    pub append_system_prompt: Option<String>,
    /// 是否启用 MCP 工具
    #[serde(default)]
    pub enable_mcp_tools: Option<bool>,
    /// 禁用的 MCP server 名称列表
    #[serde(default)]
    pub disabled_mcp_servers: Option<Vec<String>>,
    /// 上下文 ID
    #[serde(default)]
    pub context_id: Option<String>,
    /// 附件列表
    #[serde(default)]
    pub attachments: Option<Vec<Attachment>>,
    /// 关联工作区路径列表（通过 --add-dir 传递给 Claude CLI）
    #[serde(default)]
    pub additional_dirs: Option<Vec<String>>,
    /// CLI Agent 选择
    #[serde(default)]
    pub agent: Option<String>,
    /// 模型选择
    #[serde(default)]
    pub model: Option<String>,
    /// 努力级别
    #[serde(default)]
    pub effort: Option<String>,
    /// 权限模式
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// 允许的工具列表（权限重试时使用）
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
    /// Fork 来源会话 ID（配合 --fork-session 创建分支会话）
    #[serde(default)]
    pub fork_session_id: Option<String>,
    /// 模型 Profile ID（用于查找第三方端点配置）
    #[serde(default)]
    pub model_profile_id: Option<String>,
    /// 供应商选择模式（None = 未显式指定，走旧逻辑：
    /// 有 model_profile_id → 该 Profile；否则若激活了分组 → 分组；否则官方）。
    /// 与 `model_profile_id` 配合构成「官方 / 分组路由 / 指定 Profile」三态。
    #[serde(default)]
    pub profile_mode: Option<ProfileMode>,
    /// 分组路由模式下要使用的供应商分组 ID。
    /// None = 跟随全局 `active_provider_group_id`（默认）；
    /// Some(id) = 显式指定该分组（会话级覆盖，优先于全局激活）。
    /// 非分组路由模式（official/profile）下忽略此字段。
    #[serde(default)]
    pub provider_group_id: Option<String>,
    /// 前端生成的用户消息 ID（透传至 UserMessageEvent，本机回显去重用）
    #[serde(default)]
    pub client_message_id: Option<String>,
    /// 前端预生成的 assistant 消息 ID（用于 turn_persist adopt，消除 id 漂移）。
    ///
    /// 背景：同一轮回复此前会被赋予不同 id（前端 currentMessage 的 generateUUID
    /// 与后端 turn_persist 的 `xxx#axxx`），导致磁盘同内容多 id 并存、读取去重失效。
    /// 前端在 sendMessage 时预生成 assistant id 传给后端，后端 turn_persist
    /// 在 new_turn 时 adopt 它，实现全链路 id 统一。
    #[serde(default)]
    pub assistant_message_id: Option<String>,
    /// 客户端类型（desktop / web / mobile-web / mobile-app），由前端运行环境检测。
    /// 用于环境上下文注入，让 AI 知道用户实际在用哪个端对话（服务端 os/cwd
    /// 是运行时环境，不等于用户环境）。缺省不注入。
    #[serde(default)]
    pub client_type: Option<String>,
    /// 客户端平台描述（windows / android / ios 等），配合 client_type 使用。
    #[serde(default)]
    pub client_platform: Option<String>,
    /// 发起请求的设备 id（前端每安装 UUID，localStorage 持久化）。
    /// 落到用户消息 MessageEntry.device_id，审计 reason"由设备 X 启动"可归因
    /// （阶段 1A⑥ spec §3）。缺省回退 "core"。
    #[serde(default)]
    pub device_id: Option<String>,
}

