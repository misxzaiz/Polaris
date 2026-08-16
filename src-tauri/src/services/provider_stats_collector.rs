/*! 供应商调用统计收集器

持久化累加计数器，与 `RouteLogEntry` 事件流并行，每次 `record_log` 处同步累加。
数据写入 `<DataRoot>/provider-stats.json`，启动时加载，运行时内存累加。

设计要点：
- 纯累加器：不依赖 `AppState` / `ConfigStore`，只从 `RouteLogEntry` 提取字段。
- 每次 `record_log` 时同步写盘（写入频率低，计数器操作极轻）。
- 文件损坏时静默丢弃并重建，不阻塞应用启动。
- 与 `RouterLog` 环形缓冲（200 条）互补：计数器无上限，持久化。
*/

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::provider_router::RouteLogEntry;

// ============================================================================
// 数据模型
// ============================================================================

/// 单 Key 统计
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyStats {
    /// 被选为 initial 或 failover 目标的次数
    pub selected: u64,
    /// 失败次数（SpawnFailed / ApplyFailed）
    pub failed: u64,
    /// 最后活跃时间（UNIX 毫秒）
    pub last_active_ms: u64,
}

/// 单 Profile 统计
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStats {
    pub profile_id: String,
    pub profile_name: String,
    pub group_id: String,
    pub group_name: String,
    /// 被选为 initial 次数
    pub selected: u64,
    /// failover 切换到该 Profile 次数
    pub failover_in: u64,
    /// 从该 Profile failover 出去次数
    pub failover_out: u64,
    /// spawn 失败次数
    pub spawn_failed: u64,
    /// apply 失败次数
    pub apply_failed: u64,
    /// 绑定成功次数（引擎正常启动）
    pub bound: u64,
    /// 按 Key 的细分
    pub key_breakdown: HashMap<Option<usize>, KeyStats>,
    /// 最后活跃时间（UNIX 毫秒）
    pub last_active_ms: u64,
}

/// 单分组统计
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroupStats {
    pub group_id: String,
    pub group_name: String,
    pub strategy: String,
    /// 总路由次数
    pub total_routes: u64,
    /// failover 切换次数
    pub failover_count: u64,
    /// 全部不可用次数
    pub all_unavailable: u64,
    /// 官方回退次数
    pub official_fallback: u64,
}

/// 失败调用日志条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedCallLog {
    pub seq: u64,
    pub ts_ms: u64,
    pub group_id: String,
    pub group_name: String,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub key_idx: Option<usize>,
    pub session_id: Option<String>,
    pub engine: Option<String>,
    /// 失败类型
    pub error_kind: FailedCallKind,
    /// 错误详情
    pub error_message: String,
    /// 该轮尝试中已尝试的 Profile 列表
    pub tried: Vec<String>,
    /// failover 去的下一个 Profile（None = 全部不可用/回退）
    pub failover_to: Option<String>,
    /// 该轮总计尝试次数
    pub attempt: usize,
}

/// 失败类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FailedCallKind {
    /// 引擎 spawn 失败
    SpawnFailed,
    /// Profile 应用失败
    ApplyFailed,
    /// 全部组内 Profile 不可用
    AllUnavailable,
    /// 官方回退
    OfficialFallback,
}

/// 失败日志筛选参数
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FailedCallFilter {
    pub profile_id: Option<String>,
    pub error_kind: Option<FailedCallKind>,
    pub group_id: Option<String>,
    pub since_ms: Option<u64>,
    pub until_ms: Option<u64>,
    pub keyword: Option<String>,
    pub offset: u64,
    pub limit: u64,
}

/// 全量统计快照
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatsSnapshot {
    pub profiles: Vec<ProfileStats>,
    pub groups: Vec<GroupStats>,
    /// 时间戳
    pub updated_at: u64,
    /// 总路由请求数（含 fallback）
    pub total_routes: u64,
    /// 总失败次数
    pub total_failures: u64,
    /// 总 failover 切换次数
    pub total_failovers: u64,
}

// ============================================================================
// ProfileStatsCollector
// ============================================================================

/// 供应商调用统计收集器
///
/// 维护全量累加计数器，持久化到 `<DataRoot>/provider-stats.json`。
#[derive(Debug, Clone)]
pub struct ProfileStatsCollector {
    /// profile_id → ProfileStats
    profiles: HashMap<String, ProfileStats>,
    /// group_id → GroupStats
    groups: HashMap<String, GroupStats>,
    /// 总路由次数
    total_routes: u64,
    /// 总失败次数
    total_failures: u64,
    /// 总 failover 切换次数
    total_failovers: u64,
}

impl Default for ProfileStatsCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl ProfileStatsCollector {
    pub fn new() -> Self {
        Self {
            profiles: HashMap::new(),
            groups: HashMap::new(),
            total_routes: 0,
            total_failures: 0,
            total_failovers: 0,
        }
    }

    /// 记录一条路由日志到计数器
    pub fn record(&mut self, entry: &RouteLogEntry) {
        use super::provider_router::RouteLogKind;

        self.total_routes += 1;

        // 更新分组统计
        let gs = self.groups.entry(entry.group_id.clone()).or_insert_with(|| GroupStats {
            group_id: entry.group_id.clone(),
            group_name: entry.group_name.clone(),
            strategy: format!("{:?}", entry.strategy),
            ..Default::default()
        });
        gs.total_routes += 1;

        match entry.kind {
            RouteLogKind::InitialSelect => {
                if let Some(ref pid) = entry.profile_id {
                    let ps = self.profile_mut(pid, entry);
                    ps.selected += 1;
                    ps.last_active_ms = entry.ts_ms;
                    ps.key_breakdown.entry(entry.key_idx).or_default().selected += 1;
                }
            }
            RouteLogKind::FailoverSwitch => {
                self.total_failovers += 1;
                gs.failover_count += 1;
                // 被选中的 Profile 记 failover_in
                if let Some(ref pid) = entry.profile_id {
                    let ps = self.profile_mut(pid, entry);
                    ps.failover_in += 1;
                    ps.last_active_ms = entry.ts_ms;
                    ps.key_breakdown.entry(entry.key_idx).or_default().selected += 1;
                }
                // 上一个失败的 Profile 记 failover_out
                // tried 的最后一个元素是"上一个"（未包含当前选中的）
                if entry.tried.len() >= 2 {
                    if let Some(prev_pid) = entry.tried.iter().rev().nth(1) {
                        if let Some(prev_ps) = self.profiles.get_mut(prev_pid) {
                            prev_ps.failover_out += 1;
                        }
                    }
                }
            }
            RouteLogKind::ApplyFailed => {
                self.total_failures += 1;
                if let Some(ref pid) = entry.profile_id {
                    let ps = self.profile_mut(pid, entry);
                    ps.apply_failed += 1;
                    ps.last_active_ms = entry.ts_ms;
                    ps.key_breakdown.entry(entry.key_idx).or_default().failed += 1;
                }
            }
            RouteLogKind::SpawnFailed => {
                self.total_failures += 1;
                if let Some(ref pid) = entry.profile_id {
                    let ps = self.profile_mut(pid, entry);
                    ps.spawn_failed += 1;
                    ps.last_active_ms = entry.ts_ms;
                    ps.key_breakdown.entry(entry.key_idx).or_default().failed += 1;
                }
            }
            RouteLogKind::Bound => {
                if let Some(ref pid) = entry.profile_id {
                    let ps = self.profile_mut(pid, entry);
                    ps.bound += 1;
                    ps.last_active_ms = entry.ts_ms;
                }
            }
            RouteLogKind::AllUnavailable => {
                self.total_failures += 1;
                gs.all_unavailable += 1;
            }
            RouteLogKind::OfficialFallback => {
                gs.official_fallback += 1;
            }
        }
    }

    /// 获取快照
    pub fn snapshot(&self) -> ProviderStatsSnapshot {
        let mut profiles: Vec<ProfileStats> = self.profiles.values().cloned().collect();
        profiles.sort_by(|a, b| b.selected.cmp(&a.selected));

        let mut groups: Vec<GroupStats> = self.groups.values().cloned().collect();
        groups.sort_by(|a, b| b.total_routes.cmp(&a.total_routes));

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        ProviderStatsSnapshot {
            profiles,
            groups,
            updated_at: now_ms,
            total_routes: self.total_routes,
            total_failures: self.total_failures,
            total_failovers: self.total_failovers,
        }
    }

    /// 清空所有计数器
    pub fn clear(&mut self) {
        self.profiles.clear();
        self.groups.clear();
        self.total_routes = 0;
        self.total_failures = 0;
        self.total_failovers = 0;
    }

    /// 从磁盘加载
    pub fn load_from_disk(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(content) => {
                match serde_json::from_str::<ProviderStatsSnapshot>(&content) {
                    Ok(snapshot) => {
                        let mut collector = Self::new();
                        // 重建 profile 和 group 索引
                        for p in snapshot.profiles {
                            collector.profiles.insert(p.profile_id.clone(), p);
                        }
                        for g in snapshot.groups {
                            collector.groups.insert(g.group_id.clone(), g);
                        }
                        collector.total_routes = snapshot.total_routes;
                        collector.total_failures = snapshot.total_failures;
                        collector.total_failovers = snapshot.total_failovers;
                        collector
                    }
                    Err(e) => {
                        tracing::warn!("[ProfileStatsCollector] 解析失败，重建: {}", e);
                        Self::new()
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::new(),
            Err(e) => {
                tracing::warn!("[ProfileStatsCollector] 读取失败，重建: {}", e);
                Self::new()
            }
        }
    }

    /// 保存到磁盘
    pub fn save_to_disk(&self, path: &Path) {
        let snapshot = self.snapshot();
        match serde_json::to_string_pretty(&snapshot) {
            Ok(content) => {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::write(path, &content) {
                    tracing::warn!("[ProfileStatsCollector] 写盘失败: {}", e);
                }
            }
            Err(e) => {
                tracing::warn!("[ProfileStatsCollector] 序列化失败: {}", e);
            }
        }
    }

    // ========================================================================
    // 内部辅助
    // ========================================================================

    fn profile_mut(&mut self, profile_id: &str, entry: &RouteLogEntry) -> &mut ProfileStats {
        self.profiles.entry(profile_id.to_string()).or_insert_with(|| ProfileStats {
            profile_id: profile_id.to_string(),
            profile_name: entry.profile_name.clone().unwrap_or_else(|| profile_id.to_string()),
            group_id: entry.group_id.clone(),
            group_name: entry.group_name.clone(),
            ..Default::default()
        })
    }
}

// ============================================================================
// FailedCallCollector
// ============================================================================

const FAILED_CALL_CAPACITY: usize = 1000;

/// 失败调用日志收集器
///
/// 维护失败调用记录的持久化缓冲，JSONL 格式追加写。
/// 上限 1000 条，超出后截断前 500 条。
pub struct FailedCallCollector {
    /// 所有失败日志（按 seq 升序）
    logs: Vec<FailedCallLog>,
    /// 序列号计数器
    seq: u64,
}

impl Default for FailedCallCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl FailedCallCollector {
    pub fn new() -> Self {
        Self {
            logs: Vec::with_capacity(FAILED_CALL_CAPACITY),
            seq: 0,
        }
    }

    /// 从路由日志条目创建失败日志（如果该条目属于失败事件）
    pub fn record(&mut self, entry: &RouteLogEntry) -> Option<&FailedCallLog> {
        use super::provider_router::RouteLogKind;

        let kind = match entry.kind {
            RouteLogKind::SpawnFailed => FailedCallKind::SpawnFailed,
            RouteLogKind::ApplyFailed => FailedCallKind::ApplyFailed,
            RouteLogKind::AllUnavailable => FailedCallKind::AllUnavailable,
            RouteLogKind::OfficialFallback => FailedCallKind::OfficialFallback,
            // FailoverSwitch 不单独记录为失败日志（由触发它的 SpawnFailed/ApplyFailed 承载）
            // InitialSelect / Bound 不记录
            _ => return None,
        };

        // failover_to 在记录失败时无法确定（后续 select_next 才决定），
        // 设为 None，前端可通过 tried 列表推断链路
        let failover_to: Option<String> = None;

        let log = FailedCallLog {
            seq: self.seq,
            ts_ms: entry.ts_ms,
            group_id: entry.group_id.clone(),
            group_name: entry.group_name.clone(),
            profile_id: entry.profile_id.clone(),
            profile_name: entry.profile_name.clone(),
            key_idx: entry.key_idx,
            session_id: entry.session_id.clone(),
            engine: entry.engine.clone(),
            error_kind: kind,
            error_message: entry.error.clone().unwrap_or_else(|| String::new()),
            tried: entry.tried.clone(),
            failover_to,
            attempt: entry.attempt,
        };

        self.seq += 1;
        self.logs.push(log);

        // 上限控制：超出后截断前半
        if self.logs.len() > FAILED_CALL_CAPACITY {
            self.logs.drain(0..500);
        }

        self.logs.last()
    }

    /// 列出失败日志（带筛选 + 分页）
    pub fn list(&self, filter: &FailedCallFilter) -> Vec<FailedCallLog> {
        let mut filtered: Vec<&FailedCallLog> = self.logs.iter().filter(|log| {
            if let Some(ref pid) = filter.profile_id {
                if log.profile_id.as_deref() != Some(pid) {
                    return false;
                }
            }
            if let Some(ref kind) = filter.error_kind {
                if &log.error_kind != kind {
                    return false;
                }
            }
            if let Some(ref gid) = filter.group_id {
                if log.group_id != *gid {
                    return false;
                }
            }
            if let Some(since) = filter.since_ms {
                if log.ts_ms < since {
                    return false;
                }
            }
            if let Some(until) = filter.until_ms {
                if log.ts_ms > until {
                    return false;
                }
            }
            if let Some(ref kw) = filter.keyword {
                if !kw.is_empty() && !log.error_message.to_lowercase().contains(&kw.to_lowercase()) {
                    return false;
                }
            }
            true
        }).collect();

        // 按时间倒序（最新在上）
        filtered.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms));

        let offset = filter.offset as usize;
        let limit = filter.limit as usize;
        let limit = if limit == 0 { 20 } else { limit };

        filtered
            .into_iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect()
    }

    /// 总数（用于分页）
    pub fn total_count(&self, filter: &FailedCallFilter) -> u64 {
        let mut filter = filter.clone();
        filter.offset = 0;
        filter.limit = u64::MAX;
        self.list(&filter).len() as u64
    }

    /// 清空所有失败日志
    pub fn clear(&mut self) {
        self.logs.clear();
        self.seq = 0;
    }

    /// 从磁盘加载（JSONL 格式）
    pub fn load_from_disk(path: &Path) -> Self {
        let mut collector = Self::new();
        match std::fs::read_to_string(path) {
            Ok(content) => {
                for line in content.lines() {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<FailedCallLog>(line) {
                        Ok(log) => {
                            collector.logs.push(log);
                        }
                        Err(e) => {
                            tracing::warn!("[FailedCallCollector] 解析行失败: {}", e);
                        }
                    }
                }
                // 按 seq 排序
                collector.logs.sort_by(|a, b| a.seq.cmp(&b.seq));
                collector.seq = collector.logs.last().map(|l| l.seq + 1).unwrap_or(0);
                collector
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::new(),
            Err(e) => {
                tracing::warn!("[FailedCallCollector] 读取失败，重建: {}", e);
                Self::new()
            }
        }
    }

    /// 保存到磁盘（JSONL 格式）
    pub fn save_to_disk(&self, path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut content = String::new();
        for log in &self.logs {
            if let Ok(line) = serde_json::to_string(log) {
                content.push_str(&line);
                content.push('\n');
            }
        }
        if let Err(e) = std::fs::write(path, &content) {
            tracing::warn!("[FailedCallCollector] 写盘失败: {}", e);
        }
    }
}