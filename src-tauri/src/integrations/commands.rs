/*! IM 机器人命令解析和处理
 *
 * 支持的命令：
 * - 模型切换: /claude, /openai, /agent
 * - 提示词预设: /preset <preset_id>, /preset list, /preset default
 * - 中断对话: /stop, /end, /停止
 * - 状态查询: /status, /状态
 * - 工作目录: /path <目录>, /路径 <目录>
 * - 会话恢复: /resume, /继续, /恢复
 * - 重启会话: /restart, /rs, /重启
 * - 帮助: /help, /帮助
 */

use serde::{Deserialize, Serialize};
use crate::ai::EngineId;

/// 提示词模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PromptMode {
    /// 追加到默认提示词
    #[default]
    Append,
    /// 替换默认提示词
    Replace,
}

/// IM 机器人命令类型
#[derive(Debug, Clone)]
pub enum BotCommand {
    /// 切换模型
    SwitchProvider {
        provider: EngineId,
        custom_prompt: Option<String>,
        replace_mode: bool,
    },
    /// 切换提示词预设
    SwitchPreset {
        preset_id: Option<String>,
    },
    /// 列出可用预设
    ListPresets,
    /// 中断当前对话
    Interrupt,
    /// 查询状态
    Status,
    /// 切换工作目录
    SetPath { path: String },
    /// 显示当前路径（无参数的 /path）
    GetPath,
    /// 恢复最新会话
    Resume,
    /// 重启会话
    Restart,
    /// 帮助
    Help,
    /// 未知命令（作为普通消息处理）
    Unknown,
}

/// 命令解析器
pub struct CommandParser;

impl CommandParser {
    /// 解析消息内容，返回命令或 None（普通消息）
    pub fn parse(content: &str) -> Option<BotCommand> {
        let trimmed = content.trim();

        // 必须以 / 开头才是命令
        if !trimmed.starts_with('/') {
            return None;
        }

        let cmd_text = trimmed[1..].trim();
        let parts: Vec<&str> = cmd_text.split_whitespace().collect();

        if parts.is_empty() {
            return None;
        }

        let cmd = parts[0].to_lowercase();

        let command = match cmd.as_str() {
            // 模型切换
            "claude" | "claude-code" | "claudecode" => {
                let (custom_prompt, replace_mode) = Self::parse_switch_args(&parts[1..]);
                Some(BotCommand::SwitchProvider {
                    provider: EngineId::ClaudeCode,
                    custom_prompt,
                    replace_mode,
                })
            }
            "openai" => {
                // 解析参数：支持 /openai [provider_id] [-r] [自定义提示词]
                let (provider_id, custom_prompt, replace_mode) = Self::parse_openai_args(&parts[1..]);
                Some(BotCommand::SwitchProvider {
                    provider: EngineId::OpenAI { provider_id },
                    custom_prompt,
                    replace_mode,
                })
            }
            "agent" => {
                let (custom_prompt, replace_mode) = Self::parse_switch_args(&parts[1..]);
                Some(BotCommand::SwitchProvider {
                    provider: EngineId::ClaudeCode, // agent 默认使用 claude
                    custom_prompt,
                    replace_mode,
                })
            }

            // 中断
            "stop" | "end" | "停止" => Some(BotCommand::Interrupt),

            // 状态
            "status" | "状态" => Some(BotCommand::Status),

            // 工作目录
            "path" | "路径" => {
                if parts.len() > 1 {
                    Some(BotCommand::SetPath {
                        path: parts[1..].join(" "),
                    })
                } else {
                    Some(BotCommand::GetPath)
                }
            }

            // 恢复会话
            "resume" | "继续" | "恢复" => Some(BotCommand::Resume),

            // 重启
            "restart" | "rs" | "重启" => Some(BotCommand::Restart),

            // 帮助
            "help" | "帮助" => Some(BotCommand::Help),

            // 提示词预设
            "preset" | "预设" => {
                if parts.len() > 1 {
                    let sub_cmd = parts[1].to_lowercase();
                    match sub_cmd.as_str() {
                        "list" | "列表" => Some(BotCommand::ListPresets),
                        "default" | "默认" => Some(BotCommand::SwitchPreset { preset_id: None }),
                        _ => Some(BotCommand::SwitchPreset {
                            preset_id: Some(parts[1..].join(" ")),
                        }),
                    }
                } else {
                    Some(BotCommand::ListPresets)
                }
            }

            // 未知命令
            _ => Some(BotCommand::Unknown),
        };

        // Unknown 命令返回 None，作为普通消息处理
        match command {
            Some(BotCommand::Unknown) => None,
            other => other,
        }
    }

    /// 解析切换命令的参数
    /// 格式: [-r] [自定义提示词]
    fn parse_switch_args(parts: &[&str]) -> (Option<String>, bool) {
        let mut replace_mode = false;
        let mut prompt_parts = Vec::new();

        for part in parts {
            if *part == "-r" {
                replace_mode = true;
            } else {
                prompt_parts.push(*part);
            }
        }

        let custom_prompt = if prompt_parts.is_empty() {
            None
        } else {
            Some(prompt_parts.join(" "))
        };

        (custom_prompt, replace_mode)
    }

    /// 解析 OpenAI 切换命令的参数
    /// 格式: [provider_id] [-r] [自定义提示词]
    ///
    /// 示例:
    /// - `/openai` → (None, None, false) 使用激活的 provider
    /// - `/openai qwen` → (Some("qwen"), None, false) 使用 id 包含 "qwen" 的 provider
    /// - `/openai qwen -r 你是专家` → (Some("qwen"), Some("你是专家"), true)
    fn parse_openai_args(parts: &[&str]) -> (Option<String>, Option<String>, bool) {
        let mut replace_mode = false;
        let mut provider_id: Option<String> = None;
        let mut prompt_parts = Vec::new();

        for part in parts {
            if *part == "-r" {
                replace_mode = true;
            } else if provider_id.is_none() && !part.starts_with('-') {
                // 第一个非 -r 参数视为 provider_id
                provider_id = Some(part.to_string());
            } else {
                prompt_parts.push(*part);
            }
        }

        let custom_prompt = if prompt_parts.is_empty() {
            None
        } else {
            Some(prompt_parts.join(" "))
        };

        (provider_id, custom_prompt, replace_mode)
    }
}

/// 历史消息（用于 OpenAI 等无状态引擎的上下文）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    /// 角色：user 或 assistant
    pub role: String,
    /// 消息内容
    pub content: String,
    /// 时间戳
    pub timestamp: i64,
}

impl HistoryMessage {
    pub fn user(content: impl Into<String>) -> Self {
        use chrono::Utc;
        Self {
            role: "user".to_string(),
            content: content.into(),
            timestamp: Utc::now().timestamp_millis(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        use chrono::Utc;
        Self {
            role: "assistant".to_string(),
            content: content.into(),
            timestamp: Utc::now().timestamp_millis(),
        }
    }
}

/// 会话状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationState {
    /// 会话 ID
    pub conversation_id: String,
    /// 当前使用的引擎
    pub engine_id: String,
    /// AI 会话 ID（用于恢复）
    pub ai_session_id: Option<String>,
    /// 工作目录
    pub work_dir: Option<String>,
    /// 提示词预设 ID
    #[serde(default)]
    pub prompt_preset_id: Option<String>,
    /// 自定义提示词
    pub custom_prompt: Option<String>,
    /// 提示词模式
    pub prompt_mode: PromptMode,
    /// 最后活动时间
    pub last_activity: i64,
    /// 消息计数
    pub message_count: u32,
    /// 消息历史（用于 OpenAI 等无状态引擎）
    #[serde(default)]
    pub message_history: Vec<HistoryMessage>,
    /// 最大历史条数
    #[serde(default = "default_max_history")]
    pub max_history: usize,
}

fn default_max_history() -> usize {
    20
}

#[allow(dead_code)]
impl ConversationState {
    /// 创建新的会话状态
    pub fn new(conversation_id: impl Into<String>) -> Self {
        use chrono::Utc;

        Self {
            conversation_id: conversation_id.into(),
            engine_id: "claude".to_string(),
            ai_session_id: None,
            work_dir: None,
            prompt_preset_id: None,
            custom_prompt: None,
            prompt_mode: PromptMode::default(),
            last_activity: Utc::now().timestamp_millis(),
            message_count: 0,
            message_history: Vec::new(),
            max_history: default_max_history(),
        }
    }

    /// 更新活动时间
    pub fn touch(&mut self) {
        use chrono::Utc;
        self.last_activity = Utc::now().timestamp_millis();
        self.message_count += 1;
    }

    /// 重置状态
    pub fn reset(&mut self) {
        self.ai_session_id = None;
        self.prompt_preset_id = None;
        self.custom_prompt = None;
        self.prompt_mode = PromptMode::default();
        self.message_count = 0;
        self.message_history.clear();
        use chrono::Utc;
        self.last_activity = Utc::now().timestamp_millis();
    }

    /// 获取引擎 ID
    pub fn get_engine_id(&self) -> EngineId {
        EngineId::from_str(&self.engine_id).unwrap_or(EngineId::ClaudeCode)
    }

    /// 设置引擎
    pub fn set_engine(&mut self, engine_id: &EngineId) {
        self.engine_id = engine_id.as_str();
    }

    /// 添加用户消息到历史
    pub fn add_user_message(&mut self, content: impl Into<String>) {
        self.message_history.push(HistoryMessage::user(content));
        self.trim_history();
    }

    /// 添加助手回复到历史
    pub fn add_assistant_message(&mut self, content: impl Into<String>) {
        self.message_history.push(HistoryMessage::assistant(content));
        self.trim_history();
    }

    /// 裁剪历史，保持在 max_history 限制内
    fn trim_history(&mut self) {
        if self.message_history.len() > self.max_history {
            // 保留最近的 N 条消息
            let keep = self.max_history;
            self.message_history.drain(0..self.message_history.len() - keep);
        }
    }

    /// 获取消息历史
    pub fn get_message_history(&self) -> &[HistoryMessage] {
        &self.message_history
    }

    /// 清空消息历史
    pub fn clear_history(&mut self) {
        self.message_history.clear();
    }
}

impl Default for ConversationState {
    fn default() -> Self {
        Self::new("")
    }
}

/// 帮助信息
pub fn get_help_text() -> String {
    r#"📖 **命令帮助**

**模型切换**
`/claude [提示词]` - 切换到 Claude
`/openai [provider_id] [提示词]` - 切换到 OpenAI
`/agent [提示词]` - 切换到 Agent
• OpenAI 支持 provider_id 参数指定具体模型
• 添加 `-r` 参数替换默认提示词
• 示例: `/claude 你是Python专家`
• 示例: `/openai qwen 你是专家`

**提示词预设**
`/preset <预设名>` - 切换提示词预设
`/preset list` - 列出可用预设
`/preset default` - 恢复默认预设
• 示例: `/preset minimal` 使用精简预设
• 示例: `/preset full` 使用完整预设

**会话控制**
`/stop` - 中断当前对话
`/restart` - 重置会话
`/resume` - 恢复最新会话

**其他**
`/status` - 查看状态
`/path <目录>` - 设置工作目录
`/help` - 显示帮助
"#.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_switch_provider() {
        // 基本切换
        let cmd = CommandParser::parse("/claude");
        assert!(matches!(
            cmd,
            Some(BotCommand::SwitchProvider {
                provider: EngineId::ClaudeCode,
                custom_prompt: None,
                replace_mode: false
            })
        ));

        // 带提示词
        let cmd = CommandParser::parse("/claude 你是助手");
        assert!(matches!(
            cmd,
            Some(BotCommand::SwitchProvider {
                provider: EngineId::ClaudeCode,
                custom_prompt: Some(_),
                replace_mode: false
            })
        ));

        // 替换模式
        let cmd = CommandParser::parse("/openai -r 你是专家");
        assert!(matches!(
            cmd,
            Some(BotCommand::SwitchProvider {
                provider: EngineId::OpenAI { provider_id: None },
                custom_prompt: Some(_),
                replace_mode: true
            })
        ));

        // OpenAI 带 provider_id
        let cmd = CommandParser::parse("/openai qwen");
        assert!(matches!(
            cmd,
            Some(BotCommand::SwitchProvider {
                provider: EngineId::OpenAI { provider_id: Some(_) },
                custom_prompt: None,
                replace_mode: false
            })
        ));
    }

    #[test]
    fn test_parse_preset() {
        // 列出预设
        let cmd = CommandParser::parse("/preset list");
        assert!(matches!(cmd, Some(BotCommand::ListPresets)));

        let cmd = CommandParser::parse("/预设 列表");
        assert!(matches!(cmd, Some(BotCommand::ListPresets)));

        // 切换预设
        let cmd = CommandParser::parse("/preset minimal");
        assert!(matches!(
            cmd,
            Some(BotCommand::SwitchPreset { preset_id: Some(_) })
        ));

        // 恢复默认
        let cmd = CommandParser::parse("/preset default");
        assert!(matches!(
            cmd,
            Some(BotCommand::SwitchPreset { preset_id: None })
        ));

        // 无参数显示列表
        let cmd = CommandParser::parse("/preset");
        assert!(matches!(cmd, Some(BotCommand::ListPresets)));
    }

    #[test]
    fn test_parse_interrupt() {
        assert!(matches!(CommandParser::parse("/stop"), Some(BotCommand::Interrupt)));
        assert!(matches!(CommandParser::parse("/end"), Some(BotCommand::Interrupt)));
        assert!(matches!(CommandParser::parse("/停止"), Some(BotCommand::Interrupt)));
    }

    #[test]
    fn test_parse_status() {
        assert!(matches!(CommandParser::parse("/status"), Some(BotCommand::Status)));
        assert!(matches!(CommandParser::parse("/状态"), Some(BotCommand::Status)));
    }

    #[test]
    fn test_parse_path() {
        let cmd = CommandParser::parse("/path /home/user/project");
        assert!(matches!(
            cmd,
            Some(BotCommand::SetPath { path }) if path == "/home/user/project"
        ));

        let cmd = CommandParser::parse("/path");
        assert!(matches!(cmd, Some(BotCommand::GetPath)));
    }

    #[test]
    fn test_parse_restart() {
        assert!(matches!(CommandParser::parse("/restart"), Some(BotCommand::Restart)));
        assert!(matches!(CommandParser::parse("/rs"), Some(BotCommand::Restart)));
        assert!(matches!(CommandParser::parse("/重启"), Some(BotCommand::Restart)));
    }

    #[test]
    fn test_parse_resume() {
        assert!(matches!(CommandParser::parse("/resume"), Some(BotCommand::Resume)));
        assert!(matches!(CommandParser::parse("/继续"), Some(BotCommand::Resume)));
        assert!(matches!(CommandParser::parse("/恢复"), Some(BotCommand::Resume)));
    }

    #[test]
    fn test_non_command() {
        // 不以 / 开头
        assert!(CommandParser::parse("hello").is_none());

        // 普通消息
        assert!(CommandParser::parse("请帮我写代码").is_none());
    }

    #[test]
    fn test_unknown_command() {
        // 未知命令返回 None（作为普通消息处理）
        assert!(CommandParser::parse("/unknown").is_none());
    }

    #[test]
    fn test_conversation_state_preset() {
        let mut state = ConversationState::new("test");
        assert!(state.prompt_preset_id.is_none());

        state.prompt_preset_id = Some("preset-minimal".to_string());
        assert_eq!(state.prompt_preset_id, Some("preset-minimal".to_string()));

        state.reset();
        assert!(state.prompt_preset_id.is_none());
    }
}
