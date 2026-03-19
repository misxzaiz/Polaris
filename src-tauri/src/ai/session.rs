/*! 会话管理
 *
 * 管理引擎的活动会话，追踪进程 PID 以支持中断等操作。
 * 支持临时 session_id 到真实 session_id 的别名映射。
 */

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use crate::error::{AppError, Result};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 进程创建标志：不创建新窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 会话信息
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct SessionInfo {
    /// 会话 ID（真实 ID）
    pub id: String,
    /// 进程 PID
    pub pid: u32,
    /// 引擎 ID
    pub engine_id: String,
    /// 创建时间
    pub created_at: i64,
    /// 别名列表（临时 ID -> 真实 ID 的映射）
    pub aliases: Vec<String>,
}

/// 会话管理器
pub struct SessionManager {
    /// 会话映射: session_id -> SessionInfo
    sessions: Arc<Mutex<HashMap<String, SessionInfo>>>,
}

impl SessionManager {
    /// 创建新的会话管理器
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 注册会话
    pub fn register(&self, session_id: String, pid: u32, engine_id: String) -> Result<()> {
        let info = SessionInfo {
            id: session_id.clone(),
            pid,
            engine_id,
            created_at: chrono::Utc::now().timestamp(),
            aliases: Vec::new(),
        };

        let mut sessions = self.sessions.lock()
            .map_err(|e| AppError::Unknown(format!("锁获取失败: {}", e)))?;
        sessions.insert(session_id, info);

        Ok(())
    }

    /// 更新会话 ID（当引擎返回真实 session_id 时）
    ///
    /// 保留旧 ID 作为别名，这样用临时 ID 也能找到会话
    pub fn update_session_id(&self, old_id: &str, new_id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock()
            .map_err(|e| AppError::Unknown(format!("锁获取失败: {}", e)))?;

        if let Some(mut info) = sessions.remove(old_id) {
            // 将旧 ID 添加到别名列表
            if !info.aliases.contains(&old_id.to_string()) {
                info.aliases.push(old_id.to_string());
            }

            // 更新为新的真实 ID
            info.id = new_id.to_string();

            // 插入新 ID 映射
            sessions.insert(new_id.to_string(), info.clone());

            // 同时为所有别名创建指向同一 SessionInfo 的引用
            for alias in &info.aliases {
                sessions.insert(alias.clone(), info.clone());
            }
        }

        Ok(())
    }

    /// 获取会话信息
    pub fn get(&self, session_id: &str) -> Option<SessionInfo> {
        let sessions = self.sessions.lock().ok()?;
        sessions.get(session_id).cloned()
    }

    /// 获取会话 PID
    pub fn get_pid(&self, session_id: &str) -> Option<u32> {
        let sessions = self.sessions.lock().ok()?;
        sessions.get(session_id).map(|info| info.pid)
    }

    /// 移除会话（同时移除所有别名）
    pub fn remove(&self, session_id: &str) -> Option<SessionInfo> {
        let mut sessions = self.sessions.lock().ok()?;

        // 先获取会话信息，以获取所有别名
        let info = sessions.get(session_id).cloned()?;

        // 移除真实 ID
        sessions.remove(&info.id);

        // 移除所有别名
        for alias in &info.aliases {
            sessions.remove(alias);
        }

        Some(info)
    }

    /// 获取活动会话数量（按真实 ID 计数）
    pub fn count(&self) -> usize {
        let sessions = self.sessions.lock().ok();
        sessions.map(|s| {
            s.values()
                .filter(|info| info.id == *s.keys().find(|k| s.get(*k).map(|i| i.id == **k).unwrap_or(false)).unwrap_or(&String::new()))
                .count()
        }).unwrap_or(0)
    }

    /// 获取会话管理器的共享引用
    pub fn shared(&self) -> Arc<Mutex<HashMap<String, SessionInfo>>> {
        Arc::clone(&self.sessions)
    }

    /// 通过共享引用更新 session_id（用于后台线程）
    ///
    /// 保留旧 ID 作为别名，这样用临时 ID 也能找到会话
    pub fn update_session_id_shared(
        sessions: &Arc<Mutex<HashMap<String, SessionInfo>>>,
        old_id: &str,
        new_id: &str,
        pid: u32,
        engine_id: &str,
    ) {
        if let Ok(mut s) = sessions.lock() {
            // 创建新的 SessionInfo，将 old_id 作为别名
            let mut aliases = Vec::new();
            aliases.push(old_id.to_string());

            let info = SessionInfo {
                id: new_id.to_string(),
                pid,
                engine_id: engine_id.to_string(),
                created_at: chrono::Utc::now().timestamp(),
                aliases: aliases.clone(),
            };

            // 插入新 ID 映射
            s.insert(new_id.to_string(), info.clone());

            // 为旧 ID（临时 ID）也创建映射
            s.insert(old_id.to_string(), info);
        }
    }

    /// 终止进程
    ///
    /// 返回值：
    /// - Ok(true): 会话存在，已处理（kill 成功或进程已结束）
    /// - Ok(false): 会话不存在
    pub fn kill_process(&self, session_id: &str) -> Result<bool> {
        // 获取会话信息
        let info = self.get(session_id);

        if let Some(info) = info {
            let pid = info.pid;

            #[cfg(windows)]
            {
                let output = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();

                match output {
                    Ok(o) if o.status.success() => {
                        tracing::info!("[SessionManager] 进程 {} 已终止", pid);
                    }
                    Ok(o) => {
                        // taskkill 失败通常意味着进程已结束
                        let stderr = String::from_utf8_lossy(&o.stderr);
                        tracing::debug!("[SessionManager] taskkill 失败 (进程可能已结束): {}", stderr);
                    }
                    Err(e) => {
                        tracing::warn!("[SessionManager] taskkill 执行失败: {}", e);
                    }
                }

                // 无论 taskkill 是否成功，都移除会话并返回 true
                // 因为进程可能已经结束了
                self.remove(session_id);
                return Ok(true);
            }

            #[cfg(not(windows))]
            {
                use std::process::Command;
                let output = Command::new("kill")
                    .arg(pid.to_string())
                    .output();

                match output {
                    Ok(o) if o.status.success() => {
                        tracing::info!("[SessionManager] 进程 {} 已终止", pid);
                    }
                    _ => {
                        tracing::debug!("[SessionManager] kill 失败 (进程可能已结束)");
                    }
                }

                self.remove(session_id);
                return Ok(true);
            }
        }

        // 会话不存在
        Ok(false)
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}
