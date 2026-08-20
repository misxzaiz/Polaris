/*! 会话管理
 *
 * 管理引擎的活动会话，追踪进程 PID 以支持中断等操作。
 * 支持临时 session_id 到真实 session_id 的别名映射。
 * 支持通过 channel 向进程 stdin 发送输入。
 */

use std::collections::HashMap;
use std::sync::{Arc, Mutex, mpsc::Sender};
use crate::error::{AppError, Result};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// 会话信息
#[allow(dead_code)]
#[derive(Debug)]
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
    /// stdin 输入发送器（用于向进程发送输入）
    pub input_sender: Option<Sender<String>>,
}

impl Clone for SessionInfo {
    fn clone(&self) -> Self {
        Self {
            id: self.id.clone(),
            pid: self.pid,
            engine_id: self.engine_id.clone(),
            created_at: self.created_at,
            aliases: self.aliases.clone(),
            // Sender 无法 clone，但可以多次 send
            // 这里使用 Option 来处理没有 sender 的情况
            input_sender: self.input_sender.clone(),
        }
    }
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

    /// 注册会话（无 stdin 发送器）
    pub fn register(&self, session_id: String, pid: u32, engine_id: String) -> Result<()> {
        self.register_with_sender(session_id, pid, engine_id, None)
    }

    /// 注册会话（带 stdin 发送器）
    pub fn register_with_sender(
        &self,
        session_id: String,
        pid: u32,
        engine_id: String,
        input_sender: Option<Sender<String>>,
    ) -> Result<()> {
        let info = SessionInfo {
            id: session_id.clone(),
            pid,
            engine_id,
            created_at: chrono::Utc::now().timestamp(),
            aliases: Vec::new(),
            input_sender,
        };

        let mut sessions = self.sessions.lock()
            .map_err(|e| AppError::Unknown(format!("锁获取失败: {}", e)))?;
        sessions.insert(session_id, info);

        Ok(())
    }

    /// 向会话发送输入
    ///
    /// 返回值：
    /// - Ok(true): 发送成功
    /// - Ok(false): 会话不存在或没有 stdin 发送器
    pub fn send_input(&self, session_id: &str, input: &str) -> Result<bool> {
        let sessions = self.sessions.lock()
            .map_err(|e| AppError::Unknown(format!("锁获取失败: {}", e)))?;

        if let Some(info) = sessions.get(session_id) {
            if let Some(ref sender) = info.input_sender {
                sender.send(input.to_string())
                    .map_err(|e| AppError::ProcessError(format!("发送输入失败: {}", e)))?;
                tracing::info!("[SessionManager] 已向会话 {} 发送输入", session_id);
                return Ok(true);
            }
            tracing::warn!("[SessionManager] 会话 {} 没有 stdin 发送器", session_id);
            return Ok(false);
        }

        tracing::warn!("[SessionManager] 会话 {} 不存在", session_id);
        Ok(false)
    }

    /// 更新会话 ID（当引擎返回真实 session_id 时）（预留功能）
    ///
    /// 保留旧 ID 作为别名，这样用临时 ID 也能找到会话
    #[allow(dead_code)]
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

    /// 获取会话 PID（预留功能）
    #[allow(dead_code)]
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
        input_sender: Option<Sender<String>>,
    ) {
        if let Ok(mut s) = sessions.lock() {
            // 创建新的 SessionInfo，将 old_id 作为别名
            let aliases = vec![old_id.to_string()];

            let info = SessionInfo {
                id: new_id.to_string(),
                pid,
                engine_id: engine_id.to_string(),
                created_at: chrono::Utc::now().timestamp(),
                aliases,
                input_sender,
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
    /// - Ok(true): 会话存在,且 kill 命令执行成功(进程已终止或已不存在)
    /// - Ok(false): 会话不存在,或 kill 命令明确失败需上层兜底
    ///
    /// 重要变更:
    /// 1. Windows 下使用 `taskkill /T /F`(杀进程树),解决 Standalone CLI 启动器
    ///    场景下父进程被杀但 Node/工作子进程仍在运行的问题.
    /// 2. taskkill 失败不再吞错并谎报成功;改为 warn 级日志 + 返回 false,
    ///    让 EngineRegistry / interrupt_chat_inner 的兜底链路能感知并继续尝试.
    /// 3. 所有分支(包括 session 缺失)都有 info/warn 级日志,便于线上诊断.
    pub fn kill_process(&self, session_id: &str) -> Result<bool> {
        let info = self.get(session_id);

        let Some(info) = info else {
            tracing::info!(
                "[SessionManager] kill_process: session {} 不在 map 中(返回 false 由上层兜底)",
                session_id
            );
            return Ok(false);
        };

        let pid = info.pid;
        tracing::info!(
            "[SessionManager] kill_process: 准备终止 session {} (PID={})",
            session_id,
            pid
        );

        #[cfg(windows)]
        {
            // /T = 终止指定进程及其子进程(进程树);/F = 强制终止
            // 解决: Claude CLI 部分发行版(Standalone/Node SEA)实际由父启动器
            // spawn 出工作子进程,不带 /T 时父进程被 kill 后子进程仍在运行,
            // 表现为"看似中断但 AI 继续输出".
            let output = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();

            let kill_succeeded = match output {
                Ok(o) if o.status.success() => {
                    tracing::info!(
                        "[SessionManager] taskkill 成功终止进程树 PID={}",
                        pid
                    );
                    true
                }
                Ok(o) => {
                    // 非零退出:常见原因是进程已经退出(code 128),少数情况是权限不足.
                    // 改为 warn 级别,确保问题能被看到.
                    let stderr = String::from_utf8_lossy(&o.stderr);
                    let stdout = String::from_utf8_lossy(&o.stdout);
                    tracing::warn!(
                        "[SessionManager] taskkill 非零退出 PID={} code={:?} stdout={:?} stderr={:?}",
                        pid,
                        o.status.code(),
                        stdout.trim(),
                        stderr.trim()
                    );
                    // 进程可能已经结束(常见于 session_end 后再点中断);仍视为已处理.
                    // 但如果是权限错误,会被上面的 warn 暴露,后续可以加更细的判断.
                    true
                }
                Err(e) => {
                    tracing::warn!(
                        "[SessionManager] taskkill 命令本身执行失败 PID={} err={}",
                        pid,
                        e
                    );
                    false
                }
            };

            if kill_succeeded {
                self.remove(session_id);
                tracing::info!(
                    "[SessionManager] session {} 已从 map 移除",
                    session_id
                );
                return Ok(true);
            }
            // taskkill 命令本身失败 -> 不撒谎,让上层兜底重试
            return Ok(false);
        }

        #[cfg(not(windows))]
        {
            use std::process::Command;
            // Unix: 默认 SIGTERM,如不响应再 SIGKILL.
            // 进程组场景由调用方处理(此处假设单进程).
            let output = Command::new("kill").arg("-9").arg(pid.to_string()).output();

            let kill_succeeded = match output {
                Ok(o) if o.status.success() => {
                    tracing::info!("[SessionManager] kill 成功 PID={}", pid);
                    true
                }
                Ok(o) => {
                    let stderr = String::from_utf8_lossy(&o.stderr);
                    tracing::warn!(
                        "[SessionManager] kill 非零退出 PID={} code={:?} stderr={:?}",
                        pid,
                        o.status.code(),
                        stderr.trim()
                    );
                    // 进程可能已经结束,仍视为已处理.
                    true
                }
                Err(e) => {
                    tracing::warn!(
                        "[SessionManager] kill 命令本身执行失败 PID={} err={}",
                        pid,
                        e
                    );
                    false
                }
            };

            if kill_succeeded {
                self.remove(session_id);
                tracing::info!(
                    "[SessionManager] session {} 已从 map 移除",
                    session_id
                );
                return Ok(true);
            }
            Ok(false)
        }
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}
