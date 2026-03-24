/*! 连续执行判定器
 *
 * 负责判断任务是否应立即进入下一轮执行
 */

use crate::models::scheduler::ScheduledTask;

/// 连续执行判定器
pub struct ContinuationDecider;

impl ContinuationDecider {
    /// 判断是否应立即继续执行
    ///
    /// # 判定逻辑
    /// 1. 任务是否启用连续执行 (`continue_immediately`)
    /// 2. 是否达到最大连续轮次 (`max_continuous_runs`)
    ///
    /// # Arguments
    /// * `task` - 任务定义
    /// * `current_continuous_runs` - 当前连续执行轮次（从 1 开始）
    ///
    /// # Returns
    /// * `true` - 应立即继续执行
    /// * `false` - 不应继续，回到普通调度
    pub fn should_continue(task: &ScheduledTask, current_continuous_runs: u32) -> bool {
        // 未启用连续执行
        if !task.continue_immediately {
            return false;
        }

        // 检查是否达到上限
        match task.max_continuous_runs {
            Some(limit) => current_continuous_runs < limit,
            None => true, // 无上限限制
        }
    }

    /// 计算下一轮的连续执行计数
    ///
    /// # Arguments
    /// * `current` - 当前计数
    ///
    /// # Returns
    /// * 下一轮计数（当前计数 + 1）
    pub fn next_run_count(current: u32) -> u32 {
        current + 1
    }

    /// 检查是否为首次连续执行
    ///
    /// # Arguments
    /// * `continuous_runs` - 连续执行计数
    ///
    /// # Returns
    /// * `true` - 首次执行（计数为 1）
    pub fn is_first_run(continuous_runs: u32) -> bool {
        continuous_runs == 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::scheduler::TriggerType;

    fn create_test_task(continue_immediately: bool, max_continuous_runs: Option<u32>) -> ScheduledTask {
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
            last_run_outcome: None,
            next_run_at: None,
            created_at: 0,
            updated_at: 0,
            max_runs: None,
            current_runs: 0,
            reuse_session: false,
            conversation_session_id: None,
            continue_immediately,
            max_continuous_runs,
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
            blocked: false,
            blocked_reason: None,
            current_phase: None,
            last_effective_progress_at: None,
            protocol_version: None,
            session_last_used_at: None,
            consecutive_no_progress_count: 0,
        }
    }

    #[test]
    fn test_should_continue_disabled() {
        let task = create_test_task(false, Some(10));
        assert!(!ContinuationDecider::should_continue(&task, 1));
    }

    #[test]
    fn test_should_continue_within_limit() {
        let task = create_test_task(true, Some(5));
        assert!(ContinuationDecider::should_continue(&task, 1));
        assert!(ContinuationDecider::should_continue(&task, 4));
        assert!(!ContinuationDecider::should_continue(&task, 5));
        assert!(!ContinuationDecider::should_continue(&task, 6));
    }

    #[test]
    fn test_should_continue_no_limit() {
        let task = create_test_task(true, None);
        assert!(ContinuationDecider::should_continue(&task, 1));
        assert!(ContinuationDecider::should_continue(&task, 100));
        assert!(ContinuationDecider::should_continue(&task, 1000));
    }

    #[test]
    fn test_next_run_count() {
        assert_eq!(ContinuationDecider::next_run_count(1), 2);
        assert_eq!(ContinuationDecider::next_run_count(5), 6);
    }

    #[test]
    fn test_is_first_run() {
        assert!(ContinuationDecider::is_first_run(1));
        assert!(!ContinuationDecider::is_first_run(2));
        assert!(!ContinuationDecider::is_first_run(0));
    }
}
