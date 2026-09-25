/*! Simple AI 对话循环
 *
 * 发起 OpenAI 兼容流式请求 → 解析 SSE → 执行工具调用 → 将结果回灌继续，
 * 直至模型不再请求工具或达到轮次上限。三线路协议适配见 `simple_ai_protocol`。
 */

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::ai::engine::simple_ai_protocol::{
    build_request_body, CliModelSuffix, StreamDelta, StreamState, WireProtocol,
};
use crate::error::{AppError, Result};
use crate::models::ai_event::{
    ProgressEvent, SessionEndEvent, ThinkingEvent, TokenEvent, ToolCallEndEvent, ToolCallStartEvent,
    UsageEvent,
};
use crate::models::AIEvent;

use super::compact;
use super::history;
use super::tools::{ToolContext, ToolRegistry};

/// 历史中单条 assistant 文本输出的 token 上限，超出则截断头部（约 16k 字符）。
/// 仅截真正巨大的输出（如模型贴大段代码/文件），正常回答不受影响；零额外 API 调用。
const HISTORY_ASSISTANT_TOKEN_CAP: usize = 4000;

/// 默认请求总超时（秒）。可经 ModelProfile.custom_env 的 `SIMPLE_AI_TIMEOUT_SECS` 覆盖。
///
/// 语义：**建连 + 等待响应头** 的上限（由 `send_with_retry` 返回后、读 body 前的
/// `tokio::select!` 兜底）。注意 reqwest 的 `.timeout()` 是「连接开始 → 响应体读完」
/// 的总超时，流式(SSE)读取期间计时器持续走——若用它设总时长，长分析/长报告这类
/// 单轮输出超过该时长的任务会被直接掐断。因此这里**不设请求级总超时**：
/// - 建连：`reqwest` `connect_timeout`（30s）兜底；
/// - 首字节/响应头：本常量兜底（默认 300s，对齐文档承诺）；
/// - 流式 body：由 `STREAM_IDLE_TIMEOUT_SECS` 逐 chunk 空闲检测兜底，无总时长限制。
const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 300;

/// 默认建连超时（秒）：建立 TCP/TLS 连接的上限。
const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 30;

/// 默认流空闲超时（秒）：距上一个数据块超过该时长视为流卡死。
/// 可经 ModelProfile.custom_env 的 `SIMPLE_AI_STREAM_IDLE_SECS` 覆盖。
/// 300s：思考密集型模型（1M 上下文 / Opus / 长 reasoning）输出常出现
/// "首字节后长沉默再续"，且跨网关/反代会攒批转发致本地 chunk 间隔放大；
/// 300s 仍能兜死真僵死连接，又避开绝大多数正常长沉默。
const STREAM_IDLE_TIMEOUT_SECS: u64 = 300;

/// 工具调用轮次上限，**默认 0 = 不限制**。可在 ModelProfile.custom_env 中通过
/// `SIMPLE_AI_MAX_TOOL_ROUNDS` 覆盖为 0（不限制）或正数（防御性兜底：超过该轮次
/// 强行终止，避免模型无限循环调用工具导致应用卡死）。
///
/// 默认不限制的原因：
/// - 极长攻坚/编码任务可能超过 40 轮，截断会破坏任务的连续性；
/// - 模型自然终止 + 用户中断 + token 成本已是自然的收敛约束；
/// - 有需要的用户仍可通过 custom_env 设置正数恢复兜底。
const DEFAULT_MAX_TOOL_ROUNDS: u64 = 0;

/// 发起 OpenAI Chat Completions 流式请求，执行工具调用循环
pub(super) async fn run_chat_loop(
    session_id: &str,
    messages: &mut Vec<Value>,
    profile: &crate::models::config::ModelProfile,
    effort: Option<&str>,
    work_dir: &str,
    event_callback: &Arc<dyn Fn(AIEvent) + Send + Sync>,
    abort_rx: &mut watch::Receiver<bool>,
    mcp_servers: &[crate::services::mcp_config_service::ResolvedExternalMcpServer],
    skills: &std::collections::HashMap<String, super::skill::SkillEntry>,
    file_states: &std::sync::Arc<super::tools::FileStateRegistry>,
    depth: u32,
    allowed_tools: &[String],
) -> Result<()> {
    let protocol = WireProtocol::from_wire_api(profile.wire_api.as_deref());
    tracing::info!(
        "[SimpleAI] run_chat_loop 开始, session={}, protocol={}",
        session_id,
        protocol.as_str()
    );

    // 超时配置：默认常量，可经 profile.custom_env 覆盖（不改 ModelProfile 结构/前端）。
    let request_timeout_secs =
        read_env_u64(&profile.custom_env, "SIMPLE_AI_TIMEOUT_SECS", DEFAULT_REQUEST_TIMEOUT_SECS);
    let stream_idle_secs =
        read_env_u64(&profile.custom_env, "SIMPLE_AI_STREAM_IDLE_SECS", STREAM_IDLE_TIMEOUT_SECS);
    // 工具调用轮次上限：默认 0 = 不限制。custom_env SIMPLE_AI_MAX_TOOL_ROUNDS
    // 可设为正数恢复防御性兜底（例如 40）。
    // 不复用 read_env_u64（它会把 0 视为非法回退），因为 0 有「无限制」的合法语义。
    let max_tool_rounds = profile
        .custom_env
        .as_ref()
        .and_then(|m| m.get("SIMPLE_AI_MAX_TOOL_ROUNDS"))
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_MAX_TOOL_ROUNDS);

    // 工具注册表 + 本轮 schema。新增工具无需改动本循环。
    // agent 定义的 tools 白名单(P0-2 解析保留,U2-7 启用):空 = 不过滤
    let mut registry = ToolRegistry::with_builtins().with_allowed_tools(allowed_tools);
    // dispatch_agent 默认开启；SIMPLE_AI_DISABLE_SUBAGENT=1 时移除（决策 §12-4）。
    let subagent_disabled = profile
        .custom_env
        .as_ref()
        .and_then(|m| m.get("SIMPLE_AI_DISABLE_SUBAGENT"))
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if subagent_disabled {
        tracing::info!("[SimpleAI] dispatch_agent 已禁用（SIMPLE_AI_DISABLE_SUBAGENT）");
        registry = registry.without_tool("dispatch_agent");
    }
    // MCP 工具池（Phase 4b）：若有已启用的 MCP server，spawn 并注入工具。
    // 加 30s 超时防止 MCP server 进程卡死阻塞整个会话启动。
    if !mcp_servers.is_empty() {
        let pool_fut = super::mcp::McpClientPool::from_servers(mcp_servers.to_vec());
        let pool = match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            pool_fut,
        ).await {
            Ok(pool) => Arc::new(pool),
            Err(_) => {
                tracing::warn!(
                    "[SimpleAI] MCP server 启动超时（30s），跳过 MCP 工具注入, session={session_id}"
                );
                let _ = event_callback(AIEvent::Progress(ProgressEvent::new(
                    session_id,
                    "MCP server 启动超时，已跳过。部分工具不可用。".to_string(),
                )));
                Arc::new(super::mcp::McpClientPool::empty())
            }
        };
        tracing::info!(
            "[SimpleAI] MCP pool 就绪：{} 个 server 连接，{} 个工具",
            pool.connected_count().await,
            pool.tool_specs().len()
        );
        registry = registry.with_mcp(pool);
    }
    let tools = registry.specs();
    // update_plan 的计划面板状态：每轮首次调用先发 plan_start。
    let plan_id = format!("{}-plan", session_id);
    let plan_started = AtomicBool::new(false);
    // 会话级文件状态缓存由调用方持有（SimpleAISession.file_states），
    // 保证 continue / 子 agent 共享同一份 read 登记（read-before-write + mtime 校验）。
    // 上下文压缩配置（Phase 3.3）：最近一轮 input 达窗口 75% 时触发摘要压缩。
    let context_window = profile
        .context_window
        .filter(|v| *v > 0)
        .unwrap_or_else(|| {
            read_env_u64(
                &profile.custom_env,
                "SIMPLE_AI_CONTEXT_WINDOW",
                compact::DEFAULT_CONTEXT_WINDOW,
            )
        });
    let mut usage_acc = compact::UsageAccumulator::default();
    // 压缩效果监督：刚压缩过一轮仍超阈 → 压不动，本 turn 熔断（防每轮空耗摘要请求）。
    let mut rounds_since_compact: Option<u32> = None;
    let mut compact_exhausted = false;

    let mut round: u64 = 0;

    // 构建可复用的 HTTP 客户端（避免每轮循环重建，防止 TLS 会话池/连接池泄漏）。
    // 注意：**不设 request 级总超时**（reqwest 的 timeout 覆盖流式 body 读取全程，
    // 会掐断长分析/长报告）。建连超时用 connect_timeout 兜底；等待响应头用
    // request_timeout_secs（见发送段 select）；流式 body 由 stream_idle 逐 chunk 兜底。
    let http_client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(DEFAULT_CONNECT_TIMEOUT_SECS))
        .pool_max_idle_per_host(4) // 限制单 host 空闲连接数，避免资源泄漏
        .build()
        .map_err(|e| AppError::ProcessError(format!("HTTP client error: {}", e)))?;

    loop {
        // 默认 40 轮上限；custom_env 设为 0 可取消限制（不推荐）。
        if max_tool_rounds > 0 && round >= max_tool_rounds {
            let _ = event_callback(AIEvent::Progress(ProgressEvent::new(
                session_id,
                format!("Reached configured tool call round cap ({}), stopping.", max_tool_rounds),
            )));
            break;
        }
        round += 1;

        if *abort_rx.borrow() {
            let _ = event_callback(AIEvent::SessionEnd(SessionEndEvent::new(session_id)));
            return Ok(());
        }

        // 裁剪历史中超长的 assistant 输出，避免长会话撑爆上下文窗口（零额外 API 调用）。
        history::truncate_history_assistant_outputs(messages, HISTORY_ASSISTANT_TOKEN_CAP);

        // 上下文压缩（Phase 3.3）：最近一轮 input 达阈值时，发摘要请求替换历史区间。
        if !compact_exhausted && usage_acc.should_compact(context_window, messages) {
            if rounds_since_compact == Some(1) {
                compact_exhausted = true;
                tracing::warn!(
                    "[SimpleAI] 压缩无效（压缩后 input 仍超阈值），本轮任务内不再压缩"
                );
            } else {
                tracing::info!(
                    "[SimpleAI] 触发上下文压缩（最近一轮 input={}，window={}，累计 input={}）",
                    usage_acc.last_input,
                    context_window,
                    usage_acc.total_input
                );
                let compacted =
                    compact::compact_history(messages, profile, context_window, event_callback, session_id)
                        .await?;
                if compacted {
                    // 清零触发基准，待下一轮真实 usage 刷新（天然一轮冷却）。
                    usage_acc.reset_last();
                    rounds_since_compact = Some(0);
                }
                // 区间过小跳过时不重置：下一轮消息增多后区间可选再压。
            }
        }

        // 剥离 CLI 私有模型后缀（如 `[1m]`），返回纯模型名与协议信号。
        let suffix = CliModelSuffix::new(&profile.model);
        let base_model = suffix
            .base_model
            .as_deref()
            .unwrap_or_else(|| profile.model.as_str());

        // 构建请求体（按线路协议转换内部 OpenAI 消息格式）—— 用剥离后的纯模型名。
        // effort 来自会话配置（状态栏选择），映射为协议内思考参数（见 simple_ai_protocol.rs）。
        let body = build_request_body(protocol, base_model, messages, &tools, profile.max_tokens, effort);
        if tools.is_empty() {
            tracing::warn!("[SimpleAI] 工具列表为空!");
        } else {
            tracing::info!(
                "[SimpleAI] 发送 {} 个工具定义 (protocol={})",
                tools.len(),
                protocol.as_str()
            );
        }
        // 复用循环外构建的 http_client（避免每次循环重建 TLS 连接池，导致资源泄漏）。
        // 请求地址：追加 CLI 后缀衍生的 query（仅 Anthropic 协议生效，如 `?beta=true`）。
        let url = if let Some(ref q) = suffix.query {
            format!("{}?{}", protocol.build_url(&profile.base_url), q)
        } else {
            protocol.build_url(&profile.base_url)
        };

        let mut req = http_client
            .post(&url)
            .header("Content-Type", "application/json");
        // 注意：不设 `.timeout()`——reqwest 的 timeout 覆盖「连接 → 响应体读完」全程，
        // 流式(SSE)读取期间计时器持续走，长分析/长报告单轮输出超过该时长会被直接掐断。
        // 响应头等待上限由下方发送段的 tokio::select! 处理；流式 body 由 stream_idle 兜底。
        for (k, v) in protocol.auth_headers(&profile.api_key) {
            req = req.header(k, v);
        }
        // Anthropic 协议下，注入 CLI `[1m]` 等后缀对应的 `anthropic-beta` 头。
        // 这些头告知上游启用 1M 上下文 / 交错思考等 beta 能力。
        // 注入在 custom_headers 之前，允许用户通过 Profile 的 custom_headers 覆盖。
        if let Some(ref beta_tokens) = suffix.beta_tokens {
            if !beta_tokens.is_empty() {
                let beta_header = beta_tokens.join(",");
                tracing::debug!(
                    "[SimpleAI] 注入 anthropic-beta 头: {} (protocol={})",
                    beta_header,
                    protocol.as_str()
                );
                req = req.header("anthropic-beta", beta_header);
            }
        }
        if let Some(headers) = &profile.custom_headers {
            for (k, v) in headers {
                req = req.header(k.as_str(), v.as_str());
            }
        }
        let req = req.body(body.to_string());

        let retry_max = read_env_u64(
            &profile.custom_env,
            "SIMPLE_AI_RETRY_MAX",
            super::retry::DEFAULT_RETRY_MAX_ATTEMPTS as u64,
        ) as u32;
        let retry_base_ms = read_env_u64(
            &profile.custom_env,
            "SIMPLE_AI_RETRY_BASE_MS",
            super::retry::DEFAULT_RETRY_BASE_MS,
        );
        tracing::info!(
            "[SimpleAI] 发送 API 请求: {} (model={}, raw={}, retry_max={})",
            url,
            base_model,
            profile.model,
            retry_max
        );
        // 传入 abort_rx：中断信号可在发送等待与 429 长退避期间立即打断，
        // 否则「页面上点停止」在限流重试窗口内形同失效。
        // url 仅用于错误诊断（脱敏后拼进错误消息，便于前端直接看到请求目标）。
        let response = super::retry::send_with_retry(
            req,
            retry_max,
            retry_base_ms,
            Some(abort_rx),
            &url,
            // header 等待超时：仅覆盖「发请求 → 收到响应头」。响应头返回后进入流式
            // body 读取，由 STREAM_IDLE_TIMEOUT_SECS 逐 chunk 兜底，不受总时长限制。
            Some(std::time::Duration::from_secs(request_timeout_secs)),
        )
        .await?;
        tracing::info!("[SimpleAI] API 响应状态: {}", response.status());

        // 流式解析 SSE
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut assistant_content = String::new();
        let mut stream_state = StreamState::new(protocol);

        loop {
            if *abort_rx.borrow() {
                tracing::warn!(
                    "[SimpleAI] [DIAG] abort_rx 被置为 true, 提前结束, session={session_id}"
                );
                // 防御：清掉历史末尾不完整的工具轮次（孤儿 tool_calls / 缺结果批次），
                // 保证中断后 continue_session 复用历史不会被协议层 400 拒绝。
                history::sanitize_tool_pairs(messages);
                let _ = event_callback(AIEvent::SessionEnd(SessionEndEvent::new(session_id)));
                return Ok(());
            }

            let chunk = tokio::select! {
                chunk = stream.next() => {
                    if chunk.is_none() {
                        // 流自然结束（服务端关闭连接，部分网关不发 [DONE]），正常路径。
                        tracing::debug!(
                            "[SimpleAI] stream 结束（无更多 chunk），session={session_id}"
                        );
                    }
                    chunk
                }
                _ = abort_rx.changed() => {
                    // 防御：changed() 在 sender 被替换/drop 时会返回 Err(RecvError)，
                    // 此时 channel 已无 observer，应视为非中断信号，继续等待流。
                    // 仅当 changed() 返回 Ok(true) 时才视为真正的中断请求。
                    if abort_rx.borrow().clone() == true {
                        tracing::warn!(
                            "[SimpleAI] [DIAG] abort_rx 被置为 true, 提前结束, session={session_id}"
                        );
                        // 防御：同上，清洗不完整工具轮次（当前轮可能已 push tool_calls/tool 消息）。
                        history::sanitize_tool_pairs(messages);
                        let _ = event_callback(AIEvent::SessionEnd(SessionEndEvent::new(session_id)));
                        return Ok(());
                    }
                    // 假阳性（sender 替换/关闭）：继续循环，不退出。
                    continue;
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(stream_idle_secs)) => {
                    // 流空闲超时：距上一数据块过久，视为连接僵死。
                    // 非致命：若已收到 assistant 内容，软结束本轮并提示，已生成内容保留；
                    // 若尚无任何内容，才作为真错误返回，避免静默吞故障。
                    tracing::warn!(
                        target: "simple_ai::stream_idle_timeout",
                        bytes_received = assistant_content.len(),
                        round,
                        model = %profile.model,
                        session_id,
                        "stream idle timeout (no data for {}s)",
                        stream_idle_secs
                    );
                    if assistant_content.is_empty() {
                        return Err(AppError::ProcessError(format!(
                            "Stream idle timeout: no data for {}s (url={}, protocol={}, model={}, round={})",
                            stream_idle_secs,
                            super::retry::sanitize_url(&url),
                            protocol.as_str(),
                            base_model,
                            round
                        )));
                    }
                    let _ = event_callback(AIEvent::Progress(ProgressEvent::new(
                        session_id,
                        format!("流空闲 {}s，本轮回复已截断。", stream_idle_secs),
                    )));
                    break;
                }
            };

            let Some(chunk_result) = chunk else { break };

            let bytes = match chunk_result {
                Ok(b) => b,
                Err(e) => {
                    // 流式传输中途解码失败（网关断连 / chunked 损坏 / HTTP/2 RST_STREAM 等）。
                    // 非致命：若已收到 assistant 内容，视为本轮软结束（与上面"部分网关不发 [DONE]"
                    // 的自然结束语义一致）；若尚无任何内容，才作为真错误返回，避免静默吞故障。
                    tracing::warn!(
                        target: "simple_ai::stream_decode_error",
                        error = %e,
                        bytes_received = assistant_content.len(),
                        round,
                        model = %profile.model,
                        session_id,
                        "stream decode error mid-flight"
                    );
                    if assistant_content.is_empty() {
                        return Err(AppError::ProcessError(format!(
                            "Stream error: {e} (url={}, protocol={}, model={}, round={})",
                            super::retry::sanitize_url(&url),
                            protocol.as_str(),
                            base_model,
                            round
                        )));
                    }
                    let _ = event_callback(AIEvent::Progress(ProgressEvent::new(
                        session_id,
                        "网络波动，本轮回复已截断。".to_string(),
                    )));
                    break;
                }
            };

            buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() || line.starts_with(':') {
                    continue;
                }

                // SSE 规范允许 "data:" 后无空格，部分自建网关如此发送。
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    continue;
                }

                let Ok(chunk_json) = serde_json::from_str::<Value>(data) else {
                    continue;
                };

                for delta in stream_state.feed(&chunk_json) {
                    match delta {
                        StreamDelta::Text(text) => {
                            assistant_content.push_str(&text);
                            let _ = event_callback(AIEvent::Token(TokenEvent::new(
                                session_id,
                                text,
                            )));
                        }
                        StreamDelta::Thinking(thinking) => {
                            let _ = event_callback(AIEvent::Thinking(ThinkingEvent::new(
                                session_id,
                                thinking,
                            )));
                        }
                    }
                }
            }
        }

        // 流处理完毕
        let mut tool_calls = stream_state.finish_tool_calls();
        // token usage（Phase 3.1）：三协议在流末解析。日志上报 + 发送 UsageEvent 供前端计算上下文水位。
        // 三协议统一携带缓存分类（cache_creation / cache_read）与响应侧实际模型（actual_model）。
        // 双口径：SimpleAI 每轮即单次 API 调用快照，scope="turn" —— 前端水位直接以
        // input+cacheCreation+cacheRead 为分子，成本明细按事件逐条累加（scope 缺省时
        // 前端也按 cumulative 兜底累加，语义等价）。
        if let Some(usage) = stream_state.finish_usage() {
            usage_acc.add(usage.input_tokens);
            let actual_model = stream_state.finish_actual_model();
            tracing::info!(
                "[SimpleAI] token usage: input={}, output={}, total={} (缓存读={}, 缓存写={}, 实际模型={:?}) (累计 input={})",
                usage.input_tokens,
                usage.output_tokens,
                usage.total_tokens,
                usage.cache_read,
                usage.cache_creation,
                actual_model,
                usage_acc.total_input
            );
            let mut usage_event = UsageEvent::new(
                session_id,
                usage.input_tokens,
                Some(usage.cache_creation),
                Some(usage.cache_read),
                usage.output_tokens,
                None,
                Some(context_window),
            );
            usage_event = usage_event
                .with_scope("turn")
                .with_actual_model(actual_model.clone());
            let _ = event_callback(AIEvent::Usage(usage_event));

            // DX: 同步写入 SQLite 用量数据库（覆盖 SimpleAI 不经过代理的路径）。
            // 使用 spawn_blocking 避免 std::sync::Mutex 阻塞 tokio worker 线程。
            tracing::debug!("[SimpleAI] 调用 record_usage: model={}, input={}, output={}, cache_read={}, cache_creation={}", base_model, usage.input_tokens, usage.output_tokens, usage.cache_read, usage.cache_creation);
            let request_model = Some(profile.model.as_str());
            // 落库口径：model = 响应侧实际模型（动态路由时权威），request_model = 请求侧配置别名。
            // 响应未回填实际模型时退化到请求侧 base_model，避免统计落到空模型。
            let model_owned = actual_model.unwrap_or_else(|| base_model.to_string());
            let base_model_owned = base_model.to_string();
            let request_model_owned = request_model.map(|s| s.to_string());
            let input_tokens = usage.input_tokens as i64;
            let output_tokens = usage.output_tokens as i64;
            let cache_read_tokens = usage.cache_read as i64;
            let cache_creation_tokens = usage.cache_creation as i64;
            tokio::task::spawn_blocking(move || {
                crate::services::usage_db::record_usage(
                    &model_owned,
                    request_model_owned.as_deref(),
                    Some("simple-ai"),
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                    0, 200, true,
                );
            });
        }
        // 压缩效果监督计数（每完成一轮 +1；Some(1) 表示"刚压缩后的第一轮"）。
        if let Some(r) = rounds_since_compact.as_mut() {
            *r += 1;
        }
        // 输出被 max_tokens 截断时明确告警（可在供应商配置中调大 maxTokens）。
        if stream_state.finish_reason() == Some("length") {
            tracing::warn!(
                "[SimpleAI] 输出被 max_tokens 截断（finish_reason=length），\
                 可在模型供应商配置中调大 maxTokens, session={session_id}"
            );
        }
        tracing::info!(
            "[SimpleAI] 流处理完毕, session={}, content_len={}, tool_calls={}, first_100_chars={:?}",
            session_id,
            assistant_content.len(),
            tool_calls.len(),
            assistant_content.chars().take(100).collect::<String>()
        );

        if tool_calls.is_empty() {
            // 纯文本回复
            messages.push(json!({
                "role": "assistant",
                "content": if assistant_content.is_empty() { Value::Null } else { json!(assistant_content) }
            }));
            break;
        }

        // === 有工具调用 ===

        // 1. 发送 tool_call_start 事件
        for tc in &tool_calls {
            let tool_name = tc["function"]["name"].as_str().unwrap_or("unknown");
            let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));

            let mut start_event = ToolCallStartEvent::new(
                session_id,
                tool_name.to_string(),
                args.as_object()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .collect(),
            );
            start_event.call_id = Some(tc["id"].as_str().unwrap_or("").to_string());
            let _ = event_callback(AIEvent::ToolCallStart(start_event));
        }

        // 2. 保存 assistant 消息
        messages.push(json!({
            "role": "assistant",
            "content": if assistant_content.is_empty() { Value::Null } else { json!(assistant_content) },
            "tool_calls": tool_calls
        }));
        assistant_content.clear();

        // 3. 执行工具并收集结果
        for tc in &tool_calls {
            // 工具执行前 abort 检查（快速路径：下一批工具尚未启动即可停下）。
            // 若模型一次返回多个 tool_call，用户中断后不再执行余下工具。
            if *abort_rx.borrow() {
                tracing::warn!(
                    "[SimpleAI] 工具执行前收到中断, 提前结束, session={session_id}"
                );
                // 本批 assistant(tool_calls) 已入历史但结果未齐，清洗掉不完整批次，
                // 否则 continue 时 OpenAI/Anthropic 协议会因缺配对结果而 400。
                history::sanitize_tool_pairs(messages);
                let _ = event_callback(AIEvent::SessionEnd(SessionEndEvent::new(session_id)));
                return Ok(());
            }

            let call_id = tc["id"].as_str().unwrap_or("").to_string();
            let tool_name = tc["function"]["name"].as_str().unwrap_or("unknown");
            let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));

            let ctx = ToolContext {
                work_dir,
                session_id,
                event_callback,
                plan_id: &plan_id,
                plan_started: &plan_started,
                skills,
                file_states,
                profile,
                mcp_servers,
                subagent_depth: depth,
                abort_rx,
                effort,
            };
            let outcome = registry.dispatch(tool_name, &args, &ctx).await;
            // 工具执行完成后 abort 检查：若执行期间用户已中断，
            // 丢弃本工具结果（不 push tool 消息），下一轮顶部检查点会自然退出。
            // 注意：不 push 半截 tool 消息可避免把「未回灌的工具结果」误发给模型。
            if *abort_rx.borrow() {
                tracing::warn!(
                    "[SimpleAI] 工具执行完成但已收到中断, 提前结束, session={session_id}"
                );
                // 本工具结果已丢弃（未 push tool 消息），但 assistant(tool_calls) 已入历史，
                // 清洗掉不完整批次，保证 continue 可正常续接。
                history::sanitize_tool_pairs(messages);
                let _ = event_callback(AIEvent::SessionEnd(SessionEndEvent::new(session_id)));
                return Ok(());
            }

            let mut end_event =
                ToolCallEndEvent::new(session_id, tool_name.to_string(), outcome.success);
            end_event.call_id = Some(call_id.clone());
            end_event.result = Some(Value::String(outcome.content.clone()));
            let _ = event_callback(AIEvent::ToolCallEnd(end_event));

            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": outcome.content
            }));
        }

        tool_calls.clear();
    }

    Ok(())
}

/// 从 profile 的 `custom_env` 读取一个正整数 u64 配置；缺失/非法/为 0 时回退默认值。
fn read_env_u64(
    custom_env: &Option<std::collections::HashMap<String, String>>,
    key: &str,
    default: u64,
) -> u64 {
    custom_env
        .as_ref()
        .and_then(|m| m.get(key))
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(default)
}
