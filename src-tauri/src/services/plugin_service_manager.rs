//! 插件服务管理器
//!
//! 管理插件声明的后台服务的完整生命周期：
//! - 启动/停止/重启服务
//! - 健康检查
//! - 自动重启
//! - 端口分配

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};

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
            "worker" => ServiceType::Worker,
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

/// 服务状态信息
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

/// 管理的服务
struct ManagedService {
    contribution: PluginServiceManifestContribution,
    plugin_id: String,
    status: ServiceStatus,
    child: Option<Child>,
    started_at: Option<Instant>,
    health_check_handle: Option<tokio::task::JoinHandle<()>>,
    restart_handle: Option<tokio::task::JoinHandle<()>>,
}

/// 插件服务管理器
pub struct PluginServiceManager {
    services: Arc<Mutex<HashMap<String, ManagedService>>>,
    port_counter: u16,
    allocated_ports: Arc<Mutex<Vec<u16>>>,
}

impl PluginServiceManager {
    /// 创建新的服务管理器
    pub fn new() -> Self {
        Self {
            services: Arc::new(Mutex::new(HashMap::new())),
            port_counter: 10000,
            allocated_ports: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// 根据插件列表启动所有需要的服务
    pub async fn start_services_for_plugins(
        &mut self,
        plugins: &[DiscoveredPluginManifest],
        plugin_states: &HashMap<String, bool>,
    ) -> Result<()> {
        for plugin in plugins {
            // 检查插件是否启用
            let enabled = plugin_states.get(&plugin.id).copied().unwrap_or(true);
            if !enabled {
                continue;
            }

            for service_contribution in &plugin.contributes.services {
                if service_contribution.auto_start {
                    self.start_service(
                        &plugin.id,
                        service_contribution,
                        &plugin.install_path,
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    /// 停止指定插件的所有服务
    pub async fn stop_services_for_plugin(&mut self, plugin_id: &str) -> Result<()> {
        let service_keys: Vec<String> = {
            let services = self.services.lock().map_err(|e| {
                AppError::ProcessError(format!("Failed to lock services: {}", e))
            })?;
            services
                .keys()
                .filter(|k| k.starts_with(&format!("{}::", plugin_id)))
                .cloned()
                .collect()
        };

        for key in service_keys {
            let parts: Vec<&str> = key.splitn(2, "::").collect();
            if parts.len() == 2 {
                self.stop_service(parts[0], parts[1]).await?;
            }
        }

        Ok(())
    }

    /// 启动单个服务
    pub async fn start_service(
        &mut self,
        plugin_id: &str,
        contribution: &PluginServiceManifestContribution,
        plugin_install_path: &str,
    ) -> Result<ServiceStatus> {
        let service_key = format!("{}::{}", plugin_id, contribution.id);

        // 检查是否已在运行
        {
            let services = self.services.lock().map_err(|e| {
                AppError::ProcessError(format!("Failed to lock services: {}", e))
            })?;
            if let Some(existing) = services.get(&service_key) {
                if existing.status.state == ServiceState::Running {
                    return Ok(existing.status.clone());
                }
            }
        }

        // 分配端口
        let port = contribution.port.unwrap_or_else(|| self.allocate_port());

        // 构建启动参数
        let args = self.build_args(contribution, plugin_install_path, port);

        // 创建初始状态
        let status = ServiceStatus {
            service_id: contribution.id.clone(),
            plugin_id: plugin_id.to_string(),
            state: ServiceState::Starting,
            port: Some(port),
            pid: None,
            uptime: None,
            last_error: None,
            restart_count: 0,
        };

        // 启动进程
        let child = Command::new(&contribution.command)
            .args(&args)
            .current_dir(plugin_install_path)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                AppError::ProcessError(format!(
                    "Failed to start service {}: {}",
                    contribution.id, e
                ))
            })?;

        let pid = child.id().unwrap_or(0);

        let mut final_status = status.clone();
        final_status.state = ServiceState::Running;
        final_status.pid = Some(pid);

        let managed = ManagedService {
            contribution: contribution.clone(),
            plugin_id: plugin_id.to_string(),
            status: final_status.clone(),
            child: Some(child),
            started_at: Some(Instant::now()),
            health_check_handle: None,
            restart_handle: None,
        };

        {
            let mut services = self.services.lock().map_err(|e| {
                AppError::ProcessError(format!("Failed to lock services: {}", e))
            })?;
            services.insert(service_key, managed);
        }

        // 启动健康检查
        if contribution.health_check.is_some() {
            self.start_health_check(plugin_id, &contribution.id);
        }

        Ok(final_status)
    }

    /// 停止单个服务
    pub async fn stop_service(&mut self, plugin_id: &str, service_id: &str) -> Result<ServiceStatus> {
        let service_key = format!("{}::{}", plugin_id, service_id);

        let mut managed = {
            let mut services = self.services.lock().map_err(|e| {
                AppError::ProcessError(format!("Failed to lock services: {}", e))
            })?;
            services.remove(&service_key)
        };

        if let Some(ref mut managed) = managed {
            // 取消健康检查
            if let Some(handle) = managed.health_check_handle.take() {
                handle.abort();
            }

            // 取消重启
            if let Some(handle) = managed.restart_handle.take() {
                handle.abort();
            }

            // 停止进程
            if let Some(ref mut child) = managed.child {
                managed.status.state = ServiceState::Stopping;
                let _ = child.kill().await;
            }

            managed.status.state = ServiceState::Stopped;

            // 释放端口
            if let Some(port) = managed.status.port {
                self.release_port(port);
            }
        }

        if let Some(managed) = managed {
            let final_status = managed.status.clone();

            // 重新插入以保持状态
            let mut services = self.services.lock().map_err(|e| {
                AppError::ProcessError(format!("Failed to lock services: {}", e))
            })?;
            services.insert(service_key, managed);

            Ok(final_status)
        } else {
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
    }

    /// 重启服务
    pub async fn restart_service(
        &mut self,
        plugin_id: &str,
        service_id: &str,
        plugin_install_path: &str,
    ) -> Result<ServiceStatus> {
        self.stop_service(plugin_id, service_id).await?;

        let contribution = {
            let services = self.services.lock().map_err(|e| {
                AppError::ProcessError(format!("Failed to lock services: {}", e))
            })?;
            services
                .get(&format!("{}::{}", plugin_id, service_id))
                .map(|m| m.contribution.clone())
        };

        if let Some(contribution) = contribution {
            self.start_service(plugin_id, &contribution, plugin_install_path)
                .await
        } else {
            Err(AppError::ProcessError(format!(
                "Service {} not found",
                service_id
            )))
        }
    }

    /// 获取服务状态
    pub fn get_service_status(&self, plugin_id: &str, service_id: &str) -> Result<Option<ServiceStatus>> {
        let services = self.services.lock().map_err(|e| {
            AppError::ProcessError(format!("Failed to lock services: {}", e))
        })?;

        let key = format!("{}::{}", plugin_id, service_id);
        Ok(services.get(&key).map(|m| {
            let mut status = m.status.clone();
            // 计算运行时间
            if let Some(started_at) = m.started_at {
                if status.state == ServiceState::Running {
                    status.uptime = Some(started_at.elapsed().as_secs());
                }
            }
            status
        }))
    }

    /// 获取指定插件的所有服务状态
    pub fn get_plugin_service_statuses(&self, plugin_id: &str) -> Result<Vec<ServiceStatus>> {
        let services = self.services.lock().map_err(|e| {
            AppError::ProcessError(format!("Failed to lock services: {}", e))
        })?;

        let prefix = format!("{}::", plugin_id);
        Ok(services
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .map(|(_, m)| {
                let mut status = m.status.clone();
                if let Some(started_at) = m.started_at {
                    if status.state == ServiceState::Running {
                        status.uptime = Some(started_at.elapsed().as_secs());
                    }
                }
                status
            })
            .collect())
    }

    /// 获取所有服务状态
    pub fn get_all_service_statuses(&self) -> Result<Vec<ServiceStatus>> {
        let services = self.services.lock().map_err(|e| {
            AppError::ProcessError(format!("Failed to lock services: {}", e))
        })?;

        Ok(services
            .values()
            .map(|m| {
                let mut status = m.status.clone();
                if let Some(started_at) = m.started_at {
                    if status.state == ServiceState::Running {
                        status.uptime = Some(started_at.elapsed().as_secs());
                    }
                }
                status
            })
            .collect())
    }

    /// 停止所有服务
    pub async fn stop_all(&mut self) -> Result<()> {
        let service_keys: Vec<String> = {
            let services = self.services.lock().map_err(|e| {
                AppError::ProcessError(format!("Failed to lock services: {}", e))
            })?;
            services.keys().cloned().collect()
        };

        for key in service_keys {
            let parts: Vec<&str> = key.splitn(2, "::").collect();
            if parts.len() == 2 {
                self.stop_service(parts[0], parts[1]).await?;
            }
        }

        Ok(())
    }

    // === 内部方法 ===

    fn allocate_port(&mut self) -> u16 {
        let mut ports = self.allocated_ports.lock().unwrap();
        while ports.contains(&self.port_counter) {
            self.port_counter += 1;
            if self.port_counter >= 60000 {
                self.port_counter = 10000;
            }
        }
        let port = self.port_counter;
        ports.push(port);
        self.port_counter += 1;
        if self.port_counter >= 60000 {
            self.port_counter = 10000;
        }
        port
    }

    fn release_port(&self, port: u16) {
        if let Ok(mut ports) = self.allocated_ports.lock() {
            ports.retain(|&p| p != port);
        }
    }

    fn build_args(
        &self,
        contribution: &PluginServiceManifestContribution,
        plugin_install_path: &str,
        port: u16,
    ) -> Vec<String> {
        contribution
            .args_template
            .iter()
            .map(|arg| {
                arg.replace("{{port}}", &port.to_string())
                    .replace("{{serviceId}}", &contribution.id)
                    .replace("{{pluginDir}}", plugin_install_path)
                    .replace("{{workspacePath}}", "{{workspacePath}}")
                    .replace("{{appConfigDir}}", "{{appConfigDir}}")
            })
            .collect()
    }

    fn start_health_check(&self, plugin_id: &str, service_id: &str) {
        let services = self.services.clone();
        let plugin_id_owned = plugin_id.to_string();
        let service_id_owned = service_id.to_string();
        let service_key = format!("{}::{}", plugin_id, service_id);
        let service_key_clone = service_key.clone();

        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;

                let services = services.lock().unwrap();
                if let Some(managed) = services.get(&service_key_clone) {
                    if managed.status.state != ServiceState::Running {
                        break;
                    }

                    // TODO: 实际的健康检查逻辑
                    // 这里应该发送 HTTP 请求或检查进程状态
                    tracing::debug!(
                        "Health check for service {} (plugin: {})",
                        service_id_owned,
                        plugin_id_owned
                    );
                } else {
                    break;
                }
            }
        });

        // 存储健康检查句柄
        if let Ok(mut services) = self.services.lock() {
            if let Some(managed) = services.get_mut(&service_key) {
                managed.health_check_handle = Some(handle);
            }
        }
    }

    fn schedule_restart(&mut self, plugin_id: &str, service_id: &str) {
        let service_key = format!("{}::{}", plugin_id, service_id);
        let service_key_clone = service_key.clone();
        let services = self.services.clone();
        let service_id_owned = service_id.to_string();

        let handle = tokio::spawn(async move {
            // 指数退避
            let delay = Duration::from_secs(5);

            tokio::time::sleep(delay).await;

            let mut services = services.lock().unwrap();
            if let Some(managed) = services.get_mut(&service_key_clone) {
                let max_restarts = managed.contribution.max_restarts;
                if managed.status.restart_count >= max_restarts {
                    tracing::warn!(
                        "Service {} exceeded max restarts ({})",
                        service_id_owned,
                        max_restarts
                    );
                    managed.status.state = ServiceState::Error;
                    managed.status.last_error =
                        Some(format!("Exceeded max restarts: {}", max_restarts));
                    return;
                }

                managed.status.restart_count += 1;
                // TODO: 重新启动进程
            }
        });

        // 存储重启句柄
        if let Ok(mut services) = self.services.lock() {
            if let Some(managed) = services.get_mut(&service_key) {
                managed.restart_handle = Some(handle);
            }
        }
    }
}

impl Default for PluginServiceManager {
    fn default() -> Self {
        Self::new()
    }
}
