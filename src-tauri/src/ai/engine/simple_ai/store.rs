/*! Simple AI 会话持久化
 *
 * SimpleAI 引擎的会话表（`sessions: HashMap<String, SimpleAISession>`）原本是
 * 纯内存结构：进程（桌面/Web 后端）重启后所有历史会话丢失。前端历史恢复时
 * 用引擎返回的 sessionId（`simple-ai-xxx`）作为 conversationId 继续发送
 * `continue`，后端却找不到会话 → `SessionNotFound` → 前端「立刻中断」。
 *
 * 本模块解决该问题：把会话（消息历史 + 工作目录）落盘到
 * `<DataRoot>/simple-ai/sessions/<session_id>.json`，引擎启动时扫描恢复，
 * 使 Web 后端重启后历史会话仍可无缝 continue。
 *
 * 与 compact.rs 的 context-checkpoints 的区别：
 * - 本模块存的是**会话当前完整历史**（进程重启恢复用），随每轮结束更新；
 * - compact.rs 存的是**压缩前的归档快照**（回查/对比用），不可用于恢复。
 */

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 会话存档目录名（位于 DataRoot 下）
const SESSIONS_DIR_NAME: &str = "simple-ai/sessions";

/// 会话存档文件（单文件 JSON，非 JSONL——会话历史是整存整取）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SessionRecord {
    /// 引擎会话 ID（`simple-ai-<ts>-<counter>`，同时作为前端 conversationId）
    pub(crate) session_id: String,
    /// 工作目录
    pub(crate) work_dir: String,
    /// 消息历史（OpenAI Chat Completions 格式，含 system 首条）
    pub(crate) messages: Vec<Value>,
    /// 最后更新时间（epoch ms，供未来 LRU 清理）
    pub(crate) updated_at_ms: u64,
}

impl SessionRecord {
    /// 由引擎内存会话构造（`is_running` / watch channel 不落盘，恢复后为 idle）。
    pub(crate) fn from_memory(session_id: &str, work_dir: &str, messages: &[Value]) -> Self {
        Self {
            session_id: session_id.to_string(),
            work_dir: work_dir.to_string(),
            messages: messages.to_vec(),
            updated_at_ms: now_ms(),
        }
    }
}

/// 会话存档根目录：`<DataRoot>/simple-ai/sessions`
pub(crate) fn sessions_root(data_root: &PathBuf) -> PathBuf {
    data_root.join(SESSIONS_DIR_NAME)
}

/// 单个会话存档文件路径
fn session_file_path(data_root: &PathBuf, session_id: &str) -> PathBuf {
    sessions_root(data_root).join(format!("{}.json", sanitize_filename(session_id)))
}

/// 将 session_id 中的非法文件名字符替换为下划线（与 compact.rs 的 sanitize 一致）。
fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// 保存一个会话到磁盘（覆盖写）。失败仅记 warn，不阻塞主流程。
pub(crate) fn save_session(data_root: &PathBuf, record: &SessionRecord) {
    let dir = sessions_root(data_root);
    if let Err(e) = fs::create_dir_all(&dir) {
        tracing::warn!("[SimpleAI] 创建会话存档目录失败: {}: {}", dir.display(), e);
        return;
    }
    let path = session_file_path(data_root, &record.session_id);
    match serde_json::to_string_pretty(record) {
        Ok(json) => match fs::write(&path, json) {
            Ok(_) => tracing::debug!(
                "[SimpleAI] 会话已存档: {} ({} 条消息)",
                path.display(),
                record.messages.len()
            ),
            Err(e) => tracing::warn!("[SimpleAI] 写入会话存档失败: {}: {}", path.display(), e),
        },
        Err(e) => tracing::warn!("[SimpleAI] 序列化会话存档失败: {}", e),
    }
}

/// 删除一个会话存档（会话被删除/清理时调用）。文件不存在视为成功。
pub(crate) fn delete_session(data_root: &PathBuf, session_id: &str) {
    let path = session_file_path(data_root, session_id);
    match fs::remove_file(&path) {
        Ok(_) => tracing::info!("[SimpleAI] 会话存档已删除: {}", path.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("[SimpleAI] 删除会话存档失败: {}: {}", path.display(), e),
    }
}

/// 扫描存档目录，恢复全部会话（引擎启动时调用）。
///
/// 返回 (session_id → (work_dir, messages)) 映射；损坏/不可读的单个存档
/// 记 warn 跳过，不阻断整体恢复。
pub(crate) fn load_all_sessions(
    data_root: &PathBuf,
) -> Vec<(String, String, Vec<Value>)> {
    let dir = sessions_root(data_root);
    let mut result = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        // 目录不存在 = 从无存档（首次运行），静默返回
        return result;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(file_stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        match fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<SessionRecord>(&content) {
                Ok(record) => {
                    // 防呆：存档内 session_id 与文件名不一致时以文件名为准
                    let sid = if record.session_id.is_empty() {
                        file_stem.to_string()
                    } else {
                        record.session_id.clone()
                    };
                    tracing::info!(
                        "[SimpleAI] 恢复会话存档: {} ({} 条消息)",
                        sid,
                        record.messages.len()
                    );
                    result.push((sid, record.work_dir, record.messages));
                }
                Err(e) => tracing::warn!(
                    "[SimpleAI] 会话存档解析失败，跳过: {}: {}",
                    path.display(),
                    e
                ),
            },
            Err(e) => tracing::warn!(
                "[SimpleAI] 读取会话存档失败，跳过: {}: {}",
                path.display(),
                e
            ),
        }
    }
    result
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn tmp_root() -> (TempDir, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        (tmp, root)
    }

    #[test]
    fn save_and_load_roundtrip() {
        let (_tmp, root) = tmp_root();
        let record = SessionRecord {
            session_id: "simple-ai-1700000000000-0".into(),
            work_dir: "C:/work".into(),
            messages: vec![
                json!({ "role": "system", "content": "sys" }),
                json!({ "role": "user", "content": "hi" }),
            ],
            updated_at_ms: 123,
        };
        save_session(&root, &record);

        let loaded = load_all_sessions(&root);
        assert_eq!(loaded.len(), 1);
        let (sid, work_dir, messages) = &loaded[0];
        assert_eq!(sid, "simple-ai-1700000000000-0");
        assert_eq!(work_dir, "C:/work");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], json!("system"));
    }

    #[test]
    fn load_empty_when_no_dir() {
        let (_tmp, root) = tmp_root();
        // 目录不存在：静默返回空
        let loaded = load_all_sessions(&root);
        assert!(loaded.is_empty());
    }

    #[test]
    fn corrupt_file_is_skipped() {
        let (_tmp, root) = tmp_root();
        let dir = sessions_root(&root);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("broken.json"), "not json{{{").unwrap();
        fs::write(dir.join("valid.json"), serde_json::to_string(&SessionRecord {
            session_id: "simple-ai-1-1".into(),
            work_dir: ".".into(),
            messages: vec![json!({ "role": "user", "content": "ok" })],
            updated_at_ms: 0,
        }).unwrap()).unwrap();

        let loaded = load_all_sessions(&root);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].0, "simple-ai-1-1");
    }

    #[test]
    fn delete_removes_file() {
        let (_tmp, root) = tmp_root();
        let record = SessionRecord {
            session_id: "simple-ai-9-9".into(),
            work_dir: ".".into(),
            messages: vec![json!({ "role": "user", "content": "x" })],
            updated_at_ms: 0,
        };
        save_session(&root, &record);
        assert_eq!(load_all_sessions(&root).len(), 1);

        delete_session(&root, "simple-ai-9-9");
        assert!(load_all_sessions(&root).is_empty());

        // 删除不存在的文件不报错
        delete_session(&root, "no-such-session");
    }

    #[test]
    fn sanitize_filename_replaces_illegal_chars() {
        assert_eq!(sanitize_filename("simple-ai-1700-0"), "simple-ai-1700-0");
        assert_eq!(sanitize_filename("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
    }
}
