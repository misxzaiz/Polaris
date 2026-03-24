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

    fn create_test_task(continue_immediately: bool, max_continuous_runs: Option<u32>) -> ScheduledTask {
        ScheduledTask {
            continue_immediately,
            max_continuous_runs,
            ..Default::default()
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
