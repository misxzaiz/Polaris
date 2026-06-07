/*! Simple AI 工具集
 *
 * Phase 2：把原先 `match name` 的工具分发升级为 **Tool trait + 注册表**。
 * 每个工具一个文件，实现 [`Tool`]，由 [`ToolRegistry`] 统一聚合 schema 与分发执行。
 * 新增工具无需改动 `chat_loop`。
 *
 * 工具清单：bash / read_file / write_file / list_directory / edit_file / search_files
 * / glob / apply_patch / update_plan。
 */

mod apply_patch;
mod bash;
mod fs;
mod plan;
mod search;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::Value;

use crate::models::AIEvent;

use apply_patch::ApplyPatchTool;
use bash::BashTool;
use fs::{EditFileTool, ListDirectoryTool, ReadFileTool, WriteFileTool};
use plan::UpdatePlanTool;
use search::{GlobTool, SearchFilesTool};

// ============================================================================
// 共享类型
// ============================================================================

/// 工具执行结果：`content` 始终作为 tool result 回传给模型；`success` 用于事件标记，
/// 让前端与模型都能区分工具成功/失败。
pub(crate) struct ToolOutcome {
    pub(crate) content: String,
    pub(crate) success: bool,
}

impl ToolOutcome {
    pub(crate) fn ok(content: impl Into<String>) -> Self {
        Self { content: content.into(), success: true }
    }
    pub(crate) fn fail(content: impl Into<String>) -> Self {
        Self { content: content.into(), success: false }
    }
}

/// 工具执行上下文。绝大多数工具只用 `work_dir`；`update_plan` 额外用到事件回调与计划状态。
pub(crate) struct ToolContext<'a> {
    /// 会话工作目录（相对路径以此为基准）
    pub work_dir: &'a str,
    /// 会话 ID（用于发事件）
    pub session_id: &'a str,
    /// 事件回调（update_plan 等带副作用的工具用于推送前端事件）
    pub event_callback: &'a Arc<dyn Fn(AIEvent) + Send + Sync>,
    /// 本轮计划面板的稳定 plan_id
    pub plan_id: &'a str,
    /// 本轮计划面板是否已创建（首次 update_plan 需先发 plan_start）
    pub plan_started: &'a AtomicBool,
}

/// 工具 trait。无状态（unit struct 实现），便于后续并行执行。
pub(crate) trait Tool: Send + Sync {
    /// 工具名（与 OpenAI function name 一致）
    fn name(&self) -> &'static str;
    /// OpenAI function calling schema（含 `{"type":"function","function":{...}}`）
    fn spec(&self) -> Value;
    /// 执行工具
    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutcome;
}

/// 安全截断到至多 `max_chars` 个字符（按字符边界，避免切断 UTF-8 多字节序列导致 panic）。
pub(crate) fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let head: String = s.chars().take(max_chars).collect();
        format!("{}\n... (truncated, total {} bytes)", head, s.len())
    }
}

// ============================================================================
// 注册表
// ============================================================================

/// 工具注册表：聚合所有内置工具，统一提供 schema 与分发。
pub(super) struct ToolRegistry {
    tools: Vec<Box<dyn Tool>>,
}

impl ToolRegistry {
    /// 构建内置工具集。
    pub(super) fn with_builtins() -> Self {
        Self {
            tools: vec![
                Box::new(BashTool),
                Box::new(ReadFileTool),
                Box::new(WriteFileTool),
                Box::new(ListDirectoryTool),
                Box::new(EditFileTool),
                Box::new(SearchFilesTool),
                Box::new(GlobTool),
                Box::new(ApplyPatchTool),
                Box::new(UpdatePlanTool),
            ],
        }
    }

    /// 全部工具的 OpenAI function schema（替代旧的 `builtin_tools()`）。
    pub(super) fn specs(&self) -> Vec<Value> {
        self.tools.iter().map(|t| t.spec()).collect()
    }

    /// 按名分发执行。未知工具返回失败结果（与旧行为一致）。
    pub(super) fn dispatch(&self, name: &str, args: &Value, ctx: &ToolContext) -> ToolOutcome {
        match self.tools.iter().find(|t| t.name() == name) {
            Some(tool) => tool.execute(args, ctx),
            None => ToolOutcome::fail(format!("Unknown tool: {}", name)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_chars_is_utf8_safe_and_char_bounded() {
        assert_eq!(truncate_chars("hello", 10), "hello");
        // 多字节字符按字符数截断且不 panic
        let out = truncate_chars("你好世界你好世界", 4);
        assert!(out.starts_with("你好世界"));
        assert!(out.contains("truncated"));
    }

    #[test]
    fn registry_exposes_all_builtins_and_dispatches_unknown() {
        let reg = ToolRegistry::with_builtins();
        let specs = reg.specs();
        assert_eq!(specs.len(), 9);
        let names: Vec<&str> = specs
            .iter()
            .map(|s| s["function"]["name"].as_str().unwrap())
            .collect();
        for expected in [
            "bash",
            "read_file",
            "write_file",
            "list_directory",
            "edit_file",
            "search_files",
            "glob",
            "apply_patch",
            "update_plan",
        ] {
            assert!(names.contains(&expected), "missing tool: {}", expected);
        }
    }
}
