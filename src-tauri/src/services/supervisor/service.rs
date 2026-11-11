//! ServiceSupervisor：插件服务唯一管理者（重构 spec PR-2 核心）
//!
//! 架构不变式落地（spec §二）：
//! - **单写者**：全部进程动作只发生在 [`SupervisorInner::tick_once`] 内；
//!   start/stop/restart/卸载/退出钩子一律改写 specs（期望）+ 唤醒 + 等收敛。
//! - **真相三方制**：期望 = specs（可随时重算）；实际 = OS 进程表 + 健康探测；
//!   registry = 账本（epoch 归属 + 诊断，非权威）。
//! - **幂等可重入**：tick 任意时刻可被唤醒重跑；宿主重启后第一轮 tick
//!   孤儿清杀 + 期望重拉，自愈是自然行为而非独立机制。
//!
//! 进程句柄纪律：spawn 后 Child 所有权立即移交退出观察任务（谁持有谁观察）；
//! 停止走 OS 层 `proc_kill::kill_pid`，不依赖 Child 句柄——无交接、无悬空。

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{broadcast, Mutex, Notify};

use crate::error::{AppError, Result};
use crate::models::plugin::{DiscoveredPluginManifest, PluginServiceManifestContribution};

use super::proc_kill::ProcessSnapshot;
use super::reconciler::{
    reconcile, mark_spawn_failed, Action, Budget, EpochRecord, KillReason, Observed, ServiceKey,
};
use super::registry::{Registry, RegistryEntry};

/// tick 周期；事件（进程退出/期望变更/手动操作）额外唤醒。
const TICK_INTERVAL: Duration = Duration::from_secs(10);
/// 运行中服务集合快照（MCP 健康门控读；tick 更新，std 锁同步读无 runtime 依赖）。
static RUNNING_PLUGIN_IDS: std::sync::RwLock<Option<std::collections::HashSet<String>>> =
    std::sync::RwLock::new(None);
/// 停止收敛等待（外部 stop 调用的阻塞上限；超时由后续 tick 兜底收敛）。
const STOP_SETTLE_WAIT: Duration = Duration::from_secs(3);
/// 退出钩子的短暂等待（CloseRequested：给优雅停止一个机会，Job Object 兜底超时）。
const SHUTDOWN_WAIT: Duration = Duration::from_secs(1);
/// 状态轮询步长。
const SETTLE_POLL: Duration = Duration::from_millis(100);

// ── 对外协议（冻结：serde 字段与旧 PluginServiceManager 完全一致）──

/// 服务状态
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Error,
}

/// 服务状态信息（对外返回；既有字段与旧 PluginServiceManager 冻结一致，
/// 重构新增字段全部 Option + skip 序列化——向后兼容追加，spec §3.6）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub service_id: String,
    pub plugin_id: String,
    pub state: ServiceState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub restart_count: u32,
    /// 进程代际（重构新增）：跨重启区分同服务的不同进程实例
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<u64>,
    /// 终态原因（重构新增）：Error 时的预算/端口等判定依据
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// 启动选项（旧 StartContext 平移 + 协议 v2 注入所需 web 端点）。
#[derive(Debug, Clone, Default)]
pub struct StartContext {
    pub workspace_path: Option<String>,
    pub app_config_dir: Option<String>,
    /// 宿主 web 端口/令牌（协议 v2 env 注入；None = 降级走 kvclient 文件自发现）
    pub web_port: Option<u16>,
    pub web_token: Option<String>,
}

// ── 内部 ──

/// 服务完整规格（期望的载体：wanted + spawn 上下文）。
#[derive(Debug, Clone)]
struct ServiceSpec {
    contribution: PluginServiceManifestContribution,
    install_path: String,
    ctx: StartContext,
    /// enabled && (autoStart || 手动要求)
    wanted: bool,
}

#[derive(Default)]
struct SupState {
    specs: HashMap<ServiceKey, ServiceSpec>,
    epochs: HashMap<ServiceKey, EpochRecord>,
    budgets: HashMap<ServiceKey, Budget>,
    allocated_ports: Vec<u16>,
    port_counter: u16,
    reserved_host_ports: Vec<u16>,
    shutting_down: bool,
}

pub struct SupervisorInner {
    state: Mutex<SupState>,
    wake: Notify,
    status_tx: broadcast::Sender<ServiceStatus>,
    /// 数据根（装配时一次性写入；tick 读，无锁争用）
    data_root: std::sync::OnceLock<PathBuf>,
    /// 最近动作环形日志（短字符串、无 await——std 锁足够）
    recent_actions: std::sync::Mutex<VecDeque<String>>,
    /// 引擎注册表（孤儿清杀降级排除表数据源）。装配期一次写入，tick 读。
    engine_registry: std::sync::OnceLock<
        Arc<tokio::sync::Mutex<crate::ai::registry::EngineRegistry>>,
    >,
}

#[derive(Clone)]
pub struct ServiceSupervisor {
    inner: Arc<SupervisorInner>,
}

impl ServiceSupervisor {
    pub fn new(reserved_host_ports: Vec<u16>) -> Self {
        let (status_tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(SupervisorInner {
                state: Mutex::new(SupState {
                    port_counter: 10000,
                    reserved_host_ports,
                    ..Default::default()
                }),
                wake: Notify::new(),
                status_tx,
                data_root: std::sync::OnceLock::new(),
                recent_actions: std::sync::Mutex::new(VecDeque::new()),
                engine_registry: std::sync::OnceLock::new(),
            }),
        }
    }

    /// 注入数据根（registry 落盘位置 + 孤儿扫描特征）。装配时调用一次（幂等，首次生效）。
    pub fn set_data_root(&self, data_root: PathBuf) {
        let _ = self.inner.data_root.set(data_root);
    }

    /// 注入引擎注册表（孤儿清杀降级排除表数据源）。装配时调用一次
    /// （幂等，首次生效）；须在 run_loop spawn 之前完成。
    pub fn set_engine_registry(
        &self,
        registry: Arc<tokio::sync::Mutex<crate::ai::registry::EngineRegistry>>,
    ) {
        let _ = self.inner.engine_registry.set(registry);
    }

    pub fn subscribe_status(&self) -> broadcast::Receiver<ServiceStatus> {
        self.inner.status_tx.subscribe()
    }

    /// 最近动作环形日志（cap 快照/诊断用）。
    pub async fn recent_actions(&self) -> Vec<String> {
        self.inner
            .recent_actions
            .lock()
            .map(|q| q.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 全量同步规格（应用启动 / 插件启停 / 安装卸载后调用）。
    /// 期望完全由 manifests + enabled map 派生（纯派生不变式）；
    /// 未在 map 中的插件回落 enabledByDefault。
    pub async fn sync_from_manifests(
        &self,
        plugins: &[DiscoveredPluginManifest],
        enabled_map: &HashMap<String, bool>,
        ctx: StartContext,
    ) {
        let mut new_specs: HashMap<ServiceKey, ServiceSpec> = HashMap::new();
        for plugin in plugins {
            let enabled = enabled_map
                .get(&plugin.id)
                .copied()
                .unwrap_or(plugin.enabled_by_default);
            for service in &plugin.contributes.services {
                let key = (plugin.id.clone(), service.id.clone());
                new_specs.insert(
                    key,
                    ServiceSpec {
                        contribution: service.clone(),
                        install_path: plugin.install_path.clone(),
                        ctx: ctx.clone(),
                        wanted: enabled && service.auto_start,
                    },
                );
            }
        }
        {
            let mut st = self.inner.state.lock().await;
            st.specs = new_specs;
        }
        self.wake();
    }

    /// 手动启动（cap/命令入口）：置 wanted + 唤醒 + 等首轮收敛。
    pub async fn start_service(
        &self,
        plugin_id: &str,
        service_id: &str,
        contribution: PluginServiceManifestContribution,
        install_path: String,
        ctx: StartContext,
    ) -> Result<ServiceStatus> {
        let key = (plugin_id.to_string(), service_id.to_string());
        {
            let mut st = self.inner.state.lock().await;
            match st.specs.get_mut(&key) {
                Some(existing) => {
                    existing.contribution = contribution;
                    existing.install_path = install_path;
                    existing.ctx = ctx;
                    existing.wanted = true;
                }
                None => {
                    st.specs.insert(
                        key.clone(),
                        ServiceSpec {
                            contribution,
                            install_path,
                            ctx,
                            wanted: true,
                        },
                    );
                }
            }
            // 手动 start 清终态与退避（用户意志优先，spec §3.3）
            let budget = st.budgets.entry(key.clone()).or_default();
            budget.error_terminal = None;
            budget.next_retry_at_ms = 0;
        }
        self.wake();
        self.wait_settled_started(&key, STOP_SETTLE_WAIT).await;
        self.get_status(plugin_id, service_id).await.ok_or_else(|| {
            AppError::ProcessError(format!("服务 {}/{} 未注册", plugin_id, service_id))
        })
    }

    /// 停止（期望置 false + 唤醒 + 等收敛）。返回收敛后的真实状态。
    pub async fn stop_service(&self, plugin_id: &str, service_id: &str) -> Result<ServiceStatus> {
        let key = (plugin_id.to_string(), service_id.to_string());
        {
            let mut st = self.inner.state.lock().await;
            if let Some(spec) = st.specs.get_mut(&key) {
                spec.wanted = false;
            }
            st.budgets.remove(&key); // 手动 stop 重置重启预算
        }
        self.wake();
        self.wait_settled_stopped(&key, STOP_SETTLE_WAIT).await;
        self.get_status(plugin_id, service_id)
            .await
            .ok_or_else(|| {
                AppError::ProcessError(format!("服务 {}/{} 未注册", plugin_id, service_id))
            })
    }

    pub async fn stop_services_for_plugin(&self, plugin_id: &str) -> Result<Vec<ServiceStatus>> {
        let keys: Vec<ServiceKey> = {
            let st = self.inner.state.lock().await;
            st.specs
                .keys()
                .filter(|(p, _)| p == plugin_id)
                .cloned()
                .collect()
        };
        let mut out = Vec::new();
        for (p, s) in &keys {
            out.push(self.stop_service(p, s).await?);
        }
        Ok(out)
    }

    pub async fn restart_service(
        &self,
        plugin_id: &str,
        service_id: &str,
    ) -> Result<ServiceStatus> {
        let key = (plugin_id.to_string(), service_id.to_string());
        let spec = {
            let st = self.inner.state.lock().await;
            st.specs.get(&key).cloned()
        };
        let Some(spec) = spec else {
            return Err(AppError::ProcessError(format!(
                "Service {}/{} not registered",
                plugin_id, service_id
            )));
        };
        let was_wanted = spec.wanted;
        self.stop_service(plugin_id, service_id).await?;
        if was_wanted {
            return self
                .start_service(
                    plugin_id,
                    service_id,
                    spec.contribution,
                    spec.install_path,
                    spec.ctx,
                )
                .await;
        }
        self.get_status(plugin_id, service_id)
            .await
            .ok_or_else(|| AppError::ProcessError("service missing after restart".into()))
    }

    /// 退出钩子（CloseRequested）：全量停 + 短等优雅退出；超时由
    /// Job Object 兜底（宿主进程退出 → OS 终止全部收容子进程）。
    /// **不 block_on 3s**（旧 exit(0) 与 kill_on_drop 注释矛盾的根因）。
    pub async fn shutdown(&self) {
        {
            let mut st = self.inner.state.lock().await;
            st.shutting_down = true;
            for spec in st.specs.values_mut() {
                spec.wanted = false;
            }
        }
        self.wake();
        let deadline = tokio::time::Instant::now() + SHUTDOWN_WAIT;
        while tokio::time::Instant::now() < deadline {
            let alive = self.inner.state.lock().await.epochs.len();
            if alive == 0 {
                break;
            }
            tokio::time::sleep(SETTLE_POLL).await;
        }
        // 无论是否停净：返回后宿主退出，Job Object 兜底。
    }

    pub async fn list_status(&self) -> Vec<ServiceStatus> {
        let st = self.inner.state.lock().await;
        st.specs
            .keys()
            .map(|k| status_from(&st.epochs, &st.budgets, k))
            .collect()
    }

    pub async fn get_status(&self, plugin_id: &str, service_id: &str) -> Option<ServiceStatus> {
        let st = self.inner.state.lock().await;
        let key = (plugin_id.to_string(), service_id.to_string());
        st.specs
            .contains_key(&key)
            .then(|| status_from(&st.epochs, &st.budgets, &key))
    }

    /// MCP 健康门控快照（PR-3 消费）：服务 Running 才允许注册 AI 工具。
    pub async fn running_keys(&self) -> Vec<ServiceKey> {
        self.inner.state.lock().await.epochs.keys().cloned().collect()
    }

    fn wake(&self) {
        self.inner.wake.notify_one();
    }

    /// 对账循环本体（定时 + 事件双触发）。由调用方在 tokio runtime 内 spawn：
    /// 桌面 = `tauri::async_runtime::spawn(sup.run_loop())`；web bin = `tokio::spawn`。
    pub async fn run_loop(self) {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(TICK_INTERVAL) => {}
                _ = self.inner.wake.notified() => {}
            }
            if let Err(e) = self.tick_once().await {
                tracing::warn!("supervisor tick 失败（下轮重试）: {}", e);
            }
        }
    }

    async fn wait_settled_started(&self, key: &ServiceKey, wait: Duration) {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            {
                let st = self.inner.state.lock().await;
                let settled = st.epochs.contains_key(key)
                    || st
                        .budgets
                        .get(key)
                        .map(|b| b.error_terminal.is_some() || b.next_retry_at_ms > 0)
                        .unwrap_or(false);
                if settled || st.shutting_down {
                    return;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return; // 超时不阻塞调用方；tick 后续收敛
            }
            tokio::time::sleep(SETTLE_POLL).await;
        }
    }

    async fn wait_settled_stopped(&self, key: &ServiceKey, wait: Duration) {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let alive = {
                let st = self.inner.state.lock().await;
                st.epochs.contains_key(key)
            };
            if !alive {
                return;
            }
            if tokio::time::Instant::now() >= deadline {
                return; // 超时不阻塞调用方；tick 后续收敛（Job Object 兜底退出）
            }
            tokio::time::sleep(SETTLE_POLL).await;
        }
    }

    /// 单轮对账（唯一进程动作入口）。
    async fn tick_once(&self) -> Result<()> {
        let data_root = self.inner.data_root.get().cloned();

        // ── 1. 观测：OS 进程表快照 + 孤儿扫描 ──
        // 孤儿排除表（spec plans/supervisor-orphan-kill-false-positive-fix.md）：
        // 首选 Job Object 成员（宿主认领的进程全集）；不可用（Job 未初始化/
        // 非 Windows）降级为在管 PID ∪ 引擎活跃适配器 PID。
        let snapshot = ProcessSnapshot::capture();
        let orphan_pids = match &data_root {
            Some(root) => {
                let exclude_pids: Vec<u32> = match super::job::job_member_pids() {
                    Some(job_pids) => {
                        tracing::debug!("孤儿扫描排除（Job 成员）：{} 个", job_pids.len());
                        job_pids.into_iter().collect()
                    }
                    None => {
                        // 降级：在管 PID ∪ 引擎申报的活跃适配器 PID
                        // （registry 锁为微秒级临界区，无长持锁风险）
                        let mut exclude: Vec<u32> = {
                            let st = self.inner.state.lock().await;
                            st.epochs.values().map(|r| r.pid).collect()
                        };
                        if let Some(registry_arc) = self.inner.engine_registry.get() {
                            let registry = registry_arc.lock().await;
                            for engine in registry.engines() {
                                exclude.extend(engine.active_adapter_pids());
                            }
                        }
                        tracing::debug!(
                            "孤儿扫描排除（降级：在管+引擎申报）：{} 个",
                            exclude.len()
                        );
                        exclude
                    }
                };
                collect_orphans(&snapshot, root, &exclude_pids)
            }
            None => Vec::new(),
        };

        // ── 2. 观测：在管进程存活 ──
        let mut observed: HashMap<ServiceKey, Observed> = HashMap::new();
        {
            let st = self.inner.state.lock().await;
            for (key, rec) in &st.epochs {
                observed.insert(
                    key.clone(),
                    Observed {
                        alive: Some(snapshot.is_alive(rec.pid)),
                        healthy: None,
                        orphan_pids: Vec::new(),
                    },
                );
            }
        }
        if !orphan_pids.is_empty() {
            // 伪 key：reconciler 的孤儿收集遍历 observed.values()，与 desires 无关
            observed.insert(
                ("__orphan__".into(), "__global__".into()),
                Observed {
                    alive: None,
                    healthy: None,
                    orphan_pids,
                },
            );
        }

        // ── 3. 观测：http 健康（活着的在管进程，并发探测）──
        self.probe_healthies(&mut observed).await;

        // ── 4. 决策（纯函数）──
        let now = now_ms();
        let (actions, epochs_snapshot) = {
            let mut st = self.inner.state.lock().await;
            let desires: Vec<super::reconciler::Desire> = st
                .specs
                .iter()
                .map(|((p, s), spec)| super::reconciler::Desire {
                    plugin_id: p.clone(),
                    service_id: s.clone(),
                    wanted: spec.wanted && !st.shutting_down,
                    max_restarts: spec.contribution.max_restarts,
                })
                .collect();
            // 显式字段拆分借用：reconcile 需要同时可变借 epochs/budgets
            let SupState {
                epochs, budgets, ..
            } = &mut *st;
            let actions = reconcile(
                &desires,
                &observed,
                epochs,
                budgets,
                &super::reconciler::ReconcileParams {
                    now_ms: now,
                    ..Default::default()
                },
            );
            (actions, st.epochs.clone())
        };

        // ── 5. 执行（动作前重验，幂等不变式）──
        for action in actions {
            match action {
                Action::Spawn { key } => self.exec_spawn(&key).await,
                Action::Kill { key, pid, reason, .. } => {
                    let ok = super::proc_kill::kill_pid(pid);
                    if ok {
                        let mut st = self.inner.state.lock().await;
                        st.epochs.remove(&key);
                        if let Some(port) = epochs_snapshot.get(&key).and_then(|r| r.port) {
                            st.allocated_ports.retain(|&p| p != port);
                        }
                    }
                    let verb = match reason {
                        KillReason::Unwanted => "停止",
                        KillReason::ZombieUnhealthy => "僵死处决",
                    };
                    let msg = format!(
                        "{} {}/{} (pid={})：{}",
                        verb,
                        key.0,
                        key.1,
                        pid,
                        if ok { "已终止" } else { "终止失败，下轮重试" }
                    );
                    if ok {
                        tracing::info!("supervisor: {}", msg);
                    } else {
                        tracing::warn!("supervisor: {}", msg);
                    }
                    self.note_action(msg);
                }
                Action::KillOrphan { pid, .. } => {
                    // 动作前重验（幂等不变式，与 Kill 同范式）：决策与执行之间
                    // 恰有新进程 spawn 且已收容进 Job（spawn→assign 为同步代码块），
                    // 该进程已被宿主认领，不再是孤儿——跳过并留痕。
                    if matches!(super::job::is_job_member(pid), Some(true)) {
                        let msg = format!(
                            "孤儿清杀跳过 pid={}：执行时已是 Job 成员（新收容进程）",
                            pid
                        );
                        tracing::info!("supervisor: {}", msg);
                        self.note_action(msg);
                        continue;
                    }
                    let ok = super::proc_kill::kill_pid(pid);
                    let msg = format!(
                        "孤儿清杀 pid={}：{}",
                        pid,
                        if ok { "已终止" } else { "终止失败" }
                    );
                    tracing::warn!("supervisor: {}", msg);
                    self.note_action(msg);
                }
                Action::Note { key, msg } => {
                    tracing::debug!("supervisor: {}/{} {}", key.0, key.1, msg);
                }
            }
        }

        // ── 6. 账本持久化 + 快照表 + 状态广播 ──
        update_running_snapshot(&epochs_snapshot);
        self.persist_registry().await;
        self.publish_all().await;
        Ok(())
    }

    /// spawn 执行（Action::Spawn 的执行侧）。
    async fn exec_spawn(&self, key: &ServiceKey) {
        let (spec, port) = {
            let mut st = self.inner.state.lock().await;
            let Some(spec) = st.specs.get(key).cloned() else {
                return;
            };
            // 幂等重验：已有在管记录则不重复 spawn（两次唤醒间竞态防护）
            if st.epochs.contains_key(key) {
                return;
            }
            let port = match spec.contribution.port {
                Some(p) => {
                    if st.allocated_ports.contains(&p)
                        || st.reserved_host_ports.contains(&p)
                        || !bind_probe(p).await
                    {
                        // 端口占用 = 非瞬态，终态不再重试（spec §3.3，终结重试风暴）
                        let reason = format!("端口 {} 被占用（非瞬态，不自动重试）", p);
                        mark_spawn_failed(key, &mut st.budgets, reason.clone(), false);
                        tracing::warn!("服务 {}/{} spawn 失败：{}", key.0, key.1, reason);
                        self.note_action(format!(
                            "spawn 失败 {}/{}：{}",
                            key.0, key.1, reason
                        ));
                        return;
                    }
                    st.allocated_ports.push(p);
                    p
                }
                None => match allocate_dynamic_port(&mut st).await {
                    Some(p) => p,
                    None => {
                        mark_spawn_failed(
                            key,
                            &mut st.budgets,
                            "动态端口分配失败".into(),
                            true,
                        );
                        return;
                    }
                },
            };
            (spec, port)
        };

        let epoch = new_epoch();
        let args = build_args_v2(&spec.contribution, &spec.install_path, port, &spec.ctx, key);

        let mut command = tokio::process::Command::new(&spec.contribution.command);
        command.args(&args).current_dir(&spec.install_path).kill_on_drop(true);
        for (k, v) in spawn_env(&spec.ctx, epoch, key) {
            command.env(k, v);
        }
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        match command.spawn() {
            Ok(child) => {
                // 收容（needs 067 P0-1）：宿主强杀/崩溃时 OS 保证终止
                crate::services::supervisor::job::assign_child(&child);
                let pid = child.id().unwrap_or(0);
                let rec = EpochRecord {
                    epoch,
                    pid,
                    port: Some(port),
                    started_at_ms: now_ms(),
                    consecutive_health_fails: 0,
                };
                {
                    let mut st = self.inner.state.lock().await;
                    st.epochs.insert(key.clone(), rec);
                }
                self.spawn_exit_observer(epoch, child);
                let msg = format!(
                    "拉起 {}/{} (pid={}, port={})",
                    key.0, key.1, pid, port
                );
                tracing::info!("supervisor: {}", msg);
                self.note_action(msg);
            }
            Err(e) => {
                let msg = e.to_string();
                let mut st = self.inner.state.lock().await;
                st.allocated_ports.retain(|&p| p != port);
                mark_spawn_failed(key, &mut st.budgets, format!("spawn 失败: {}", msg), true);
                tracing::warn!("服务 {}/{} spawn 失败: {}", key.0, key.1, msg);
                self.note_action(format!("spawn 失败 {}/{}：{}", key.0, key.1, msg));
            }
        }
    }

    /// 进程退出观察：独占 Child，wait 返回 → 唤醒下一轮 tick（决策归 reconcile）。
    fn spawn_exit_observer(&self, epoch: u64, mut child: tokio::process::Child) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let _ = child.wait().await;
            tracing::debug!(epoch, "插件服务进程退出，唤醒对账");
            inner.wake.notify_one();
        });
    }

    async fn probe_healthies(&self, observed: &mut HashMap<ServiceKey, Observed>) {
        let probes: Vec<(ServiceKey, u16, String, u64)> = {
            let st = self.inner.state.lock().await;
            st.epochs
                .iter()
                .filter_map(|(key, rec)| {
                    let spec = st.specs.get(key)?;
                    let port = rec.port?;
                    let path = spec
                        .contribution
                        .health_check
                        .clone()
                        .unwrap_or_else(|| "/".to_string());
                    let timeout_ms = spec.contribution.health_check_timeout.unwrap_or(3000);
                    Some((key.clone(), port, path, timeout_ms))
                })
                .collect()
        };
        if probes.is_empty() {
            return;
        }
        let mut join = tokio::task::JoinSet::new();
        for (key, port, path, timeout_ms) in probes {
            join.spawn(async move {
                let url = format!("http://127.0.0.1:{}{}", port, path);
                let timeout = Duration::from_millis(timeout_ms.min(3000));
                let ok = reqwest::Client::builder()
                    .timeout(timeout)
                    .build()
                    .ok()
                    .and_then(|c| {
                        // probe 同步收口到本 task
                        Some(async move {
                            matches!(c.get(&url).send().await, Ok(resp) if resp.status().is_success())
                        })
                    });
                match ok {
                    Some(fut) => (key, fut.await),
                    None => (key, false),
                }
            });
        }
        while let Some(res) = join.join_next().await {
            if let Ok((key, ok)) = res {
                if let Some(obs) = observed.get_mut(&key) {
                    obs.healthy = Some(ok);
                }
            }
        }
    }

    async fn persist_registry(&self) {
        let Some(root) = self.inner.data_root.get().cloned() else {
            return;
        };
        let entries: Vec<RegistryEntry> = {
            let st = self.inner.state.lock().await;
            st.epochs
                .iter()
                .map(|((p, s), rec)| RegistryEntry {
                    epoch: rec.epoch,
                    plugin_id: p.clone(),
                    service_id: s.clone(),
                    pid: rec.pid,
                    port: rec.port,
                    started_at_ms: rec.started_at_ms,
                })
                .collect()
        };
        let mut registry = Registry::open(&root);
        if let Err(e) = registry.persist(entries) {
            tracing::warn!("registry 持久化失败（不影响对账）: {}", e);
        }
    }

    async fn publish_all(&self) {
        for s in self.list_status().await {
            let _ = self.inner.status_tx.send(s);
        }
    }

    fn note_action(&self, msg: String) {
        if let Ok(mut q) = self.inner.recent_actions.lock() {
            q.push_back(msg);
            while q.len() > 10 {
                q.pop_front();
            }
        }
    }
}

// ── 自由函数 ──

/// 运行中服务的 pluginId 集合快照（MCP 健康门控用）。
/// 数据源 = 在管 epochs（存活进程），tick 更新，最终一致（≤tick 周期）。
pub fn running_plugin_ids_snapshot() -> Option<std::collections::HashSet<String>> {
    RUNNING_PLUGIN_IDS.read().ok().and_then(|g| g.clone())
}

fn update_running_snapshot(epochs: &HashMap<ServiceKey, EpochRecord>) {
    let ids: std::collections::HashSet<String> =
        epochs.keys().map(|(p, _)| p.clone()).collect();
    if let Ok(mut g) = RUNNING_PLUGIN_IDS.write() {
        *g = Some(ids);
    }
}

async fn bind_probe(port: u16) -> bool {
    tokio::net::TcpListener::bind(("127.0.0.1", port)).await.is_ok()
}

/// 动态端口分配：bind 探测 + 记账（互斥由调用方持锁保证）。
async fn allocate_dynamic_port(st: &mut SupState) -> Option<u16> {
    for _ in 0..256 {
        let port = st.port_counter;
        st.port_counter = if st.port_counter >= 60000 {
            10000
        } else {
            st.port_counter + 1
        };
        if st.allocated_ports.contains(&port) || st.reserved_host_ports.contains(&port) {
            continue;
        }
        if !bind_probe(port).await {
            continue;
        }
        st.allocated_ports.push(port);
        return Some(port);
    }
    None
}

/// epoch：毫秒时间戳 ^ 进程 id ^ 纳秒熵（去重用途，非安全级）。
fn new_epoch() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    ms ^ ((std::process::id() as u64) << 20) ^ nanos.wrapping_mul(0x9E3779B97F4A7C15)
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 协议 v2 参数（spec §3.5）：新增 {{hostPid}}/{{pluginId}}；旧变量不变。
fn build_args_v2(
    contribution: &PluginServiceManifestContribution,
    plugin_install_path: &str,
    port: u16,
    ctx: &StartContext,
    key: &ServiceKey,
) -> Vec<String> {
    let normalized_dir =
        std::path::PathBuf::from(plugin_install_path).to_string_lossy().to_string();
    let workspace = ctx.workspace_path.clone().unwrap_or_default();
    let config_dir = ctx.app_config_dir.clone().unwrap_or_default();
    let host_pid = std::process::id().to_string();
    contribution
        .args_template
        .iter()
        .map(|arg| {
            arg.replace("{{port}}", &port.to_string())
                .replace("{{serviceId}}", &contribution.id)
                .replace("{{pluginId}}", &key.0)
                .replace("{{pluginDir}}", &normalized_dir)
                .replace("{{workspacePath}}", &workspace)
                .replace("{{appConfigDir}}", &config_dir)
                .replace("{{hostPid}}", &host_pid)
        })
        .collect()
}

/// 协议 v2 环境注入（spec §3.1）：断跨根渗透 + 孤儿自指死端口。
/// kvclient 端点自发现注释自证 env 优先——注入后服务只与本宿主通信。
fn spawn_env(ctx: &StartContext, epoch: u64, key: &ServiceKey) -> Vec<(String, String)> {
    let mut env = vec![
        ("POLARIS_EPOCH".to_string(), epoch.to_string()),
        ("POLARIS_HOST_PID".to_string(), std::process::id().to_string()),
        ("POLARIS_SERVICE_ID".to_string(), format!("{}/{}", key.0, key.1)),
        ("POLARIS_HOST".to_string(), "127.0.0.1".to_string()),
    ];
    if let (Some(p), Some(t)) = (&ctx.web_port, &ctx.web_token) {
        env.push(("POLARIS_PORT".to_string(), p.to_string()));
        env.push(("POLARIS_TOKEN".to_string(), t.clone()));
    }
    if let Some(dir) = &ctx.app_config_dir {
        env.push(("POLARIS_APP_CONFIG_DIR".to_string(), dir.clone()));
    }
    env
}

/// 孤儿收集：命令行含 `<dataRoot>\plugins\` 且 PID ∉ 排除表的进程。
///
/// 排除表语义（spec plans/supervisor-orphan-kill-false-positive-fix.md）：
/// 「宿主认领的进程」不是孤儿。首选判据 = Job Object 成员（宿主全部直接
/// 子进程 spawn 即收容，收容即认领——排除表天然完备，新增 spawn 点无需登记）；
/// Job 不可用时降级 = 在管 epochs PID ∪ 各引擎活跃适配器 PID。
///
/// 2026-11-11 事故根因：此前排除表恒空，命令行含 plugins 路径的**在管服务与
/// 引擎适配器**（codebuddy/qoder 等）被 10s tick 周期性误杀——codebuddy 会话
/// 100% 失败、supervisor 服务陷入「拉起→自杀→重拉」循环。
fn collect_orphans(snapshot: &ProcessSnapshot, data_root: &std::path::Path, exclude: &[u32]) -> Vec<u32> {
    let fragment = format!(
        "{root}{sep}plugins{sep}",
        root = data_root.to_string_lossy(),
        sep = std::path::MAIN_SEPARATOR
    );
    snapshot.find_by_cmd_fragment(&fragment, exclude)
}

/// status 推导（对外协议冻结；语义对齐旧版）。
fn status_from(
    epochs: &HashMap<ServiceKey, EpochRecord>,
    budgets: &HashMap<ServiceKey, Budget>,
    key: &ServiceKey,
) -> ServiceStatus {
    let (plugin_id, service_id) = key.clone();
    match epochs.get(key) {
        Some(rec) => ServiceStatus {
            service_id,
            plugin_id,
            state: ServiceState::Running,
            port: rec.port,
            pid: Some(rec.pid),
            uptime: Some(now_ms().saturating_sub(rec.started_at_ms) / 1000),
            last_error: None,
            restart_count: budgets.get(key).map(|b| b.restart_count).unwrap_or(0),
            epoch: Some(rec.epoch),
            unavailable_reason: None,
        },
        None => {
            let budget = budgets.get(key);
            let state = match budget {
                Some(b) if b.error_terminal.is_some() => ServiceState::Error,
                _ => ServiceState::Stopped,
            };
            ServiceStatus {
                service_id,
                plugin_id,
                state,
                port: None,
                pid: None,
                uptime: None,
                last_error: budget.and_then(|b| b.error_terminal.clone()),
                restart_count: budget.map(|b| b.restart_count).unwrap_or(0),
                epoch: None,
                unavailable_reason: budget.and_then(|b| b.error_terminal.clone()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 协议 v2 env 注入（验收 B4）：宿主端点/EPOCH/HOST_PID 显式注入——
    /// kvclient env 优先，服务只与本宿主通信，跨数据根渗透与孤儿骚扰即断。
    #[test]
    fn spawn_env_injects_host_binding() {
        let ctx = StartContext {
            workspace_path: None,
            app_config_dir: Some("C:/cfg".into()),
            web_port: Some(9829),
            web_token: Some("tok".into()),
        };
        let env: HashMap<String, String> = spawn_env(&ctx, 42, &("p".into(), "s".into()))
            .into_iter()
            .collect();
        assert_eq!(env.get("POLARIS_HOST").map(String::as_str), Some("127.0.0.1"));
        assert_eq!(env.get("POLARIS_PORT").map(String::as_str), Some("9829"));
        assert_eq!(env.get("POLARIS_TOKEN").map(String::as_str), Some("tok"));
        assert_eq!(env.get("POLARIS_EPOCH").map(String::as_str), Some("42"));
        assert_eq!(
            env.get("POLARIS_HOST_PID").map(String::as_str),
            Some(std::process::id().to_string().as_str())
        );
    }

    /// 协议 v2 args：{{hostPid}}/{{pluginId}} 新变量替换；旧变量不受影响。
    #[test]
    fn build_args_v2_expands_host_pid() {
        let contribution = serde_json::from_value::<PluginServiceManifestContribution>(
            serde_json::json!({
                "id": "radar-service", "type": "http", "command": "node",
                "argsTemplate": ["{{pluginDir}}/s.js", "{{port}}", "{{hostPid}}", "{{pluginId}}"]
            }),
        )
        .expect("fixture");
        let ctx = StartContext {
            app_config_dir: Some("C:/cfg".into()),
            ..Default::default()
        };
        let args = build_args_v2(&contribution, "D:/root/plugins/feed-radar", 10001, &ctx, &("feed-radar".into(), "radar-service".into()));
        assert!(args[0].contains("D:/root/plugins/feed-radar"));
        assert_eq!(args[1], "10001");
        assert_eq!(args[2], std::process::id().to_string(), "{{hostPid}} 应展开为宿主 PID");
        assert_eq!(args[3], "feed-radar", "{{pluginId}} 应展开");
    }
}
