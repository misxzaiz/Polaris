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
mod agent;
mod bash;
#[cfg(windows)]
mod computer;
mod fs;
mod plan;
mod search;
mod skill;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::models::AIEvent;

use agent::DispatchAgentTool;
use apply_patch::ApplyPatchTool;
use bash::BashTool;
use fs::{EditFileTool, ListDirectoryTool, ReadFileTool, WriteFileTool};
use plan::UpdatePlanTool;
use search::{GlobTool, SearchFilesTool};
use skill::ReadSkillTool;

use super::skill::SkillEntry;

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

/// 工具执行上下文。绝大多数工具只用 `work_dir`；`update_plan` 额外用到事件回调与计划状态，
/// `read_skill` 用 `skills` 索引按需读全文，`dispatch_agent`（Phase 5）用 profile/mcp_servers/depth
/// spawn 子会话。
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
    /// 已加载的 skill 索引（Phase 4c：read_skill 工具按名查全文）
    pub skills: &'a HashMap<String, SkillEntry>,
    /// 当前会话的 ModelProfile（Phase 5：dispatch_agent 子会话复用）
    pub profile: &'a crate::models::config::ModelProfile,
    /// 当前会话的 MCP server 列表（Phase 5：子会话复用父 pool 输入）
    pub mcp_servers: &'a [crate::services::mcp_config_service::ResolvedExternalMcpServer],
    /// 子代理递归深度（Phase 5：0=顶层，超 SUBAGENT_MAX_DEPTH 拒绝）
    pub subagent_depth: u32,
}

/// 子代理最大递归深度（Phase 5）。
pub(crate) const SUBAGENT_MAX_DEPTH: u32 = 3;

/// 工具 trait。无状态（unit struct 实现），便于后续并行执行。
///
/// `execute` 为 `async fn`（Phase 4a 异步化）：MCP 工具与 subagent 需要异步 IO，
/// 内置同步工具（bash / computer）用 `tokio::task::spawn_blocking` 包裹长任务，
/// 短 IO 工具（fs / search / apply_patch / plan）直接在 async 体内同步执行。
#[async_trait]
pub(crate) trait Tool: Send + Sync {
    /// 工具名（与 OpenAI function name 一致）
    fn name(&self) -> &'static str;
    /// OpenAI function calling schema（含 `{"type":"function","function":{...}}`）
    fn spec(&self) -> Value;
    /// 执行工具
    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome;
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
    /// 可选的 MCP 工具池（Phase 4b）：内置工具未命中时按 `mcp__{srv}__{tool}` 路由。
    mcp_pool: Option<Arc<super::mcp::McpClientPool>>,
}

impl ToolRegistry {
    /// 构建内置工具集。
    pub(super) fn with_builtins() -> Self {
        let mut tools: Vec<Box<dyn Tool>> = vec![
            Box::new(BashTool),
            Box::new(ReadFileTool),
            Box::new(WriteFileTool),
            Box::new(ListDirectoryTool),
            Box::new(EditFileTool),
            Box::new(SearchFilesTool),
            Box::new(GlobTool),
            Box::new(ApplyPatchTool),
            Box::new(UpdatePlanTool),
            Box::new(ReadSkillTool),
            Box::new(DispatchAgentTool),
        ];
        // 电脑操作工具（截图/输入/控件树）。仅在 Windows 编入（依赖 Windows UI Automation 等平台能力），
        // 故 Windows 主程序内的 SimpleAI 默认可用；其它平台不提供。
        #[cfg(windows)]
        tools.push(Box::new(computer::ComputerTool));
        Self {
            tools,
            mcp_pool: None,
        }
    }

    /// 注入 MCP 工具池（builder 模式）。
    pub(super) fn with_mcp(mut self, pool: Arc<super::mcp::McpClientPool>) -> Self {
        self.mcp_pool = Some(pool);
        self
    }

    /// 移除指定内置工具（builder 模式；用于禁用 dispatch_agent 等）。
    pub(super) fn without_tool(mut self, name: &str) -> Self {
        self.tools.retain(|t| t.name() != name);
        self
    }

    /// 全部工具的 OpenAI function schema（内置 + MCP）。
    pub(super) fn specs(&self) -> Vec<Value> {
        let mut specs: Vec<Value> = self.tools.iter().map(|t| t.spec()).collect();
        if let Some(pool) = &self.mcp_pool {
            specs.extend(pool.tool_specs().iter().cloned());
        }
        specs
    }

    /// 按名分发执行。内置工具优先；未命中且为 `mcp__` 前缀时路由到 MCP pool；否则返回失败。
    pub(super) async fn dispatch(
        &self,
        name: &str,
        args: &Value,
        ctx: &ToolContext<'_>,
    ) -> ToolOutcome {
        match self.tools.iter().find(|t| t.name() == name) {
            Some(tool) => tool.execute(args, ctx).await,
            None => {
                if let Some(pool) = &self.mcp_pool {
                    if super::mcp::McpClientPool::parse_tool_name(name).is_some() {
                        return pool.call(name, args).await;
                    }
                }
                ToolOutcome::fail(format!("Unknown tool: {}", name))
            }
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

    #[tokio::test]
    async fn registry_exposes_all_builtins_and_dispatches_unknown() {
        let reg = ToolRegistry::with_builtins();
        let specs = reg.specs();
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
            "read_skill",
            "dispatch_agent",
        ] {
            assert!(names.contains(&expected), "missing tool: {}", expected);
        }
        // Windows 上额外注册 1 个 computer 工具（电脑操作）。
        #[cfg(windows)]
        {
            assert_eq!(specs.len(), 12);
            assert!(names.contains(&"computer"));
        }
        #[cfg(not(windows))]
        assert_eq!(specs.len(), 11);

        // 未知工具经 async dispatch 返回失败。
        let cb: Arc<dyn Fn(AIEvent) + Send + Sync> = Arc::new(|_| ());
        let started = AtomicBool::new(false);
        let skills = HashMap::new();
        let profile = crate::models::config::ModelProfile::default();
        let mcp_servers: Vec<crate::services::mcp_config_service::ResolvedExternalMcpServer> =
            Vec::new();
        let ctx = ToolContext {
            work_dir: ".",
            session_id: "s",
            event_callback: &cb,
            plan_id: "s-plan",
            plan_started: &started,
            skills: &skills,
            profile: &profile,
            mcp_servers: &mcp_servers,
            subagent_depth: 0,
        };
        let out = reg
            .dispatch("nonexistent_tool", &serde_json::json!({}), &ctx)
            .await;
        assert!(!out.success);
        assert!(out.content.contains("Unknown tool"));
    }
}
