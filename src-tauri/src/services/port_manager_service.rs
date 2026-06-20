//! 端口管理服务
//!
//! 提供端口检测、进程查询、进程终止等能力。
//! Windows 上通过 netstat + tasklist 实现，无需额外依赖。

use std::collections::HashMap;
use std::process::Command;

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};

/// 监听端口信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    /// 端口号
    pub port: u16,
    /// 协议 (tcp / tcp6)
    pub protocol: String,
    /// 监听地址 (0.0.0.0 / 127.0.0.1 等)
    pub address: String,
    /// 进程 ID
    pub pid: u32,
    /// 进程名称
    pub process_name: String,
    /// 进程命令行（可选）
    pub command_line: Option<String>,
}

/// 端口释放结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KillResult {
    /// 目标端口
    pub port: u16,
    /// 被终止的进程 PID
    pub pid: u32,
    /// 进程名称
    pub process_name: String,
    /// 是否成功
    pub success: bool,
    /// 错误信息（失败时）
    pub error: Option<String>,
}

/// 常用开发端口列表
const COMMON_DEV_PORTS: &[u16] = &[
    3000, 3001, 5173, 5174, 8080, 8081, 8443, 4200, 4201,
    3306, 5432, 6379, 27017, 9200, 9300, 1433, 1521,
    8000, 8888, 9000, 9090, 2181, 9092, 5672, 15672,
];

/// 判断是否为常用开发端口
pub fn is_common_dev_port(port: u16) -> bool {
    COMMON_DEV_PORTS.contains(&port)
}

/// 获取常用端口的友好名称
pub fn common_port_name(port: u16) -> Option<&'static str> {
    match port {
        3000 | 3001 => Some("React/Next.js Dev"),
        5173 | 5174 => Some("Vite Dev"),
        8080 | 8081 => Some("HTTP Proxy"),
        8443 => Some("HTTPS Alt"),
        4200 | 4201 => Some("Angular Dev"),
        3306 => Some("MySQL"),
        5432 => Some("PostgreSQL"),
        6379 => Some("Redis"),
        27017 => Some("MongoDB"),
        9200 | 9300 => Some("Elasticsearch"),
        1433 => Some("SQL Server"),
        1521 => Some("Oracle DB"),
        8000 | 8888 => Some("HTTP Alt"),
        9000 => Some("SonarQube/PHP-FPM"),
        9090 => Some("Prometheus"),
        2181 => Some("ZooKeeper"),
        9092 => Some("Kafka"),
        5672 | 15672 => Some("RabbitMQ"),
        _ => None,
    }
}

/// 列出所有监听中的 TCP 端口
///
/// 通过解析 `netstat -ano -p tcp` 输出实现。
pub fn list_listening_ports() -> Result<Vec<PortInfo>> {
    let output = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
        .map_err(|e| AppError::ProcessError(format!("执行 netstat 失败: {}", e)))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        return Err(AppError::ProcessError(format!(
            "netstat 执行失败: {}",
            stderr.trim()
        )));
    }

    // 收集所有 PID，批量查询进程名
    let mut entries: Vec<PortInfo> = Vec::new();
    let mut pids: Vec<u32> = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("协议") || line.starts_with("Proto") {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }

        let protocol = parts[0].to_string();
        let local_addr = parts[1];
        let state = parts[3];
        let pid_str = parts[4];

        // 只要 LISTENING 状态
        if state != "LISTENING" {
            continue;
        }

        // 解析端口号: "0.0.0.0:3000" → 3000
        let port = match local_addr.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) {
            Some(p) => p,
            None => continue,
        };

        let address = local_addr.rsplit(':').last().unwrap_or("").to_string();
        let address = local_addr[..local_addr.len() - address.len() - 1].to_string();

        let pid = match pid_str.parse::<u32>() {
            Ok(p) => p,
            Err(_) => continue,
        };

        pids.push(pid);
        entries.push(PortInfo {
            port,
            protocol,
            address,
            pid,
            process_name: String::new(), // 稍后填充
            command_line: None,
        });
    }

    // 批量查询进程名
    let pid_names = get_process_names(&pids);
    for entry in &mut entries {
        if let Some(name) = pid_names.get(&entry.pid) {
            entry.process_name = name.clone();
        } else {
            entry.process_name = format!("PID:{}", entry.pid);
        }
    }

    // 按端口号排序
    entries.sort_by_key(|e| e.port);

    Ok(entries)
}

/// 查找指定端口的占用信息
pub fn find_port_owner(port: u16) -> Result<Option<PortInfo>> {
    let all_ports = list_listening_ports()?;
    Ok(all_ports.into_iter().find(|p| p.port == port))
}

/// 检查端口是否可用
pub fn is_port_available(port: u16) -> Result<bool> {
    let owner = find_port_owner(port)?;
    Ok(owner.is_none())
}

/// 终止占用指定端口的进程
pub fn kill_process_by_port(port: u16) -> Result<KillResult> {
    let owner = find_port_owner(port)?
        .ok_or_else(|| AppError::ValidationError(format!("端口 {} 未被占用", port)))?;

    let pid = owner.pid;
    let process_name = owner.process_name.clone();

    // 尝试终止进程
    let output = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .output();

    match output {
        Ok(result) if result.status.success() => Ok(KillResult {
            port,
            pid,
            process_name,
            success: true,
            error: None,
        }),
        Ok(result) => {
            let stderr = String::from_utf8_lossy(&result.stderr);
            Ok(KillResult {
                port,
                pid,
                process_name,
                success: false,
                error: Some(format!("终止失败: {}", stderr.trim())),
            })
        }
        Err(e) => Ok(KillResult {
            port,
            pid,
            process_name,
            success: false,
            error: Some(format!("执行 taskkill 失败: {}", e)),
        }),
    }
}

/// 批量查询进程名称（通过 tasklist）
fn get_process_names(pids: &[u32]) -> HashMap<u32, String> {
    if pids.is_empty() {
        return HashMap::new();
    }

    let output = match Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return HashMap::new(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut map = HashMap::new();

    for line in stdout.lines() {
        // CSV 格式: "进程名","PID","会话名","会话#","内存使用"
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 2 {
            continue;
        }

        let name = parts[0].trim_matches('"');
        let pid_str = parts[1].trim_matches('"');

        if let Ok(pid) = pid_str.parse::<u32>() {
            if pids.contains(&pid) {
                map.insert(pid, name.to_string());
            }
        }
    }

    map
}

/// 获取端口统计摘要
pub fn get_port_summary() -> Result<PortSummary> {
    let ports = list_listening_ports()?;

    let total = ports.len() as u32;
    let common_count = ports.iter().filter(|p| is_common_dev_port(p.port)).count() as u32;

    let mut by_process: HashMap<String, u32> = HashMap::new();
    for port in &ports {
        *by_process.entry(port.process_name.clone()).or_insert(0) += 1;
    }

    let mut top_processes: Vec<(String, u32)> = by_process.into_iter().collect();
    top_processes.sort_by(|a, b| b.1.cmp(&a.1));
    top_processes.truncate(10);

    Ok(PortSummary {
        total_listening: total,
        common_dev_ports_used: common_count,
        top_processes,
    })
}

/// 端口统计摘要
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortSummary {
    pub total_listening: u32,
    pub common_dev_ports_used: u32,
    pub top_processes: Vec<(String, u32)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_common_dev_port() {
        assert!(is_common_dev_port(3000));
        assert!(is_common_dev_port(5432));
        assert!(!is_common_dev_port(12345));
    }

    #[test]
    fn test_common_port_name() {
        assert_eq!(common_port_name(3000), Some("React/Next.js Dev"));
        assert_eq!(common_port_name(5432), Some("PostgreSQL"));
        assert_eq!(common_port_name(12345), None);
    }
}
