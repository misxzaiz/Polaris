/*! Claude Code 会话历史提供者
 *
 * 使用 stat-sort-paginate 三阶段策略：
 * 1. stat 阶段：只读取文件元数据（mtime + file_size），不打开文件内容
 * 2. 排序分页：按 mtime 倒序排序后 skip/take
 * 3. 解析阶段：只对当前页的少量文件读取内容提取元数据
 */

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::SystemTime;

use crate::ai::history::{
    HistoryMessage, LinkedPR, PagedResult, Pagination, SessionHistoryProvider, SessionMeta,
};
use crate::error::{AppError, Result};
use crate::models::config::Config;

/// 轻量级 stat 条目（不读取文件内容）
struct StatEntry {
    session_id: String,
    mtime: SystemTime,
    file_size: u64,
    project_dir_name: String,
    file_path: PathBuf,
}

/// Claude Code 会话历史提供者
#[allow(dead_code)]
pub struct ClaudeHistoryProvider {
    #[allow(dead_code)]
    config: Config,
}

impl ClaudeHistoryProvider {
    /// 创建新的提供者
    pub fn new(config: Config) -> Self {
        Self { config }
    }

    /// 获取 Claude Code 项目目录
    pub(crate) fn get_claude_dir() -> PathBuf {
        if cfg!(windows) {
            std::env::var("USERPROFILE")
                .map(|p| PathBuf::from(p).join(".claude").join("projects"))
                .unwrap_or_else(|_| PathBuf::from(".claude").join("projects"))
        } else {
            std::env::var("HOME")
                .map(|p| PathBuf::from(p).join(".claude").join("projects"))
                .unwrap_or_else(|_| PathBuf::from(".claude").join("projects"))
        }
    }

    /// 将工作区路径转换为 Claude 目录名
    /// 例: "D:\space\base\Polaris" -> "D--space-base-Polaris"
    fn work_dir_to_claude_dir_name(work_dir: &str) -> String {
        work_dir.replace([':', '\\', '/'], "-")
    }

    /// 查找会话文件
    fn find_session_file(&self, session_id: &str, project_path: Option<&str>) -> Option<PathBuf> {
        let claude_dir = Self::get_claude_dir();

        if let Some(project) = project_path {
            let path = claude_dir.join(project).join(format!("{}.jsonl", session_id));
            if path.exists() {
                return Some(path);
            }
        }

        // 搜索所有项目目录
        if let Ok(entries) = std::fs::read_dir(&claude_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let candidate = entry.path().join(format!("{}.jsonl", session_id));
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }

        None
    }

    /// 解析 JSONL 文件中的消息（用于 get_session_history）
    fn parse_jsonl_messages(&self, path: &PathBuf, pagination: &Pagination) -> Result<(Vec<HistoryMessage>, usize)> {
        use std::io::{BufRead, BufReader};

        let file = std::fs::File::open(path)
            .map_err(|e| AppError::ValidationError(format!("无法打开文件: {}", e)))?;

        let reader = BufReader::new(file);
        let mut all_messages: Vec<HistoryMessage> = Vec::new();

        for line in reader.lines() {
            let line = line.map_err(|e| AppError::ValidationError(format!("读取行失败: {}", e)))?;
            if line.is_empty() {
                continue;
            }

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(msg_type) = json.get("type").and_then(|t| t.as_str()) {
                    match msg_type {
                        "user" => {
                            if let Some(content) = json.get("message").and_then(|m| m.get("content")) {
                                if let Some(text) = content.as_str() {
                                    all_messages.push(HistoryMessage {
                                        message_id: json.get("uuid").and_then(|u| u.as_str()).map(|s| s.to_string()),
                                        role: "user".to_string(),
                                        content: text.to_string(),
                                        timestamp: json.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string()),
                                        tool_calls: None,
                                        tool_result: None,
                                        usage: None,
                                    });
                                }
                            }
                        }
                        "assistant" => {
                            if let Some(message) = json.get("message") {
                                if let Some(content) = message.get("content") {
                                    if let Some(arr) = content.as_array() {
                                        for item in arr {
                                            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                                    all_messages.push(HistoryMessage {
                                                        message_id: json.get("uuid").and_then(|u| u.as_str()).map(|s| s.to_string()),
                                                        role: "assistant".to_string(),
                                                        content: text.to_string(),
                                                        timestamp: json.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string()),
                                                        tool_calls: None,
                                                        tool_result: None,
                                                        usage: None,
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        let total = all_messages.len();
        let skip = pagination.skip();
        let take = pagination.take();

        let items: Vec<HistoryMessage> = all_messages
            .into_iter()
            .skip(skip)
            .take(take)
            .collect();

        Ok((items, total))
    }

    /// 解析会话元数据（只读取必要数据）
    /// 返回 (first_prompt, message_count, created, real_cwd, git_branch)
    pub(crate) fn parse_session_metadata_light(
        file_path: &PathBuf,
    ) -> (Option<String>, usize, Option<String>, Option<String>, Option<String>) {
        use std::io::{BufRead, BufReader};

        let mut first_prompt: Option<String> = None;
        let mut message_count = 0usize;
        let mut created: Option<String> = None;
        let mut cwd: Option<String> = None;
        let mut git_branch: Option<String> = None;

        if let Ok(file) = std::fs::File::open(file_path) {
            let reader = BufReader::new(file);
            for line in reader.lines().map_while(|r| r.ok()) {
                if line.is_empty() {
                    continue;
                }
                // 快速跳过非 JSON 行
                let trimmed = line.trim_start();
                if !trimmed.starts_with('{') {
                    continue;
                }

                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(msg_type) = json.get("type").and_then(|t| t.as_str()) {
                        if msg_type == "user" {
                            message_count += 1;
                            if first_prompt.is_none() {
                                if let Some(content) = json.get("message").and_then(|m| m.get("content")) {
                                    let prompt_text = if let Some(text) = content.as_str() {
                                        Some(text.to_string())
                                    } else if let Some(arr) = content.as_array() {
                                        arr.iter()
                                            .find(|item| {
                                                item.get("type").and_then(|t| t.as_str()) == Some("text")
                                            })
                                            .and_then(|item| {
                                                item.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                                            })
                                    } else {
                                        None
                                    };

                                    if let Some(text) = prompt_text {
                                        let title = if text.chars().count() > 100 {
                                            format!("{}...", text.chars().take(100).collect::<String>())
                                        } else {
                                            text
                                        };
                                        first_prompt = Some(title);
                                    }
                                }
                            }
                            if created.is_none() {
                                created = json.get("timestamp").and_then(|t| t.as_str()).map(String::from);
                            }
                            if cwd.is_none() {
                                cwd = json.get("cwd").and_then(|c| c.as_str()).map(String::from);
                            }
                            // 提取 gitBranch
                            if git_branch.is_none() {
                                git_branch = json.get("gitBranch").and_then(|b| b.as_str()).map(String::from);
                            }
                        } else if msg_type == "assistant" {
                            message_count += 1;
                        }
                    }
                }
            }
        }

        (first_prompt, message_count, created, cwd, git_branch)
    }

    /// 从 git 分支名称中提取 PR 编号
    fn extract_pr_from_branch(branch_name: &str) -> Option<LinkedPR> {
        // 规则 1: pr-123 或 pr/123
        let pr_pattern = regex::Regex::new(r"(?i)pr[-/](\d+)").ok()?;
        if let Some(caps) = pr_pattern.captures(branch_name) {
            if let Some(num_str) = caps.get(1) {
                if let Ok(number) = num_str.as_str().parse::<u32>() {
                    return Some(LinkedPR {
                        number,
                        url: None,
                        title: None,
                        state: None,
                    });
                }
            }
        }

        // 规则 2: 123-feature-description（数字开头）
        let number_prefix = regex::Regex::new(r"^(\d+)-").ok()?;
        if let Some(caps) = number_prefix.captures(branch_name) {
            if let Some(num_str) = caps.get(1) {
                if let Ok(number) = num_str.as_str().parse::<u32>() {
                    return Some(LinkedPR {
                        number,
                        url: None,
                        title: None,
                        state: None,
                    });
                }
            }
        }

        None
    }
}

impl SessionHistoryProvider for ClaudeHistoryProvider {
    fn engine_id(&self) -> &'static str {
        "claude"
    }

    fn list_sessions(
        &self,
        work_dir: Option<&str>,
        pagination: Pagination,
    ) -> Result<PagedResult<SessionMeta>> {
        let claude_dir = Self::get_claude_dir();

        // ── 阶段 1：确定扫描目录范围 ──
        let dirs_to_scan: Vec<PathBuf> = if let Some(wd) = work_dir {
            let dir_name = Self::work_dir_to_claude_dir_name(wd);
            let target = claude_dir.join(&dir_name);
            if target.is_dir() {
                vec![target]
            } else {
                return Ok(PagedResult::empty(pagination.page, pagination.page_size));
            }
        } else {
            let mut dirs = Vec::new();
            if let Ok(entries) = std::fs::read_dir(&claude_dir) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        dirs.push(entry.path());
                    }
                }
            }
            dirs
        };

        // ── 阶段 2：stat 收集（不读文件内容） ──
        let mut stat_entries: Vec<StatEntry> = Vec::new();

        for dir in &dirs_to_scan {
            let project_dir_name = dir.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            if let Ok(session_entries) = std::fs::read_dir(dir) {
                for session_entry in session_entries.flatten() {
                    let path = session_entry.path();
                    if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                        if let Ok(metadata) = std::fs::metadata(&path) {
                            let mtime = metadata.modified()
                                .unwrap_or(SystemTime::UNIX_EPOCH);
                            let file_size = metadata.len();
                            let session_id = path.file_stem()
                                .map(|s| s.to_string_lossy().to_string())
                                .unwrap_or_default();

                            stat_entries.push(StatEntry {
                                session_id,
                                mtime,
                                file_size,
                                project_dir_name: project_dir_name.clone(),
                                file_path: path,
                            });
                        }
                    }
                }
            }
        }

        // ── 阶段 3：排序 + 分页 ──
        stat_entries.sort_by(|a, b| b.mtime.cmp(&a.mtime));

        let total = stat_entries.len();
        let page_entries: Vec<&StatEntry> = stat_entries
            .iter()
            .skip(pagination.skip())
            .take(pagination.take())
            .collect();

        // ── 阶段 4：只解析当前页文件 ──
        let mut items: Vec<SessionMeta> = Vec::with_capacity(page_entries.len());
        for entry in &page_entries {
            let (first_prompt, message_count, created, real_cwd, git_branch) =
                Self::parse_session_metadata_light(&entry.file_path);

            let updated_at = entry.mtime
                .duration_since(SystemTime::UNIX_EPOCH)
                .ok()
                .and_then(|d| {
                    chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                });

            // 从 git_branch 推断 PR 关联
            let linked_pr = git_branch.as_ref().and_then(|branch| {
                Self::extract_pr_from_branch(branch)
            });

            items.push(SessionMeta {
                session_id: entry.session_id.clone(),
                engine_id: "claude".to_string(),
                project_path: Some(real_cwd.unwrap_or_else(|| entry.project_dir_name.clone())),
                created_at: created,
                updated_at,
                message_count: Some(message_count),
                summary: first_prompt,
                file_size: Some(entry.file_size),
                claude_project_name: Some(entry.project_dir_name.clone()),
                file_path: Some(entry.file_path.to_string_lossy().to_string()),
                parent_session_id: None, // Fork 检测需要二次处理
                child_session_ids: Vec::new(),
                git_branch,
                linked_pr,
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
        let session_file = self.find_session_file(session_id, None)
            .ok_or_else(|| AppError::ValidationError(format!("会话不存在: {}", session_id)))?;

        let (items, total) = self.parse_jsonl_messages(&session_file, &pagination)?;

        Ok(PagedResult::new(items, total, pagination.page, pagination.page_size))
    }

    fn get_message(&self, session_id: &str, message_id: &str) -> Result<Option<HistoryMessage>> {
        let session_file = match self.find_session_file(session_id, None) {
            Some(f) => f,
            None => return Ok(None),
        };

        use std::io::{BufRead, BufReader};
        let file = std::fs::File::open(&session_file)
            .map_err(|e| AppError::ValidationError(format!("无法打开文件: {}", e)))?;

        let reader = BufReader::new(file);

        for line in reader.lines() {
            let line = line.map_err(|e| AppError::ValidationError(format!("读取行失败: {}", e)))?;
            if line.is_empty() {
                continue;
            }

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if json.get("uuid").and_then(|u| u.as_str()) == Some(message_id) {
                    if let Some(msg_type) = json.get("type").and_then(|t| t.as_str()) {
                        match msg_type {
                            "user" => {
                                if let Some(content) = json.get("message").and_then(|m| m.get("content")) {
                                    if let Some(text) = content.as_str() {
                                        return Ok(Some(HistoryMessage {
                                            message_id: Some(message_id.to_string()),
                                            role: "user".to_string(),
                                            content: text.to_string(),
                                            timestamp: json.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string()),
                                            tool_calls: None,
                                            tool_result: None,
                                            usage: None,
                                        }));
                                    }
                                }
                            }
                            "assistant" => {
                                if let Some(message) = json.get("message") {
                                    if let Some(content) = message.get("content") {
                                        if let Some(arr) = content.as_array() {
                                            for item in arr {
                                                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                                        return Ok(Some(HistoryMessage {
                                                            message_id: Some(message_id.to_string()),
                                                            role: "assistant".to_string(),
                                                            content: text.to_string(),
                                                            timestamp: json.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string()),
                                                            tool_calls: None,
                                                            tool_result: None,
                                                            usage: None,
                                                        }));
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        Ok(None)
    }

    fn delete_session(&self, session_id: &str) -> Result<()> {
        let session_file = self.find_session_file(session_id, None)
            .ok_or_else(|| AppError::ValidationError(format!("会话不存在: {}", session_id)))?;

        std::fs::remove_file(&session_file)
            .map_err(|e| AppError::ValidationError(format!("删除会话失败: {}", e)))?;

        Ok(())
    }
}
