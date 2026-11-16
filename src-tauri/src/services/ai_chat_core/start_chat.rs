//! start_chat_inner（K-R6 自 ai_chat_core.rs 迁入）

use std::path::PathBuf;
use std::sync::Arc;

use crate::ai::{
    launcher::{self, McpSessionConfig, McpConfigParams},
};
use crate::ai::{EngineId, ImageAttachment, SessionOptions};
use crate::error::{AppError, Result};
use crate::models::AIEvent;

use crate::models::config::ProfileMode;
use crate::services::{ProviderRouter, RouteLogEntry, RouteLogKind, RouteSelection, TriedPair};

use super::attachments::*;
use super::callbacks::*;
use super::events::*;
use super::profile_options::*;
use super::provider_routing::*;
use super::types::*;

// ============================================================================
// Inner functions (shared business logic)
// ============================================================================

/// MCP 准备的工作目录：无 work_dir 时以数据根兜底。
///
/// 此前 work_dir 缺失会直接跳过 MCP 准备（工具面为空）——外部发起的会话
/// （cap.ai.chat / dispatch 等）因此拿不到任何 MCP 工具。数据根是安全缺省：
/// 插件服务发现走 config_dir（与 work_dir 无关），project 级插件仅在
/// workspace 下存在，兜底后仍按 user 级正常注入。
pub fn effective_mcp_work_dir(work_dir: Option<&str>) -> String {
    match work_dir {
        Some(dir) if !dir.trim().is_empty() => dir.to_string(),
        _ => crate::services::data_root::data_root()
            .root()
            .to_string_lossy()
            .to_string(),
    }
}

pub async fn start_chat_inner(
    message: String,
    options: ChatRequestOptions,
    state: &crate::AppState,
    callbacks: ChatCallbacks,
    app_paths: &AppPaths,
) -> Result<String> {
    tracing::info!(
        "[start_chat_inner] 消息长度: {} 字符, 附件数: {:?}",
        message.len(),
        options.attachments.as_ref().map(|a| a.len())
    );

    // 后端消息持久化：登记本轮用户请求（多数引擎不回显 user 事件，故不能依赖事件路径）。
    // 落库时机：请求时立即写伪会话 + 轮次首事件到达时按 context_id 认领迁移
    // （见 turn_persist::record_user_request，B1.e/B1.h）。
    crate::services::turn_persist::record_user_request(
        &message,
        options.client_message_id.as_deref(),
        options.assistant_message_id.as_deref(),
        options.context_id.as_deref(),
        options.device_id.as_deref(),
    );

    let processed =
        if let (Some(ref dir), Some(ref atts)) = (&options.work_dir, &options.attachments) {
            if !atts.is_empty() {
                process_attachments(dir, atts)?
            } else {
                ProcessedAttachment {
                    embedded_sections: Vec::new(),
                    file_references: Vec::new(),
                    image_data: Vec::new(),
                    image_paths: Vec::new(),
                }
            }
        } else {
            ProcessedAttachment {
                embedded_sections: Vec::new(),
                file_references: Vec::new(),
                image_data: Vec::new(),
                image_paths: Vec::new(),
            }
        };

    let final_message = build_message_with_attachments(&message, &processed);
    tracing::info!(
        "[start_chat_inner] 消息长度: {}, 图片数: {}, 文件引用数: {}",
        final_message.len(),
        processed.image_data.len(),
        processed.file_references.len()
    );

    let default_engine = || {
        state
            .clone_config()
            .ok()
            .and_then(|config| {
                let s = config.default_engine.trim();
                if s.is_empty() { None } else { Some(EngineId::parse_any(s)) }
            })
            .unwrap_or(EngineId::ClaudeCode)
    };

    let engine = match &options.engine_id {
        Some(id) => {
            let parsed = EngineId::parse_any(id);
            tracing::info!("[start_chat_inner] 解析引擎: '{}' -> {:?}", id, parsed);
            parsed
        }
        None => default_engine(),
    };

    tracing::info!("[start_chat_inner] 使用引擎: {:?}", engine);

    // 统一 MCP 配置准备
    let enable_mcp = options.enable_mcp_tools.unwrap_or(false);
    let mcp_config: McpSessionConfig = if enable_mcp {
        let mcp_work_dir = effective_mcp_work_dir(options.work_dir.as_deref());
        {
            let ask_route_session_id = options.context_id.as_deref().and_then(|id| {
                id.strip_prefix("session-")
                    .map(str::to_string)
                    .or_else(|| id.starts_with("dispatch-").then(|| id.to_string()))
            });
            launcher::prepare_mcp_config(McpConfigParams {
                engine_id: &engine,
                work_dir: &mcp_work_dir,
                config_dir: &app_paths.config_dir,
                resource_dir: app_paths.resource_dir.as_deref(),
                app_root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap(),
                ask_listener: state.ask_listener.get().cloned(),
                ask_route_session_id,
                disabled_mcp_servers: options.disabled_mcp_servers.as_deref().unwrap_or(&[]),
                web_endpoint: state.plugin_service_manager.web_endpoint(),
            })?
        }
    } else {
        McpSessionConfig::default()
    };

    let engine_str = engine.as_str();
    let ctx_id = options.context_id.clone();
    // 批 4a（协议定稿，裁决方案 B4.a）：本轮 turnId——信封层标识，前端跨轮
    // 异步回调（interrupt 兜底定时器等）与后续幂等水位消费；旧前端忽略未知字段
    // 天然兼容。
    let turn_id = format!("turn-{}", uuid::Uuid::new_v4());
    let emit_ref = callbacks.emit_event.clone();
    let notify_ref = callbacks.notify_complete.clone();
    // 修复（2026-10-24，跨端跟随实测）：见闭包内注释——首事件补写 session_start
    let lifecycle_start_logged = std::sync::atomic::AtomicBool::new(false);
    let lifecycle_start_flag = std::sync::Arc::new(lifecycle_start_logged);
    let event_callback = move |event: AIEvent| {
        // 阶段 4 批次 4：dispatch 链路附加写入 session_events（影子，失败不阻断）。
        // 修复（2026-10-24，跨端跟随实测）：Claude 等 CLI 引擎不发 SessionStart 事件，
        // 真实会话在 lifecycle 中没有 start 记录——跨端跟随发现不了它、启动清 running
        // 与「会话已在运行中」仲裁也失真。改为：本请求首个事件到达时以事件的真实
        // session_id 补写 session_start（标志防重；发过 SessionStart 的引擎不双写）。
        {
            use std::sync::atomic::Ordering;
            let sid = event.session_id();
            if !sid.is_empty() && !lifecycle_start_flag.swap(true, Ordering::SeqCst) {
                append_session_event(
                    sid,
                    crate::services::session_state::SessionEventType::SessionStart,
                    None,
                    None,
                );
            }
        }
        // SessionStart/SessionEnd 的 session_id 即引擎会话 ID（conversation_id）。
        match &event {
            AIEvent::SessionStart(start) => {
                // session_start 已由闭包开头首事件补写覆盖（标志互斥），不再重复写
                let _ = &start.session_id;
            }
            AIEvent::SessionEnd(end) => {
                let reason = end.reason.as_ref().map(|r| match r {
                    crate::models::SessionEndReason::Completed => "completed".to_string(),
                    crate::models::SessionEndReason::Aborted => "aborted".to_string(),
                    crate::models::SessionEndReason::Error => "error".to_string(),
                });
                append_session_event(
                    &end.session_id,
                    crate::services::session_state::SessionEventType::SessionEnd,
                    reason.clone(),
                    None,
                );
                // --- hook: ai.session.end（会话结束）---
                // 数据 {sessionId, engineId, reason}；sessionId 为引擎真实会话 id。
                // 插件可做会话级清理 / 记录。
                let _ = crate::services::hook_registry::dispatch_hooks(
                    "ai.session.end",
                    serde_json::json!({
                        "sessionId": end.session_id,
                        "engineId": engine_str,
                        "reason": reason,
                    }),
                );
            }
            _ => {}
        }
        // 后端消息持久化（旁路，失败不阻断）：累加当前轮 + 轮末兜底归档。
        // context_id 随闭包捕获传入：轮次首事件按请求归属认领用户消息（B1.e）。
        crate::services::turn_persist::observe_ctx(&event, &engine_str, ctx_id.as_deref());
        // 事件到达时刻（epoch ms），供前端计算 TTFT 与生成速率（TPS）。
        // 仅给有流式时序意义的事件打戳，其余事件保持原序列化路径，不增加开销。
        let now_ms = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        };
        // 为 session_start 事件注入 engineId，确保前端自动创建会话时绑定正确引擎；
        // 流式时序事件注入 receivedAtMs。本回调是所有引擎（claude / opencode / pi /
        // simple_ai / 插件引擎）的唯一汇聚点，在此打戳即覆盖全引擎，
        // 无需改各引擎代码或 event_parser。
        let enriched = match &event {
            AIEvent::SessionStart(_) => serde_json::to_value(&event).ok().map(|mut v| {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("engineId".to_string(), serde_json::Value::String(engine_str.to_string()));
                    obj.insert("receivedAtMs".to_string(), serde_json::Value::from(now_ms()));
                }
                v
            }),
            AIEvent::SessionEnd(_) | AIEvent::CliInit(_) | AIEvent::Usage(_) | AIEvent::Token(_)
            | AIEvent::Thinking(_) | AIEvent::AssistantMessage(_) => serde_json::to_value(&event).ok().map(|mut v| {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("receivedAtMs".to_string(), serde_json::Value::from(now_ms()));
                }
                v
            }),
            _ => None,
        };
        let event_json = if let Some(ref cid) = ctx_id {
            if let Some(ref enriched) = enriched {
                serde_json::json!({ "contextId": cid, "turnId": turn_id, "payload": enriched })
            } else {
                serde_json::json!({ "contextId": cid, "turnId": turn_id, "payload": event })
            }
        } else if let Some(ref enriched) = enriched {
            serde_json::json!({ "contextId": "main", "turnId": turn_id, "payload": enriched })
        } else {
            serde_json::json!({ "contextId": "main", "turnId": turn_id, "payload": event })
        };
        tracing::debug!(
            "[start_chat_inner] 发送事件: {}",
            event_json.to_string().chars().take(200).collect::<String>()
        );
        emit_ref(event_json);
        if matches!(event, AIEvent::SessionEnd(_)) {
            notify_ref();
        }
    };

    let engine_str_for_session = engine.as_str();
    let ctx_id_for_session = options.context_id.clone();
    let emit_ref2 = callbacks.emit_event.clone();
    let session_id_update_callback = move |new_session_id: String| {
        let event_json = if let Some(ref cid) = ctx_id_for_session {
            serde_json::json!({ "contextId": cid, "payload": { "type": "session_start", "sessionId": new_session_id, "engineId": engine_str_for_session } })
        } else {
            serde_json::json!({ "contextId": "main", "payload": { "type": "session_start", "sessionId": new_session_id, "engineId": engine_str_for_session } })
        };
        emit_ref2(event_json);
    };

    let mut session_opts = SessionOptions::new(event_callback);
    session_opts.on_session_id_update = Some(Arc::new(session_id_update_callback));

    if let Some(ref dir) = options.work_dir {
        session_opts = session_opts.with_work_dir(dir.clone());
    }
    if let Some(ref prompt) = options.system_prompt {
        session_opts = session_opts.with_system_prompt(prompt.clone());
    }
    if let Some(ref prompt) = options.append_system_prompt {
        session_opts = session_opts.with_append_system_prompt(prompt.clone());
    }
    if let Some(ref id) = options.client_message_id {
        session_opts.client_message_id = Some(id.clone());
    }
    inject_client_context(&mut session_opts, &options, &engine.as_str());
    // 统一 MCP 注入
    launcher::inject_mcp_into_session_opts(&mut session_opts, &engine, &mcp_config);
    if let Some(ref dirs) = options.additional_dirs {
        session_opts.additional_dirs = dirs.clone();
    }
    if let Some(ref agent) = options.agent {
        session_opts = session_opts.with_agent(agent.clone());
    }
    if let Some(ref model) = options.model {
        session_opts = session_opts.with_model(model.clone());
    }
    if let Some(ref effort) = options.effort {
        session_opts = session_opts.with_effort(effort.clone());
    }
    if let Some(ref permission_mode) = options.permission_mode {
        session_opts = session_opts.with_permission_mode(permission_mode.clone());
    }
    if let Some(ref tools) = options.allowed_tools {
        if !tools.is_empty() {
            session_opts = session_opts.with_allowed_tools(tools.clone());
        }
    }
    if let Some(ref fork_sid) = options.fork_session_id {
        session_opts.fork_session_id = Some(fork_sid.clone());
    }
    if !processed.image_data.is_empty() {
        // 图片直通判定：仅当 Profile 显式声明支持或模型名命中已知视觉模型时，
        // 才把 base64 图块传给引擎。否则（unknown/unsupported）跳过直通，
        // 走「落盘 + 指向 + AI 决策」路径（图片已由 build_message_with_attachments
        // 生成指引文本注入 user 消息），避免把图块发给不支持的模型导致 400。
        if should_direct_send_image(state, options.model_profile_id.as_deref()) {
            let images: Vec<ImageAttachment> = processed
                .image_data
                .iter()
                .map(|img| ImageAttachment {
                    media_type: img.media_type.clone(),
                    data: img.data.clone(),
                })
                .collect();
            tracing::info!(
                "[start_chat_inner] 传递 {} 张图片给引擎（stream-json 模式）",
                images.len()
            );
            session_opts = session_opts.with_image_attachments(images);
        } else {
            tracing::info!(
                "[start_chat_inner] 模型不支持/未声明视觉，跳过图片直通（走落盘+指向路径），共 {} 张图",
                processed.image_data.len()
            );
        }
    }

    // 为当前会话生成一个临时 session_id，传给 start_proxy 作为代理索引。
    // 避免按 profile_id 索引代理时跨会话互相干扰。
    let session_id = uuid::Uuid::new_v4().to_string();

    // --- hook: ai.session.start（会话启动）---
    // 数据 {sessionId, engineId}；此时 session_id 为临时 id（引擎真实会话 id
    // 在首个事件到达后才有，见 session_state）。插件可做会话级注入 / 记录。
    let _ = crate::services::hook_registry::dispatch_hooks(
        "ai.session.start",
        serde_json::json!({
            "sessionId": session_id,
            "engineId": engine.as_str(),
        }),
    );

    // ──────────────────────────────────────────────────────
    // 供应商分组路由（切入点 A/B：spawn 级 failover）
    //
    // base_opts（含 callback / 工作目录 / 系统提示词 / MCP / 图片等）是请求级
    // 常量，不随 Profile 变化，构建一次后每次重试 Clone 复用；Profile 特定
    // 字段（settings_overlay_path / env_overrides 等）由
    // apply_model_profile_options 在本轮 Profile 上覆盖。
    //
    // 切入点 C（async error + 首字超时）在 P2 接入 claude.rs。
    // ──────────────────────────────────────────────────────
    let route_choice = resolve_active_provider_group(state, options.provider_group_id.as_deref()).await;
    let max_attempts: usize = if let Some((g, _)) = route_choice.as_ref() {
        g.max_failover_attempts.max(1) as usize
    } else {
        1
    };

    // 分组路由模式下，若 session_opts.model 未设置（用户未选模型），
    // 用分组的 default_model 填充，实现组级默认模型（与单 Profile 的 model 字段语义一致）。
    if session_opts.model.is_none() {
        if let Some((ref group, _)) = route_choice {
            if let Some(ref default_model) = group.default_model {
                if !default_model.is_empty() {
                    session_opts = session_opts.with_model(default_model.clone());
                    tracing::info!(
                        "[start_chat_inner] 使用分组默认模型: {}",
                        default_model
                    );
                }
            }
        }
    }

    let mut final_session_id: Option<String> = None;

    // 已尝试的 (Profile ID, Key Index) 列表（failover 时跳过）。仅分组路由下使用。
    let mut tried_pairs: Vec<TriedPair> = Vec::new();

    // profile_mode 显式「官方」时直接闭锁分组：不进入 failover 循环，
    // 单轮 apply(None) → CLI 走官方端点。这与 PRD 契约一致（强制官方）。
    let force_official = options.profile_mode == Some(ProfileMode::Official);
    let force_group = options.profile_mode == Some(ProfileMode::Group);

    // 跟踪本轮路由选择（含 key_idx），供 ApplyFailed / SpawnFailed / Bound 日志点使用。
    let mut current_route_selection: Option<RouteSelection> = None;

    for attempt in 0..max_attempts {
        let chosen_profile_id: Option<String> = if force_official {
            // 官方：不使用任何 Profile（不分组）
            None
        } else if let Some(ref pid) = options.model_profile_id {
            if force_group {
                // 契约保护：Group 模式下忽略显式 model_profile_id（前端不传，防御）。
                None
            } else {
                // 用户显式指定：始终用用户的 Profile（不分组）
                Some(pid.clone())
            }
        } else if let Some((group, profiles)) = &route_choice {
            // 分组路由：
            //   - 首轮（attempt==0 或 tried 为空）用 select_initial（按策略选首个）；
            //   - failover 重试轮用 select_next（跳过已尝试的 Profile）。
            //   注意：RoundRobin 策略下 select_next 不推进游标，避免重试导致轮询跳号。
            let pick = if attempt == 0 || tried_pairs.is_empty() {
                state
                    .provider_router
                    .select_initial(group, profiles, &std::collections::HashSet::new())
                    .await
            } else {
                state
                    .provider_router
                    .select_next(
                        group,
                        &tried_pairs,
                        profiles,
                        &std::collections::HashSet::new(),
                    )
                    .await
            };
            // 跟踪本轮路由选择（含 key_idx），供后续失败/绑定日志点使用。
            current_route_selection = pick.clone();
            // 记录本轮尝试的 Profile+Key（用于后续 select_next 跳过）
            if let Some(ref s) = pick {
                if !tried_pairs.iter().any(|t| t.profile_id == s.profile_id && t.key_idx == s.key_idx) {
                    tried_pairs.push(TriedPair::new(&s.profile_id, s.key_idx));
                }
            }
            // 埋点：记录首轮选择 / failover 切换日志
            if let Some(ref s) = pick {
                let kind = if attempt == 0 {
                    RouteLogKind::InitialSelect
                } else {
                    RouteLogKind::FailoverSwitch
                };
                let key_count = ProviderRouter::member_key_count(
                    group.members.iter().find(|m| m.profile_id == s.profile_id).unwrap()
                );
                state
                    .record_route_log(RouteLogEntry {
                        seq: 0,
                        kind,
                        group_id: group.id.clone(),
                        group_name: group.name.clone(),
                        strategy: group.strategy.clone(),
                        profile_id: Some(s.profile_id.clone()),
                        profile_name: profiles.iter().find(|p| p.id == s.profile_id).map(|p| p.name.clone()),
                        session_id: Some(session_id.clone()),
                        engine: Some(format!("{:?}", engine)),
                        attempt,
                        error: None,
                        tried: tried_pairs.iter().map(|t| t.profile_id.clone()).collect(),
                        key_idx: s.key_idx,
                        key_count: if key_count > 0 { Some(key_count) } else { None },
                        ts_ms: 0,
                    })
                    .await;
            }
            pick.map(|s| s.profile_id)
        } else {
            // 无激活分组：
            //   - force_group（用户显式要分组但没配）→ 回退官方（None）；
            //   - 否则走单 Profile 旧路径：回退到全局 active
            if force_group {
                None
            } else {
                state
                    .clone_config()
                    .ok()
                    .and_then(|c| c.active_model_profile_id)
            }
        };

        // 用户显式要求分组路由，但当前没有激活的可用分组 → 回退官方并记录日志。
        if force_group && route_choice.is_none() {
            tracing::warn!(
                "[start_chat_inner] 用户指定分组路由，但无激活分组，回退官方端点 (attempt {}/{})",
                attempt + 1,
                max_attempts
            );
            record_official_fallback(state, None, &engine, &session_id).await;
            break;
        }

        // 若分组路由本轮未选出 Profile（组内已全部尝试过），提前终止
        if chosen_profile_id.is_none() && route_choice.is_some() && attempt > 0 {
            tracing::warn!(
                "[start_chat_inner] 分组内所有 Profile 均已尝试且不可用 (attempt {}/{})",
                attempt + 1,
                max_attempts
            );
            if let Some((group, _)) = &route_choice {
                state
                    .record_route_log(RouteLogEntry {
                        seq: 0,
                        kind: RouteLogKind::AllUnavailable,
                        group_id: group.id.clone(),
                        group_name: group.name.clone(),
                        strategy: group.strategy.clone(),
                        profile_id: None,
                        profile_name: None,
                        session_id: Some(session_id.clone()),
                        engine: Some(format!("{:?}", engine)),
                        attempt,
                        error: Some("组内所有 Profile 均已尝试且不可用".into()),
                        tried: tried_pairs.iter().map(|t| t.profile_id.clone()).collect(),
                        key_idx: None,
                        key_count: None,
                        ts_ms: 0,
                    })
                    .await;
            }
            break;
        }

        // 本回合用的 opts：从 base Clone，让 Profile 特定字段覆盖
        let session_opts_for_this_attempt = session_opts.clone();

        // 切入点 A 失败门控（应用 Profile 参数失败）
        let session_opts_for_this_attempt = match apply_model_profile_options(
            session_opts_for_this_attempt,
            chosen_profile_id.as_ref(),
            &engine,
            state,
            "start_chat_inner",
            &session_id,
        )
        .await
        {
            Ok(o) => o,
            Err(e) if attempt + 1 < max_attempts
                && route_choice.is_some()
                && is_failoverable_spawn_err(&e, &route_choice.as_ref().unwrap().0) =>
            {
                tracing::warn!(
                    "[start_chat_inner] Profile 应用失败 (attempt {}/{}): {}",
                    attempt + 1,
                    max_attempts,
                    e
                );
                if let Some((group, _)) = &route_choice {
                    state
                        .record_route_log(RouteLogEntry {
                            seq: 0,
                            kind: RouteLogKind::ApplyFailed,
                            group_id: group.id.clone(),
                            group_name: group.name.clone(),
                            strategy: group.strategy.clone(),
                            profile_id: chosen_profile_id.clone(),
                            profile_name: None,
                            session_id: Some(session_id.clone()),
                            engine: Some(format!("{:?}", engine)),
                            attempt,
                            error: Some(format!("{:?}", e)),
                            tried: tried_pairs.iter().map(|t| t.profile_id.clone()).collect(),
                            key_idx: current_route_selection.as_ref().and_then(|rs| rs.key_idx),
                            key_count: None,
                            ts_ms: 0,
                        })
                        .await;
                }
                continue;
            }
            Err(e) => return Err(e),
        };

        // spawn
        let mut registry = state.engine_registry.lock().await;
        match registry.start_session(Some(engine.clone()), &final_message, session_opts_for_this_attempt) {
            Ok(temp_id) => {
                // 成功：绑定会话亲和
                if let Some(ref pid) = chosen_profile_id {
                    state
                        .provider_router
                        .bind_affinity(&temp_id, pid, None)
                        .await;
                    tracing::info!(
                        "[start_chat_inner] 会话 {} 绑定 Profile {} (attempt {})",
                        temp_id,
                        pid,
                        attempt + 1
                    );
                    // 埋点：成功绑定
                    if let Some((group, _)) = &route_choice {
                        state
                            .record_route_log(RouteLogEntry {
                                seq: 0,
                                kind: RouteLogKind::Bound,
                                group_id: group.id.clone(),
                                group_name: group.name.clone(),
                                strategy: group.strategy.clone(),
                                profile_id: Some(pid.clone()),
                                profile_name: None,
                                session_id: Some(session_id.clone()),
                                engine: Some(format!("{:?}", engine)),
                                attempt,
                                error: None,
                                tried: tried_pairs.iter().map(|t| t.profile_id.clone()).collect(),
                                key_idx: current_route_selection.as_ref().and_then(|rs| rs.key_idx),
                                key_count: None,
                                ts_ms: 0,
                            })
                            .await;
                    }
                }
                final_session_id = Some(temp_id);
                break;
            }
            Err(e) if attempt + 1 < max_attempts
                && route_choice.is_some()
                && is_failoverable_spawn_err(&e, &route_choice.as_ref().unwrap().0) =>
            {
                // 切入点 B：spawn 级失败，切换到下一个 Profile
                tracing::warn!(
                    "[start_chat_inner] spawn 失败 (attempt {}/{}, 已尝试 {} 个 Profile): {}",
                    attempt + 1,
                    max_attempts,
                    tried_pairs.len(),
                    e
                );
                // 埋点：spawn 失败
                if let Some((group, _)) = &route_choice {
                    state
                        .record_route_log(RouteLogEntry {
                            seq: 0,
                            kind: RouteLogKind::SpawnFailed,
                            group_id: group.id.clone(),
                            group_name: group.name.clone(),
                            strategy: group.strategy.clone(),
                            profile_id: chosen_profile_id.clone(),
                            profile_name: None,
                            session_id: Some(session_id.clone()),
                            engine: Some(format!("{:?}", engine)),
                            attempt,
                            error: Some(format!("{:?}", e)),
                            tried: tried_pairs.iter().map(|t| t.profile_id.clone()).collect(),
                            key_idx: current_route_selection.as_ref().and_then(|rs| rs.key_idx),
                            key_count: None,
                            ts_ms: 0,
                        })
                        .await;
                }
                // 清理本回合的代理（防止端口泄漏）
                state.proxy_manager.stop_proxy(&session_id).await;
                continue;
            }
            Err(e) => return Err(e),
        }
    }

    final_session_id.ok_or_else(|| {
        AppError::ProcessError(
            "供应商分组内所有 Profile 均不可用，请检查端点配置后重试".to_string(),
        )
    })
}

