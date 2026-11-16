//! 供应商分组路由（P1：切入点 A/B，spawn 级 failover + 会话亲和）

use crate::error::AppError;
use crate::ai::EngineId;
use crate::models::config::{FailoverPattern, ProfileMode, ProviderGroup, RouteStrategy};
use crate::services::{FailoverError, RouteLogEntry, RouteLogKind};

// ============================================================================
// 供应商分组路由（P1：切入点 A/B，spawn 级 failover + 会话亲和）
//
// 当 Config.active_provider_group_id 指向一个存在且 active 的分组时，
// 新会话首请求走分组路由：按策略选 Profile，spawn 失败时自动切换到组内
// 下一个 Profile。否则回退单 Profile 旧路径（向后兼容）。
//
// 切入点 C（async error + 首字超时）在 P2 接入 claude.rs。
// ============================================================================

/// 解析当前生效的供应商分组。
///
/// `explicit_group_id`：带外指定的分组 ID（会话级覆盖，来自请求/provider_group_id）。
/// - Some(id) → 优先查找该分组（必须是 active 且非空成员）；找不到返回 None（回退官方）。
/// - None → 跟随全局 `active_provider_group_id`（默认行为）。
///
/// 返回 None 表示不启用分组（走单 Profile 旧路径）。
pub(super) async fn resolve_active_provider_group(
    state: &crate::AppState,
    explicit_group_id: Option<&str>,
) -> Option<(ProviderGroup, Vec<crate::models::config::ModelProfile>)> {
    let config = state.clone_config().ok()?;
    let group_id = explicit_group_id
        .map(|id| id.to_string())
        .or(config.active_provider_group_id.clone())?;
    let group = config.provider_groups.iter().find(|g| g.id == group_id && g.active)?;
    if group.members.is_empty() {
        return None;
    }
    let profiles = config.model_profiles;
    Some((group.clone(), profiles))
}

/// 解析一次请求应使用的 Profile ID + Key 索引（start / continue 共用）。
///
/// 判定优先级（与 PRD §2.3 契约表一致）：
/// 1. `profile_mode = Official` → 强制官方，忽略一切分组与 model_profile_id；
/// 2. `profile_mode = Profile` → 使用 `model_profile_id`（显式指定，屏蔽分组）；
/// 3. 激活了分组（`route_choice.is_some()`）时：
///    - 首条（无亲和）→ `select_initial` 按策略选首个
///    - 续聊（亲和命中）→ 复用亲和 Profile（同会话跨轮稳定）
///    - 亲和未命中 → `select_initial`
/// 4. 无分组（或没激活）→ 回退全局 `active_model_profile_id`。
///
/// `None` 返回值语义：官方端点（不绑定任何 Profile）。
/// 返回 `Some((profile_id, Option<key_idx>))` 供日志点记录 Key 级信息。
#[allow(clippy::too_many_arguments)]
pub(super) async fn resolve_profile_id_for_request(
    profile_mode: Option<ProfileMode>,
    model_profile_id: Option<&str>,
    state: &crate::AppState,
    route_choice: &Option<(ProviderGroup, Vec<crate::models::config::ModelProfile>)>,
    session_id: &str,
) -> Option<(String, Option<usize>)> {
    match resolve_profile_target(profile_mode, model_profile_id, route_choice.is_some()) {
        ResolvedTarget::Official => None,
        ResolvedTarget::ExplicitProfile(pid) => Some((pid, None)),
        ResolvedTarget::GlobalActive => state
            .clone_config()
            .ok()
            .and_then(|c| c.active_model_profile_id)
            .map(|pid| (pid, None)),
        ResolvedTarget::Group => {
            let Some((group, profiles)) = route_choice else {
                return None; // 防御：Group 目标但无激活分组
            };
            // 亲和优先（续聊稳定），其次 select_initial
            if let Some((affinity_pid, affinity_key_idx)) = state.provider_router.get_affinity(session_id).await {
                if profiles.iter().any(|p| p.id == affinity_pid) {
                    return Some((affinity_pid, affinity_key_idx));
                }
            }
            state
                .provider_router
                .select_initial(group, profiles, &std::collections::HashSet::new())
                .await
                .map(|s| (s.profile_id, s.key_idx))
        }
    }
}

/// 纯决策：一次请求应解析到的路由目标（不触碰 AppState，便于单测）。
///
/// 用同步纯函数承载 PRD §2.3 的整条优先级链，`resolve_profile_id_for_request`
/// 仅负责把目标映射到具体 Profile（需要 state 的 select_initial / 亲和 / 全局激活）。
#[derive(Debug, Clone, PartialEq)]
pub(super) enum ResolvedTarget {
    /// 官方端点（不绑定任何 Profile）
    Official,
    /// 显式指定 Profile（model_profile_id 有效）
    ExplicitProfile(String),
    /// 走分组路由（路由目标 = 激活分组）
    Group,
    /// 无分组、未显式 → 回退全局 active_model_profile_id
    GlobalActive,
}

pub(super) fn resolve_profile_target(
    profile_mode: Option<ProfileMode>,
    model_profile_id: Option<&str>,
    has_active_group: bool,
) -> ResolvedTarget {
    // 1. 强制官方
    if profile_mode == Some(ProfileMode::Official) {
        return ResolvedTarget::Official;
    }
    // 2. 显式指定 Profile（Group 模式除外 —— Group 是显式意图，忽略 model_profile_id）
    if let Some(pid) = model_profile_id {
        if profile_mode != Some(ProfileMode::Group) {
            return ResolvedTarget::ExplicitProfile(pid.to_string());
        }
    }
    // 3. 激活分组 → 分组路由
    if has_active_group {
        return ResolvedTarget::Group;
    }
    // 4. 无分组 → 官方（默认不指定 Profile 时无全局激活即官方）；
    //    有全局 active_model_profile_id 时走 GlobalActive 由调用方回退。
    ResolvedTarget::GlobalActive
}

/// 会话是否已经产生过路由日志（用于续聊轮选择日志去重：
/// 首条已记录 InitialSelect，续聊复用亲和只记 Bound）。
pub(super) async fn attempt_log_dedup(state: &crate::AppState, session_id: &str) -> bool {
    let logs = state.provider_router.all_logs().await;
    logs.iter()
        .filter(|l| l.session_id.as_deref() == Some(session_id))
        .any(|l| l.kind == RouteLogKind::InitialSelect)
}

/// 记录「分组路由不可用，回退官方」日志。
///
/// `group` 为 Some 时记录真实分组；None 表示「用户指定分组但无激活分组」，
/// group 字段兜底显示 active_provider_group_id（或"未设置分组"提示）。
pub(super) async fn record_official_fallback(
    state: &crate::AppState,
    group: Option<&ProviderGroup>,
    engine: &EngineId,
    session_id: &str,
) {
    let (group_id, group_name, strategy) = match group {
        Some(g) => (g.id.clone(), g.name.clone(), g.strategy.clone()),
        None => {
            let label = state
                .clone_config()
                .ok()
                .and_then(|c| c.active_provider_group_id)
                .unwrap_or_else(|| "（未设置分组）".to_string());
            ("".to_string(), label, RouteStrategy::Failover)
        }
    };
    state
        .record_route_log(RouteLogEntry {
            seq: 0,
            kind: RouteLogKind::OfficialFallback,
            group_id,
            group_name,
            strategy,
            profile_id: None,
            profile_name: None,
            session_id: Some(session_id.to_string()),
            engine: Some(format!("{:?}", engine)),
            attempt: 0,
            error: Some("用户指定分组路由，但无激活可用分组，已回退官方端点".into()),
            tried: vec![],
            key_idx: None,
            key_count: None,
            ts_ms: 0,
        })
        .await;
}

/// 判定一个 spawn 级错误是否可 failover（自动切换到下一个 Profile）。
///
/// 基于分组配置的 `FailoverPattern` 判定（复用数据模型，非字符串启发式）：
///   - 从 `AppError` 消息中解析出结构化的 `FailoverError`（HTTP 状态码、
///     ConnectionRefused、首字超时、stderr 原文）；
///   - 用 `group.effective_patterns()` 逐一匹配，命中任一即可 failover。
///
/// 不可 failover 的硬错误（与 Profile 无关，切换也不会好转）通过关键词
/// 预过滤排除，避免误切换：
///   - 命令行过长 (os error 206 / 32767 字符) — 上下文过大
///   - "stream-json 数据包含非 UTF-8" — 消息编码错误
///   - "session 已存在" — 会话状态冲突
pub(super) fn is_failoverable_spawn_err(err: &AppError, group: &ProviderGroup) -> bool {
    let msg = match err {
        AppError::ProcessError(m) => m.as_str(),
        AppError::ConfigError(m) => m.as_str(),
        _ => return false,
    };
    let low = msg.to_lowercase();

    // 不可 failover 的硬错误（优先排除，切 Profile 也不会好）
    if low.contains("32767 字符")
        || low.contains("os error 206")
        || low.contains("命令行参数总长度")
        || low.contains("stream-json 数据包含非 utf-8")
        || low.contains("session 已存在")
    {
        return false;
    }

    // 构造结构化的 FailoverError：从消息中解析 HTTP 状态码，
    // 并把 spawn 级失败视为 ConnectionRefused 候选。
    let foe = FailoverError {
        status: extract_http_status(msg),
        first_token_timeout: low.contains("timed out") || low.contains("timeout"),
        connection_refused: low.contains("connection refused")
            || low.contains("connectionrefused")
            // CLI 起不来 / 代理起不来的典型模式
            || low.contains("no such file or directory")
            || low.contains("command not found")
            || low.contains("启动")
                && (low.contains("进程失败") || low.contains("代理失败")),
        message: msg.to_string(),
    };

    FailoverPattern::matches_any(&foe, &group.effective_patterns())
}

/// 从错误消息文本中提取首个 HTTP 状态码（3 位数字、语义为状态码）。
///
/// 仅匹配 4xx/5xx 段（1xx-3xx 不构成 failover 触发条件），
/// 且要求前后为非数字边界，避免误抓端口号（如 "port 8080"）。
pub(super) fn extract_http_status(msg: &str) -> Option<u16> {
    let bytes = msg.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() {
        let c = bytes[i];
        // 只从 4 或 5 起始的 3 位数字开始（HTTP 失败状态码段）
        if (c == b'4' || c == b'5')
            && bytes[i + 1].is_ascii_digit()
            && bytes[i + 2].is_ascii_digit()
            && (i + 3 >= bytes.len() || !bytes[i + 3].is_ascii_digit())
            && (i == 0 || !bytes[i - 1].is_ascii_digit())
        {
            let code = ((c - b'0') as u16) * 100
                + ((bytes[i + 1] - b'0') as u16) * 10
                + ((bytes[i + 2] - b'0') as u16);
            return Some(code);
        }
        i += 1;
    }
    None
}

