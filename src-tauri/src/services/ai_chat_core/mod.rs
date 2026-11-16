/*! AI 聊天业务核（第七步阶段 A1：自 commands/chat.rs 抽出，传输无关）
 *
 * 全部函数仅依赖 '&crate::AppState' 与回调参数（ChatCallbacks/AppPaths），
 * 不含任何 Tauri 类型；事件经 'broadcast_chat_event'（EventBroadcaster）出站，
 * 桌面 Tauri 事件由 lib.rs 的 chat-event 中继任务镜像（见 step7-consolidation.md）。
 *
 * 入口：cap.ai.chat（dispatch/dispatch_stream）——命令层包装已摘除。
 */

/*! 聊天命令模块
 *
 * 提供统一的 AI 聊天接口，使用 EngineRegistry 管理多种 AI 引擎。
 */

//! K-R6 拆分：原 2,928 行单文件按分区目录化。对外路径
pub mod attachments;
pub mod callbacks;
pub mod continue_chat;
pub mod events;
pub mod interrupt;
pub mod ask_question;
pub mod plan_mode;
pub mod profile_options;
pub mod provider_routing;
pub mod send_input;
pub mod start_chat;
pub mod types;

pub use attachments::process_attachments;
pub use callbacks::{AppPaths, ChatCallbacks};
pub use continue_chat::continue_chat_inner;
pub use interrupt::interrupt_chat_inner;
pub use ask_question::{
    answer_question, clear_answered_questions, get_pending_questions,
    register_pending_question, respond_plugin_card, PluginCardResponse,
};
pub use plan_mode::{
    approve_plan, clear_processed_plans, get_pending_plans, register_pending_plan,
    reject_plan,
};
pub use events::append_session_event;
pub use send_input::send_input;
pub use start_chat::start_chat_inner;
pub use types::{Attachment, ChatRequestOptions};

#[cfg(test)]
mod route_failover_tests {
    use super::provider_routing::*;
    use crate::models::config::{FailoverPattern, GroupMember, ProviderGroup, RouteStrategy};

        use super::*;
    use crate::models::config::{
        FailoverPattern, GroupMember, ProviderGroup, RouteStrategy,
    };

    fn group_with_defaults(members: Vec<GroupMember>) -> ProviderGroup {
        ProviderGroup {
            id: "g".into(),
            name: "g".into(),
            strategy: RouteStrategy::Failover,
            members,
            failover_on: vec![],
            first_token_timeout_secs: None,
            max_failover_attempts: 3,
            active: true,
            default_model: None,
            target_engines: vec![],
            description: None,
            category: None,
        }
    }

    // === extract_http_status ===

    #[test]
    fn extract_status_4xx_5xx() {
        assert_eq!(extract_http_status("error 401 unauthorized"), Some(401));
        assert_eq!(extract_http_status("HTTP 502 bad gateway"), Some(502));
        assert_eq!(extract_http_status("got 429 too many requests"), Some(429));
    }

    #[test]
    fn extract_status_skips_port_numbers() {
        // "8080" 是 4 位，不应被抓为状态码
        assert_eq!(extract_http_status("port 8080 connection refused"), None);
        // "808" 虽是 3 位但 8 开头不在 4xx/5xx 段
        assert_eq!(extract_http_status("binding 808 failed"), None);
    }

    #[test]
    fn extract_status_digit_boundary() {
        // 前后须为非数字边界
        assert_eq!(extract_http_status("port 5000 err"), None); // 500 后有 0，是 5000
        assert_eq!(extract_http_status("code=403"), Some(403));
    }

    // === is_failoverable_spawn_err ===

    #[test]
    fn failover_on_401_with_default_patterns() {
        let g = group_with_defaults(vec![GroupMember {
            profile_id: "p".into(),
            priority: 0,
            weight: 1,
            keys: None,
            key_strategy: RouteStrategy::RoundRobin,
            key_weights: None,
        }]);
        let err = AppError::ProcessError("请求失败 401 Unauthorized".into());
        assert!(is_failoverable_spawn_err(&err, &g));
    }

    #[test]
    fn failover_on_connection_refused() {
        let g = group_with_defaults(vec![GroupMember {
            profile_id: "p".into(),
            priority: 0,
            weight: 1,
            keys: None,
            key_strategy: RouteStrategy::RoundRobin,
            key_weights: None,
        }]);
        let err = AppError::ProcessError("启动 Claude 进程失败: Connection refused".into());
        assert!(is_failoverable_spawn_err(&err, &g));
    }

    #[test]
    fn no_failover_on_hard_error_command_too_long() {
        let g = group_with_defaults(vec![GroupMember {
            profile_id: "p".into(),
            priority: 0,
            weight: 1,
            keys: None,
            key_strategy: RouteStrategy::RoundRobin,
            key_weights: None,
        }]);
        let err = AppError::ProcessError("命令行参数总长度超过 32767 字符".into());
        assert!(!is_failoverable_spawn_err(&err, &g));
    }

    #[test]
    fn no_failover_on_session_exists() {
        let g = group_with_defaults(vec![GroupMember {
            profile_id: "p".into(),
            priority: 0,
            weight: 1,
            keys: None,
            key_strategy: RouteStrategy::RoundRobin,
            key_weights: None,
        }]);
        let err = AppError::ProcessError("session 已存在".into());
        assert!(!is_failoverable_spawn_err(&err, &g));
    }

    #[test]
    fn custom_failover_patterns_respected() {
        // 用户自定义只匹配 "api key invalid" stderr 模式
        let g = ProviderGroup {
            failover_on: vec![FailoverPattern::StderrContains {
                pattern: "api key invalid".into(),
            }],
            ..group_with_defaults(vec![GroupMember {
                profile_id: "p".into(),
                priority: 0,
                weight: 1,
                keys: None,
                key_strategy: RouteStrategy::RoundRobin,
                key_weights: None,
            }])
        };
        // 命中自定义模式
        assert!(is_failoverable_spawn_err(
            &AppError::ProcessError("Error: API KEY INVALID".into()),
            &g
        ));
        // 不在自定义模式里 → 即使是 401 也不 failover（用户显式限定模式集）
        assert!(!is_failoverable_spawn_err(
            &AppError::ProcessError("401 unauthorized".into()),
            &g
        ));
    }

    // === resolve_profile_target（ProfileMode 三态决策，PRD B1-B5） ===

    #[test]
    fn b1_official_forces_official_even_with_active_group_and_profile() {
        // B1: profile_mode=Official + 激活分组 + 有 model_profile_id → 强制官方
        let target = resolve_profile_target(
            Some(ProfileMode::Official),
            Some("pid-A"),
            true, // 有激活分组
        );
        assert_eq!(target, ResolvedTarget::Official);
    }

    #[test]
    fn b2_group_without_active_group_falls_back_to_global_active() {
        // B2: profile_mode=Group + 无激活分组 → 回退全局 active Profile
        let target = resolve_profile_target(Some(ProfileMode::Group), None, false);
        assert_eq!(target, ResolvedTarget::GlobalActive);
    }

    #[test]
    fn b3_missing_mode_with_model_profile_id_prefers_profile_over_group() {
        // B3: profile_mode=None + model_profile_id=A + 激活分组 → 用 A（向前兼容显式 Profile）
        let target = resolve_profile_target(None, Some("pid-A"), true);
        assert_eq!(target, ResolvedTarget::ExplicitProfile("pid-A".into()));
    }

    #[test]
    fn b4_missing_mode_without_profile_uses_group() {
        // B4: profile_mode=None + 无 model_profile_id + 激活分组 → 走分组
        let target = resolve_profile_target(None, None, true);
        assert_eq!(target, ResolvedTarget::Group);
    }

    #[test]
    fn b5_profile_mode_profile_with_model_profile_id_uses_that_profile() {
        // B5: profile_mode=Profile + model_profile_id=A → 用 A
        let target = resolve_profile_target(Some(ProfileMode::Profile), Some("pid-A"), true);
        assert_eq!(target, ResolvedTarget::ExplicitProfile("pid-A".into()));
    }

    #[test]
    fn group_mode_ignores_model_profile_id() {
        // 契约保护：profile_mode=Group + model_profile_id=A → 忽略 A，走分组
        let target = resolve_profile_target(Some(ProfileMode::Group), Some("pid-A"), true);
        assert_eq!(target, ResolvedTarget::Group);
    }

    #[test]
    fn missing_mode_without_profile_without_group_uses_global_active() {
        // profile_mode=None + 无 model_profile_id + 无激活分组 → 回退全局 active
        let target = resolve_profile_target(None, None, false);
        assert_eq!(target, ResolvedTarget::GlobalActive);
    }
}
