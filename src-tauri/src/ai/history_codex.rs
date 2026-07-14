/*! Codex 会话历史提供者
 *
 * 读取 Codex CLI 原生会话文件: ~/.codex/sessions/**/rollout-*.jsonl。
 */

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use crate::ai::history::{
    HistoryMessage, PagedResult, Pagination, SessionHistoryProvider, SessionMeta,
};
use crate::error::{AppError, Result};
use crate::models::config::Config;

struct CodexStatEntry {
    session_id: String,
    mtime: SystemTime,
    file_size: u64,
    file_path: PathBuf,
}

/// 阶段 1 收集的轻量条目：stat 元数据 + 头部读到的 cwd / created_at，
/// 可选携带兜底全量 parse 结果（仅在 head 缺失 cwd 但需要 work_dir 过滤时）。
struct StageOneEntry {
    stat: CodexStatEntry,
    cwd: Option<String>,
    head_created_at: Option<String>,
    /// (summary, message_count, created_at) — 阶段 3 可直接复用避免重复 IO
    prefetched_full: Option<(Option<String>, usize, Option<String>)>,
}

/// 从 jsonl 文件头部 `session_meta` 行提取的轻量元数据。
/// 用于阶段 1 stat-only 扫描，避免对每个文件做全量解析。
struct SessionMetaHead {
    session_id: String,
    cwd: Option<String>,
    created_at: Option<String>,
}

/// 进程级缓存：sessionId -> 文件路径。
/// 由 `list_sessions` 填充，`find_session_file` / `delete_session` 复用。
/// 写入时校验 path.exists()，保证不返回已删除文件。
static CODEX_SESSION_INDEX: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

fn codex_session_index() -> &'static Mutex<HashMap<String, PathBuf>> {
    CODEX_SESSION_INDEX.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 读取 jsonl 文件前若干行，提取 `session_meta` 头部信息。
/// 大多数 codex rollout 文件第一行即为 session_meta，限定上界避免坏文件 IO 失控。
fn read_session_meta_only(path: &Path) -> Option<SessionMetaHead> {
    use std::io::{BufRead, BufReader};

    const SCAN_LINES_LIMIT: usize = 32;

    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    for line in reader.lines().take(SCAN_LINES_LIMIT).map_while(|r| r.ok()) {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('{') {
            continue;
        }
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if json.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
            continue;
        }
        let payload = json.get("payload")?;
        let session_id = payload.get("id").and_then(|v| v.as_str())?.to_string();
        let cwd = payload
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let created_at = payload
            .get("timestamp")
            .and_then(|v| v.as_str())
            .or_else(|| json.get("timestamp").and_then(|v| v.as_str()))
            .map(|s| s.to_string());
        return Some(SessionMetaHead {
            session_id,
            cwd,
            created_at,
        });
    }

    None
}

pub struct CodexHistoryProvider {
    #[allow(dead_code)]
    config: Config,
}

impl CodexHistoryProvider {
    pub fn new(config: Config) -> Self {
        Self { config }
    }

    fn get_codex_sessions_dir() -> PathBuf {
        dirs::home_dir()
            .map(|home| home.join(".codex").join("sessions"))
            .unwrap_or_else(|| PathBuf::from(".codex").join("sessions"))
    }

    fn collect_jsonl_files(dir: &Path, files: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                Self::collect_jsonl_files(&path, files);
            } else if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                files.push(path);
            }
        }
    }

    fn session_id_from_file(path: &Path) -> Option<String> {
        use std::io::{BufRead, BufReader};

        let file = std::fs::File::open(path).ok()?;
        let reader = BufReader::new(file);

        for line in reader.lines().map_while(|r| r.ok()) {
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if json.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
                continue;
            }
            if let Some(id) = json
                .get("payload")
                .and_then(|p| p.get("id"))
                .and_then(|id| id.as_str())
            {
                return Some(id.to_string());
            }
        }

        path.file_stem()
            .and_then(|s| s.to_str())
            .and_then(|stem| stem.rsplit('-').next())
            .map(|s| s.to_string())
    }

    fn find_session_file(&self, session_id: &str) -> Option<PathBuf> {
        // 1. 优先查进程级缓存（由 list_sessions 填充）
        if let Ok(cache) = codex_session_index().lock() {
            if let Some(p) = cache.get(session_id) {
                if p.exists() {
                    return Some(p.clone());
                }
            }
        }

        // 2. 缓存未命中：扫描所有文件 + 顺便回填缓存
        let mut files = Vec::new();
        Self::collect_jsonl_files(&Self::get_codex_sessions_dir(), &mut files);

        let mut matched: Option<PathBuf> = None;
        for file in files {
            // 优先用轻量头读取（只扫前 32 行）；失败回退到旧的全文扫描
            let sid = read_session_meta_only(&file)
                .map(|h| h.session_id)
                .or_else(|| Self::session_id_from_file(&file));
            if let Some(sid) = sid {
                if let Ok(mut cache) = codex_session_index().lock() {
                    cache.insert(sid.clone(), file.clone());
                }
                if sid == session_id {
                    matched = Some(file);
                    // 不 break：继续回填后面的条目，下次 find 也能命中
                }
            }
        }

        matched
    }

    fn text_from_content_array(value: &serde_json::Value, text_key: &str) -> String {
        let Some(items) = value.as_array() else {
            return String::new();
        };

        items
            .iter()
            .filter_map(|item| {
                item.get(text_key)
                    .and_then(|v| v.as_str())
                    .or_else(|| item.get("text").and_then(|v| v.as_str()))
            })
            .collect::<Vec<_>>()
            .join("")
    }

    fn message_content(payload: &serde_json::Value) -> String {
        let Some(content) = payload.get("content") else {
            return String::new();
        };

        if let Some(text) = content.as_str() {
            return text.to_string();
        }

        Self::text_from_content_array(content, "text")
    }

    fn parse_messages(
        path: &Path,
        pagination: &Pagination,
    ) -> Result<(Vec<HistoryMessage>, usize)> {
        use std::io::{BufRead, BufReader};

        let file = std::fs::File::open(path)
            .map_err(|e| AppError::ValidationError(format!("无法打开 Codex 会话文件: {}", e)))?;
        let reader = BufReader::new(file);

        let mut all_messages = Vec::new();

        for line in reader.lines() {
            let line =
                line.map_err(|e| AppError::ValidationError(format!("读取 Codex 历史失败: {}", e)))?;
            if line.trim().is_empty() {
                continue;
            }

            let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if json.get("type").and_then(|t| t.as_str()) != Some("response_item") {
                continue;
            }

            let Some(payload) = json.get("payload") else {
                continue;
            };
            if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
                continue;
            }

            let Some(role) = payload.get("role").and_then(|r| r.as_str()) else {
                continue;
            };
            if role != "user" && role != "assistant" && role != "system" {
                continue;
            }

            let content = Self::message_content(payload);
            if content.trim().is_empty() {
                continue;
            }

            all_messages.push(HistoryMessage {
                message_id: payload
                    .get("id")
                    .and_then(|id| id.as_str())
                    .map(|s| s.to_string()),
                role: role.to_string(),
                content,
                timestamp: json
                    .get("timestamp")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string()),
                tool_calls: None,
                tool_result: None,
                usage: None,
            });
        }

        let total = all_messages.len();
        let items = all_messages
            .into_iter()
            .skip(pagination.skip())
            .take(pagination.take())
            .collect();

        Ok((items, total))
    }

    fn parse_metadata(
        path: &Path,
    ) -> (
        Option<String>,
        usize,
        Option<String>,
        Option<String>,
        Option<String>,
    ) {
        use std::io::{BufRead, BufReader};

        let mut summary = None;
        let mut message_count = 0usize;
        let mut created_at = None;
        let mut cwd = None;
        let mut session_id = None;

        let Ok(file) = std::fs::File::open(path) else {
            return (summary, message_count, created_at, cwd, session_id);
        };

        let reader = BufReader::new(file);
        for line in reader.lines().map_while(|r| r.ok()) {
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };

            match json.get("type").and_then(|t| t.as_str()) {
                Some("session_meta") => {
                    if let Some(payload) = json.get("payload") {
                        if session_id.is_none() {
                            session_id = payload
                                .get("id")
                                .and_then(|id| id.as_str())
                                .map(|s| s.to_string());
                        }
                        if created_at.is_none() {
                            created_at = payload
                                .get("timestamp")
                                .and_then(|t| t.as_str())
                                .or_else(|| json.get("timestamp").and_then(|t| t.as_str()))
                                .map(|s| s.to_string());
                        }
                        if cwd.is_none() {
                            cwd = payload
                                .get("cwd")
                                .and_then(|c| c.as_str())
                                .map(|s| s.to_string());
                        }
                    }
                }
                Some("response_item") => {
                    let Some(payload) = json.get("payload") else {
                        continue;
                    };
                    if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
                        continue;
                    }

                    let role = payload.get("role").and_then(|r| r.as_str());
                    if matches!(role, Some("user") | Some("assistant")) {
                        let content = Self::message_content(payload);
                        if !content.trim().is_empty() {
                            message_count += 1;
                            if summary.is_none() && role == Some("user") {
                                summary = Some(if content.chars().count() > 100 {
                                    format!("{}...", content.chars().take(100).collect::<String>())
                                } else {
                                    content
                                });
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        (summary, message_count, created_at, cwd, session_id)
    }

    /// list_sessions 的内部实现，接受任意 sessions 目录便于测试。
    /// 实际入口由 `<Self as SessionHistoryProvider>::list_sessions` 传入 `~/.codex/sessions`。
    fn list_sessions_in(
        &self,
        sessions_dir: &Path,
        work_dir: Option<&str>,
        pagination: Pagination,
    ) -> Result<PagedResult<SessionMeta>> {
        // ── 阶段 1：stat + 仅读 session_meta 头部，按 work_dir 过滤 ──
        // 同时把 sessionId -> 路径回填到进程级缓存，加速后续 find_session_file。
        let mut files = Vec::new();
        Self::collect_jsonl_files(sessions_dir, &mut files);

        let mut stat_entries: Vec<StageOneEntry> = Vec::with_capacity(files.len());

        for file_path in files {
            let Ok(metadata) = std::fs::metadata(&file_path) else {
                continue;
            };

            // 优先用轻量头读取（限 32 行）；失败回退到 session_id_from_file 兜底。
            let head = read_session_meta_only(&file_path);
            let (session_id_opt, head_cwd, head_created_at) = match head {
                Some(h) => (Some(h.session_id), h.cwd, h.created_at),
                None => (Self::session_id_from_file(&file_path), None, None),
            };

            // work_dir 过滤策略：
            //   - head 有 cwd 且匹配  → 通过，prefetched=None
            //   - head 有 cwd 且不匹配 → 跳过
            //   - head 没 cwd 但调用方指定了 wd → 回退到全量 parse 验证（同时复用其结果）
            //   - head 没 cwd 且调用方未指定 wd → 通过
            let (resolved_cwd, prefetched_full) = match (work_dir, head_cwd.clone()) {
                (Some(wd), Some(c)) if c == wd => (Some(c), None),
                (Some(_), Some(_)) => continue,
                (Some(wd), None) => {
                    let (s, m, ts, c, _sid) = Self::parse_metadata(&file_path);
                    if c.as_deref() != Some(wd) {
                        continue;
                    }
                    (c.clone(), Some((s, m, ts)))
                }
                (None, c) => (c, None),
            };

            let session_id = session_id_opt.unwrap_or_else(|| {
                file_path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            });

            // 回填进程级缓存
            if !session_id.is_empty() {
                if let Ok(mut cache) = codex_session_index().lock() {
                    cache.insert(session_id.clone(), file_path.clone());
                }
            }

            stat_entries.push(StageOneEntry {
                stat: CodexStatEntry {
                    session_id,
                    mtime: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    file_size: metadata.len(),
                    file_path,
                },
                cwd: resolved_cwd,
                head_created_at,
                prefetched_full,
            });
        }

        // ── 阶段 2：按 mtime 倒序 + 分页 ──
        stat_entries.sort_by(|a, b| b.stat.mtime.cmp(&a.stat.mtime));

        let total = stat_entries.len();
        let page_entries: Vec<StageOneEntry> = stat_entries
            .into_iter()
            .skip(pagination.skip())
            .take(pagination.take())
            .collect();

        // ── 阶段 3：仅对当前页做全量 parse 拿 summary + message_count ──
        let mut items: Vec<SessionMeta> = Vec::with_capacity(page_entries.len());
        for entry in page_entries {
            // 优先复用阶段 1 的 prefetched 结果，避免重复 IO
            let (summary, message_count, created_at_full) = match entry.prefetched_full {
                Some(prefetched) => prefetched,
                None => {
                    let (s, m, ts, _cwd, _sid) = Self::parse_metadata(&entry.stat.file_path);
                    (s, m, ts)
                }
            };

            let updated_at = entry
                .stat
                .mtime
                .duration_since(SystemTime::UNIX_EPOCH)
                .ok()
                .and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0))
                .map(|dt| dt.to_rfc3339());

            items.push(SessionMeta {
                session_id: entry.stat.session_id,
                engine_id: "codex".to_string(),
                project_path: entry.cwd,
                created_at: created_at_full.or(entry.head_created_at),
                updated_at,
                message_count: Some(message_count),
                summary,
                file_size: Some(entry.stat.file_size),
                claude_project_name: None,
                file_path: Some(entry.stat.file_path.to_string_lossy().to_string()),
                parent_session_id: None,
                child_session_ids: Vec::new(),
                git_branch: None,
                linked_pr: None,
                extra: HashMap::new(),
            });
        }

        Ok(PagedResult::new(
            items,
            total,
            pagination.page,
            pagination.page_size,
        ))
    }
}

impl SessionHistoryProvider for CodexHistoryProvider {
    fn engine_id(&self) -> &'static str {
        "codex"
    }

    fn list_sessions(
        &self,
        work_dir: Option<&str>,
        pagination: Pagination,
    ) -> Result<PagedResult<SessionMeta>> {
        self.list_sessions_in(&Self::get_codex_sessions_dir(), work_dir, pagination)
    }

    fn get_session_history(
        &self,
        session_id: &str,
        pagination: Pagination,
    ) -> Result<PagedResult<HistoryMessage>> {
        let session_file = self.find_session_file(session_id).ok_or_else(|| {
            AppError::ValidationError(format!("Codex 会话不存在: {}", session_id))
        })?;

        let (items, total) = Self::parse_messages(&session_file, &pagination)?;
        Ok(PagedResult::new(
            items,
            total,
            pagination.page,
            pagination.page_size,
        ))
    }

    fn get_message(&self, session_id: &str, message_id: &str) -> Result<Option<HistoryMessage>> {
        let session_file = match self.find_session_file(session_id) {
            Some(path) => path,
            None => return Ok(None),
        };

        let (messages, _) = Self::parse_messages(&session_file, &Pagination::new(1, usize::MAX))?;

        Ok(messages
            .into_iter()
            .find(|message| message.message_id.as_deref() == Some(message_id)))
    }

    fn delete_session(&self, session_id: &str) -> Result<()> {
        let session_file = self.find_session_file(session_id).ok_or_else(|| {
            AppError::ValidationError(format!("Codex 会话不存在: {}", session_id))
        })?;

        std::fs::remove_file(&session_file)
            .map_err(|e| AppError::ValidationError(format!("删除 Codex 会话失败: {}", e)))?;

        // 失效进程级缓存中的对应条目
        if let Ok(mut cache) = codex_session_index().lock() {
            cache.remove(session_id);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_codex_metadata_and_messages() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir
            .path()
            .join("rollout-2026-05-01T00-00-00-session-1.jsonl");
        let mut file = std::fs::File::create(&file_path).unwrap();

        writeln!(
            file,
            r#"{{"timestamp":"2026-05-01T00:00:00Z","type":"session_meta","payload":{{"id":"session-1","timestamp":"2026-05-01T00:00:00Z","cwd":"D:\\space\\base\\Polaris"}}}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"timestamp":"2026-05-01T00:00:01Z","type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"你好"}}]}}}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"timestamp":"2026-05-01T00:00:02Z","type":"response_item","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"你好，有什么可以帮你？"}}]}}}}"#
        )
        .unwrap();

        let (summary, message_count, created_at, cwd, session_id) =
            CodexHistoryProvider::parse_metadata(&file_path);
        assert_eq!(summary.as_deref(), Some("你好"));
        assert_eq!(message_count, 2);
        assert_eq!(created_at.as_deref(), Some("2026-05-01T00:00:00Z"));
        assert_eq!(cwd.as_deref(), Some("D:\\space\\base\\Polaris"));
        assert_eq!(session_id.as_deref(), Some("session-1"));

        let (messages, total) =
            CodexHistoryProvider::parse_messages(&file_path, &Pagination::new(1, 50)).unwrap();
        assert_eq!(total, 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "你好");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "你好，有什么可以帮你？");
    }

    /// 辅助：写入一个 codex 风格 jsonl 文件
    fn write_codex_rollout(
        dir: &Path,
        file_name: &str,
        session_id: &str,
        cwd: &str,
        user_msg: &str,
        assistant_msg: &str,
    ) -> PathBuf {
        let path = dir.join(file_name);
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            r#"{{"timestamp":"2026-05-01T00:00:00Z","type":"session_meta","payload":{{"id":"{}","timestamp":"2026-05-01T00:00:00Z","cwd":"{}"}}}}"#,
            session_id,
            cwd.replace('\\', "\\\\")
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"timestamp":"2026-05-01T00:00:01Z","type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"{}"}}]}}}}"#,
            user_msg
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"timestamp":"2026-05-01T00:00:02Z","type":"response_item","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"{}"}}]}}}}"#,
            assistant_msg
        )
        .unwrap();
        path
    }

    /// `read_session_meta_only` 应该只读到 session_meta 头部信息，且尊重 32 行扫描上限。
    #[test]
    fn read_session_meta_only_returns_head_from_first_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_codex_rollout(
            dir.path(),
            "rollout-1.jsonl",
            "sid-head-1",
            "/tmp/projA",
            "hi",
            "hello",
        );

        let head = read_session_meta_only(&path).expect("应该读到 session_meta");
        assert_eq!(head.session_id, "sid-head-1");
        assert_eq!(head.cwd.as_deref(), Some("/tmp/projA"));
        assert_eq!(head.created_at.as_deref(), Some("2026-05-01T00:00:00Z"));
    }

    #[test]
    fn read_session_meta_only_returns_none_when_session_meta_beyond_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-late.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        // 写 40 行无用 noop，确保 session_meta 超出 SCAN_LINES_LIMIT (32)
        for i in 0..40 {
            writeln!(file, r#"{{"type":"noop","seq":{}}}"#, i).unwrap();
        }
        writeln!(
            file,
            r#"{{"type":"session_meta","payload":{{"id":"sid-late","cwd":"/tmp/late"}}}}"#
        )
        .unwrap();
        assert!(read_session_meta_only(&path).is_none());
    }

    /// 阶段 1 应该按 cwd 正确过滤，且阶段 3 只 parse 当前页文件。
    #[test]
    fn list_sessions_in_filters_by_cwd_and_paginates() {
        let dir = tempfile::tempdir().unwrap();
        write_codex_rollout(
            dir.path(),
            "rollout-a.jsonl",
            "sid-A",
            "/tmp/projA",
            "msgA",
            "respA",
        );
        write_codex_rollout(
            dir.path(),
            "rollout-b.jsonl",
            "sid-B",
            "/tmp/projB",
            "msgB",
            "respB",
        );

        let provider = CodexHistoryProvider::new(Config::default());

        // 过滤 projA：只返回 sid-A
        let result_a = provider
            .list_sessions_in(dir.path(), Some("/tmp/projA"), Pagination::new(1, 50))
            .unwrap();
        assert_eq!(result_a.total, 1);
        assert_eq!(result_a.items[0].session_id, "sid-A");
        assert_eq!(
            result_a.items[0].project_path.as_deref(),
            Some("/tmp/projA")
        );
        assert_eq!(result_a.items[0].summary.as_deref(), Some("msgA"));

        // 不过滤：返回两条
        let result_all = provider
            .list_sessions_in(dir.path(), None, Pagination::new(1, 50))
            .unwrap();
        assert_eq!(result_all.total, 2);
    }

    /// list_sessions_in 应填充进程级缓存，find_session_file 后续命中缓存。
    #[test]
    fn find_session_file_uses_cache_populated_by_list_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let path_x = write_codex_rollout(
            dir.path(),
            "rollout-x.jsonl",
            "sid-find-X",
            "/tmp/projX",
            "msgX",
            "respX",
        );

        let provider = CodexHistoryProvider::new(Config::default());

        // 触发缓存填充
        provider
            .list_sessions_in(dir.path(), None, Pagination::new(1, 50))
            .unwrap();

        // 直接查缓存（绕过 find_session_file 的 fallback 全目录扫描）
        let cached = {
            let cache = codex_session_index().lock().unwrap();
            cache.get("sid-find-X").cloned()
        };
        assert_eq!(cached, Some(path_x));
    }
}
