/*! 执行结果分析器
 *
 * 负责分析任务执行结果，提供结构化判断能力
 */

use super::ProtocolTaskService;
use serde::{Deserialize, Serialize};

/// 执行结果类型
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum ExecutionOutcome {
    /// 成功且有实质进展
    SuccessWithProgress,
    /// 成功但无明显进展（可能需要继续执行）
    SuccessNoProgress,
    /// 部分成功（有错误但有进展）
    PartialSuccess,
    /// 失败
    Failed,
    /// 被阻塞（需要用户干预）
    Blocked(String),
    /// 连续无进展（可能陷入循环）
    ConsecutiveNoProgress(u32),
}

/// 默认最大连续无进展次数
pub const DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS: u32 = 3;

/// 执行结果分析器
pub struct ExecutionResultAnalyzer;

impl ExecutionResultAnalyzer {
    /// 分析执行结果
    ///
    /// # 判定逻辑
    /// 1. exit_code 非 0 → Failed
    /// 2. 检测 memory/index.md 阻塞状态 → Blocked
    /// 3. 分析输出内容是否有实质成果 → SuccessWithProgress / SuccessNoProgress
    ///
    /// # Arguments
    /// * `exit_code` - 进程退出码
    /// * `output` - AI 输出内容
    /// * `tool_call_count` - 工具调用次数
    /// * `work_dir` - 工作目录（可选）
    /// * `task_path` - 任务路径（可选）
    ///
    /// # Returns
    /// 执行结果类型
    pub fn analyze(
        exit_code: i32,
        output: &str,
        tool_call_count: u32,
        work_dir: Option<&str>,
        task_path: Option<&str>,
    ) -> ExecutionOutcome {
        // 1. 首先检查是否失败
        if exit_code != 0 {
            return ExecutionOutcome::Failed;
        }

        // 2. 检查是否被阻塞（协议任务）
        if let (Some(work_dir), Some(task_path)) = (work_dir, task_path) {
            if let Some(blocked_reason) = Self::detect_blocked(work_dir, task_path) {
                return ExecutionOutcome::Blocked(blocked_reason);
            }
        }

        // 3. 分析是否有实质进展
        if Self::has_effective_progress(output, tool_call_count) {
            ExecutionOutcome::SuccessWithProgress
        } else {
            ExecutionOutcome::SuccessNoProgress
        }
    }

    /// 分析执行结果（带连续无进展检测）
    ///
    /// 在基础分析之上，增加连续无进展次数的考量
    ///
    /// # Arguments
    /// * `exit_code` - 进程退出码
    /// * `output` - AI 输出内容
    /// * `tool_call_count` - 工具调用次数
    /// * `work_dir` - 工作目录（可选）
    /// * `task_path` - 任务路径（可选）
    /// * `consecutive_no_progress_count` - 当前连续无进展次数
    /// * `max_consecutive_no_progress` - 最大允许连续无进展次数
    ///
    /// # Returns
    /// 执行结果类型
    pub fn analyze_with_consecutive_check(
        exit_code: i32,
        output: &str,
        tool_call_count: u32,
        work_dir: Option<&str>,
        task_path: Option<&str>,
        consecutive_no_progress_count: u32,
        max_consecutive_no_progress: Option<u32>,
    ) -> ExecutionOutcome {
        // 基础分析
        let base_outcome = Self::analyze(exit_code, output, tool_call_count, work_dir, task_path);

        // 如果是成功但无进展，检查连续次数
        if matches!(base_outcome, ExecutionOutcome::SuccessNoProgress) {
            let max_allowed = max_consecutive_no_progress.unwrap_or(DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS);
            if consecutive_no_progress_count >= max_allowed {
                return ExecutionOutcome::ConsecutiveNoProgress(consecutive_no_progress_count);
            }
        }

        base_outcome
    }

    /// 检测任务是否被阻塞
    ///
    /// 解析 memory/index.md 中的 `## 当前阻塞` 部分
    ///
    /// # Arguments
    /// * `work_dir` - 工作目录
    /// * `task_path` - 任务路径
    ///
    /// # Returns
    /// * `Some(String)` - 阻塞原因
    /// * `None` - 未阻塞
    pub fn detect_blocked(work_dir: &str, task_path: &str) -> Option<String> {
        let content = ProtocolTaskService::read_memory_index(work_dir, task_path).ok()?;

        // 查找 ## 当前阻塞 部分
        let mut in_blocked_section = false;
        let mut blocked_lines: Vec<String> = Vec::new();

        for line in content.lines() {
            let trimmed = line.trim();

            // 检测章节标题
            if trimmed.starts_with("## ") {
                if trimmed == "## 当前阻塞" {
                    in_blocked_section = true;
                    continue;
                } else if in_blocked_section {
                    // 进入下一个章节，停止收集
                    break;
                }
            }

            // 收集阻塞内容
            if in_blocked_section {
                // 跳过空行和 "[暂无]" 标记
                if trimmed.is_empty() || trimmed == "- [暂无]" {
                    continue;
                }
                // 收集有意义的阻塞原因
                if trimmed.starts_with("- ") {
                    let reason = trimmed.trim_start_matches("- ").trim();
                    if !reason.is_empty() && reason != "[暂无]" {
                        blocked_lines.push(reason.to_string());
                    }
                }
            }
        }

        if blocked_lines.is_empty() {
            None
        } else {
            Some(blocked_lines.join("; "))
        }
    }

    /// 提取当前阶段
    ///
    /// 解析 memory/index.md 中的 `当前阶段` 字段
    ///
    /// # Arguments
    /// * `work_dir` - 工作目录
    /// * `task_path` - 任务路径
    ///
    /// # Returns
    /// * `Some(String)` - 当前阶段
    /// * `None` - 无法提取
    pub fn extract_current_phase(work_dir: &str, task_path: &str) -> Option<String> {
        let content = ProtocolTaskService::read_memory_index(work_dir, task_path).ok()?;

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("当前阶段:") {
                let phase = trimmed
                    .trim_start_matches("当前阶段:")
                    .trim();
                if !phase.is_empty() {
                    return Some(phase.to_string());
                }
            }
        }

        None
    }

    /// 提取当前进度
    ///
    /// 解析 memory/index.md 中的 `进度` 字段
    ///
    /// # Arguments
    /// * `work_dir` - 工作目录
    /// * `task_path` - 任务路径
    ///
    /// # Returns
    /// * `Some(u8)` - 进度百分比 (0-100)
    /// * `None` - 无法提取
    pub fn extract_progress(work_dir: &str, task_path: &str) -> Option<u8> {
        let content = ProtocolTaskService::read_memory_index(work_dir, task_path).ok()?;

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("进度:") {
                let progress_str = trimmed
                    .trim_start_matches("进度:")
                    .trim()
                    .trim_end_matches('%');
                if let Ok(value) = progress_str.parse::<u8>() {
                    return Some(value.min(100));
                }
            }
        }

        None
    }

    /// 判断是否有实质进展
    ///
    /// # 判定标准
    /// 1. 工具调用次数 > 0（表示 AI 做了实际操作）
    /// 2. 输出包含成果描述关键词
    /// 3. 输出长度超过阈值
    ///
    /// # Arguments
    /// * `output` - AI 输出内容
    /// * `tool_call_count` - 工具调用次数
    ///
    /// # Returns
    /// * `true` - 有实质进展
    /// * `false` - 无明显进展
    fn has_effective_progress(output: &str, tool_call_count: u32) -> bool {
        // 工具调用表示有实际操作
        if tool_call_count > 0 {
            return true;
        }

        // 输出长度检查（少于 100 字符可能是简单回复）
        if output.len() < 100 {
            return false;
        }

        // 检查是否包含成果关键词
        let progress_keywords = [
            "完成",
            "实现",
            "修复",
            "添加",
            "更新",
            "创建",
            "删除",
            "重构",
            "优化",
            "成功",
            "resolved",
            "completed",
            "implemented",
            "fixed",
            "added",
            "updated",
            "created",
            "deleted",
            "refactored",
        ];

        let output_lower = output.to_lowercase();
        for keyword in &progress_keywords {
            if output_lower.contains(keyword) {
                return true;
            }
        }

        // 检查是否包含文件操作描述
        let file_patterns = [
            ".rs",
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".py",
            ".json",
            ".md",
            "src/",
            "lib/",
            "tests/",
        ];

        for pattern in &file_patterns {
            if output.contains(pattern) {
                return true;
            }
        }

        false
    }

    /// 判断连续执行是否应该停止
    ///
    /// # 判定逻辑
    /// 1. 失败 → 停止
    /// 2. 阻塞状态 → 停止
    /// 3. 连续无进展次数超限 → 停止
    /// 4. 任务已完成 → 停止
    /// 5. 无增量检测（连续两轮成果相似）→ 停止
    ///
    /// # Arguments
    /// * `outcome` - 执行结果
    /// * `work_dir` - 工作目录
    /// * `task_path` - 任务路径
    ///
    /// # Returns
    /// * `true` - 应该停止连续执行
    /// * `false` - 可以继续
    pub fn should_stop_continuation(
        outcome: &ExecutionOutcome,
        work_dir: Option<&str>,
        task_path: Option<&str>,
    ) -> bool {
        match outcome {
            ExecutionOutcome::Failed => true,
            ExecutionOutcome::Blocked(_) => true,
            ExecutionOutcome::ConsecutiveNoProgress(count) => {
                tracing::warn!("[Scheduler] 连续 {} 次无进展，停止连续执行", count);
                true
            }
            ExecutionOutcome::SuccessNoProgress => {
                // 单次无进展暂时允许继续，由 consecutive_no_progress_count 控制
                false
            }
            ExecutionOutcome::SuccessWithProgress | ExecutionOutcome::PartialSuccess => {
                // 检查任务是否已完成
                if let (Some(work_dir), Some(task_path)) = (work_dir, task_path) {
                    Self::is_task_completed(work_dir, task_path)
                } else {
                    false
                }
            }
        }
    }

    /// 判断连续执行是否应该停止（增强版，带无增量检测）
    ///
    /// # 判定逻辑
    /// 在基础判断之上，增加无增量检测：
    /// - 对比当前执行成果与最近一轮的成果
    /// - 如果连续两轮成果高度相似，表示可能陷入重复模式
    ///
    /// # Arguments
    /// * `outcome` - 执行结果
    /// * `work_dir` - 工作目录
    /// * `task_path` - 任务路径
    /// * `current_run_summary` - 当前轮次的成果摘要
    /// * `similarity_threshold` - 相似度阈值（0.0-1.0），超过则认为无增量
    ///
    /// # Returns
    /// * `true` - 应该停止连续执行
    /// * `false` - 可以继续
    pub fn should_stop_continuation_with_increment_check(
        outcome: &ExecutionOutcome,
        work_dir: Option<&str>,
        task_path: Option<&str>,
        current_run_summary: Option<&str>,
        similarity_threshold: Option<f32>,
    ) -> bool {
        // 基础判断
        if Self::should_stop_continuation(outcome, work_dir, task_path) {
            return true;
        }

        // 只对有进展的结果进行无增量检测
        if !matches!(
            outcome,
            ExecutionOutcome::SuccessWithProgress | ExecutionOutcome::PartialSuccess
        ) {
            return false;
        }

        // 无增量检测
        if let (Some(work_dir), Some(task_path), Some(current_summary)) =
            (work_dir, task_path, current_run_summary)
        {
            let threshold = similarity_threshold.unwrap_or(0.7);
            if Self::has_no_increment(work_dir, task_path, current_summary, threshold) {
                tracing::warn!("[Scheduler] 检测到无增量进展，停止连续执行");
                return true;
            }
        }

        false
    }

    /// 检测是否有增量进展
    ///
    /// 对比当前轮次成果与最近一轮成果，判断是否有实质新增
    ///
    /// # Arguments
    /// * `work_dir` - 工作目录
    /// * `task_path` - 任务路径
    /// * `current_summary` - 当前轮次成果摘要
    /// * `threshold` - 相似度阈值
    ///
    /// # Returns
    /// * `true` - 无增量（高度相似）
    /// * `false` - 有增量
    pub fn has_no_increment(
        work_dir: &str,
        task_path: &str,
        current_summary: &str,
        threshold: f32,
    ) -> bool {
        // 获取最近一轮成果
        let last_summary = match ProtocolTaskService::get_latest_run_summary(work_dir, task_path) {
            Some(s) => s,
            None => return false, // 没有历史记录，无法比较
        };

        // 计算相似度
        let similarity = Self::calculate_text_similarity(&last_summary, current_summary);

        if similarity >= threshold {
            tracing::debug!(
                "[Scheduler] 成果相似度 {} >= {}，可能无增量进展",
                similarity,
                threshold
            );
            true
        } else {
            false
        }
    }

    /// 计算文本相似度（基于 Jaccard 相似度）
    ///
    /// 使用词集合的交集/并集来衡量相似度
    ///
    /// # Arguments
    /// * `text1` - 文本1
    /// * `text2` - 文本2
    ///
    /// # Returns
    /// 相似度值 (0.0 - 1.0)
    fn calculate_text_similarity(text1: &str, text2: &str) -> f32 {
        // 简单分词：按空格和常见标点分割，返回 String 集合避免生命周期问题
        let tokenize = |text: &str| -> std::collections::HashSet<String> {
            text.split(|c: char| c.is_whitespace() || "，。、；：！？,.;:!?\n".contains(c))
                .filter(|s| !s.is_empty() && s.len() > 1) // 过滤单字和空串
                .map(|s| s.to_string())
                .collect()
        };

        let set1 = tokenize(text1);
        let set2 = tokenize(text2);

        if set1.is_empty() && set2.is_empty() {
            return 1.0; // 都为空，认为完全相似
        }
        if set1.is_empty() || set2.is_empty() {
            return 0.0; // 一个为空，不相似
        }

        // 计算 Jaccard 相似度
        let intersection = set1.intersection(&set2).count();
        let union = set1.union(&set2).count();

        intersection as f32 / union as f32
    }

    /// 检查任务是否已完成
    ///
    /// 解析 memory/index.md 中的状态字段
    ///
    /// # Arguments
    /// * `work_dir` - 工作目录
    /// * `task_path` - 任务路径
    ///
    /// # Returns
    /// * `true` - 任务已完成
    /// * `false` - 任务未完成
    pub fn is_task_completed(work_dir: &str, task_path: &str) -> bool {
        let content = match ProtocolTaskService::read_memory_index(work_dir, task_path) {
            Ok(c) => c,
            Err(_) => return false,
        };

        // 查找状态字段
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("状态:") {
                let status = trimmed
                    .trim_start_matches("状态:")
                    .trim();
                return status == "已完成";
            }
        }

        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use chrono::Local;

    fn create_temp_task_dir() -> (PathBuf, String) {
        let unique = format!("polaris-exec-result-{}", Local::now().timestamp_nanos_opt().unwrap_or_default());
        let temp_dir = std::env::temp_dir().join(&unique);
        let task_path = ".polaris/tasks/20260324092458";
        let memory_dir = temp_dir.join(task_path).join("memory");
        fs::create_dir_all(&memory_dir).unwrap();
        (temp_dir, task_path.to_string())
    }

    fn cleanup_temp_dir(path: &PathBuf) {
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn test_analyze_failed() {
        let outcome = ExecutionResultAnalyzer::analyze(1, "error", 0, None, None);
        assert_eq!(outcome, ExecutionOutcome::Failed);
    }

    #[test]
    fn test_analyze_success_with_tool_calls() {
        let outcome = ExecutionResultAnalyzer::analyze(0, "done", 5, None, None);
        assert_eq!(outcome, ExecutionOutcome::SuccessWithProgress);
    }

    #[test]
    fn test_analyze_success_with_progress_keywords() {
        // 需要足够长的输出（>= 100 字节）且包含进度关键词
        let output = "我已经完成了功能的实现，代码已更新到 src/main.rs 文件中。\
                      本次修改包括：添加了新的 API 接口，更新了相关测试用例。\
                      所有变更已通过 cargo check 验证。";
        let outcome = ExecutionResultAnalyzer::analyze(0, output, 0, None, None);
        assert_eq!(outcome, ExecutionOutcome::SuccessWithProgress);
    }

    #[test]
    fn test_analyze_success_no_progress() {
        let output = "好的，我了解了。"; // 短输出，无关键词
        let outcome = ExecutionResultAnalyzer::analyze(0, output, 0, None, None);
        assert_eq!(outcome, ExecutionOutcome::SuccessNoProgress);
    }

    #[test]
    fn test_detect_blocked_with_reason() {
        let (temp_dir, task_path) = create_temp_task_dir();
        let memory_content = r#"# 成果索引

## 当前状态
状态: 进行中

## 当前阻塞
- 等待用户确认设计方案
- API 接口尚未返回
"#;
        fs::write(temp_dir.join(&task_path).join("memory/index.md"), memory_content).unwrap();

        let blocked_reason = ExecutionResultAnalyzer::detect_blocked(
            temp_dir.to_str().unwrap(),
            &task_path,
        );

        assert!(blocked_reason.is_some());
        let reason = blocked_reason.unwrap();
        assert!(reason.contains("等待用户确认设计方案"));
        assert!(reason.contains("API 接口尚未返回"));

        cleanup_temp_dir(&temp_dir);
    }

    #[test]
    fn test_detect_blocked_no_block() {
        let (temp_dir, task_path) = create_temp_task_dir();
        let memory_content = r#"# 成果索引

## 当前状态
状态: 进行中

## 当前阻塞
- [暂无]
"#;
        fs::write(temp_dir.join(&task_path).join("memory/index.md"), memory_content).unwrap();

        let blocked_reason = ExecutionResultAnalyzer::detect_blocked(
            temp_dir.to_str().unwrap(),
            &task_path,
        );

        assert!(blocked_reason.is_none());

        cleanup_temp_dir(&temp_dir);
    }

    #[test]
    fn test_extract_current_phase() {
        let (temp_dir, task_path) = create_temp_task_dir();
        let memory_content = r#"# 成果索引

## 当前状态
状态: 进行中
当前阶段: 开发
进度: 35%
"#;
        fs::write(temp_dir.join(&task_path).join("memory/index.md"), memory_content).unwrap();

        let phase = ExecutionResultAnalyzer::extract_current_phase(
            temp_dir.to_str().unwrap(),
            &task_path,
        );

        assert_eq!(phase, Some("开发".to_string()));

        cleanup_temp_dir(&temp_dir);
    }

    #[test]
    fn test_extract_progress() {
        let (temp_dir, task_path) = create_temp_task_dir();
        let memory_content = r#"# 成果索引

## 当前状态
状态: 进行中
进度: 42%
"#;
        fs::write(temp_dir.join(&task_path).join("memory/index.md"), memory_content).unwrap();

        let progress = ExecutionResultAnalyzer::extract_progress(
            temp_dir.to_str().unwrap(),
            &task_path,
        );

        assert_eq!(progress, Some(42));

        cleanup_temp_dir(&temp_dir);
    }

    #[test]
    fn test_is_task_completed() {
        let (temp_dir, task_path) = create_temp_task_dir();
        
        // 测试已完成状态
        let memory_content = r#"# 成果索引

## 当前状态
状态: 已完成
"#;
        fs::write(temp_dir.join(&task_path).join("memory/index.md"), memory_content).unwrap();

        assert!(ExecutionResultAnalyzer::is_task_completed(
            temp_dir.to_str().unwrap(),
            &task_path,
        ));

        // 测试进行中状态
        let memory_content2 = r#"# 成果索引

## 当前状态
状态: 进行中
"#;
        fs::write(temp_dir.join(&task_path).join("memory/index.md"), memory_content2).unwrap();

        assert!(!ExecutionResultAnalyzer::is_task_completed(
            temp_dir.to_str().unwrap(),
            &task_path,
        ));

        cleanup_temp_dir(&temp_dir);
    }

    #[test]
    fn test_should_stop_continuation_blocked() {
        let outcome = ExecutionOutcome::Blocked("等待确认".to_string());
        assert!(ExecutionResultAnalyzer::should_stop_continuation(&outcome, None, None));
    }

    #[test]
    fn test_should_stop_continuation_failed() {
        let outcome = ExecutionOutcome::Failed;
        assert!(ExecutionResultAnalyzer::should_stop_continuation(&outcome, None, None));
    }

    #[test]
    fn test_should_stop_continuation_task_completed() {
        let (temp_dir, task_path) = create_temp_task_dir();
        let memory_content = r#"# 成果索引

## 当前状态
状态: 已完成
"#;
        fs::write(temp_dir.join(&task_path).join("memory/index.md"), memory_content).unwrap();

        let outcome = ExecutionOutcome::SuccessWithProgress;
        let should_stop = ExecutionResultAnalyzer::should_stop_continuation(
            &outcome,
            Some(temp_dir.to_str().unwrap()),
            Some(&task_path),
        );

        assert!(should_stop);

        cleanup_temp_dir(&temp_dir);
    }

    #[test]
    fn test_should_stop_continuation_consecutive_no_progress() {
        let outcome = ExecutionOutcome::ConsecutiveNoProgress(3);
        assert!(ExecutionResultAnalyzer::should_stop_continuation(&outcome, None, None));
    }

    #[test]
    fn test_analyze_with_consecutive_check() {
        // 测试连续无进展检测
        let outcome = ExecutionResultAnalyzer::analyze_with_consecutive_check(
            0,
            "好的，我知道了",
            0,
            None,
            None,
            3, // consecutive_no_progress_count
            Some(3), // max_consecutive_no_progress
        );
        assert_eq!(outcome, ExecutionOutcome::ConsecutiveNoProgress(3));

        // 测试未达到上限
        let outcome2 = ExecutionResultAnalyzer::analyze_with_consecutive_check(
            0,
            "好的，我知道了",
            0,
            None,
            None,
            2, // consecutive_no_progress_count
            Some(3), // max_consecutive_no_progress
        );
        assert_eq!(outcome2, ExecutionOutcome::SuccessNoProgress);
    }

    #[test]
    fn test_calculate_text_similarity_identical() {
        let text1 = "完成了功能的实现";
        let text2 = "完成了功能的实现";
        let similarity = ExecutionResultAnalyzer::calculate_text_similarity(text1, text2);
        assert!((similarity - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_calculate_text_similarity_different() {
        let text1 = "完成了功能的实现";
        let text2 = "修复了页面的样式问题";
        let similarity = ExecutionResultAnalyzer::calculate_text_similarity(text1, text2);
        assert!(similarity < 0.5);
    }

    #[test]
    fn test_calculate_text_similarity_partial() {
        let text1 = "完成了功能的实现，修复了若干问题";
        let text2 = "完成了功能的实现，添加了新特性";
        let similarity = ExecutionResultAnalyzer::calculate_text_similarity(text1, text2);
        // 应该有部分相似
        assert!(similarity > 0.3 && similarity < 0.9);
    }

    #[test]
    fn test_has_no_increment_high_similarity() {
        let (temp_dir, task_path) = create_temp_task_dir();
        
        // 写入最近一轮成果
        let runs_content = r#"# 执行轮次记录

## Run 1
- 完成事项: 实现了用户登录功能
- 遗留事项: 无
"#;
        fs::write(temp_dir.join(&task_path).join("memory/runs.md"), runs_content).unwrap();

        // 当前轮次成果与之前高度相似
        let current_summary = "- 完成事项: 实现了用户登录功能\n- 遗留事项: 无";
        let has_no_increment = ExecutionResultAnalyzer::has_no_increment(
            temp_dir.to_str().unwrap(),
            &task_path,
            current_summary,
            0.7,
        );

        assert!(has_no_increment);

        cleanup_temp_dir(&temp_dir);
    }

    #[test]
    fn test_has_no_increment_low_similarity() {
        let (temp_dir, task_path) = create_temp_task_dir();
        
        // 写入最近一轮成果
        let runs_content = r#"# 执行轮次记录

## Run 1
- 完成事项: 实现了用户登录功能
- 遗留事项: 无
"#;
        fs::write(temp_dir.join(&task_path).join("memory/runs.md"), runs_content).unwrap();

        // 当前轮次成果与之前不同
        let current_summary = "- 完成事项: 实现了支付模块和订单系统\n- 遗留事项: 需要测试";
        let has_no_increment = ExecutionResultAnalyzer::has_no_increment(
            temp_dir.to_str().unwrap(),
            &task_path,
            current_summary,
            0.7,
        );

        assert!(!has_no_increment);

        cleanup_temp_dir(&temp_dir);
    }
}
