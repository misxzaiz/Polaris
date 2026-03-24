/*! 会话策略解析器
 *
 * 负责决定使用新会话还是复用现有会话
 */

use crate::models::scheduler::ScheduledTask;

/// 会话策略
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SessionStrategy {
    /// 每次新会话
    NewEachRun,
    /// 复用最近有效会话
    ReuseLatest,
}

/// 会话决策结果
#[derive(Debug, Clone)]
pub enum SessionDecision {
    /// 启动新会话
    StartNew,
    /// 复用现有会话
    Continue {
        session_id: String,
    },
}

/// 会话策略解析器
pub struct SessionStrategyResolver;

impl SessionStrategyResolver {
    /// 解析任务的会话策略
    ///
    /// # Arguments
    /// * `task` - 任务定义
    ///
    /// # Returns
    /// * 会话决策结果
    pub fn resolve(task: &ScheduledTask) -> SessionStrategy {
        if task.reuse_session {
            SessionStrategy::ReuseLatest
        } else {
            SessionStrategy::NewEachRun
        }
    }

    /// 决定使用哪种会话模式
    ///
    /// # Arguments
    /// * `task` - 任务定义
    ///
    /// # Returns
    /// * `SessionDecision::Continue` - 复用现有会话（如果存在且启用复用）
    /// * `SessionDecision::StartNew` - 启动新会话
    pub fn decide(task: &ScheduledTask) -> SessionDecision {
        let strategy = Self::resolve(task);

        match strategy {
            SessionStrategy::NewEachRun => SessionDecision::StartNew,
            SessionStrategy::ReuseLatest => {
                if let Some(ref session_id) = task.conversation_session_id {
                    if !session_id.is_empty() {
                        SessionDecision::Continue {
                            session_id: session_id.clone(),
                        }
                    } else {
                        SessionDecision::StartNew
                    }
                } else {
                    SessionDecision::StartNew
                }
            }
        }
    }

    /// 检查是否应该复用会话
    ///
    /// # Arguments
    /// * `task` - 任务定义
    ///
    /// # Returns
    /// * `true` - 应尝试复用会话
    pub fn should_reuse(task: &ScheduledTask) -> bool {
        task.reuse_session
            && task.conversation_session_id.is_some()
            && !task.conversation_session_id.as_ref().unwrap().is_empty()
    }

    /// 获取现有会话 ID（如果存在）
    ///
    /// # Arguments
    /// * `task` - 任务定义
    ///
    /// # Returns
    /// * `Some(session_id)` - 存在有效会话 ID
    /// * `None` - 无有效会话 ID
    pub fn get_existing_session_id(task: &ScheduledTask) -> Option<String> {
        if task.reuse_session {
            task.conversation_session_id.clone()
        } else {
            None
        }
    }

    /// 从错误中提取友好的错误信息
    ///
    /// # Arguments
    /// * `error` - 原始错误
    ///
    /// # Returns
    /// * 友好的错误信息
    pub fn extract_resume_error_message(error: &str) -> String {
        let message = error.trim();
        if message.is_empty() {
            "未知错误".to_string()
        } else {
            message.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::scheduler::TriggerType;

    fn create_test_task(reuse_session: bool, session_id: Option<&str>) -> ScheduledTask {
        ScheduledTask {
            id: "test-task".to_string(),
            name: "Test Task".to_string(),
            enabled: true,
            trigger_type: TriggerType::Interval,
            trigger_value: "1h".to_string(),
            engine_id: "claude-code".to_string(),
            prompt: String::new(),
            work_dir: None,
            group: None,
            description: None,
            task_path: None,
            mission: None,
            last_run_at: None,
            last_run_status: None,
            next_run_at: None,
            created_at: 0,
            updated_at: 0,
            max_runs: None,
            current_runs: 0,
            reuse_session,
            conversation_session_id: session_id.map(|s| s.to_string()),
            continue_immediately: false,
            max_continuous_runs: None,
            run_in_terminal: false,
            template_id: None,
            template_param_values: None,
            subscribed_context_id: None,
            max_retries: None,
            retry_count: 0,
            retry_interval: None,
            notify_on_complete: true,
            timeout_minutes: None,
            user_supplement: None,
            task_template: None,
            memory_template: None,
            tasks_template: None,
            runs_template: None,
            supplement_template: None,
        }
    }

    #[test]
    fn test_resolve_new_each_run() {
        let task = create_test_task(false, None);
        assert_eq!(SessionStrategyResolver::resolve(&task), SessionStrategy::NewEachRun);
    }

    #[test]
    fn test_resolve_reuse_latest() {
        let task = create_test_task(true, None);
        assert_eq!(SessionStrategyResolver::resolve(&task), SessionStrategy::ReuseLatest);
    }

    #[test]
    fn test_decide_start_new_no_reuse() {
        let task = create_test_task(false, Some("session-123"));
        match SessionStrategyResolver::decide(&task) {
            SessionDecision::StartNew => {}
            _ => panic!("Expected StartNew"),
        }
    }

    #[test]
    fn test_decide_continue_with_session() {
        let task = create_test_task(true, Some("session-123"));
        match SessionStrategyResolver::decide(&task) {
            SessionDecision::Continue { session_id } => {
                assert_eq!(session_id, "session-123");
            }
            _ => panic!("Expected Continue"),
        }
    }

    #[test]
    fn test_decide_start_new_empty_session() {
        let task = create_test_task(true, Some(""));
        match SessionStrategyResolver::decide(&task) {
            SessionDecision::StartNew => {}
            _ => panic!("Expected StartNew for empty session"),
        }
    }

    #[test]
    fn test_should_reuse_true() {
        let task = create_test_task(true, Some("session-123"));
        assert!(SessionStrategyResolver::should_reuse(&task));
    }

    #[test]
    fn test_should_reuse_false_no_session() {
        let task = create_test_task(true, None);
        assert!(!SessionStrategyResolver::should_reuse(&task));
    }

    #[test]
    fn test_should_reuse_false_not_enabled() {
        let task = create_test_task(false, Some("session-123"));
        assert!(!SessionStrategyResolver::should_reuse(&task));
    }

    #[test]
    fn test_extract_resume_error_message() {
        assert_eq!(
            SessionStrategyResolver::extract_resume_error_message("some error"),
            "some error"
        );
        assert_eq!(
            SessionStrategyResolver::extract_resume_error_message(""),
            "未知错误"
        );
        assert_eq!(
            SessionStrategyResolver::extract_resume_error_message("   "),
            "未知错误"
        );
    }
}
