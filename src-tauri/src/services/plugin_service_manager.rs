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
use tokio::sync::Mutex;

use crate::error::{AppError, Result};
use crate::models::plugin::{DiscoveredPluginManifest, PluginServiceManifestContribution};

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
struct ManagedService {
    contribution: PluginServiceManifestContribution,
    plugin_id: String,
    install_path: String,
    ctx: StartContext,
    status: ServiceStatus,
    child: Option<Child>,
    started_at: Option<Instant>,
    /// 自动重启控制：true 表示进程退出后允许重启
    auto_restart_enabled: bool,
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

        // 已在 Running 则直接返回
        {
            let services = self.services.lock().await;
            if let Some(existing) = services.get(&service_key) {
                if existing.status.state == ServiceState::Running {
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

        let child = command.spawn().map_err(|e| {
            AppError::ProcessError(format!(
                "Failed to start service {} (command='{}'): {}",
                contribution.id, contribution.command, e
            ))
        })?;

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

        // 写入 map（保留 child）
        {
            let mut services = self.services.lock().await;
            // 如果已存在记录（之前 stopped），保留 restart_count
            let restart_count = services
                .get(&service_key)
                .map(|m| m.status.restart_count)
                .unwrap_or(0);
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
                    child: Some(child),
                    started_at: Some(Instant::now()),
                    auto_restart_enabled: contribution.restart_on_failure,
                },
            );
        }

        // 启动进程监视任务（等子进程退出 → 触发重启或标记停止）
        self.spawn_process_watcher(plugin_id.to_string(), contribution.id.clone());

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
    pub async fn stop_service(
        self: &Arc<Self>,
        plugin_id: &str,
        service_id: &str,
    ) -> Result<ServiceStatus> {
        let service_key = make_key(plugin_id, service_id);

        let (child_opt, port_opt) = {
            let mut services = self.services.lock().await;
            match services.get_mut(&service_key) {
                Some(managed) => {
                    managed.auto_restart_enabled = false; // 阻止后续自动重启
                    managed.status.state = ServiceState::Stopping;
                    let child = managed.child.take();
                    let port = managed.status.port;
                    (child, port)
                }
                None => {
                    return Ok(ServiceStatus {
                        service_id: service_id.to_string(),
                        plugin_id: plugin_id.to_string(),
                        state: ServiceState::Stopped,
                        port: None,
                        pid: None,
                        uptime: None,
                        last_error: None,
                        restart_count: 0,
                    });
                }
            }
        };

        if let Some(mut child) = child_opt {
            // Tokio Child::kill 是 async；先发 kill 信号
            let _ = child.kill().await;
            let _ = child.wait().await;
        }

        if let Some(port) = port_opt {
            self.release_port(port).await;
        }

        let mut services = self.services.lock().await;
        if let Some(managed) = services.get_mut(&service_key) {
            managed.status.state = ServiceState::Stopped;
            managed.status.pid = None;
            managed.status.uptime = None;
            managed.started_at = None;
            return Ok(snapshot_status(managed));
        }

        Ok(ServiceStatus {
            service_id: service_id.to_string(),
            plugin_id: plugin_id.to_string(),
            state: ServiceState::Stopped,
            port: None,
            pid: None,
            uptime: None,
            last_error: None,
            restart_count: 0,
        })
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

    /// 进程退出监视：等子进程退出后触发自动重启或停止收尾
    fn spawn_process_watcher(self: &Arc<Self>, plugin_id: String, service_id: String) {
        let manager = self.clone();
        let key = make_key(&plugin_id, &service_id);

        tokio::spawn(async move {
            // 取出 child（waiting 阶段独占）
            let mut child = {
                let mut services = manager.services.lock().await;
                match services.get_mut(&key).and_then(|m| m.child.take()) {
                    Some(c) => c,
                    None => return,
                }
            };

            let exit_result = child.wait().await;
            let exit_msg = match &exit_result {
                Ok(status) => format!("exited with {:?}", status),
                Err(e) => format!("wait failed: {}", e),
            };

            tracing::info!(
                plugin_id = %plugin_id,
                service_id = %service_id,
                "plugin service process {}",
                exit_msg
            );

            // 决定是否重启
            let restart_decision = {
                let mut services = manager.services.lock().await;
                let m = match services.get_mut(&key) {
                    Some(m) => m,
                    None => return,
                };

                // 用户主动停止
                if !m.auto_restart_enabled {
                    m.status.state = ServiceState::Stopped;
                    m.status.pid = None;
                    return;
                }

                if m.status.restart_count >= m.contribution.max_restarts {
                    m.status.state = ServiceState::Error;
                    m.status.last_error =
                        Some(format!("Exceeded max restarts ({})", m.contribution.max_restarts));
                    tracing::error!(
                        plugin_id = %m.plugin_id,
                        service_id = %m.contribution.id,
                        "plugin service exceeded max restarts"
                    );
                    return;
                }

                m.status.restart_count += 1;
                m.status.state = ServiceState::Starting;
                m.status.last_error = Some(exit_msg.clone());

                Some((
                    m.plugin_id.clone(),
                    m.contribution.clone(),
                    m.install_path.clone(),
                    m.ctx.clone(),
                    m.status.restart_count,
                ))
            };

            if let Some((pid, contribution, install_path, ctx, attempt)) = restart_decision {
                // 指数退避
                let delay_secs = std::cmp::min(2u64.pow(attempt.min(6)), 60);
                tokio::time::sleep(Duration::from_secs(delay_secs)).await;

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
                    }
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
