/*! 统一 AI 会话启动器
 *
 * 集中管理 MCP 配置准备与 SessionOptions 构建，消除以下入口间的重复代码：
 * - commands/chat.rs::start_chat_inner / continue_chat_inner
 * - integrations/manager.rs::process_ai_message
 *
 * 使用方式：
 * ```ignore
 * let mcp = prepare_mcp_config(&params)?;
 * let mut opts = SessionOptions::new(callback);
 * inject_mcp_into_session_opts(&mut opts, &engine, &mcp);
 * opts = opts.with_work_dir(dir).with_system_prompt(prompt)...;
 * registry.start_session(Some(engine), message, opts)
 * ```
 */

use std::path::{Path, PathBuf};

use crate::ai::traits::{EngineId, SessionOptions};
use crate::error::{AppError, Result};
use crate::services::ask_listener::AskListenerHandle;
use crate::services::mcp_config_service::{
    self, resolve_workspace_mcp_runtime_service, ResolvedExternalMcpServer,
};

/// 统一 MCP 配置结果，同时适用于所有引擎类型。
///
/// 替代：
/// - `commands/chat.rs::PreparedMcpConfig`
/// - `integrations/manager.rs::IntegrationMcpConfig`
#[derive(Default, Clone)]
pub struct McpSessionConfig {
    /// Claude Code：JSON 配置文件路径（.polaris/claude/mcp.json）
    pub claude_config_path: Option<String>,
    /// Codex CLI：-c key=value 参数列表
    pub codex_config_args: Vec<String>,
    /// SimpleAI / Pi：直接消费的 MCP server 列表
    pub mcp_servers: Vec<ResolvedExternalMcpServer>,
}

/// MCP 配置准备参数
pub struct McpConfigParams<'a> {
    pub engine_id: &'a EngineId,
    pub work_dir: &'a str,
    pub config_dir: &'a Path,
    pub resource_dir: Option<&'a Path>,
    pub app_root: &'a Path,
    pub ask_listener: Option<AskListenerHandle>,
    pub ask_route_session_id: Option<String>,
    pub disabled_mcp_servers: &'a [String],
    pub ask_mcp_enabled: bool,
}

/// 统一 MCP 配置准备入口。
///
/// 替代：
/// - `commands/chat.rs::prepare_mcp_config_with_paths()`
/// - `integrations/manager.rs` 中内联的 MCP 准备逻辑
pub fn prepare_mcp_config(params: McpConfigParams) -> Result<McpSessionConfig> {
    let app_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| AppError::ProcessError("无法确定应用根目录".to_string()))?
        .to_path_buf();

    let (service, persisted_disabled_servers) = resolve_workspace_mcp_runtime_service(
        params.config_dir.to_path_buf(),
        params.resource_dir.map(|p| p.to_path_buf()),
        app_root,
        Path::new(params.work_dir),
        params.ask_listener,
        params.ask_route_session_id,
    )?;

    // 合并禁用列表：请求层 + 持久化层
    let mut disabled_servers = params.disabled_mcp_servers.to_vec();
    for server_name in &persisted_disabled_servers {
        if !disabled_servers.iter().any(|name| name == server_name) {
            disabled_servers.push(server_name.clone());
        }
    }
    // InteractionConfig 门控：只作用于 polaris-ask 本身
    if !params.ask_mcp_enabled
        && !disabled_servers.iter().any(|name| name == "polaris-ask")
    {
        disabled_servers.push("polaris-ask".to_string());
    }

    // 为所有引擎准备配置（一次 resolve，多引擎复用）
    let claude_config_path = service
        .prepare_workspace_config_with_disabled(params.work_dir, &disabled_servers)
        .map(|p| p.to_string_lossy().to_string())
        .ok();

    let codex_config_args = service
        .prepare_workspace_codex_config_args_with_disabled(params.work_dir, &disabled_servers)
        .ok()
        .unwrap_or_default();

    let mut mcp_servers = service.resolved_simple_ai_servers(params.work_dir, &disabled_servers);

    // aiToolAccess 门控：内置总暴露，外部插件检查 aiToolAccess
    let (_, plugins) = mcp_config_service::load_plugin_mcp_runtime_state(
        params.config_dir,
        Path::new(params.work_dir),
    );
    mcp_servers.retain(|s| {
        if s.plugin_id == "polaris.builtin" {
            return true;
        }
        plugins
            .iter()
            .find(|p| p.id == s.plugin_id)
            .map(|p| p.permissions.ai_tool_access.unwrap_or(false))
            .unwrap_or(false)
    });

    if !mcp_servers.is_empty() {
        let builtin_count = mcp_servers
            .iter()
            .filter(|s| s.plugin_id == "polaris.builtin")
            .count();
        let plugin_count = mcp_servers.len() - builtin_count;
        tracing::info!(
            "[SessionLauncher] 解析到 {} 个可用 MCP server（内置 {} + 插件 {}，aiToolAccess 已过滤）",
            mcp_servers.len(),
            builtin_count,
            plugin_count
        );
    }

    Ok(McpSessionConfig {
        claude_config_path,
        codex_config_args,
        mcp_servers,
    })
}

/// 根据引擎类型将 MCP 配置注入到 SessionOptions 中。
///
/// 不同引擎消费 MCP 配置的方式不同：
/// - ClaudeCode → mcp_config_path（JSON 文件路径，通过 --mcp-config 传递）
/// - Codex      → codex_config_args（-c key=value 参数）
/// - SimpleAI   → mcp_servers（直接注入 function calling schema）
/// - Pi         → mcp_servers（同 SimpleAI，通过 Extension 桥接）
/// - Custom(_)  → mcp_servers（注入后由 PluginEngineRunner 根据自身
///   mcp_consumption 策略决定如何桥接，如 PiExtension 写 JS Extension + --extension）
pub fn inject_mcp_into_session_opts(
    opts: &mut SessionOptions,
    engine_id: &EngineId,
    mcp: &McpSessionConfig,
) {
    match engine_id {
        EngineId::ClaudeCode => {
            if let Some(ref path) = mcp.claude_config_path {
                opts.mcp_config_path = Some(path.clone());
                tracing::debug!("[SessionLauncher] 注入 Claude MCP 配置: {}", path);
            }
        }
        EngineId::Codex => {
            if !mcp.codex_config_args.is_empty() {
                opts.codex_config_args = mcp.codex_config_args.clone();
                tracing::debug!(
                    "[SessionLauncher] 注入 Codex MCP 配置: {} 个参数",
                    mcp.codex_config_args.len()
                );
            }
        }
        EngineId::SimpleAI => {
            if !mcp.mcp_servers.is_empty() {
                opts.mcp_servers = mcp.mcp_servers.clone();
                tracing::debug!(
                    "[SessionLauncher] 注入 SimpleAI MCP: {} 个 server",
                    mcp.mcp_servers.len()
                );
            }
        }
        EngineId::Pi | EngineId::Custom(_) => {
            if !mcp.mcp_servers.is_empty() {
                opts.mcp_servers = mcp.mcp_servers.clone();
                tracing::debug!(
                    "[SessionLauncher] 注入 Pi/Custom MCP: {} 个 server",
                    mcp.mcp_servers.len()
                );
                // 自动追加 MCP 直接调用指导：LLM 应直接调用 mcp__{server}__{tool} 工具名，
                // 而不是用 write 包装（OMP 的默认行为不稳定）。实测 add-system-prompt 指导后
                // LLM 能稳定直接调用，不再依赖 write 包装。
                let server_names: Vec<&str> = mcp.mcp_servers.iter().map(|s| s.server_name.as_str()).collect();
                let mcp_guidance = format!(
                    "You have MCP tools available via Extension bridge. \
                     Call them directly by their tool name `mcp__{{server}}__{{tool}}`. \
                     DO NOT wrap MCP calls in `write()` or use `xd://` prefix. \
                     Available MCP servers: {}.",
                    server_names.join(", ")
                );
                if let Some(ref mut existing) = opts.append_system_prompt {
                    existing.push_str("\n\n");
                    existing.push_str(&mcp_guidance);
                } else {
                    opts.append_system_prompt = Some(mcp_guidance);
                }
                tracing::debug!(
                    "[SessionLauncher] 已追加 MCP 直接调用指导到 append_system_prompt（{} 个 server）",
                    mcp.mcp_servers.len()
                );
            }
        }
    }
}