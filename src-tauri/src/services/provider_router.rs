/*! 供应商分组路由决策层（P1 + Key 级路由扩展）

在新会话首请求时按分组策略选 Profile + Key；请求失败时按策略选下一个 Profile/Key。

设计要点：
- **纯决策逻辑**：本模块不触碰 `AppState` / `EngineRegistry` / `ProxyManager`，
  只做"给定 group + profiles + 已尝试集合 → 下一个 (Profile, Key)"的纯计算，
  便于单测（参考 `simple_ai/retry.rs` 的纯函数设计）。
- **两层路由**：先选成员（Profile），再选 Key（成员内多 Key 轮转）。
  Key 级失败优先于成员级 failover：先用完一个成员的所有 Key，再切到下一个成员。
- **会话亲和**：`select_initial` 选出的 (Profile, Key) 会绑定到 session_id，
  续聊时优先复用（避免同一会话在不同端点间跳）。
- **健康缓存**：可选注入外部健康状态；未注入时视为全部健康（P1 不做后台探活）。
- **轮询游标**：成员级和 Key 级各用原子计数器，持久化在内存（P1），
  进程重启归零可接受（轮询偏差自愈）。
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
    OfficialFallback,
}

/// 路由决策日志条目
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteLogEntry {
    pub seq: u64,
    pub kind: RouteLogKind,
    pub group_id: String,
    pub group_name: String,
    pub strategy: RouteStrategy,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub session_id: Option<String>,
    pub engine: Option<String>,
    pub attempt: usize,
    pub error: Option<String>,
    pub tried: Vec<String>,
    /// 本次选中的 Key 索引（None = 使用 Profile 的 apiKey）
    pub key_idx: Option<usize>,
    /// 该成员总 Key 数（前端展示用）
    pub key_count: Option<usize>,
    pub ts_ms: u64,
}

/// 路由选择结果：Profile ID + 可选的 Key 索引
#[derive(Debug, Clone, PartialEq)]
pub struct RouteSelection {
    pub profile_id: String,
    /// Key 索引（None = 使用 Profile 的 apiKey，单 Key 向后兼容）
    pub key_idx: Option<usize>,
}

/// 已尝试过的组合（用于 failover 跳过）
#[derive(Debug, Clone, PartialEq)]
pub struct TriedPair {
    pub profile_id: String,
    pub key_idx: Option<usize>,
}

impl TriedPair {
    pub fn new(profile_id: &str, key_idx: Option<usize>) -> Self {
        Self {
            profile_id: profile_id.to_string(),
            key_idx,
        }
    }
}

/// 亲和表条目
#[derive(Debug, Clone)]
struct AffinityEntry {
    profile_id: String,
    key_idx: Option<usize>,
}

/// failover 决策所需的上游错误摘要（从 spawn 失败或 async error 提取）
#[derive(Debug, Clone)]
pub struct FailoverError {
    pub status: Option<u16>,
    pub first_token_timeout: bool,
    pub connection_refused: bool,
    pub message: String,
}

impl FailoverError {
    pub fn from_spawn_err(msg: &str) -> Self {
        Self {
            status: None,
            first_token_timeout: false,
            connection_refused: true,
            message: msg.to_string(),
        }
    }
}

impl FailoverPattern {
    pub fn matches(&self, err: &FailoverError) -> bool {
        match self {
            Self::HttpStatus { code } => {
                err.status
                    .map(|s| s == *code || (*code >= 500 && s >= 500 && s < 600))
                    .unwrap_or(false)
            }
            Self::FirstTokenTimeout => err.first_token_timeout,
            Self::ConnectionRefused => err.connection_refused,
            Self::StderrContains { pattern } => err.message.to_lowercase().contains(&pattern.to_lowercase()),
        }
    }

    pub fn matches_any(err: &FailoverError, patterns: &[Self]) -> bool {
        patterns.iter().any(|p| p.matches(err))
    }
}

/// 供应商路由器
pub struct ProviderRouter {
    /// 成员级轮询游标：group_id → 原子计数器
    cursors: AsyncMutex<HashMap<String, Arc<AtomicU64>>>,
    /// Key 级轮询游标：profile_id → 原子计数器
    key_cursors: AsyncMutex<HashMap<String, Arc<AtomicU64>>>,
    /// 会话亲和：session_id → (profile_id, Option<key_idx>)
    affinity: AsyncMutex<HashMap<String, AffinityEntry>>,
    /// 路由日志环形缓冲
    logs: AsyncMutex<VecDeque<RouteLogEntry>>,
    /// 日志序号
    log_seq: AtomicU64,
}

impl ProviderRouter {
    pub fn new() -> Self {
        Self {
            cursors: AsyncMutex::new(HashMap::new()),
            key_cursors: AsyncMutex::new(HashMap::new()),
            affinity: AsyncMutex::new(HashMap::new()),
            logs: AsyncMutex::new(VecDeque::with_capacity(ROUTE_LOG_CAPACITY)),
            log_seq: AtomicU64::new(0),
        }
    }

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

    pub async fn all_logs(&self) -> Vec<RouteLogEntry> {
        let logs = self.logs.lock().await;
        logs.iter().cloned().collect()
    }

    pub async fn logs_since(&self, since: u64) -> Vec<RouteLogEntry> {
        let logs = self.logs.lock().await;
        logs.iter()
            .filter(|e| e.seq > since)
            .cloned()
            .collect()
    }

    pub async fn clear_logs(&self) {
        let mut logs = self.logs.lock().await;
        logs.clear();
    }

    /// 为新会话选择首个 Profile + Key（按 strategy）
    ///
    /// 返回 `RouteSelection`，包含选中的 Profile ID 和 Key 索引。
    /// Key 索引为 None 表示使用 Profile 的 apiKey（单 Key 兼容）。
    pub async fn select_initial(
        &self,
        group: &ProviderGroup,
        profiles: &[ModelProfile],
        healthy_profile_ids: &std::collections::HashSet<String>,
    ) -> Option<RouteSelection> {
        let ordered = group.ordered_members();
        let healthy_members: Vec<&GroupMember> = ordered
            .into_iter()
            .filter(|m| is_healthy(&m.profile_id, healthy_profile_ids))
            .collect();
        if healthy_members.is_empty() {
            return None;
        }

        let member = match group.strategy {
            RouteStrategy::Failover => {
                // priority 升序后取首个
                &healthy_members[0]
            }
            RouteStrategy::RoundRobin => {
                let idx = self.advance_cursor(&group.id, healthy_members.len()).await;
                &healthy_members[idx % healthy_members.len()]
            }
            RouteStrategy::Weighted => {
                return self.weighted_initial(&healthy_members, profiles);
            }
        };

        let key_idx = self.select_key(member).await;
        Some(RouteSelection {
            profile_id: member.profile_id.clone(),
            key_idx,
        })
    }

    /// failover 时选下一个 (Profile, Key)（跳过已尝试的）
    ///
    /// 策略：
    /// 1. 先尝试同一 Profile 的下一个 Key（如果有多 Key 且未全试完）
    /// 2. 同一 Profile 所有 Key 已尝试 → 尝试下一个 Profile 的首个 Key
    /// 3. 单 Key Profile 直接跳过（已尝试）
    pub async fn select_next(
        &self,
        group: &ProviderGroup,
        tried: &[TriedPair],
        profiles: &[ModelProfile],
        healthy_profile_ids: &std::collections::HashSet<String>,
    ) -> Option<RouteSelection> {
        let ordered = group.ordered_members();
        for member in ordered.iter() {
            if !is_healthy(&member.profile_id, healthy_profile_ids) {
                continue;
            }
            let keys = member_keys(member);
            for (key_idx, _) in keys.iter().enumerate() {
                let key_idx = if keys.len() == 1 && member.keys.is_none() {
                    // 单 Key Profile：key_idx = None
                    None
                } else {
                    Some(key_idx)
                };
                if tried.iter().any(|t| t.profile_id == member.profile_id && t.key_idx == key_idx) {
                    continue;
                }
                return Some(RouteSelection {
                    profile_id: member.profile_id.clone(),
                    key_idx,
                });
            }
        }
        None
    }

    /// 选择 Key 索引（基于成员的 keyStrategy）
    async fn select_key(&self, member: &GroupMember) -> Option<usize> {
        let keys = member.keys.as_ref()?;
        if keys.is_empty() {
            return None;
        }
        match member.key_strategy {
            RouteStrategy::RoundRobin => {
                let idx = self.advance_key_cursor(&member.profile_id, keys.len()).await;
                Some(idx)
            }
            RouteStrategy::Failover => {
                // 始终返回第一个 Key，failover 由 select_next 处理
                Some(0)
            }
            RouteStrategy::Weighted => {
                // Key 级等权随机
                let seed = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos() as u64)
                    .unwrap_or(0);
                Some((seed % keys.len() as u64) as usize)
            }
        }
    }

    /// 加权策略下选择成员并返回 RouteSelection
    fn weighted_initial(
        &self,
        members: &[&GroupMember],
        profiles: &[ModelProfile],
    ) -> Option<RouteSelection> {
        let total: u32 = members.iter().map(|m| m.weight.max(1)).sum();
        if total == 0 {
            return None;
        }
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let r = (seed % total as u64) as u32;
        let mut acc = 0u32;
        for m in members {
            acc += m.weight.max(1);
            if r < acc {
                // 异步 self.select_key 在此处无法使用（同步函数）
                // 加权选择不做 Key 级轮转，fallback 到 failover 策略
                let key_idx = m.keys.as_ref()
                    .filter(|k| !k.is_empty())
                    .map(|_| 0);
                return Some(RouteSelection {
                    profile_id: m.profile_id.clone(),
                    key_idx,
                });
            }
        }
        let last = members.last()?;
        let key_idx = last.keys.as_ref()
            .filter(|k| !k.is_empty())
            .map(|_| 0);
        Some(RouteSelection {
            profile_id: last.profile_id.clone(),
            key_idx,
        })
    }

    /// 绑定会话亲和（含 Key 索引）
    pub async fn bind_affinity(&self, session_id: &str, profile_id: &str, key_idx: Option<usize>) {
        let mut aff = self.affinity.lock().await;
        aff.insert(session_id.to_string(), AffinityEntry {
            profile_id: profile_id.to_string(),
            key_idx,
        });
    }

    /// 查询会话亲和的 Profile + Key 索引（续聊时优先复用）
    pub async fn get_affinity(&self, session_id: &str) -> Option<(String, Option<usize>)> {
        let aff = self.affinity.lock().await;
        aff.get(session_id).map(|e| (e.profile_id.clone(), e.key_idx))
    }

    /// 清除会话亲和
    pub async fn clear_affinity(&self, session_id: &str) {
        let mut aff = self.affinity.lock().await;
        aff.remove(session_id);
    }

    /// 推进成员级轮询游标并返回当前索引
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

    /// 推进 Key 级轮询游标
    async fn advance_key_cursor(&self, profile_id: &str, len: usize) -> usize {
        if len == 0 {
            return 0;
        }
        let mut cursors = self.key_cursors.lock().await;
        let counter = cursors
            .entry(profile_id.to_string())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)));
        let prev = counter.fetch_add(1, Ordering::Relaxed);
        (prev as usize) % len
    }

    /// 获取成员的 Key 总数（用于日志记录）
    pub fn member_key_count(member: &GroupMember) -> usize {
        member.keys.as_ref()
            .map(|k| k.len())
            .unwrap_or(0)
    }
}

impl Default for ProviderRouter {
    fn default() -> Self {
        Self::new()
    }
}

/// 判定 Profile 是否健康
fn is_healthy(profile_id: &str, healthy: &std::collections::HashSet<String>) -> bool {
    healthy.is_empty() || healthy.contains(profile_id)
}

/// 获取成员实际的 Key 列表（供模块内使用）
fn member_keys(member: &GroupMember) -> Vec<String> {
    member.keys.as_ref()
        .filter(|k| !k.is_empty())
        .cloned()
        .unwrap_or_else(|| vec![String::new()])
}

/// 当前 UNIX 毫秒时间戳
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
            keys: None,
            key_strategy: RouteStrategy::RoundRobin,
        }
    }

    /// 多 Key 成员
    fn multi_key_member(id: &str, priority: u32, weight: u32, keys: Vec<&str>) -> GroupMember {
        GroupMember {
            profile_id: id.to_string(),
            priority,
            weight,
            keys: Some(keys.into_iter().map(|k| k.to_string()).collect()),
            key_strategy: RouteStrategy::RoundRobin,
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
            default_model: None,
            target_engines: vec![],
            description: None,
            category: None,
        }
    }

    fn empty_health() -> std::collections::HashSet<String> {
        std::collections::HashSet::new()
    }

    // === 现有单 Key 测试保持兼容 ===

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
        assert_eq!(pick.profile_id, "main");
        assert_eq!(pick.key_idx, None); // 单 Key → None
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
            .select_next(&g, &[TriedPair::new("main", None)], &profiles, &empty_health())
            .await
            .unwrap();
        assert_eq!(next.profile_id, "backup");
        assert_eq!(next.key_idx, None);
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
                &[TriedPair::new("main", None), TriedPair::new("backup", None)],
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
        assert_eq!(first.profile_id, "a");
        assert_eq!(second.profile_id, "b");
        assert_eq!(third.profile_id, "c");
        assert_eq!(fourth.profile_id, "a");
    }

    // === 多 Key 路由测试 ===

    #[tokio::test]
    async fn multi_key_select_initial_uses_key_idx() {
        let g = group(
            RouteStrategy::Failover,
            vec![multi_key_member("main", 0, 1, vec!["key-a", "key-b", "key-c"])],
        );
        let profiles = vec![profile("main")];
        let router = ProviderRouter::new();
        let pick = router
            .select_initial(&g, &profiles, &empty_health())
            .await
            .unwrap();
        assert_eq!(pick.profile_id, "main");
        assert!(pick.key_idx.is_some(), "多 Key 应有 key_idx");
        // RoundRobin 从 0 开始
        assert_eq!(pick.key_idx, Some(0));
    }

    #[tokio::test]
    async fn multi_key_round_robin_rotates_keys() {
        let g = group(
            RouteStrategy::Failover,
            vec![multi_key_member("main", 0, 1, vec!["key-a", "key-b", "key-c"])],
        );
        let profiles = vec![profile("main")];
        let router = ProviderRouter::new();
        let first = router.select_initial(&g, &profiles, &empty_health()).await.unwrap();
        assert_eq!(first.key_idx, Some(0));
        // 同一成员，Key 级游标推进
        // 注：select_initial 每次会推进 key_cursor，按 RoundRobin 策略轮转
        // 但我们无法在同一成员上调用多次 select_initial 来验证轮转，因为
        // select_initial 每次都会推进成员级游标（当前 Failover 不推进）。
        // 验证边界：轮转后索引应有变化
        let second = router.select_initial(&g, &profiles, &empty_health()).await.unwrap();
        // Failover 策略下 select_initial 永远返回 priority 最低的成员（main），
        // 但 key_cursor 会推进，所以第二次 key_idx 应是 1
        assert_eq!(second.key_idx, Some(1));
    }

    #[tokio::test]
    async fn multi_key_select_next_skips_tried_key() {
        let g = group(
            RouteStrategy::Failover,
            vec![multi_key_member("main", 0, 1, vec!["key-a", "key-b"])],
        );
        let profiles = vec![profile("main")];
        let router = ProviderRouter::new();
        // 尝试 key-a (idx=0) 失败，应切到 key-b (idx=1)
        let next = router
            .select_next(&g, &[TriedPair::new("main", Some(0))], &profiles, &empty_health())
            .await
            .unwrap();
        assert_eq!(next.profile_id, "main");
        assert_eq!(next.key_idx, Some(1));
    }

    #[tokio::test]
    async fn multi_key_select_next_exhausts_keys_then_next_member() {
        let g = group(
            RouteStrategy::Failover,
            vec![
                multi_key_member("main", 0, 1, vec!["key-a", "key-b"]),
                member("backup", 1, 1),
            ],
        );
        let profiles = vec![profile("main"), profile("backup")];
        let router = ProviderRouter::new();
        // main 的两个 Key 都试过了
        let next = router
            .select_next(
                &g,
                &[TriedPair::new("main", Some(0)), TriedPair::new("main", Some(1))],
                &profiles,
                &empty_health(),
            )
            .await
            .unwrap();
        // 应切到 backup（单 Key，key_idx=None）
        assert_eq!(next.profile_id, "backup");
        assert_eq!(next.key_idx, None);
    }

    #[tokio::test]
    async fn multi_key_select_next_returns_none_when_all_tried() {
        let g = group(
            RouteStrategy::Failover,
            vec![multi_key_member("main", 0, 1, vec!["key-a"])],
        );
        let profiles = vec![profile("main")];
        let router = ProviderRouter::new();
        let next = router
            .select_next(
                &g,
                &[TriedPair::new("main", Some(0))],
                &profiles,
                &empty_health(),
            )
            .await;
        assert!(next.is_none());
    }

    #[tokio::test]
    async fn mixed_multi_and_single_key_routing() {
        // 混合场景：main 有 2 个 Key，backup 单 Key
        let g = group(
            RouteStrategy::Failover,
            vec![
                multi_key_member("main", 0, 1, vec!["key-a", "key-b"]),
                member("backup", 1, 1),
            ],
        );
        let profiles = vec![profile("main"), profile("backup")];
        let router = ProviderRouter::new();
        // 初始选 main/key-a
        let initial = router.select_initial(&g, &profiles, &empty_health()).await.unwrap();
        assert_eq!(initial.profile_id, "main");
        assert_eq!(initial.key_idx, Some(0));

        // main/key-a 失败 → main/key-b
        let next1 = router
            .select_next(&g, &[TriedPair::new("main", Some(0))], &profiles, &empty_health())
            .await
            .unwrap();
        assert_eq!(next1.profile_id, "main");
        assert_eq!(next1.key_idx, Some(1));

        // main/key-b 失败 → backup（单 Key）
        let next2 = router
            .select_next(
                &g,
                &[TriedPair::new("main", Some(0)), TriedPair::new("main", Some(1))],
                &profiles,
                &empty_health(),
            )
            .await
            .unwrap();
        assert_eq!(next2.profile_id, "backup");
        assert_eq!(next2.key_idx, None);
    }

    #[tokio::test]
    async fn multi_key_failover_strategy() {
        // Failover 策略的 Key 选择：始终返回第一个 Key
        let mut m = multi_key_member("main", 0, 1, vec!["key-a", "key-b"]);
        m.key_strategy = RouteStrategy::Failover;
        let g = group(RouteStrategy::Failover, vec![m]);
        let profiles = vec![profile("main")];
        let router = ProviderRouter::new();
        let pick = router.select_initial(&g, &profiles, &empty_health()).await.unwrap();
        assert_eq!(pick.key_idx, Some(0)); // Failover 策略始终返回第一个 Key
    }

    // === 亲和测试 ===

    #[tokio::test]
    async fn affinity_bind_and_get_with_key() {
        let router = ProviderRouter::new();
        router.bind_affinity("sess-1", "main", Some(1)).await;
        let (pid, kidx) = router.get_affinity("sess-1").await.unwrap();
        assert_eq!(pid, "main");
        assert_eq!(kidx, Some(1));
        router.clear_affinity("sess-1").await;
        assert!(router.get_affinity("sess-1").await.is_none());
    }

    #[tokio::test]
    async fn affinity_bind_without_key() {
        let router = ProviderRouter::new();
        router.bind_affinity("sess-1", "main", None).await;
        let (pid, kidx) = router.get_affinity("sess-1").await.unwrap();
        assert_eq!(pid, "main");
        assert_eq!(kidx, None);
    }

    // === 健康过滤 ===

    #[tokio::test]
    async fn healthy_filter_skips_unhealthy() {
        let g = group(
            RouteStrategy::Failover,
            vec![member("main", 0, 1), member("backup", 1, 1)],
        );
        let profiles = vec![profile("main"), profile("backup")];
        let mut healthy = std::collections::HashSet::new();
        healthy.insert("backup".into());
        let router = ProviderRouter::new();
        let pick = router.select_initial(&g, &profiles, &healthy).await.unwrap();
        assert_eq!(pick.profile_id, "backup");
    }

    #[tokio::test]
    async fn select_initial_returns_none_when_all_unhealthy() {
        let g = group(RouteStrategy::Failover, vec![member("main", 0, 1)]);
        let profiles = vec![profile("main")];
        let mut healthy = std::collections::HashSet::new();
        healthy.insert("other".into());
        let router = ProviderRouter::new();
        let pick = router.select_initial(&g, &profiles, &healthy).await;
        assert!(pick.is_none());
    }
}