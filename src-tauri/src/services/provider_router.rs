/*! 供应商分组路由决策层（P1）

在新会话首请求时按分组策略选 Profile；请求失败时按策略选下一个 Profile。

设计要点：
- **纯决策逻辑**：本模块不触碰 `AppState` / `EngineRegistry` / `ProxyManager`，
  只做"给定 group + profiles + 已尝试集合 → 下一个 Profile"的纯计算，
  便于单测（参考 `simple_ai/retry.rs` 的纯函数设计）。
- **会话亲和**：`select_initial` 选出的 Profile 会绑定到 session_id，
  续聊时优先复用（避免同一会话在不同端点间跳）。
- **健康缓存**：可选注入外部健康状态；未注入时视为全部健康（P1 不做后台探活）。
- **轮询游标**：RoundRobin 策略用原子计数器，持久化在内存（P1），
  进程重启归零可接受（轮询偏差自愈）。

P1 范围：Failover + RoundRobin + Weighted 三策略的纯决策 + 单测。
切入点 A（spawn 前）/B（spawn 失败）在 `start_chat_inner` 接线；
切入点 C（async error + 首字超时）在 P2 接线。
*/

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;

use crate::models::config::{
    FailoverPattern, GroupMember, ModelProfile, ProviderGroup, RouteStrategy,
};

/// 路由日志环形缓冲容量（保留最近 N 条决策记录）
const ROUTE_LOG_CAPACITY: usize = 200;

/// 路由决策事件类型
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RouteLogKind {
    /// 首轮选择 Profile（按策略 select_initial）
    InitialSelect,
    /// failover 切换到下一个 Profile（select_next）
    FailoverSwitch,
    /// Profile 应用失败（apply_model_profile_options 报错）
    ApplyFailed,
    /// spawn 级失败（引擎起不来）
    SpawnFailed,
    /// 成功启动并绑定会话亲和
    Bound,
    /// 全部 Profile 不可用
    AllUnavailable,
    /// 用户显式要求分组路由，但无激活可用分组 → 回退官方端点
    /// （区别于 AllUnavailable：不是组内全挂，而是「组不存在 / 未激活 / 空成员」）
    OfficialFallback,
}

/// 路由决策日志条目
///
/// 记录每次会话首请求的 Profile 选择 / failover 切换 / 失败原因。
/// 供"请求响应日志面板"展示（前端 `provider_route_logs` 命令拉取 +
/// `provider-route-log` 事件增量推送）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteLogEntry {
    /// 单调递增序号（前端去重/排序用）
    pub seq: u64,
    /// 事件类型
    pub kind: RouteLogKind,
    /// 分组 ID
    pub group_id: String,
    /// 分组名称
    pub group_name: String,
    /// 路由策略
    pub strategy: RouteStrategy,
    /// 本轮选中的 Profile ID（失败轮可能为空）
    pub profile_id: Option<String>,
    /// 本轮选中的 Profile 名称
    pub profile_name: Option<String>,
    /// 会话临时 ID（start_chat_inner 生成的 uuid，用于关联同一次请求的多条日志）
    pub session_id: Option<String>,
    /// 引擎 ID
    pub engine: Option<String>,
    /// 尝试轮次（0-based）
    pub attempt: usize,
    /// 失败原因（仅失败类事件有值）
    pub error: Option<String>,
    /// 已尝试过的 Profile ID 列表（failover 累计）
    pub tried: Vec<String>,
    /// 时间戳（毫秒，UNIX_EPOCH 起）
    pub ts_ms: u64,
}

/// failover 决策所需的上游错误摘要（从 spawn 失败或 async error 提取）
#[derive(Debug, Clone)]
pub struct FailoverError {
    /// HTTP 状态码（若可解析）
    pub status: Option<u16>,
    /// 是否首字超时
    pub first_token_timeout: bool,
    /// 是否连接被拒（spawn 后立即崩溃）
    pub connection_refused: bool,
    /// stderr / 错误消息原文（用于关键词匹配）
    pub message: String,
}

impl FailoverError {
    pub fn from_spawn_err(msg: &str) -> Self {
        // spawn 级失败统一视为 ConnectionRefused 类（CLI 起不来 / 代理起不来）
        Self {
            status: None,
            first_token_timeout: false,
            connection_refused: true,
            message: msg.to_string(),
        }
    }
}

impl FailoverPattern {
    /// 判定一个上游错误是否匹配此模式
    pub fn matches(&self, err: &FailoverError) -> bool {
        match self {
            Self::HttpStatus { code } => {
                // code=500 代表 5xx 全段
                err.status
                    .map(|s| s == *code || (*code >= 500 && s >= 500 && s < 600))
                    .unwrap_or(false)
            }
            Self::FirstTokenTimeout => err.first_token_timeout,
            Self::ConnectionRefused => err.connection_refused,
            Self::StderrContains { pattern } => err.message.to_lowercase().contains(&pattern.to_lowercase()),
        }
    }

    /// 判定错误是否命中任一模式
    pub fn matches_any(err: &FailoverError, patterns: &[Self]) -> bool {
        patterns.iter().any(|p| p.matches(err))
    }
}

/// 供应商路由器
///
/// 持有轮询游标 + 会话亲和表 + 健康缓存 + 路由日志环形缓冲。线程安全（Arc 共享）。
pub struct ProviderRouter {
    /// 轮询游标：group_id → 原子计数器
    cursors: AsyncMutex<HashMap<String, Arc<AtomicU64>>>,
    /// 会话亲和：session_id → profile_id（P2 接线写入）
    affinity: AsyncMutex<HashMap<String, String>>,
    /// 路由日志环形缓冲（容量 ROUTE_LOG_CAPACITY，溢出丢最旧）
    logs: AsyncMutex<VecDeque<RouteLogEntry>>,
    /// 日志序号（单调递增，AtomicU64 保证并发安全）
    log_seq: AtomicU64,
}

impl ProviderRouter {
    pub fn new() -> Self {
        Self {
            cursors: AsyncMutex::new(HashMap::new()),
            affinity: AsyncMutex::new(HashMap::new()),
            logs: AsyncMutex::new(VecDeque::with_capacity(ROUTE_LOG_CAPACITY)),
            log_seq: AtomicU64::new(0),
        }
    }

    /// 记录一条路由决策日志到环形缓冲。
    ///
    /// 自动填充 seq 和 ts_ms。调用方提供业务字段即可。
    /// 用于"请求响应日志面板"追踪每次会话首请求的 Profile 选择与 failover 链路。
    pub async fn record_log(&self, mut entry: RouteLogEntry) -> RouteLogEntry {
        entry.seq = self.log_seq.fetch_add(1, Ordering::Relaxed);
        entry.ts_ms = now_ms();
        let mut logs = self.logs.lock().await;
        if logs.len() >= ROUTE_LOG_CAPACITY {
            logs.pop_front();
        }
        logs.push_back(entry.clone());
        entry
    }

    /// 返回当前缓冲内全部日志（按 seq 升序，即时间顺序）。
    /// 供 `provider_route_logs` 命令调用，前端面板打开时全量拉取。
    pub async fn all_logs(&self) -> Vec<RouteLogEntry> {
        let logs = self.logs.lock().await;
        logs.iter().cloned().collect()
    }

    /// 返回 seq 大于 `since` 的增量日志（前端轮询/续拉）。
    pub async fn logs_since(&self, since: u64) -> Vec<RouteLogEntry> {
        let logs = self.logs.lock().await;
        logs.iter()
            .filter(|e| e.seq > since)
            .cloned()
            .collect()
    }

    /// 清空日志缓冲。
    pub async fn clear_logs(&self) {
        let mut logs = self.logs.lock().await;
        logs.clear();
    }

    /// 为新会话选择首个 Profile（按 strategy）
    ///
    /// `healthy_profile_ids`：外部传入的健康 Profile ID 集合（P1 可传空 = 全视为健康）
    ///
    /// **仅在首请求调用一次**。failover 重试必须改用 [`select_next`]：
    /// - `select_initial` 不接收 `tried`，Failover 策略下永远返回 priority
    ///   最低的同一个 Profile，重试会陷入"反复选同一主 Profile"死循环；
    /// - RoundRobin 策略下 `select_initial` 会推进游标，重试调用会导致轮询跳号。
    pub async fn select_initial(
        &self,
        group: &ProviderGroup,
        profiles: &[ModelProfile],
        healthy_profile_ids: &std::collections::HashSet<String>,
    ) -> Option<ModelProfile> {
        let ordered = group.ordered_members();
        let healthy_members: Vec<&GroupMember> = ordered
            .into_iter()
            .filter(|m| is_healthy(&m.profile_id, healthy_profile_ids))
            .collect();
        if healthy_members.is_empty() {
            return None;
        }

        match group.strategy {
            RouteStrategy::Failover => {
                // priority 升序后取首个（ordered_members 已排序）
                pick_profile(&healthy_members[0].profile_id, profiles)
            }
            RouteStrategy::RoundRobin => {
                let idx = self.advance_cursor(&group.id, healthy_members.len()).await;
                let member = &healthy_members[idx % healthy_members.len()];
                pick_profile(&member.profile_id, profiles)
            }
            RouteStrategy::Weighted => {
                weighted_pick(&healthy_members, profiles)
            }
        }
    }

    /// failover 时选下一个 Profile（跳过已尝试的）
    ///
    /// Failover 策略：按 priority 升序取下一个健康且未尝试的；
    /// RoundRobin/Weighted：取下一个健康且未尝试的（顺序遍历）
    pub async fn select_next(
        &self,
        group: &ProviderGroup,
        tried: &[String],
        profiles: &[ModelProfile],
        healthy_profile_ids: &std::collections::HashSet<String>,
    ) -> Option<ModelProfile> {
        let ordered = group.ordered_members();
        for member in ordered.iter() {
            if tried.iter().any(|t| t == &member.profile_id) {
                continue;
            }
            if !is_healthy(&member.profile_id, healthy_profile_ids) {
                continue;
            }
            if let Some(p) = pick_profile(&member.profile_id, profiles) {
                return Some(p);
            }
        }
        None
    }

    /// 绑定会话亲和（首请求成功后调用）
    pub async fn bind_affinity(&self, session_id: &str, profile_id: &str) {
        let mut aff = self.affinity.lock().await;
        aff.insert(session_id.to_string(), profile_id.to_string());
    }

    /// 查询会话亲和的 Profile（续聊时优先复用）
    pub async fn get_affinity(&self, session_id: &str) -> Option<String> {
        let aff = self.affinity.lock().await;
        aff.get(session_id).cloned()
    }

    /// 清除会话亲和（会话结束时调用，防内存泄漏）
    pub async fn clear_affinity(&self, session_id: &str) {
        let mut aff = self.affinity.lock().await;
        aff.remove(session_id);
    }

    /// 推进轮询游标并返回当前索引
    async fn advance_cursor(&self, group_id: &str, len: usize) -> usize {
        if len == 0 {
            return 0;
        }
        let mut cursors = self.cursors.lock().await;
        let counter = cursors
            .entry(group_id.to_string())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)));
        let prev = counter.fetch_add(1, Ordering::Relaxed);
        (prev as usize) % len
    }
}

impl Default for ProviderRouter {
    fn default() -> Self {
        Self::new()
    }
}

/// 判定 Profile 是否健康（空健康集合 = 全视为健康，P1 默认行为）
fn is_healthy(profile_id: &str, healthy: &std::collections::HashSet<String>) -> bool {
    healthy.is_empty() || healthy.contains(profile_id)
}

/// 按 profile_id 从 profiles 列表查找
fn pick_profile(profile_id: &str, profiles: &[ModelProfile]) -> Option<ModelProfile> {
    profiles.iter().find(|p| p.id == profile_id).cloned()
}

/// 加权随机选择
fn weighted_pick(
    members: &[&GroupMember],
    profiles: &[ModelProfile],
) -> Option<ModelProfile> {
    let total: u32 = members.iter().map(|m| m.weight.max(1)).sum();
    if total == 0 {
        return None;
    }
    // 确定性测试：此处用简单线性同余避免引入 rand 依赖（P1 测试需要确定性）
    // 生产可后续替换为 rand。用系统纳秒做种子，避免测试非确定性时改用注入。
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let r = (seed % total as u64) as u32;
    let mut acc = 0u32;
    for m in members {
        acc += m.weight.max(1);
        if r < acc {
            return pick_profile(&m.profile_id, profiles);
        }
    }
    // 精度兜底
    pick_profile(&members.last()?.profile_id, profiles)
}

/// 当前 UNIX 毫秒时间戳（供 RouteLogEntry.ts_ms 填充）
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str) -> ModelProfile {
        ModelProfile {
            id: id.to_string(),
            name: id.to_string(),
            base_url: format!("https://{}.test", id),
            api_key: "key".into(),
            model: "m".into(),
            ..Default::default()
        }
    }

    fn member(id: &str, priority: u32, weight: u32) -> GroupMember {
        GroupMember {
            profile_id: id.to_string(),
            priority,
            weight,
        }
    }

    fn group(strategy: RouteStrategy, members: Vec<GroupMember>) -> ProviderGroup {
        ProviderGroup {
            id: "g1".into(),
            name: "g1".into(),
            strategy,
            members,
            failover_on: vec![],
            first_token_timeout_secs: None,
            max_failover_attempts: 3,
            active: true,
        }
    }

    fn empty_health() -> std::collections::HashSet<String> {
        std::collections::HashSet::new()
    }

    #[tokio::test]
    async fn failover_selects_lowest_priority_first() {
        let g = group(
            RouteStrategy::Failover,
            vec![member("backup", 1, 1), member("main", 0, 1)],
        );
        let profiles = vec![profile("main"), profile("backup")];
        let router = ProviderRouter::new();
        let pick = router
            .select_initial(&g, &profiles, &empty_health())
            .await
            .unwrap();
        assert_eq!(pick.id, "main"); // priority 0 优先
    }

    #[tokio::test]
    async fn failover_select_next_skips_tried() {
        let g = group(
            RouteStrategy::Failover,
            vec![member("main", 0, 1), member("backup", 1, 1)],
        );
        let profiles = vec![profile("main"), profile("backup")];
        let router = ProviderRouter::new();
        let next = router
            .select_next(&g, &["main".into()], &profiles, &empty_health())
            .await
            .unwrap();
        assert_eq!(next.id, "backup");
    }

    #[tokio::test]
    async fn failover_select_next_returns_none_when_all_tried() {
        let g = group(
            RouteStrategy::Failover,
            vec![member("main", 0, 1), member("backup", 1, 1)],
        );
        let profiles = vec![profile("main"), profile("backup")];
        let router = ProviderRouter::new();
        let next = router
            .select_next(
                &g,
                &["main".into(), "backup".into()],
                &profiles,
                &empty_health(),
            )
            .await;
        assert!(next.is_none());
    }

    #[tokio::test]
    async fn round_robin_rotates_across_calls() {
        let g = group(
            RouteStrategy::RoundRobin,
            vec![member("a", 0, 1), member("b", 0, 1), member("c", 0, 1)],
        );
        let profiles = vec![profile("a"), profile("b"), profile("c")];
        let router = ProviderRouter::new();
        let first = router.select_initial(&g, &profiles, &empty_health()).await.unwrap();
        let second = router.select_initial(&g, &profiles, &empty_health()).await.unwrap();
        let third = router.select_initial(&g, &profiles, &empty_health()).await.unwrap();
        let fourth = router.select_initial(&g, &profiles, &empty_health()).await.unwrap();
        // 轮转 a→b→c→a
        assert_eq!(first.id, "a");
        assert_eq!(second.id, "b");
        assert_eq!(third.id, "c");
        assert_eq!(fourth.id, "a");
    }

    #[tokio::test]
    async fn healthy_filter_skips_unhealthy() {
        let g = group(
            RouteStrategy::Failover,
            vec![member("main", 0, 1), member("backup", 1, 1)],
        );
        let profiles = vec![profile("main"), profile("backup")];
        let mut healthy = std::collections::HashSet::new();
        healthy.insert("backup".into()); // main 不健康
        let router = ProviderRouter::new();
        let pick = router.select_initial(&g, &profiles, &healthy).await.unwrap();
        assert_eq!(pick.id, "backup");
    }

    #[tokio::test]
    async fn select_initial_returns_none_when_all_unhealthy() {
        let g = group(RouteStrategy::Failover, vec![member("main", 0, 1)]);
        let profiles = vec![profile("main")];
        let mut healthy = std::collections::HashSet::new();
        healthy.insert("other".into()); // 不含 main
        let router = ProviderRouter::new();
        let pick = router.select_initial(&g, &profiles, &healthy).await;
        assert!(pick.is_none());
    }

    #[tokio::test]
    async fn affinity_bind_and_get() {
        let router = ProviderRouter::new();
        router.bind_affinity("sess-1", "main").await;
        assert_eq!(router.get_affinity("sess-1").await, Some("main".into()));
        router.clear_affinity("sess-1").await;
        assert_eq!(router.get_affinity("sess-1").await, None);
    }

    // === FailoverPattern.matches 单测 ===

    #[test]
    fn pattern_matches_http_status_exact() {
        let p = FailoverPattern::HttpStatus { code: 401 };
        let err = FailoverError {
            status: Some(401),
            first_token_timeout: false,
            connection_refused: false,
            message: "".into(),
        };
        assert!(p.matches(&err));
    }

    #[test]
    fn pattern_matches_5xx_segment() {
        // code=500 代表 5xx 全段
        let p = FailoverPattern::HttpStatus { code: 500 };
        for code in [500u16, 502, 503, 599] {
            let err = FailoverError {
                status: Some(code),
                first_token_timeout: false,
                connection_refused: false,
                message: "".into(),
            };
            assert!(p.matches(&err), "5xx code {} 应命中", code);
        }
        // 4xx 不命中
        let err_4xx = FailoverError {
            status: Some(429),
            first_token_timeout: false,
            connection_refused: false,
            message: "".into(),
        };
        assert!(!p.matches(&err_4xx));
    }

    #[test]
    fn pattern_matches_first_token_timeout() {
        let p = FailoverPattern::FirstTokenTimeout;
        let err = FailoverError {
            status: None,
            first_token_timeout: true,
            connection_refused: false,
            message: "".into(),
        };
        assert!(p.matches(&err));
    }

    #[test]
    fn pattern_matches_connection_refused() {
        let p = FailoverPattern::ConnectionRefused;
        let err = FailoverError::from_spawn_err("CLI 路径不存在");
        assert!(p.matches(&err));
    }

    #[test]
    fn pattern_matches_stderr_contains_case_insensitive() {
        let p = FailoverPattern::StderrContains {
            pattern: "api key invalid".into(),
        };
        let err = FailoverError {
            status: None,
            first_token_timeout: false,
            connection_refused: false,
            message: "Error: API KEY INVALID".into(),
        };
        assert!(p.matches(&err));
    }

    #[test]
    fn pattern_matches_any_aggregates() {
        let patterns = FailoverPattern::defaults();
        // 401 命中
        let err_401 = FailoverError {
            status: Some(401),
            first_token_timeout: false,
            connection_refused: false,
            message: "".into(),
        };
        assert!(FailoverPattern::matches_any(&err_401, &patterns));
        // 首字超时命中
        let err_timeout = FailoverError {
            status: None,
            first_token_timeout: true,
            connection_refused: false,
            message: "".into(),
        };
        assert!(FailoverPattern::matches_any(&err_timeout, &patterns));
        // 200 不命中
        let err_ok = FailoverError {
            status: Some(200),
            first_token_timeout: false,
            connection_refused: false,
            message: "".into(),
        };
        assert!(!FailoverPattern::matches_any(&err_ok, &patterns));
    }

    #[test]
    fn effective_patterns_defaults_when_empty() {
        let g = ProviderGroup {
            id: "g".into(),
            name: "g".into(),
            strategy: RouteStrategy::Failover,
            members: vec![],
            failover_on: vec![],
            first_token_timeout_secs: None,
            max_failover_attempts: 3,
            active: true,
        };
        assert_eq!(g.effective_patterns().len(), FailoverPattern::defaults().len());
    }
}
