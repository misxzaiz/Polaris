/*! AI 会话历史业务核（第七步阶段 A1：自 commands/chat.rs 抽出）
 *
 * list_sessions / get_session_history / delete_session（统一分页接口）+
 * Claude Code 会话树（元数据解析 / fork 关系推断 / 历史消息读取）。
 * 入口：commands/session_history.rs 壳命令（cap.history 迁移在阶段 B）。
 */

use crate::ai::{ClaudeHistoryProvider, PluginHistoryProvider, HistoryMessage, PagedResult, Pagination, SessionHistoryProvider, SessionMeta};
use crate::error::{AppError, Result};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

pub async fn list_sessions(
    engine_id: String,
    page: Option<usize>,
    page_size: Option<usize>,
    work_dir: Option<String>,
    state: &crate::AppState,
) -> Result<PagedResult<SessionMeta>> {
    tracing::info!("[list_sessions] 引擎: {}, 页码: {:?}", engine_id, page);

    let pagination = Pagination::new(page.unwrap_or(1), page_size.unwrap_or(50));

    let config_store = state
        .config_store
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    let config = config_store.get().clone();

    match engine_id.as_str() {
        "claude" | "claude-code" => {
            let provider = ClaudeHistoryProvider::new(config);
            provider.list_sessions(work_dir.as_deref(), pagination)
        }
        engine => {
            // 插件引擎走通用历史提供者
            let provider = PluginHistoryProvider::new(engine, engine);
            provider.list_sessions(work_dir.as_deref(), pagination)
        }
    }
}

/// 获取会话历史（统一接口，支持分页）
pub async fn get_session_history(
    session_id: String,
    engine_id: String,
    page: Option<usize>,
    page_size: Option<usize>,
    state: &crate::AppState,
) -> Result<PagedResult<HistoryMessage>> {
    tracing::info!(
        "[get_session_history] 会话: {}, 页码: {:?}",
        session_id,
        page
    );

    let pagination = Pagination::new(page.unwrap_or(1), page_size.unwrap_or(50));

    let config_store = state
        .config_store
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    let config = config_store.get().clone();

    match engine_id.as_str() {
        "claude" | "claude-code" => {
            let provider = ClaudeHistoryProvider::new(config);
            provider.get_session_history(&session_id, pagination)
        }
        engine => {
            let provider = PluginHistoryProvider::new(engine, engine);
            provider.get_session_history(&session_id, pagination)
        }
    }
}

/// 删除会话
pub async fn delete_session(
    session_id: String,
    engine_id: String,
    state: &crate::AppState,
) -> Result<()> {
    tracing::info!("[delete_session] 删除会话: {}", session_id);

    let config_store = state
        .config_store
        .lock()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    let config = config_store.get().clone();

    match engine_id.as_str() {
        "claude" | "claude-code" => {
            let provider = ClaudeHistoryProvider::new(config);
            provider.delete_session(&session_id)
        }
        engine => {
            let provider = PluginHistoryProvider::new(engine, engine);
            provider.delete_session(&session_id)
        }
    }
}

// Claude Code 会话历史（旧接口，保留向后兼容）
// ============================================================================


/// PR 关联信息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPR {
    pub number: u32,
    pub url: Option<String>,
    pub title: Option<String>,
    pub state: Option<String>, // "open" | "merged" | "closed"
}

/// Claude Code 会话元数据
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionMeta {
    pub session_id: String,
    /// 真实工作区路径（用于前端匹配/创建工作区）
    pub project_path: String,
    /// Claude Code 目录名（用于定位 jsonl 文件）
    pub claude_project_name: String,
    pub first_prompt: Option<String>,
    pub message_count: usize,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub file_path: String,
    pub file_size: u64,

    // === Fork 关系字段 ===
    /// 父会话 ID（fork 来源，通过消息指纹推断）
    #[serde(default)]
    pub parent_session_id: Option<String>,
    /// 子会话 ID 列表
    #[serde(default)]
    pub child_session_ids: Vec<String>,

    // === Git/PR 关联字段 ===
    /// Git 分支名称（从会话文件中提取）
    #[serde(default)]
    pub git_branch: Option<String>,
    /// PR 关联信息（通过 git branch 推断）
    #[serde(default)]
    pub linked_pr: Option<LinkedPR>,
}

/// 从 git 分支名称中提取 PR 编号
///
/// 支持的分支命名格式：
/// - pr-123, pr/123
/// - 123-feature-description
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

/// Claude Code 历史消息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHistoryMessage {
    pub role: String,
    /// 内容可能是字符串或数组（包含 text、tool_use、tool_result 等）
    pub content: serde_json::Value,
    pub timestamp: Option<String>,
}

/// 解析会话文件获取元数据（包括真实工作区路径 cwd 和 gitBranch）
fn parse_session_metadata(
    file_path: &PathBuf,
) -> (
    Option<String>,
    usize,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let mut first_prompt: Option<String> = None;
    let mut message_count = 0usize;
    let mut created: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut git_branch: Option<String> = None;

    if let Ok(file) = std::fs::File::open(file_path) {
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(|r| r.ok()) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(msg_type) = json.get("type").and_then(|t| t.as_str()) {
                    if msg_type == "user" {
                        message_count += 1;
                        // 获取第一条用户消息作为标题
                        if first_prompt.is_none() {
                            if let Some(content) =
                                json.get("message").and_then(|m| m.get("content"))
                            {
                                let prompt_text = if let Some(text) = content.as_str() {
                                    // 字符串格式
                                    Some(text.to_string())
                                } else if let Some(arr) = content.as_array() {
                                    // 数组格式，提取第一个 text 类型
                                    let mut found = None;
                                    for item in arr {
                                        if item.get("type").and_then(|t| t.as_str()) == Some("text")
                                        {
                                            if let Some(text) =
                                                item.get("text").and_then(|t| t.as_str())
                                            {
                                                found = Some(text.to_string());
                                                break;
                                            }
                                        }
                                    }
                                    found
                                } else {
                                    None
                                };

                                if let Some(text) = prompt_text {
                                    // 截取前 100 个字符作为标题（使用 chars() 正确处理 Unicode）
                                    let title = if text.chars().count() > 100 {
                                        format!("{}...", text.chars().take(100).collect::<String>())
                                    } else {
                                        text
                                    };
                                    first_prompt = Some(title);
                                }
                            }
                        }
                        // 获取创建时间（第一条消息的时间戳）
                        if created.is_none() {
                            created = json
                                .get("timestamp")
                                .and_then(|t| t.as_str())
                                .map(|s| s.to_string());
                        }
                        // 获取真实工作区路径（cwd）
                        if cwd.is_none() {
                            cwd = json
                                .get("cwd")
                                .and_then(|c| c.as_str())
                                .map(|s| s.to_string());
                        }
                        // 获取 git 分支（gitBranch）
                        if git_branch.is_none() {
                            git_branch = json
                                .get("gitBranch")
                                .and_then(|b| b.as_str())
                                .map(|s| s.to_string());
                        }
                    } else if msg_type == "assistant" {
                        message_count += 1;
                        // assistant 消息也可能有 gitBranch
                        if git_branch.is_none() {
                            git_branch = json
                                .get("gitBranch")
                                .and_then(|b| b.as_str())
                                .map(|s| s.to_string());
                        }
                    }
                }
            }
        }
    }

    (first_prompt, message_count, created, cwd, git_branch)
}

/// 列出 Claude Code 会话（旧接口）
pub async fn list_claude_code_sessions() -> Result<Vec<ClaudeSessionMeta>> {
    tracing::info!("[list_claude_code_sessions] 获取 Claude Code 会话列表");

    let claude_dir = if cfg!(windows) {
        std::env::var("USERPROFILE")
            .map(|p| PathBuf::from(p).join(".claude").join("projects"))
            .unwrap_or_else(|_| PathBuf::from(".claude").join("projects"))
    } else {
        std::env::var("HOME")
            .map(|p| PathBuf::from(p).join(".claude").join("projects"))
            .unwrap_or_else(|_| PathBuf::from(".claude").join("projects"))
    };

    let mut sessions = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&claude_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let project_name = entry.file_name().to_string_lossy().to_string();

                if let Ok(session_entries) = std::fs::read_dir(entry.path()) {
                    for session_entry in session_entries.flatten() {
                        let path = session_entry.path();
                        if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                            let session_id = path
                                .file_stem()
                                .map(|s| s.to_string_lossy().to_string())
                                .unwrap_or_default();

                            // 获取文件元数据
                            let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

                            let modified = std::fs::metadata(&path)
                                .ok()
                                .and_then(|m| m.modified().ok())
                                .map(|t| {
                                    let datetime: chrono::DateTime<chrono::Utc> = t.into();
                                    datetime.to_rfc3339()
                                });

                            // 解析会话内容获取详细信息
                            let (first_prompt, message_count, created, real_cwd, git_branch) =
                                parse_session_metadata(&path);

                            // claude_project_name: Claude Code 目录名（用于定位 jsonl 文件）
                            let claude_project_name = project_name.clone();
                            // project_path: 真实工作区路径（用于前端匹配/创建工作区）
                            let project_path = real_cwd.unwrap_or_else(|| project_name.clone());

                            // 从 git_branch 推断 PR 关联
                            let linked_pr = git_branch
                                .as_ref()
                                .and_then(|branch| extract_pr_from_branch(branch));

                            sessions.push(ClaudeSessionMeta {
                                session_id,
                                project_path,
                                claude_project_name,
                                first_prompt,
                                message_count,
                                created,
                                modified,
                                file_path: path.to_string_lossy().to_string(),
                                file_size,
                                parent_session_id: None, // 后续通过 fork 检测算法填充
                                child_session_ids: Vec::new(),
                                git_branch,
                                linked_pr,
                            });
                        }
                    }
                }
            }
        }
    }

    // 按修改时间排序（最新的在前）
    sessions.sort_by(|a, b| {
        let time_a = a
            .modified
            .as_ref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
        let time_b = b
            .modified
            .as_ref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
        time_b.cmp(&time_a)
    });

    // === Fork 检测算法 ===
    // 基于消息指纹推断 fork 关系
    infer_fork_relationships(&mut sessions);

    Ok(sessions)
}

/// 会话消息指纹（用于 fork 检测）
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct SessionFingerprint {
    session_id: String,
    /// 前 N 条消息的内容哈希
    message_hashes: Vec<String>,
    /// 创建时间戳
    created_at: i64,
}

/// 计算消息内容的简单哈希（用于指纹匹配）
fn simple_hash(content: &str) -> String {
    // 使用简单的哈希算法：取前 200 字符的字节和
    let bytes = content.as_bytes();
    let sample = &bytes[..bytes.len().min(200)];
    let hash: u64 = sample
        .iter()
        .enumerate()
        .map(|(i, &b)| (i as u64 + 1) * b as u64)
        .sum();
    format!("{:016x}", hash)
}

/// 从会话文件中提取消息指纹
fn compute_session_fingerprint(
    file_path: &PathBuf,
    session_id: &str,
) -> Option<SessionFingerprint> {
    let mut message_hashes = Vec::new();
    let mut created_at: i64 = 0;

    if let Ok(file) = std::fs::File::open(file_path) {
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(|r| r.ok()) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(msg_type) = json.get("type").and_then(|t| t.as_str()) {
                    if msg_type == "user" || msg_type == "assistant" {
                        // 提取消息内容
                        if let Some(content) = json.get("message").and_then(|m| m.get("content")) {
                            let content_str = if let Some(text) = content.as_str() {
                                text.to_string()
                            } else if let Some(arr) = content.as_array() {
                                // 数组格式，拼接所有 text
                                arr.iter()
                                    .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                                    .collect::<Vec<_>>()
                                    .join("")
                            } else {
                                String::new()
                            };

                            // 只取前 5 条消息
                            if message_hashes.len() < 5 && !content_str.is_empty() {
                                message_hashes.push(simple_hash(&content_str));
                            }
                        }

                        // 获取创建时间
                        if created_at == 0 {
                            if let Some(ts) = json.get("timestamp").and_then(|t| t.as_str()) {
                                created_at = chrono::DateTime::parse_from_rfc3339(ts)
                                    .map(|dt| dt.timestamp())
                                    .unwrap_or(0);
                            }
                        }
                    }
                }
            }
        }
    }

    if message_hashes.is_empty() {
        None
    } else {
        Some(SessionFingerprint {
            session_id: session_id.to_string(),
            message_hashes,
            created_at,
        })
    }
}

/// 推断 fork 关系
///
/// 算法：
/// 1. 计算每个会话的消息指纹（前 5 条消息的哈希）
/// 2. 按创建时间排序
/// 3. 对于每个会话，检查是否有更早的会话与其共享消息前缀
/// 4. 如果找到共享前缀 >= 80%，则认为该会话是 fork
fn infer_fork_relationships(sessions: &mut [ClaudeSessionMeta]) {
    use std::collections::HashMap;

    // 计算所有会话的指纹
    let fingerprints: HashMap<String, SessionFingerprint> = sessions
        .iter()
        .filter_map(|s| {
            compute_session_fingerprint(&PathBuf::from(&s.file_path), &s.session_id)
                .map(|fp| (s.session_id.clone(), fp))
        })
        .collect();

    // 按创建时间排序的会话 ID 列表
    let mut sorted_ids: Vec<String> = sessions.iter().map(|s| s.session_id.clone()).collect();
    sorted_ids.sort_by_key(|id| fingerprints.get(id).map(|fp| fp.created_at).unwrap_or(0));

    // 构建父子关系映射
    let mut parent_map: HashMap<String, String> = HashMap::new();

    for (i, session_id) in sorted_ids.iter().enumerate() {
        if let Some(fp) = fingerprints.get(session_id) {
            // 检查所有更早的会话
            for earlier_id in sorted_ids.iter().take(i) {
                if let Some(earlier_fp) = fingerprints.get(earlier_id) {
                    // 检查消息前缀匹配
                    if has_common_prefix(&fp.message_hashes, &earlier_fp.message_hashes) {
                        // 找到父会话
                        parent_map.insert(session_id.clone(), earlier_id.clone());
                        break;
                    }
                }
            }
        }
    }

    // 更新会话的 parent_session_id 和 child_session_ids
    for session in sessions.iter_mut() {
        if let Some(parent_id) = parent_map.get(&session.session_id) {
            session.parent_session_id = Some(parent_id.clone());
        }
    }

    // 构建子会话列表
    let mut child_map: HashMap<String, Vec<String>> = HashMap::new();
    for (child_id, parent_id) in &parent_map {
        child_map
            .entry(parent_id.clone())
            .or_default()
            .push(child_id.clone());
    }

    for session in sessions.iter_mut() {
        if let Some(children) = child_map.get(&session.session_id) {
            session.child_session_ids = children.clone();
        }
    }
}

/// 检查两个消息哈希列表是否有共同前缀
fn has_common_prefix(hashes1: &[String], hashes2: &[String]) -> bool {
    let min_len = hashes1.len().min(hashes2.len());
    if min_len < 2 {
        return false;
    }

    let match_count = hashes1
        .iter()
        .zip(hashes2.iter())
        .take(min_len)
        .filter(|(a, b)| a == b)
        .count();

    // 至少 80% 的前缀匹配
    match_count as f64 / min_len as f64 >= 0.8
}

/// 获取 Claude Code 会话历史（旧接口）
pub async fn get_claude_code_session_history(
    session_id: String,
    project_path: Option<String>,
) -> Result<Vec<ClaudeHistoryMessage>> {
    tracing::info!(
        "[get_claude_code_session_history] 获取会话历史: {}",
        session_id
    );

    let claude_dir = if cfg!(windows) {
        std::env::var("USERPROFILE")
            .map(|p| PathBuf::from(p).join(".claude").join("projects"))
            .unwrap_or_else(|_| PathBuf::from(".claude").join("projects"))
    } else {
        std::env::var("HOME")
            .map(|p| PathBuf::from(p).join(".claude").join("projects"))
            .unwrap_or_else(|_| PathBuf::from(".claude").join("projects"))
    };

    let session_file = if let Some(project) = &project_path {
        claude_dir
            .join(project)
            .join(format!("{}.jsonl", session_id))
    } else {
        let mut found = None;
        if let Ok(entries) = std::fs::read_dir(&claude_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let candidate = entry.path().join(format!("{}.jsonl", session_id));
                    if candidate.exists() {
                        found = Some(candidate);
                        break;
                    }
                }
            }
        }
        found.unwrap_or_else(|| claude_dir.join(format!("{}.jsonl", session_id)))
    };

    if !session_file.exists() {
        return Err(AppError::ValidationError(format!(
            "会话文件不存在: {:?}",
            session_file
        )));
    }

    let mut messages = Vec::new();

    if let Ok(file) = std::fs::File::open(&session_file) {
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(|r| r.ok()) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(msg_type) = json.get("type").and_then(|t| t.as_str()) {
                    match msg_type {
                        "user" => {
                            // 用户消息：content 可能是字符串或数组
                            if let Some(message) = json.get("message") {
                                if let Some(content) = message.get("content") {
                                    messages.push(ClaudeHistoryMessage {
                                        role: "user".to_string(),
                                        content: content.clone(),
                                        timestamp: json
                                            .get("timestamp")
                                            .and_then(|t| t.as_str())
                                            .map(|s| s.to_string()),
                                    });
                                }
                            }
                        }
                        "assistant" => {
                            // 助手消息：content 通常是数组（包含 text、tool_use 等）
                            if let Some(message) = json.get("message") {
                                if let Some(content) = message.get("content") {
                                    messages.push(ClaudeHistoryMessage {
                                        role: "assistant".to_string(),
                                        content: content.clone(),
                                        timestamp: json
                                            .get("timestamp")
                                            .and_then(|t| t.as_str())
                                            .map(|s| s.to_string()),
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    Ok(messages)
}
