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
    /// SimpleAI：直接消费的 MCP server 列表
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
}

/// 读取 config.json 的 `mcp.sessionDefaults`（会话级 MCP 白名单）。
///
/// 缺省 / null / 非字符串数组 → `None`（全量可用，保持现行为，容错不炸）。
///
/// 加固 H-2（spec audit-startup-hardening §H-2）：mtime 守卫的进程级缓存。
/// `prepare_mcp_config` 在 ClaudeCode stream-json 单发模式下每条消息调一次，
/// 原实现每次 `read_to_string`+`serde_json::from_str` 同步读盘解析——与首响
/// 优化主题相悖。现改为：命中 `config.json` 的 `modified()` 未变即返回缓存值，
/// 每条消息只一次 `metadata()`（微秒级 stat），不读不解析。config 被设置页改动
/// 后 mtime 变化 → 自动重读。
fn load_session_mcp_whitelist(config_dir: &Path) -> Option<Vec<String>> {
    use std::sync::{Mutex, OnceLock};
    use std::time::SystemTime;

    static CACHE: OnceLock<Mutex<Option<(SystemTime, Option<Vec<String>>)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));

    let config_path = config_dir.join("config.json");
    // mtime 为缓存键：拿不到 mtime（文件不存在等）直接走 None 分支，
    // 不污染缓存（下次再试）。
    let current_mtime = std::fs::metadata(&config_path)
        .and_then(|m| m.modified())
        .ok()?;

    {
        let guard = cache.lock().unwrap();
        if let Some((cached_mtime, cached_value)) = guard.as_ref() {
            if *cached_mtime == current_mtime {
                return cached_value.clone();
            }
        }
    }

    // mtime 变了（或首次）：重读重解析
    let parsed = (|| {
        let content = std::fs::read_to_string(&config_path).ok()?;
        let value: serde_json::Value = serde_json::from_str(&content).ok()?;
        let list = value.get("mcp")?.get("sessionDefaults")?.as_array()?;
        Some(
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect(),
        )
    })();

    *cache.lock().unwrap() = Some((current_mtime, parsed.clone()));
    parsed
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

    // 会话级 MCP 白名单（spec §四 C-P0）：config.json `mcp.sessionDefaults`
    // 缺省/null → 现行为（全量可用）；为数组 → 未列出的 server（内置与插件
    // 一视同仁）一律并入 disabled。
    // 性能依据（15 天日志实证，agent 复核）：ClaudeCode init 台阶在 3→5 个
    // MCP 之间（4.7s → 31.1s），54 个 MCP 时首字延迟 23-89s；压到 ≤3 个
    // → ~4-5s。
    if let Some(whitelist) = load_session_mcp_whitelist(params.config_dir) {
        let before = disabled_servers.len();
        for name in service.all_server_names() {
            let whitelisted = whitelist.iter().any(|w| w == &name);
            if !whitelisted && !disabled_servers.iter().any(|d| d == &name) {
                disabled_servers.push(name);
            }
        }
        tracing::info!(
            "[SessionLauncher] MCP 白名单生效：sessionDefaults={} 项，禁用 {} → {} 个 server",
            whitelist.len(),
            before,
            disabled_servers.len()
        );
    }
    // 为所有引擎准备配置（一次 resolve，多引擎复用）
    let claude_config_path = service
        .prepare_workspace_config_with_disabled(params.work_dir, &disabled_servers)
        .map(|p| p.to_string_lossy().to_string())
        .ok();

    let mut mcp_servers = service.resolved_simple_ai_servers(params.work_dir, &disabled_servers);

    // aiToolAccess 门控：内置总暴露，外部插件检查 aiToolAccess
    let (_, plugins) = mcp_config_service::load_plugin_mcp_runtime_state(
        params.config_dir,
        Path::new(params.work_dir),
    );
    mcp_servers.retain(|s| {
        // 内置总暴露（builtin 标记，含真实归属 plugin_id 如 polaris.scheduler）；外部插件检查 aiToolAccess
        if s.builtin {
            return true;
        }
        plugins
            .iter()
            .find(|p| p.id == s.plugin_id)
            .map(|p| p.permissions.ai_tool_access.unwrap_or(false))
            .unwrap_or(false)
    });

    if !mcp_servers.is_empty() {
        let builtin_count = mcp_servers.iter().filter(|s| s.builtin).count();
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
        mcp_servers,
    })
}

/// 根据引擎类型将 MCP 配置注入到 SessionOptions 中。
///
/// 不同引擎消费 MCP 配置的方式不同：
/// - ClaudeCode → mcp_config_path（JSON 文件路径，通过 --mcp-config 传递）
/// - SimpleAI   → mcp_servers（直接注入 function calling schema）
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
        EngineId::SimpleAI => {
            if !mcp.mcp_servers.is_empty() {
                opts.mcp_servers = mcp.mcp_servers.clone();
                tracing::debug!(
                    "[SessionLauncher] 注入 SimpleAI MCP: {} 个 server",
                    mcp.mcp_servers.len()
                );
            }
        }
        EngineId::OpenCode => {
            if !mcp.mcp_servers.is_empty() {
                // R-MCP：桥接由引擎内完成——启动前在工作区写项目级 opencode.json
                // （`mcp.<name>.{type:"local",command:[...],enabled:true}`，
                // 实测 v2.0.30 有效），EOF 线程删除文件恢复工作区原状。
                // 不用 `opencode mcp add --global`（污染用户全局配置，且无法
                // 承载每会话动态参数 --polaris-port/--polaris-token）。
                // 工作区已有 opencode.json 时引擎内跳过注入（不合并用户配置）。
                opts.mcp_servers = mcp.mcp_servers.clone();
                tracing::debug!(
                    "[SessionLauncher] 注入 OpenCode MCP: {} 个 server（引擎内桥接）",
                    mcp.mcp_servers.len()
                );
            }
        }
        EngineId::Custom(_) => {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::SystemTime;

    /// H-2：白名单 mtime 缓存命中——两次调用间不改 config.json，第二次走缓存
    /// （不重读重解析）。验证：返回值一致 + mtime 守卫生效。
    #[test]
    fn session_mcp_whitelist_caches_until_mtime_change() {
        let dir = std::env::temp_dir().join(format!(
            "polaris-launcher-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let config_path = dir.join("config.json");
        fs::write(
            &config_path,
            r#"{"mcp":{"sessionDefaults":["server-a","server-b"]}}"#,
        )
        .unwrap();

        // 首次：读盘解析
        let first = load_session_mcp_whitelist(&dir).unwrap();
        assert_eq!(first, vec!["server-a".to_string(), "server-b".to_string()]);

        // 第二次：mtime 未变 → 命中缓存（返回值一致）
        let second = load_session_mcp_whitelist(&dir).unwrap();
        assert_eq!(second, first, "mtime 未变应命中缓存返回同值");

        // 改 config.json（内容变，mtime 通常也会变）→ 缓存失效重读
        // 注：同秒内改文件 mtime 精度可能不变，强制等 1.1s 确保 mtime 推进
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(
            &config_path,
            r#"{"mcp":{"sessionDefaults":["server-c"]}}"#,
        )
        .unwrap();
        let third = load_session_mcp_whitelist(&dir).unwrap();
        assert_eq!(third, vec!["server-c".to_string()], "mtime 变化应重读");

        let _ = fs::remove_dir_all(&dir);
    }

    /// H-2：缺省/null/非数组 → None（保持现行为，容错不炸）。
    #[test]
    fn session_mcp_whitelist_absent_returns_none() {
        let dir = std::env::temp_dir().join(format!(
            "polaris-launcher-test-none-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(&dir.join("config.json"), r#"{"other":"field"}"#).unwrap();
        assert!(load_session_mcp_whitelist(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}