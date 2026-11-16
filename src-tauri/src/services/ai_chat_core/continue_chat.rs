//! continue_chat_inner（K-R6 自 ai_chat_core.rs 迁入）

use std::path::PathBuf;
use std::sync::Arc;

use crate::ai::{
    launcher::{self, McpSessionConfig, McpConfigParams},
};
use crate::ai::{EngineId, ImageAttachment, SessionOptions};
use crate::error::{AppError, Result};
use crate::models::AIEvent;
use crate::services::{RouteLogEntry, RouteLogKind};


use super::attachments::*;
use super::callbacks::*;
use super::events::*;
use super::profile_options::*;
use super::provider_routing::*;
use super::start_chat::effective_mcp_work_dir;
use crate::models::config::ProfileMode;
use super::types::ChatRequestOptions;


pub async fn continue_chat_inner(
    session_id: String,
    message: String,
    options: ChatRequestOptions,
    state: &crate::AppState,
    callbacks: ChatCallbacks,
    app_paths: &AppPaths,
) -> Result<()> {
    tracing::info!(
        "[continue_chat_inner] 继续会话: {}, 附件数: {:?}",
        session_id,
        options.attachments.as_ref().map(|a| a.len())
    );

    let processed = if let (Some(dir), Some(atts)) = (&options.work_dir, &options.attachments) {
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

    let engine = options
        .engine_id
        .as_ref()
        .map(|id| EngineId::parse_any(id))
        .ok_or_else(|| AppError::ValidationError("必须提供有效的 engine_id".to_string()))?;

    tracing::info!("[continue_chat_inner] 使用引擎: {:?}", engine);

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
            "[continue_chat_inner] 发送事件: {}",
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

    // 后端权威：续聊的用户消息在此落库（会话 ID 已知，且不依赖客户端在线）
    crate::services::turn_persist::record_user_message(
        &session_id,
        &message,
        options.client_message_id.as_deref(),
        options.assistant_message_id.as_deref(),
        options.device_id.as_deref(),
    );

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
    if !processed.image_data.is_empty() {
        // 图片直通判定（同 start）：仅确定支持视觉的 Profile 才直通图块，否则走指向路径。
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
                "[continue_chat_inner] 传递 {} 张图片给引擎（stream-json 模式）",
                images.len()
            );
            session_opts = session_opts.with_image_attachments(images);
        } else {
            tracing::info!(
                "[continue_chat_inner] 模型不支持/未声明视觉，跳过图片直通（走落盘+指向路径），共 {} 张图",
                processed.image_data.len()
            );
        }
    }

    // ──────────────────────────────────────────────────────
    // 先杀掉本会话的旧 CLI 进程，再处理代理。
    // 仅对 CLI 类引擎（Claude/Simple AI/插件引擎）生效：它们每轮会 spawn 新进程,
    // 旧进程若有 in-flight 请求在等上游响应,代理端口被关闭时会收到
    // ConnectionRefused(见 99770ad8)。先 try_interrupt_all 杀旧进程,
    // 确保无 in-flight 请求后再安全切换代理。
    // ──────────────────────────────────────────────────────
    // SimpleAI 显式跳过:它的会话是单进程复用,中断走 watch::channel latch,
    // 一旦拨到 true 不可逆 —— 后续 continue 会在 run_chat_loop 首个检查点
    // 立即 SessionEnd 不输出任何内容(即"无法继续对话"根因)。
    // SimpleAI 的 continue 是复用同一会话追加消息,无需也不应先中断。
    // 注意:用户主动点"停止"走 interrupt_chat_inner,该路径仍会对 SimpleAI
    // 调 try_interrupt_all,本处只收窄 continue 路径,不影响主动停止。
    // ──────────────────────────────────────────────────────
    {
        let mut registry = state.engine_registry.lock().await;
        let is_resident = matches!(engine, EngineId::SimpleAI);
        if !is_resident {
            // B2.e（审计 3.3 错配可观测）：engineId 错配（scheduler 自动建/历史恢复
            // 缺 engineId/fork）时，此处 try_interrupt_all 会命中 SimpleAI 的不可逆
            // latch，误杀正在流式的会话。渐进路线先加告警不删兜底（裁决方案甲 2）：
            // 命中即 warn + 进度事件，错配频率可观测后再决定拆除方式。
            let mismatch = registry
                .get(&EngineId::SimpleAI)
                .map(|e| e.has_active_session(&session_id))
                .unwrap_or(false);
            if mismatch {
                tracing::warn!(
                    "[continue_chat_inner] engineId 错配：engine={:?} 但 SimpleAI 会话 {} 正在运行，续聊前置中断兜底将中断它",
                    engine,
                    session_id
                );
                let ctx = options
                    .context_id
                    .clone()
                    .unwrap_or_else(|| "main".to_string());
                let warn_ev = AIEvent::Progress(crate::models::ai_event::ProgressEvent::new(
                    &session_id,
                    "⚠️ 检测到引擎标识错配，续聊前置中断可能误杀进行中的会话（已记录）",
                ));
                (callbacks.emit_event)(serde_json::json!({
                    "contextId": ctx,
                    "payload": warn_ev,
                }));
            }
            registry.try_interrupt_all(&session_id);
        }
    }

    // ──────────────────────────────────────────────────────
    // 供应商分组路由（切入 continue 路径）
    //
    // continue_chat_inner 在续聊时与 start_chat_inner 保持同样的选路能力：
    //   - 有显式 model_profile_id（用户指定 Profile）→ 用该 Profile；
    //   - 否则若激活了分组 → 分组路由：
    //       · 会话亲和表命中（首条曾绑定）→ 复用同一 Profile（同会话跨轮稳定）；
    //       · 否则按策略 select_initial 选首个；
    //   - 否则回退官方（apply_model_profile_options 传 None 原样返回）。
    //
    // 续聊不做 failover loop（P1 切入点在 start 路径已实现），但由于会话亲和，
    // 续聊与首条保持在同一个 Profile，首条的高可用能力即可覆盖整条会话链路。
    // ──────────────────────────────────────────────────────
    let route_choice = resolve_active_provider_group(state, options.provider_group_id.as_deref()).await;
    // 与 start_chat_inner 的判定优先级一致：profile_mode 显式指定优先，
    // 向前兼容（profile_mode=None）时 model_profile_id 优先于分组。
    // 返回值包含 (profile_id, Option<key_idx>)，用于日志记录 Key 级信息。
    let chosen_profile: Option<(String, Option<usize>)> = resolve_profile_id_for_request(
        options.profile_mode,
        options.model_profile_id.as_deref(),
        state,
        &route_choice,
        &session_id,
    )
    .await;
    let chosen_profile_id: Option<String> = chosen_profile.as_ref().map(|(pid, _)| pid.clone());
    let continue_key_idx: Option<usize> = chosen_profile.as_ref().and_then(|(_, ki)| *ki);
    if let Some((group, profiles)) = &route_choice {
        if let Some(ref pid) = chosen_profile_id {
            // 记录续聊轮的选择日志（InitialSelect / Bound），供路由日志面板追踪。
            let kind = if attempt_log_dedup(state, &session_id).await {
                RouteLogKind::Bound
            } else {
                RouteLogKind::InitialSelect
            };
            state
                .record_route_log(RouteLogEntry {
                    seq: 0,
                    kind,
                    group_id: group.id.clone(),
                    group_name: group.name.clone(),
                    strategy: group.strategy.clone(),
                    profile_id: Some(pid.clone()),
                    profile_name: profiles
                        .iter()
                        .find(|p| &p.id == pid).map(|p| p.name.clone())
                        .or_else(|| Some(pid.clone())),
                    session_id: Some(session_id.clone()),
                    engine: Some(format!("{:?}", engine)),
                    attempt: 0,
                    error: None,
                    tried: vec![],
                    key_idx: continue_key_idx,
                    key_count: None,
                    ts_ms: 0,
                })
                .await;
        }
    } else if options.profile_mode == Some(ProfileMode::Group) {
        // 用户显式选「分组路由」但无激活分组：记录日志并回退官方（无 group 可用）。
        record_official_fallback(state, None, &engine, &session_id).await;
    }

    session_opts = apply_model_profile_options(
        session_opts,
        chosen_profile_id.as_ref(),
        &engine,
        state,
        "continue_chat_inner",
        &session_id,
    )
    .await?;

    let mut registry = state.engine_registry.lock().await;

    // 按指定引擎续接会话
    match registry.continue_session(engine.clone(), &session_id, &final_message, session_opts.clone()) {
        Ok(()) => Ok(()),
        Err(primary_err) => {
            // 兜底：指定引擎续接失败时，遍历所有引擎尝试（与 try_interrupt_all 模式一致）
            tracing::warn!(
                "[continue_chat_inner] 指定引擎 {:?} 续接失败，尝试遍历所有引擎: {}",
                engine,
                primary_err
            );
            if registry.try_continue_all(&engine, &session_id, &final_message, session_opts) {
                Ok(())
            } else {
                Err(primary_err)
            }
        }
    }
}

