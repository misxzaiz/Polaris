/*! Prompt 构建器
 *
 * 负责为协议任务构建执行提示词
 * 支持首次执行和续跑两种模式
 */

use crate::error::Result;
use super::ProtocolTaskService;

/// Prompt 类型
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PromptType {
    /// 首次执行 - 包含完整协议文档
    Initial,
    /// 续跑执行 - 更简洁，仅强调增量信息
    Continuation,
}

/// Prompt 构建器
pub struct PromptBuilder;

impl PromptBuilder {
    /// 构建协议任务提示词
    ///
    /// # Arguments
    /// * `work_dir` - 工作目录
    /// * `task_path` - 任务路径
    /// * `prompt_type` - 提示词类型（首次/续跑）
    /// * `previous_summary` - 上轮摘要（续跑模式时使用）
    pub fn build(
        work_dir: &str,
        task_path: &str,
        prompt_type: PromptType,
        previous_summary: Option<&str>,
    ) -> Result<String> {
        match prompt_type {
            PromptType::Initial => Self::build_initial_prompt(work_dir, task_path),
            PromptType::Continuation => {
                Self::build_continuation_prompt(work_dir, task_path, previous_summary.unwrap_or(""))
            }
        }
    }

    /// 构建首次执行提示词
    ///
    /// 包含完整协议文档、当前状态、待办任务和用户补充
    fn build_initial_prompt(work_dir: &str, task_path: &str) -> Result<String> {
        // 读取协议文档
        let protocol = ProtocolTaskService::read_task_md(work_dir, task_path)
            .map_err(crate::error::AppError::IoError)?;

        // 读取用户补充
        let supplement = ProtocolTaskService::read_supplement_md(work_dir, task_path)
            .unwrap_or_default();
        let has_supplement = ProtocolTaskService::has_supplement_content(&supplement);
        let supplement_content = if has_supplement {
            ProtocolTaskService::extract_user_content(&supplement)
        } else {
            String::new()
        };

        // 读取记忆
        let memory_index = ProtocolTaskService::read_memory_index(work_dir, task_path)
            .unwrap_or_default();
        let memory_tasks = ProtocolTaskService::read_memory_tasks(work_dir, task_path)
            .unwrap_or_default();

        // 构建提示词
        let mut prompt = protocol;

        prompt.push_str("\n\n---\n\n## 当前状态\n\n");
        prompt.push_str(&memory_index);

        prompt.push_str("\n\n---\n\n## 待办任务\n\n");
        prompt.push_str(&memory_tasks);

        if has_supplement {
            prompt.push_str("\n\n---\n\n## 用户补充\n\n> 以下内容来自用户补充，请结合主任务适当参考：\n\n");
            prompt.push_str(&supplement_content);
        }

        Ok(prompt)
    }

    /// 构建续跑提示词
    ///
    /// 更简洁，仅强调：
    /// - 这是同一任务的继续执行
    /// - 本轮新增补充
    /// - 当前优先事项
    /// - 明确本轮目标
    fn build_continuation_prompt(
        work_dir: &str,
        task_path: &str,
        previous_summary: &str,
    ) -> Result<String> {
        // 读取记忆（重点关注当前状态和待办）
        let memory_index = ProtocolTaskService::read_memory_index(work_dir, task_path)
            .unwrap_or_default();
        let memory_tasks = ProtocolTaskService::read_memory_tasks(work_dir, task_path)
            .unwrap_or_default();

        // 读取用户补充
        let supplement = ProtocolTaskService::read_supplement_md(work_dir, task_path)
            .unwrap_or_default();
        let has_supplement = ProtocolTaskService::has_supplement_content(&supplement);
        let supplement_content = if has_supplement {
            ProtocolTaskService::extract_user_content(&supplement)
        } else {
            String::new()
        };

        // 构建简洁的续跑提示词
        let mut prompt = String::new();

        prompt.push_str("# 继续执行\n\n");
        prompt.push_str("> 这是同一任务的继续执行。请继续推进任务，无需重复发送之前的协议全文。\n\n");

        if !previous_summary.is_empty() {
            prompt.push_str("## 上轮摘要\n\n");
            prompt.push_str(previous_summary);
            prompt.push_str("\n\n");
        }

        prompt.push_str("## 当前状态\n\n");
        prompt.push_str(&memory_index);

        prompt.push_str("\n\n---\n\n## 待办任务\n\n");
        prompt.push_str(&memory_tasks);

        if has_supplement {
            prompt.push_str("\n\n---\n\n## 用户补充\n\n> 以下内容来自用户补充，请结合主任务适当参考：\n\n");
            prompt.push_str(&supplement_content);
        }

        prompt.push_str("\n\n---\n\n## 本轮目标\n\n");
        prompt.push_str("请继续执行下一个待办事项，完成后更新记忆文档。\n");

        Ok(prompt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prompt_type_equality() {
        assert_eq!(PromptType::Initial, PromptType::Initial);
        assert_eq!(PromptType::Continuation, PromptType::Continuation);
        assert_ne!(PromptType::Initial, PromptType::Continuation);
    }
}
