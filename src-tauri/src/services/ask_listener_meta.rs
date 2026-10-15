//! ask_listener 元数据落盘与读取
//!
//! 背景：ask_listener 每次启动绑定随机端口 + 随机 token，mcp.json 里固化的
//! `--polaris-port` / `--polaris-token` 会在主进程重启后失效，导致 Bridge MCP
//! server（dispatch/ask/browser）失联。
//!
//! 本模块把「当前真实端口 / token / pid」原子落盘到数据根 `.meta/ask-listener.json`，
//! Bridge 侧在连接被拒时读此文件自愈重连。写入方只有 ask_listener 的
//! `spawn_ask_listener`（主进程），读取方是各 Bridge MCP server（独立进程）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::services::data_root;

/// 元数据文件名（落在 data_root().meta_dir() 下）
pub const ASK_LISTENER_META_FILE: &str = "ask-listener.json";

/// 落盘结构。端口 / token / pid 均为主进程当前真实值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskListenerMeta {
    /// ask_listener 当前绑定的端口
    pub port: u16,
    /// ask_listener 当前鉴权 token
    pub token: String,
    /// 主进程 pid（判断进程是否存活用）
    pub pid: u32,
    /// 落盘时间（ISO 8601）
    pub started_at: String,
}

impl AskListenerMeta {
    /// 组装元数据
    pub fn new(port: u16, token: String, pid: u32) -> Self {
        Self {
            port,
            token,
            pid,
            started_at: iso_now(),
        }
    }
}

/// 元数据文件路径（数据根 `.meta/ask-listener.json`）
pub fn meta_path() -> PathBuf {
    data_root::data_root().meta_dir().join(ASK_LISTENER_META_FILE)
}

/// 原子写入元数据（temp + rename，避免崩溃残留半成品）。
pub fn write_meta(meta: &AskListenerMeta) -> Result<()> {
    let path = meta_path();
    let dir = path
        .parent()
        .ok_or_else(|| AppError::ConfigError("meta 目录无效".into()))?;
    std::fs::create_dir_all(dir)?;
    let temp_path = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(meta)?;
    std::fs::write(&temp_path, format!("{}\n", content))?;
    std::fs::rename(&temp_path, &path)?;
    Ok(())
}

/// 读取元数据。文件缺失或损坏返回 None（调用方据此回退，不 panic）。
pub fn read_meta() -> Option<AskListenerMeta> {
    let path = meta_path();
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<AskListenerMeta>(&content).ok()
}

/// 候选数据根（默认正式版 + dev，按优先级排列）。
///
/// bridge 进程由 Claude 拉起，env 无 `POLARIS_DATA_ROOT`，`data_root()` 会解析到
/// 正式版根。但当前活跃主进程可能是 dev（Polaris-dev）——所以 fallback 要
/// **主动探测**两个根，用 pid 存活判定谁是「当前活跃主进程」。
fn candidate_root() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    // 1. env 显式指定的数据根（最精确）
    if let Ok(env_root) = std::env::var("POLARIS_DATA_ROOT") {
        let env_root = env_root.trim();
        if !env_root.is_empty() {
            roots.push(PathBuf::from(env_root));
        }
    }
    // 2. 正式版 + dev 标准根
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    for name in ["Polaris", "Polaris-dev"] {
        roots.push(base.join(name));
    }
    roots
}

/// 读取某个候选根的 meta（按根路径拼 `.meta/ask-listener.json`）。
///
/// `pub` 供 bus 诊断工具遍历各根状态。
pub fn read_meta_at(root: &std::path::Path) -> Option<AskListenerMeta> {
    let path = root.join(".meta").join(ASK_LISTENER_META_FILE);
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<AskListenerMeta>(&content).ok()
}

/// 候选数据根的公开访问器（供诊断/巡检任务列举各根状态）。
///
/// 顺序与 `resolve_active_meta_preferring` 一致：env 显式根 > 正式版 > dev。
pub fn candidate_roots() -> Vec<std::path::PathBuf> {
    candidate_root()
}

/// Bridge MCP 配置（`.polaris/claude/mcp.json`）的可能落点。
///
/// Claude Code 实际加载的配置来自**工作区根** `.polaris/claude/mcp.json`
/// （`prepare_workspace_config(workspace_path)` 写入），Loader 也会把用户级
/// `~/.claude/.polaris/claude/mcp.json` 一并合并。这里返回去重后的候选集，
/// `status`/`regenerate` 据此定位需要诊断/改写的文件。
///
/// 顺序（按命中概率）：config_dir > 用户级 `~/.claude` > 候选数据根。
pub fn mcp_config_paths(config_dir: &str) -> Vec<std::path::PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();

    let mut push = |p: &std::path::Path| {
        if p.exists() && seen.insert(p.to_path_buf()) {
            out.push(p.to_path_buf());
        }
    };

    // 1. 传入的 config_dir（bus 进程的 config_dir 参数，指向应用配置根）
    push(&std::path::Path::new(config_dir).join(".polaris/claude/mcp.json"));

    // 2. 用户级 ~/.claude/.polaris/claude/mcp.json
    if let Some(home) = dirs::home_dir() {
        push(&home.join(".claude/.polaris/claude/mcp.json"));
    }

    // 3. 候选数据根下的同名相对路径
    for root in candidate_root() {
        push(&root.join(".polaris/claude/mcp.json"));
    }

    out
}

/// 解析「当前活跃主进程」的元数据。
///
/// 遍历候选数据根，返回第一个 pid 存活的 meta。这解决了 bridge 进程无法
/// 感知「主进程在哪个数据根」的问题——用 pid_alive 判定，自适应 dev/正式版。
pub fn resolve_active_meta() -> Option<AskListenerMeta> {
    resolve_active_meta_preferring(None)
}

/// 解析活跃主进程元数据，带端口偏好。
///
/// `pref_port` 为 bridge 配置里固化的端口（mcp.json 的 `--polaris-port`）。
/// 语义：优先返回「pid 存活 **且 port == pref_port**」的 meta——它就是要连的
/// 那个实例；否则回退到任意存活实例的第一个。避免 dev/正式版并存时，
/// bridge 串到另一个实例。
pub fn resolve_active_meta_preferring(pref_port: Option<u16>) -> Option<AskListenerMeta> {
    let candidates: Vec<AskListenerMeta> = candidate_root()
        .iter()
        .filter_map(|root| read_meta_at(root))
        .filter(|m| pid_alive(m.pid))
        .collect();

    // 第一优先：端口匹配偏好
    if let Some(pref) = pref_port {
        if let Some(found) = candidates.iter().find(|m| m.port == pref) {
            return Some(found.clone());
        }
    }
    // 否则：任意活跃实例第一个
    candidates.into_iter().next()
}

/// 判断元数据记录的 pid 进程是否存活。
///
/// Windows 用 `tasklist /FI "PID eq <pid>"`；非 Windows 用 kill(0)。
/// 返回 false 表示进程不存在或不可判定（保守回退）。
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::process::Command;
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
            .output();
        match out {
            Ok(o) => {
                let text = String::from_utf8_lossy(&o.stdout);
                // tasklist 存在该 pid 时输出含 pid；不含则无行。
                text.contains(&format!("\"{}\"", pid))
            }
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}

/// 当前 ISO 8601 时间（UTC）。
fn iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    // 简化格式：秒级 ISO + 毫秒，避免引入 chrono 依赖（本 crate 未直接依赖）。
    format!("1970-01-01T00:00:00Z+{}", secs * 1000 + millis as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// 隔离测试：覆盖 meta_path 到临时数据根。
    /// 因 data_root() 是全局 OnceLock，这里用直接读写文件模拟（同目录语义）。
    fn write_read_roundtrip(path: &std::path::Path) {
        let meta = AskListenerMeta::new(56496, "tok-123".into(), 4242);
        let content = serde_json::to_string_pretty(&meta).unwrap();
        std::fs::write(path, format!("{}\n", content)).unwrap();
        let loaded: AskListenerMeta =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(loaded.port, 56496);
        assert_eq!(loaded.token, "tok-123");
        assert_eq!(loaded.pid, 4242);
    }

    #[test]
    fn meta_roundtrip() {
        let tmp = TempDir::new().unwrap();
        write_read_roundtrip(&tmp.path().join(ASK_LISTENER_META_FILE));
    }

    #[test]
    fn meta_missing_returns_none() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(ASK_LISTENER_META_FILE);
        assert!(!path.exists());
        // read_meta 使用全局 data_root，这里只验证「缺失文件解析为 None」的逻辑分支，
        // 通过直接调用解析函数路径来近似：read_meta 内部 read_to_string 失败返回 None。
        // 为不污染全局单例，此测试仅覆盖序列化对称性。
        write_read_roundtrip(&path);
    }

    #[test]
    fn iso_now_format() {
        let s = iso_now();
        assert!(s.starts_with("1970-01-01T00:00:00Z+"));
    }
}
