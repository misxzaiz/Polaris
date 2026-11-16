//! dispatch 任务注册/续聊/事件（K-R3 拆分）

use super::plugin_card::parse_dispatch_depth;
use crate::state::DispatchedTask;
use super::types::{MAX_DISPATCH_DEPTH, MAX_ACTIVE_DISPATCHES};

use serde_json::{json, Value};
use uuid::Uuid;
use crate::state::AppState;

/// 派发注册参数（MCP dispatch 帧与 dispatch_create_task 命令共用）
#[derive(Debug, Clone, Default)]
pub struct DispatchTaskParams {
    pub source_session_id: String,
    pub prompt: String,
    pub title: Option<String>,
    pub work_dir: Option<String>,
    pub engine_id: Option<String>,
    /// 队员角色名（优先级最高，命中预设后覆盖 engine/model/profile）
    pub role: Option<String>,
    /// 模型供应商：Profile 名称或 id；"official" = 显式官方端点
    pub provider: Option<String>,
    pub model: Option<String>,
    /// 指定 dispatch_id（MCP 帧携带；命令路径留空自动生成）
    pub dispatch_id: Option<String>,
    /// 结构化结果 schema id（P2-2，可选）
    pub result_schema: Option<String>,
    /// NEXUS roster 流水线 id（P2-5，仅内部派发路径设置）
    pub roster_id: Option<String>,
    /// 调用方显式注入的 system prompt（专家人格 body 等）。
    /// 优先级最高:覆盖 preset.append_system_prompt,result_schema 注入在其后追加。
    pub append_system_prompt: Option<String>,
}

impl DispatchTaskParams {
    fn from_frame(frame: &Value) -> Self {
        let opt_str = |key: &str| {
            frame
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        Self {
            source_session_id: frame
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            prompt: frame
                .get("prompt")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
                .to_string(),
            title: opt_str("title"),
            work_dir: opt_str("workDir"),
            engine_id: opt_str("engineId"),
            role: opt_str("role"),
            provider: opt_str("provider"),
            model: opt_str("model"),
            dispatch_id: opt_str("dispatchId"),
            result_schema: opt_str("resultSchema"),
            roster_id: None,
            append_system_prompt: opt_str("appendSystemPrompt"),
        }
    }
}

/// 按角色名解析队员预设；未命中返回含候选列表的错误
fn resolve_dispatch_preset(
    config: &crate::models::config::Config,
    role: &str,
) -> std::result::Result<crate::models::config::DispatchPreset, String> {
    let presets = &config.dispatch.presets;
    if let Some(preset) = presets.iter().find(|p| p.name == role) {
        return Ok(preset.clone());
    }
    let lower = role.to_lowercase();
    let ci_matches: Vec<_> = presets
        .iter()
        .filter(|p| p.name.to_lowercase() == lower)
        .collect();
    match ci_matches.len() {
        1 => Ok(ci_matches[0].clone()),
        _ => {
            let available = presets
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join("、");
            Err(if available.is_empty() {
                format!("未找到队员预设「{}」，当前未配置任何预设；可改用 provider/model 参数或省略以继承来源会话", role)
            } else {
                format!("未找到队员预设「{}」，可用角色：{}", role, available)
            })
        }
    }
}

/// 按名称/id 解析模型 Profile；歧义或未命中返回含候选的错误。
/// 返回 Some("official") 哨兵表示显式官方端点。
fn resolve_dispatch_provider(
    config: &crate::models::config::Config,
    provider: &str,
) -> std::result::Result<Option<String>, String> {
    if provider.eq_ignore_ascii_case("official") {
        return Ok(Some("official".to_string()));
    }
    let profiles = &config.model_profiles;
    if let Some(p) = profiles.iter().find(|p| p.id == provider) {
        return Ok(Some(p.id.clone()));
    }
    if let Some(p) = profiles.iter().find(|p| p.name == provider) {
        return Ok(Some(p.id.clone()));
    }
    let lower = provider.to_lowercase();
    let ci_matches: Vec<_> = profiles
        .iter()
        .filter(|p| p.name.to_lowercase().contains(&lower))
        .collect();
    match ci_matches.len() {
        1 => Ok(Some(ci_matches[0].id.clone())),
        0 => {
            let available = profiles
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join("、");
            Err(format!(
                "未找到模型供应商「{}」，可用：{}（或 \"official\" 使用官方端点）",
                provider,
                if available.is_empty() { "无" } else { &available }
            ))
        }
        _ => {
            let candidates = ci_matches
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join("、");
            Err(format!(
                "供应商「{}」匹配到多个 Profile：{}，请使用完整名称",
                provider, candidates
            ))
        }
    }
}

/// 校验并登记派发任务（MCP dispatch 帧与 dispatch_create_task 命令共用）。
///
/// 完成深度/并发校验与 role/provider 解析，插入注册表并返回任务记录；
/// 调用方负责把任务下发给前端执行（emit 事件或命令返回值）。
pub fn register_dispatch_task(
    state: &AppState,
    params: DispatchTaskParams,
) -> std::result::Result<DispatchedTask, String> {
    if params.prompt.is_empty() {
        return Err("dispatch 请求缺少 prompt".to_string());
    }

    // 深度限制：防止派发会话无限递归派发
    let depth = parse_dispatch_depth(&params.source_session_id) + 1;
    if depth > MAX_DISPATCH_DEPTH {
        return Err(format!(
            "派发深度已达上限（{}），当前会话不能再派发子任务",
            MAX_DISPATCH_DEPTH
        ));
    }

    // 并发限制：防止资源被并行引擎进程打满
    let active = state.active_dispatched_task_count();
    if active >= MAX_ACTIVE_DISPATCHES {
        return Err(format!(
            "已有 {} 个派发任务在执行（上限 {}），请等待现有任务完成后再派发，可用 check_dispatched_task 查询进度",
            active, MAX_ACTIVE_DISPATCHES
        ));
    }

    // role/provider 解析（需要配置）
    let config = state.clone_config().unwrap_or_default();
    let mut engine_id = params.engine_id.clone();
    let mut model = params.model.clone();
    let mut model_profile_id: Option<String> = None;
    let mut permission_mode: Option<String> = None;
    let mut role: Option<String> = None;

    // system prompt 三来源合并(优先级: params 显式人格 > preset > result_schema 追加)
    let mut append_system_prompt: Option<String> = params.append_system_prompt.clone();

    if let Some(role_name) = params.role.as_deref() {
        // role 可能是 DispatchPreset 名(队员预设)或 corpus 专家 slug(/dispatch <slug>)。
        // 命中 preset → 应用其引擎/模型/profile/权限;未命中 → 当 corpus slug 读人格注入,
        // 引擎/模型继承来源会话(不报错,兼容单人专家派发)。
        match resolve_dispatch_preset(&config, role_name) {
            Ok(preset) => {
                role = Some(preset.name.clone());
                engine_id = Some(preset.engine_id.clone());
                model_profile_id = preset.model_profile_id.clone();
                model = params.model.clone().or(preset.model.clone());
                permission_mode = preset.permission_mode.clone();
                if append_system_prompt.is_none() {
                    append_system_prompt = preset.append_system_prompt.clone();
                }
            }
            Err(_) => {
                // 未命中 preset:尝试当全局专家 slug 读人格注入。
                // 路径与 nexus_pipeline::load_agent_persona 同构,复用 simple_ai::load_agent_def。
                if let Some((_s, _desc, body)) =
                    crate::ai::engine::simple_ai::load_agent_def(role_name)
                {
                    if !body.trim().is_empty() && append_system_prompt.is_none() {
                        append_system_prompt = Some(body);
                        role = Some(role_name.to_string());
                        tracing::info!("[Dispatch] role「{role_name}」按全局专家注入人格");
                    }
                }
                // 全局也无该 slug:role 仍记名(供展示),引擎/模型继承来源会话
                if role.is_none() {
                    role = Some(role_name.to_string());
                }
            }
        }
    } else if let Some(provider) = params.provider.as_deref() {
        model_profile_id = resolve_dispatch_provider(&config, provider)?;
    }

    // resultSchema 校验与结构化输出指令注入（P2-2，追加在人格之后）
    if let Some(schema_id) = params.result_schema.as_deref() {
        if !crate::services::nexus_verdict::schema_exists(schema_id) {
            return Err(format!(
                "未知 resultSchema: {schema_id}；可用: qa-pass/qa-fail/phase-gate/escalation/qa-verdict"
            ));
        }
        if let Some(injection) = crate::services::nexus_verdict::build_injection(schema_id) {
            append_system_prompt = Some(match append_system_prompt.take() {
                Some(existing) => format!("{existing}{injection}"),
                None => injection,
            });
        }
    }

    let dispatch_id = params
        .dispatch_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let short_id: String = Uuid::new_v4().simple().to_string()[..8].to_string();
    let session_id = format!("dispatch-{}-{}", depth, short_id);

    let title = params.title.clone().unwrap_or_else(|| {
        let mut t: String = params.prompt.chars().take(24).collect();
        if params.prompt.chars().count() > 24 {
            t.push('…');
        }
        t
    });

    let now = chrono::Utc::now().timestamp();
    let task = DispatchedTask {
        dispatch_id: dispatch_id.clone(),
        session_id,
        source_session_id: params.source_session_id,
        title,
        prompt: params.prompt,
        work_dir: params.work_dir,
        engine_id,
        depth,
        role,
        model_profile_id,
        model,
        append_system_prompt,
        permission_mode,
        status: "pending".to_string(),
        summary: None,
        latest_activity: None,
        conversation_id: None,
        result_schema: params.result_schema,
        roster_id: params.roster_id,
        verdict: None,
        verdict_status: None,
        verdict_retry_done: false,
        created_at: now,
        updated_at: now,
    };

    tracing::info!(
        "[Dispatch] 派发任务登记: dispatch_id={}, session_id={}, depth={}, role={:?}, title={}",
        task.dispatch_id,
        task.session_id,
        task.depth,
        task.role,
        task.title
    );
    state.insert_dispatched_task(task.clone());
    Ok(task)
}

/// 对已终态的派发任务追加指令（同会话续跑）：置 running 并通知前端。
/// nexus Dev↔QA loop 与 verdict 校验重试复用此入口；/dispatch continue 亦经
/// commands/dispatch.rs 到此（原 TCP 帧入口已随 polaris-dispatch MCP server 移除）。
pub fn trigger_dispatch_continue(
    state: &AppState,
    dispatch_id: &str,
    prompt: &str,
) -> std::result::Result<(), String> {
    let task = state
        .get_dispatched_task(dispatch_id)
        .ok_or_else(|| format!("未找到派发任务: {dispatch_id}"))?;
    if matches!(task.status.as_str(), "pending" | "running") {
        return Err("任务仍在执行中".into());
    }
    state.update_dispatched_task(dispatch_id, |t| {
        t.status = "running".to_string();
        t.latest_activity = None;
    });
    emit_dispatch_event(
        state,
        "dispatch-task-continue",
        &json!({
            "dispatchId": task.dispatch_id,
            "sessionId": task.session_id,
            "prompt": prompt,
            "conversationId": task.conversation_id,
        }),
    );
    Ok(())
}

/// 通用事件发射(nexus 进度等;tauri emit / web ws 双通道)
pub fn emit_event(state: &AppState, event_name: &str, payload: &Value) {
    emit_dispatch_event(state, event_name, payload);
}

/// 供 nexus_pipeline 派发成员时通知前端（复用 dispatch-task-request 事件链路）
pub fn emit_dispatch_request(state: &AppState, task: &DispatchedTask) {
    emit_dispatch_event(state, "dispatch-task-request", &dispatch_request_payload(task));
}

/// 处理 find_expert 帧(U2-4):L1 coordination.json 任务类型查表(零 token 确定性),
/// miss 时 L2 catalog+自定义专家关键词候选(调用方 LLM 做最终语义挑选)。
fn dispatch_request_payload(task: &DispatchedTask) -> Value {
    json!({
        "dispatchId": task.dispatch_id,
        "sessionId": task.session_id,
        "sourceSessionId": task.source_session_id,
        "prompt": task.prompt,
        "title": task.title,
        "workDir": task.work_dir,
        "engineId": task.engine_id,
        "role": task.role,
        "modelProfileId": task.model_profile_id,
        "model": task.model,
        "appendSystemPrompt": task.append_system_prompt,
        "permissionMode": task.permission_mode,
    })
}

/// 处理 dispatch_status 帧：查询派发任务状态并立即回帧。
fn emit_dispatch_event(state: &AppState, event_name: &str, payload: &Value) {
    #[cfg(feature = "tauri-app")]
    if let Some(handle) = state.app_handle.get() {
        use tauri::Emitter;
        if let Err(error) = handle.emit(event_name, payload) {
            tracing::warn!("[AskListener] emit {} 失败: {}", event_name, error);
        }
        return;
    }

    let ws_msg = serde_json::json!({
        "event": event_name,
        "payload": payload,
    });
    if let Ok(msg) = serde_json::to_string(&ws_msg) {
        let _ = state.event_broadcast.send(msg);
    }
}
