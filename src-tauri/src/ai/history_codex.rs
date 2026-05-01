/*! Codex 会话历史提供者
 *
 * 读取 Codex CLI 原生会话文件: ~/.codex/sessions/**/rollout-*.jsonl。
 */

use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
        let mut files = Vec::new();
        Self::collect_jsonl_files(&Self::get_codex_sessions_dir(), &mut files);

        for file in files {
            if Self::session_id_from_file(&file).as_deref() == Some(session_id) {
                return Some(file);
            }
        }

        None
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

    fn parse_messages(path: &Path, pagination: &Pagination) -> Result<(Vec<HistoryMessage>, usize)> {
        use std::io::{BufRead, BufReader};

        let file = std::fs::File::open(path)
            .map_err(|e| AppError::ValidationError(format!("无法打开 Codex 会话文件: {}", e)))?;
        let reader = BufReader::new(file);

        let mut all_messages = Vec::new();

        for line in reader.lines() {
            let line = line.map_err(|e| AppError::ValidationError(format!("读取 Codex 历史失败: {}", e)))?;
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

    fn parse_metadata(path: &Path) -> (Option<String>, usize, Option<String>, Option<String>, Option<String>) {
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
        let mut files = Vec::new();
        Self::collect_jsonl_files(&Self::get_codex_sessions_dir(), &mut files);

        let mut stat_entries = Vec::new();
        for file_path in files {
            let Ok(metadata) = std::fs::metadata(&file_path) else {
                continue;
            };
            let (summary, message_count, created_at, cwd, parsed_session_id) =
                Self::parse_metadata(&file_path);

            if let Some(wd) = work_dir {
                if cwd.as_deref() != Some(wd) {
                    continue;
                }
            }

            let session_id = parsed_session_id
                .or_else(|| Self::session_id_from_file(&file_path))
                .unwrap_or_else(|| {
                    file_path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default()
                });

            stat_entries.push((
                CodexStatEntry {
                    session_id,
                    mtime: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    file_size: metadata.len(),
                    file_path,
                },
                summary,
                message_count,
                created_at,
                cwd,
            ));
        }

        stat_entries.sort_by(|a, b| b.0.mtime.cmp(&a.0.mtime));

        let total = stat_entries.len();
        let page_entries = stat_entries
            .into_iter()
            .skip(pagination.skip())
            .take(pagination.take());

        let mut items = Vec::new();
        for (entry, summary, message_count, created_at, cwd) in page_entries {
            let updated_at = entry
                .mtime
                .duration_since(SystemTime::UNIX_EPOCH)
                .ok()
                .and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0))
                .map(|dt| dt.to_rfc3339());

            items.push(SessionMeta {
                session_id: entry.session_id,
                engine_id: "codex".to_string(),
                project_path: cwd,
                created_at,
                updated_at,
                message_count: Some(message_count),
                summary,
                file_size: Some(entry.file_size),
                claude_project_name: None,
                file_path: Some(entry.file_path.to_string_lossy().to_string()),
                parent_session_id: None,
                child_session_ids: Vec::new(),
                git_branch: None,
                linked_pr: None,
                extra: HashMap::new(),
            });
        }

        Ok(PagedResult::new(items, total, pagination.page, pagination.page_size))
    }

    fn get_session_history(
        &self,
        session_id: &str,
        pagination: Pagination,
    ) -> Result<PagedResult<HistoryMessage>> {
        let session_file = self
            .find_session_file(session_id)
            .ok_or_else(|| AppError::ValidationError(format!("Codex 会话不存在: {}", session_id)))?;

        let (items, total) = Self::parse_messages(&session_file, &pagination)?;
        Ok(PagedResult::new(items, total, pagination.page, pagination.page_size))
    }

    fn get_message(&self, session_id: &str, message_id: &str) -> Result<Option<HistoryMessage>> {
        let session_file = match self.find_session_file(session_id) {
            Some(path) => path,
            None => return Ok(None),
        };

        let (messages, _) = Self::parse_messages(
            &session_file,
            &Pagination::new(1, usize::MAX),
        )?;

        Ok(messages
            .into_iter()
            .find(|message| message.message_id.as_deref() == Some(message_id)))
    }

    fn delete_session(&self, session_id: &str) -> Result<()> {
        let session_file = self
            .find_session_file(session_id)
            .ok_or_else(|| AppError::ValidationError(format!("Codex 会话不存在: {}", session_id)))?;

        std::fs::remove_file(&session_file)
            .map_err(|e| AppError::ValidationError(format!("删除 Codex 会话失败: {}", e)))?;

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
        let file_path = dir.path().join("rollout-2026-05-01T00-00-00-session-1.jsonl");
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
}
