//! 插件服务管理器
//!
//! 管理插件声明的后台服务的完整生命周期：
//! - 启动 / 停止 / 重启服务
//! - 健康检查（HTTP probe）
//! - 自动重启（指数退避 + maxRestarts）
//! - 端口分配
//!
//! 设计要点：
//! - 整体放进 `Arc<PluginServiceManager>`，方法签名 `&self`，便于放入 Tauri State 共享。
//! - 内部状态用 `tokio::sync::Mutex` 包裹，所有持锁→await 的路径都先取 clone 再释放锁，
//!   避免跨 await 持锁导致的死锁。
//! - 健康检查通过 `tokio::spawn` 周期任务，仅 HTTP 类型服务才启用。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use tokio::sync::{watch, Mutex, Notify};

use crate::error::{AppError, Result};
use crate::models::plugin::{DiscoveredPluginManifest, PluginServiceManifestContribution};

/// 停止等待 finalize 的上限：kill(TerminateProcess) + wait 通常毫秒级，
/// 超时说明进程不可杀（系统级卡死），返回时状态可能仍是 Stopping——
/// 状态由 watcher 最终收敛，不无限阻塞调用方。
const STOP_FINALIZE_TIMEOUT: Duration = Duration::from_secs(5);

/// 服务稳定运行时长：超过该值后自然退出，restart_count 清零再计
/// （否则偶发退出累计 3 次后自动重启永久失效——审计 X2-⑤）。
const STABLE_UPTIME_SECS: u64 = 60;

/// 服务类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceType {
    Http,
    Stdio,
    Worker,
}

impl ServiceType {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "http" => ServiceType::Http,
            "stdio" => ServiceType::Stdio,
            _ => ServiceType::Worker,
        }
    }
}

/// 服务状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Error,
}

/// 服务状态信息（对外返回）
#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

/// 启动选项（由调用方提供运行时上下文）
#[derive(Debug, Clone, Default)]
pub struct StartContext {
    pub workspace_path: Option<String>,
    pub app_config_dir: Option<String>,
}

/// 管理的服务（内部状态）
///
/// 进程所有权（2026-10-24 审计 X2 修复）：child 由 `spawn_process_watcher`
/// **参数持有**，不再经 map 交接——历史设计 watcher 启动即 `take()` 走 child，
/// `stop_service` 随后 `take()` 恒得 None，kill 分支永远不执行，导致
/// 停止/重启后进程不死（僵尸占端口、双进程并存）。现在「谁持有谁负责杀」：
/// 停止请求经 `stop_signal` 通知 watcher，由 watcher kill + wait + 收尾。
struct ManagedService {
    contribution: PluginServiceManifestContribution,
    plugin_id: String,
    install_path: String,
    ctx: StartContext,
    status: ServiceStatus,
    started_at: Option<Instant>,
    /// 自动重启控制：true 表示进程退出后允许重启
    auto_restart_enabled: bool,
    /// 停止信号（stop_service → watcher；Notify permit 语义，先通知后等待不丢失）
    stop_signal: Arc<Notify>,
    /// 终态信号（watcher → stop_service；终态置 true。watch channel 存值，
    /// 「watcher 先收尾、stop 后订阅」与反序都不丢）
    finalize: watch::Sender<bool>,
}

/// 插件服务管理器
pub struct PluginServiceManager {
    services: Mutex<HashMap<String, ManagedService>>,
    allocated_ports: Mutex<Vec<u16>>,
    port_counter: Mutex<u16>,
}

impl PluginServiceManager {
    pub fn new() -> Self {
        Self {
            services: Mutex::new(HashMap::new()),
            allocated_ports: Mutex::new(Vec::new()),
            port_counter: Mutex::new(10000),
        }
    }

    /// 根据插件列表批量启动（应用启动时使用）
    ///
    /// `plugin_states` 为 `pluginId -> enabled` 的映射；不在 map 中的插件默认按 enabledByDefault 处理。
    pub async fn start_services_for_plugins(
        self: &Arc<Self>,
        plugins: &[DiscoveredPluginManifest],
        plugin_states: &HashMap<String, bool>,
        ctx: StartContext,
    ) -> Vec<ServiceStatus> {
        let mut results = Vec::new();
        for plugin in plugins {
            let enabled = plugin_states
                .get(&plugin.id)
                .copied()
                .unwrap_or(plugin.enabled_by_default);
            if !enabled {
                continue;
            }
            for service in &plugin.contributes.services {
                if !service.auto_start {
                    continue;
                }
                match self
                    .start_service_internal(
                        &plugin.id,
                        service.clone(),
                        plugin.install_path.clone(),
                        ctx.clone(),
                    )
                    .await
                {
                    Ok(status) => results.push(status),
                    Err(e) => {
                        tracing::warn!(
                            plugin_id = %plugin.id,
                            service_id = %service.id,
                            error = %e,
                            "auto-start plugin service failed"
                        );
                    }
                }
            }
        }
        results
    }

    /// 启动单个服务（命令入口）
    pub async fn start_service(
        self: &Arc<Self>,
        plugin_id: &str,
        contribution: PluginServiceManifestContribution,
        plugin_install_path: String,
        ctx: StartContext,
    ) -> Result<ServiceStatus> {
        self.start_service_internal(plugin_id, contribution, plugin_install_path, ctx)
            .await
    }

    async fn start_service_internal(
        self: &Arc<Self>,
        plugin_id: &str,
        contribution: PluginServiceManifestContribution,
        plugin_install_path: String,
        ctx: StartContext,
    ) -> Result<ServiceStatus> {
        let service_key = make_key(plugin_id, &contribution.id);

        // 已在 Running/Starting 则直接返回（Starting 也挡：防自动重启退避窗口内
        // 的并发 start 双拉进程——审计 X2-⑥，历史只挡 Running）
        {
            let services = self.services.lock().await;
            if let Some(existing) = services.get(&service_key) {
                if matches!(
                    existing.status.state,
                    ServiceState::Running | ServiceState::Starting
                ) {
                    return Ok(snapshot_status(existing));
                }
            }
        }

        // 分配端口
        let port = match contribution.port {
            Some(p) => {
                self.reserve_port(p).await;
                p
            }
            None => self.allocate_port().await,
        };

        let args = build_args(&contribution, &plugin_install_path, port, &ctx);

        tracing::info!(
            plugin_id = %plugin_id,
            service_id = %contribution.id,
            cmd = %contribution.command,
            args = ?args,
            cwd = %plugin_install_path,
            port,
            "spawning plugin service"
        );

        // 起进程
        let mut command = Command::new(&contribution.command);
        command
            .args(&args)
            .current_dir(&plugin_install_path)
            .kill_on_drop(true);

        // Windows 下隐藏 console（Tokio Command 自带 creation_flags）
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let child = match command.spawn() {
            Ok(c) => c,
            Err(e) => {
                // spawn 失败：端口已分配但无进程，回滚防泄漏
                self.release_port(port).await;
                return Err(AppError::ProcessError(format!(
                    "Failed to start service {} (command='{}'): {}",
                    contribution.id, contribution.command, e
                )));
            }
        };

        let pid = child.id().unwrap_or(0);

        let status = ServiceStatus {
            service_id: contribution.id.clone(),
            plugin_id: plugin_id.to_string(),
            state: ServiceState::Running,
            port: Some(port),
            pid: Some(pid),
            uptime: Some(0),
            last_error: None,
            restart_count: 0,
        };

        let stop_signal = Arc::new(Notify::new());
        let (finalize, _finalize_rx) = watch::channel(false);

        // 写入 map，然后立即把 child 移交 watcher（map 不持有进程句柄）
        {
            let mut services = self.services.lock().await;
            // restart_count 规则（审计 X2-⑤）：
            // - Starting（自动重启窗口，watcher 递增后转拉起）→ 保留计数
            // - 其余（用户手动 start/restart，前态 Stopped/Error）→ 清零重计
            let restart_count = match services.get(&service_key) {
                Some(m) if m.status.state == ServiceState::Starting => m.status.restart_count,
                _ => 0,
            };
            let mut status_with_history = status.clone();
            status_with_history.restart_count = restart_count;
            services.insert(
                service_key.clone(),
                ManagedService {
                    contribution: contribution.clone(),
                    plugin_id: plugin_id.to_string(),
                    install_path: plugin_install_path.clone(),
                    ctx: ctx.clone(),
                    status: status_with_history,
                    started_at: Some(Instant::now()),
                    auto_restart_enabled: contribution.restart_on_failure,
                    stop_signal: stop_signal.clone(),
                    finalize,
                },
            );
        }

        // 启动进程监视任务（持有 child：等退出 → 触发重启或停止收尾；响应停止信号）
        self.spawn_process_watcher(
            plugin_id.to_string(),
            contribution.id.clone(),
            child,
            stop_signal,
        );

        // 启动健康检查任务
        if contribution.health_check.is_some() && contribution.service_type.to_lowercase() == "http"
        {
            self.spawn_health_check(plugin_id.to_string(), contribution.id.clone());
        }

        // 返回最新 snapshot
        let services = self.services.lock().await;
        Ok(services
            .get(&service_key)
            .map(snapshot_status)
            .unwrap_or(status))
    }

    /// 停止单个服务
    ///
    /// X2 修复后的语义：本方法**不直接 kill**（不持有 child）；置 Stopping +
    /// 关自动重启 → 经 `stop_signal` 通知 watcher（child 持有者）执行
    /// kill + wait + 收尾（含端口释放，时序保证「进程真退出后才释放端口」，
    /// 杜绝僵尸占端口后的再分配冲突），并在 finalize 通道上等待收尾完成
    /// （上限 `STOP_FINALIZE_TIMEOUT`）。
    pub async fn stop_service(
        self: &Arc<Self>,
        plugin_id: &str,
        service_id: &str,
    ) -> Result<ServiceStatus> {
        let service_key = make_key(plugin_id, service_id);

        let stopped_snapshot = || ServiceStatus {
            service_id: service_id.to_string(),
            plugin_id: plugin_id.to_string(),
            state: ServiceState::Stopped,
            port: None,
            pid: None,
            uptime: None,
            last_error: None,
            restart_count: 0,
        };

        let (stop_signal, mut finalize_rx) = {
            let mut services = self.services.lock().await;
            match services.get_mut(&service_key) {
                Some(managed) => {
                    // 已是终态（进程必已退出，端口已由 watcher 收尾释放）
                    if matches!(
                        managed.status.state,
                        ServiceState::Stopped | ServiceState::Error
                    ) {
                        return Ok(snapshot_status(managed));
                    }
                    managed.auto_restart_enabled = false; // 阻止后续自动重启
                    managed.status.state = ServiceState::Stopping;
                    (
                        managed.stop_signal.clone(),
                        managed.finalize.subscribe(),
                    )
                }
                None => return Ok(stopped_snapshot()),
            }
        };

        // 通知 watcher 停止（Notify permit 语义：watcher 尚未进入 select 也无妨）
        stop_signal.notify_one();

        // 等 watcher 收尾（终态置 true / 通道关闭）；上限 STOP_FINALIZE_TIMEOUT。
        // 超时不代表失败——极退避窗口内的停止由 watcher 退避后复查收敛（见
        // spawn_process_watcher），此处不无限阻塞调用方。
        let _ = tokio::time::timeout(STOP_FINALIZE_TIMEOUT, async {
            loop {
                if *finalize_rx.borrow_and_update() {
                    break;
                }
                if finalize_rx.changed().await.is_err() {
                    break; // watcher 结束（通道关闭），读最终状态即可
                }
            }
        })
        .await;

        let mut services = self.services.lock().await;
        if let Some(managed) = services.get_mut(&service_key) {
            return Ok(snapshot_status(managed));
        }
        Ok(stopped_snapshot())
    }

    /// 停止指定插件的所有服务
    pub async fn stop_services_for_plugin(
        self: &Arc<Self>,
        plugin_id: &str,
    ) -> Result<Vec<ServiceStatus>> {
        let service_ids: Vec<String> = {
            let services = self.services.lock().await;
            services
                .values()
                .filter(|m| m.plugin_id == plugin_id)
                .map(|m| m.contribution.id.clone())
                .collect()
        };

        let mut result = Vec::new();
        for sid in service_ids {
            if let Ok(s) = self.stop_service(plugin_id, &sid).await {
                result.push(s);
            }
        }
        Ok(result)
    }

    /// 重启服务
    pub async fn restart_service(
        self: &Arc<Self>,
        plugin_id: &str,
        service_id: &str,
    ) -> Result<ServiceStatus> {
        // 取出 contribution / install_path / ctx 备用
        let saved = {
            let services = self.services.lock().await;
            services
                .get(&make_key(plugin_id, service_id))
                .map(|m| (m.contribution.clone(), m.install_path.clone(), m.ctx.clone()))
        };

        let (contribution, install_path, ctx) = match saved {
            Some(v) => v,
            None => {
                return Err(AppError::ProcessError(format!(
                    "Service {}/{} not registered",
                    plugin_id, service_id
                )));
            }
        };

        self.stop_service(plugin_id, service_id).await?;
        self.start_service(plugin_id, contribution, install_path, ctx)
            .await
    }

    /// 获取所有服务状态
    pub async fn list_status(&self) -> Vec<ServiceStatus> {
        let services = self.services.lock().await;
        services.values().map(snapshot_status).collect()
    }

    /// 获取单个服务状态
    pub async fn get_status(
        &self,
        plugin_id: &str,
        service_id: &str,
    ) -> Option<ServiceStatus> {
        let services = self.services.lock().await;
        services.get(&make_key(plugin_id, service_id)).map(snapshot_status)
    }

    /// 停止所有服务（应用退出时使用）
    pub async fn stop_all(self: &Arc<Self>) {
        let keys: Vec<(String, String)> = {
            let services = self.services.lock().await;
            services
                .values()
                .map(|m| (m.plugin_id.clone(), m.contribution.id.clone()))
                .collect()
        };
        for (pid, sid) in keys {
            let _ = self.stop_service(&pid, &sid).await;
        }
    }

    // === 内部 ===

    /// 健康检查任务：周期发 GET 请求
    fn spawn_health_check(self: &Arc<Self>, plugin_id: String, service_id: String) {
        let manager = self.clone();
        let key = make_key(&plugin_id, &service_id);

        tokio::spawn(async move {
            // 给进程一个初始预热时间
            tokio::time::sleep(Duration::from_secs(2)).await;

            loop {
                // 取必要参数 + 检查是否仍在运行
                let probe = {
                    let services = manager.services.lock().await;
                    let m = match services.get(&key) {
                        Some(m) => m,
                        None => return, // 服务已被移除
                    };
                    if m.status.state != ServiceState::Running {
                        return; // 不再运行，结束探针
                    }
                    let port = m.status.port.unwrap_or(0);
                    let path = m
                        .contribution
                        .health_check
                        .clone()
                        .unwrap_or_else(|| "/".to_string());
                    let timeout_ms = m.contribution.health_check_timeout.unwrap_or(3000);
                    (port, path, timeout_ms)
                };

                let (port, path, timeout_ms) = probe;
                let url = format!("http://127.0.0.1:{}{}", port, path);

                let client_result = reqwest::Client::builder()
                    .timeout(Duration::from_millis(timeout_ms))
                    .build();

                let ok = if let Ok(client) = client_result {
                    matches!(client.get(&url).send().await, Ok(resp) if resp.status().is_success())
                } else {
                    false
                };

                if !ok {
                    let mut services = manager.services.lock().await;
                    if let Some(m) = services.get_mut(&key) {
                        m.status.last_error = Some(format!("health check failed: {}", url));
                        tracing::warn!(url = %url, "plugin service health check failed");
                    }
                    // 健康检查失败不直接 kill，只标记 last_error；进程是否真死交给 process_watcher
                }

                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        });
    }

    /// 进程退出监视（X2 修复后的形态，2026-10-24 审计）：
    /// - **参数持有 child**（不经 map 交接）——「谁持有谁负责杀」；
    /// - `select!` 同时等「停止信号」与「进程退出」（tokio `Child::wait`
    ///   cancel-safe，取消后重建 future 无泄漏）；
    /// - 所有终态路径统一收尾：置终态 → **进程真退出后才释放端口** →
    ///   finalize 通道置 true（唤醒等待中的 stop_service）；
    /// - 自动重启退避 sleep 后**复查停止意图**：停止请求落在退避窗口内时
    ///   收敛为 Stopped，而不是继续拉起。
    fn spawn_process_watcher(
        self: &Arc<Self>,
        plugin_id: String,
        service_id: String,
        mut child: Child,
        stop_signal: Arc<Notify>,
    ) {
        let manager = self.clone();
        let key = make_key(&plugin_id, &service_id);

        tokio::spawn(async move {
            // 两条出路：用户请求停止（kill + wait） / 进程自然退出
            let (user_stop, exit_note) = tokio::select! {
                _ = stop_signal.notified() => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    (true, "stopped by user".to_string())
                }
                res = child.wait() => {
                    let msg = match &res {
                        Ok(status) => format!("exited with {:?}", status),
                        Err(e) => format!("wait failed: {}", e),
                    };
                    tracing::info!(
                        plugin_id = %plugin_id,
                        service_id = %service_id,
                        "plugin service process {}",
                        msg
                    );
                    (false, msg)
                }
            };

            // 锁内只改状态/取决策数据（文件头纪律：持锁不跨 await 做副作用）
            // decision = (待释放端口, 重启参数)
            let decision = {
                let mut services = manager.services.lock().await;
                let m = match services.get_mut(&key) {
                    Some(m) => m,
                    None => return, // 记录已被移除，无需收尾
                };
                let port = m.status.port.take();

                if user_stop || !m.auto_restart_enabled {
                    m.status.state = ServiceState::Stopped;
                    m.status.pid = None;
                    m.status.uptime = None;
                    m.started_at = None;
                    (port, None)
                } else {
                    // 稳定运行 ≥STABLE_UPTIME_SECS 后自然退出 → 计数清零再计
                    let uptime = m
                        .started_at
                        .map(|t| t.elapsed().as_secs())
                        .unwrap_or(0);
                    if uptime >= STABLE_UPTIME_SECS {
                        m.status.restart_count = 0;
                    }
                    if m.status.restart_count >= m.contribution.max_restarts {
                        m.status.state = ServiceState::Error;
                        m.status.pid = None;
                        m.status.uptime = None;
                        m.started_at = None;
                        m.status.last_error = Some(format!(
                            "Exceeded max restarts ({})",
                            m.contribution.max_restarts
                        ));
                        tracing::error!(
                            plugin_id = %m.plugin_id,
                            service_id = %m.contribution.id,
                            "plugin service exceeded max restarts"
                        );
                        (port, None)
                    } else {
                        m.status.restart_count += 1;
                        m.status.state = ServiceState::Starting;
                        m.status.pid = None;
                        m.status.last_error = Some(exit_note);
                        (
                            port,
                            Some((
                                m.plugin_id.clone(),
                                m.contribution.clone(),
                                m.install_path.clone(),
                                m.ctx.clone(),
                                m.status.restart_count,
                            )),
                        )
                    }
                }
            };

            // 锁外副作用：释放端口（进程已退出，此刻释放安全——修复「端口先释放
            // 而进程未死，新服务 bind 失败却被标 Running」的错序）
            if let Some(p) = decision.0 {
                manager.release_port(p).await;
            }

            // 非重启终态（用户停止 / 自动重启关闭 / 超限 Error）：finalize 通知后结束
            let Some((pid, contribution, install_path, ctx, attempt)) = decision.1 else {
                let services = manager.services.lock().await;
                if let Some(m) = services.get(&key) {
                    let _ = m.finalize.send(true);
                }
                return;
            };

            // 指数退避
            let delay_secs = std::cmp::min(2u64.pow(attempt.min(6)), 60);
            tokio::time::sleep(Duration::from_secs(delay_secs)).await;

            // 退避窗口内收到停止请求（stop_service 已置 auto_restart_enabled=false）
            // → 收敛为 Stopped + finalize，不再拉起
            let still_enabled = {
                let services = manager.services.lock().await;
                services
                    .get(&key)
                    .map(|m| m.auto_restart_enabled)
                    .unwrap_or(false)
            };
            if !still_enabled {
                tracing::info!(
                    plugin_id = %pid,
                    service_id = %contribution.id,
                    "stop requested during restart backoff, giving up auto-restart"
                );
                let mut services = manager.services.lock().await;
                if let Some(m) = services.get_mut(&key) {
                    m.status.state = ServiceState::Stopped;
                    m.status.pid = None;
                    m.status.uptime = None;
                    m.started_at = None;
                    let _ = m.finalize.send(true);
                }
                return;
            }

            tracing::info!(
                plugin_id = %pid,
                service_id = %contribution.id,
                attempt,
                "auto-restarting plugin service"
            );

            if let Err(e) = manager
                .start_service_internal(&pid, contribution.clone(), install_path, ctx)
                .await
            {
                tracing::error!(
                    plugin_id = %pid,
                    service_id = %contribution.id,
                    error = %e,
                    "auto-restart failed"
                );
                let mut services = manager.services.lock().await;
                if let Some(m) = services.get_mut(&key) {
                    m.status.state = ServiceState::Error;
                    m.status.last_error = Some(e.to_string());
                    let _ = m.finalize.send(true);
                }
            }
        });
    }

    async fn allocate_port(&self) -> u16 {
        let mut counter = self.port_counter.lock().await;
        let mut ports = self.allocated_ports.lock().await;
        loop {
            let port = *counter;
            *counter = if *counter >= 60000 {
                10000
            } else {
                *counter + 1
            };
            if !ports.contains(&port) {
                ports.push(port);
                return port;
            }
        }
    }

    async fn reserve_port(&self, port: u16) {
        let mut ports = self.allocated_ports.lock().await;
        if !ports.contains(&port) {
            ports.push(port);
        }
    }

    async fn release_port(&self, port: u16) {
        let mut ports = self.allocated_ports.lock().await;
        ports.retain(|&p| p != port);
    }
}

impl Default for PluginServiceManager {
    fn default() -> Self {
        Self::new()
    }
}

fn make_key(plugin_id: &str, service_id: &str) -> String {
    format!("{}::{}", plugin_id, service_id)
}

fn snapshot_status(m: &ManagedService) -> ServiceStatus {
    let mut s = m.status.clone();
    if let Some(started_at) = m.started_at {
        if s.state == ServiceState::Running {
            s.uptime = Some(started_at.elapsed().as_secs());
        }
    }
    s
}

fn build_args(
    contribution: &PluginServiceManifestContribution,
    plugin_install_path: &str,
    port: u16,
    ctx: &StartContext,
) -> Vec<String> {
    // 规范化插件目录，避免双反斜杠混合分隔符在 node 路径解析时打架
    let normalized_dir = PathBuf::from(plugin_install_path)
        .to_string_lossy()
        .to_string();
    let workspace = ctx.workspace_path.clone().unwrap_or_default();
    let config_dir = ctx.app_config_dir.clone().unwrap_or_default();

    contribution
        .args_template
        .iter()
        .map(|arg| {
            arg.replace("{{port}}", &port.to_string())
                .replace("{{serviceId}}", &contribution.id)
                .replace("{{pluginDir}}", &normalized_dir)
                .replace("{{workspacePath}}", &workspace)
                .replace("{{appConfigDir}}", &config_dir)
        })
        .collect()
}
