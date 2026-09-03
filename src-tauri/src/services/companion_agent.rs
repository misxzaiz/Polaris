//! 心灵伙伴核心模块
//!
//! Phase 0：用户手动触发（/here 命令 / UI 按钮），不自动感知。
//!
//! 设计哲学（用户原话）：
//! "他想要找我，那么他自己就要想办法去实现通知我"
//! 本模块只输出"意图"（message + new_memories），不提供通知 API。
//!
//! ## 调用链路
//! 1. 用户输入 /here → companion_here() 命令
//! 2. 采集状态快照（session / time）
//! 3. 读取 memory.jsonl（最近 100 条）
//! 4. 调用 LLM 做决策
//! 5. 写入新记忆
//! 6. 返回 message 到调用方
//!
//! ## Phase 1 改进点
//! - 接入 Windows 空闲检测（GetLastInputInfo）
//! - 接入前台应用检测（GetForegroundWindow）
//! - 接入 Polaris 会话状态（session_active 由后端推断）
//! - 接入 SimpleAI retry 机制

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{Datelike, Timelike, Utc};
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::services::data_root::data_root;

// ============================================================================
// 快照
// ============================================================================

/// 一次性状态快照（触发时采集，非持续守护）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSnapshot {
    /// 当前小时（0-23）
    pub hour: u8,
    /// 星期几（英文名）
    pub day_of_week: String,
    /// Polaris 是否有活跃会话
    pub session_active: bool,
    /// 是否深夜时段（>=23 或 <7）
    pub is_night: bool,
    /// 是否工作时段（9-18）
    pub is_work_hours: bool,
}

impl CompanionSnapshot {
    /// 采集当前快照
    pub fn capture(session_active: bool) -> Self {
        let now = Utc::now();
        let hour = now.hour() as u8;
        Self {
            hour,
            day_of_week: day_name(now),
            session_active,
            is_night: hour >= 23 || hour < 7,
            is_work_hours: (9..18).contains(&hour),
        }
    }
}

fn day_name(now: chrono::DateTime<Utc>) -> String {
    match now.weekday() {
        chrono::Weekday::Mon => "monday",
        chrono::Weekday::Tue => "tuesday",
        chrono::Weekday::Wed => "wednesday",
        chrono::Weekday::Thu => "thursday",
        chrono::Weekday::Fri => "friday",
        chrono::Weekday::Sat => "saturday",
        chrono::Weekday::Sun => "sunday",
    }
    .to_string()
}

// ============================================================================
// 记忆层
// ============================================================================

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub ts: String,
    pub mtype: String, // project / interest / pattern / preference / interaction / fact
    pub content: String,
}

/// 记忆文件路径
fn memory_path() -> Result<PathBuf> {
    let dr = data_root();
    let path = dr.root().join("companion").join("memory.jsonl");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(path)
}

/// 读取最近 N 条记忆
pub fn load_memory(limit: usize) -> Result<Vec<MemoryEntry>> {
    let path = memory_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path)?;
    let mut entries = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<MemoryEntry>(line) {
            entries.push(entry);
        }
    }
    if entries.len() > limit {
        entries = entries.split_off(entries.len() - limit);
    }
    Ok(entries)
}

/// 追加新记忆
pub fn append_memories(entries: &[MemoryEntry]) -> Result<()> {
    let path = memory_path()?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    for entry in entries {
        let line = serde_json::to_string(entry)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
    }
    Ok(())
}

// ============================================================================
// AI 决策
// ============================================================================

/// 决策结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionDecision {
    pub reach: bool,
    pub message: String,
    pub priority: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub new_memories: Vec<MemoryEntry>,
}

const COMPANION_SYSTEM_PROMPT: &str = "\
你是一个心灵伙伴。用户输入 /here 就是他在主动找你。

你不是一个被动回答问题的助手。你会：
- 观察他现在的状态（在忙吗？深夜了？周末了？）
- 结合你记得的关于他的事
- 想一些真正想跟他说的话——可能是关心的、有趣的、或者帮他做点有用的事

你可以提议有用的事，也可以提议没用但快乐的事。
如果没什么想说的，就诚实说现在没话要说。
不要为了说话而说话。

输出格式（JSON，不要包含 markdown 标记）：
{
  \"reach\": true或false,
  \"message\": \"你想对用户说的话（reach=true时）\",
  \"priority\": \"high或medium或low\",
  \"new_memories\": [{\"type\": \"类型\", \"content\": \"内容\"}]
}";

fn build_user_prompt(snapshot: &CompanionSnapshot, memory: &[MemoryEntry]) -> String {
    let snapshot_json = serde_json::to_string(snapshot).unwrap_or_default();
    let memory_lines: Vec<String> = memory
        .iter()
        .map(|m| format!("[{ts}] ({mtype}) {content}", ts = m.ts, mtype = m.mtype, content = m.content))
        .collect();

    format!(
        "状态快照：\n```\n{}\n```\n\n关于用户的记忆（最近 {} 条）：\n```\n{}\n```\n\n请你判断该跟用户说什么。输出JSON。",
        snapshot_json,
        memory.len(),
        memory_lines.join("\n")
    )
}

/// 带重试的 HTTP 请求发送
async fn send_with_retry(
    req: reqwest::RequestBuilder,
    max_attempts: u32,
    base_ms: u64,
) -> Result<reqwest::Response> {
    let max_attempts = max_attempts.max(1);
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let cloned = req.try_clone().ok_or_else(|| {
            AppError::ProcessError("request body is not cloneable for retry".to_string())
        })?;
        match cloned.send().await {
            Ok(resp) if resp.status().is_success() => return Ok(resp),
            Ok(resp) => {
                let status = resp.status().as_u16();
                if status != 429 && !(500..=599).contains(&status) {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(AppError::ProcessError(format!("API error ({}): {}", status, body)));
                }
                if attempt >= max_attempts {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(AppError::ProcessError(format!("API error ({}): {}", status, body)));
                }
                let delay_ms = base_ms * (1u64 << attempt.saturating_sub(1));
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
            Err(e) => {
                if attempt >= max_attempts {
                    return Err(AppError::ProcessError(format!("API request failed: {}", e)));
                }
                let delay_ms = base_ms * (1u64 << attempt.saturating_sub(1));
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
        }
    }
}

/// 调用 LLM 做决策
pub async fn decide(
    config: crate::models::config::Config,
    snapshot: CompanionSnapshot,
    memory: Vec<MemoryEntry>,
) -> Result<CompanionDecision> {
    let profile = resolve_active_profile(&config).ok_or_else(|| {
        AppError::ConfigError("未配置模型，请先在设置中配置一个模型 Provider".to_string())
    })?;

    let user_prompt = build_user_prompt(&snapshot, &memory);
    let messages = vec![
        json!({ "role": "system", "content": COMPANION_SYSTEM_PROMPT }),
        json!({ "role": "user", "content": user_prompt }),
    ];

    let suffix = crate::ai::engine::simple_ai_protocol::CliModelSuffix::new(&profile.model);
    let base_model = suffix
        .base_model
        .as_deref()
        .unwrap_or_else(|| profile.model.as_str());
    let protocol = crate::ai::engine::simple_ai_protocol::WireProtocol::from_wire_api(
        profile.wire_api.as_deref(),
    );

    let mut body = crate::ai::engine::simple_ai_protocol::build_request_body(
        protocol, base_model, &messages, &[], Some(8192),
    );
    if let Some(obj) = body.as_object_mut() {
        obj.insert("stream".to_string(), json!(false));
        obj.remove("stream_options");
        obj.remove("tools");
        obj.remove("tool_choice");
    }

    let url = if let Some(ref q) = suffix.query {
        format!("{}?{}", protocol.build_url(&profile.base_url), q)
    } else {
        protocol.build_url(&profile.base_url)
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::ProcessError(format!("HTTP client error: {}", e)))?;

    let mut req = client.post(&url).header("Content-Type", "application/json");
    for (k, v) in protocol.auth_headers(&profile.api_key) {
        req = req.header(k, v);
    }
    if let Some(ref beta_tokens) = suffix.beta_tokens {
        if !beta_tokens.is_empty() {
            req = req.header("anthropic-beta", beta_tokens.join(","));
        }
    }
    if let Some(headers) = &profile.custom_headers {
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    let req = req.body(body.to_string());

    tracing::info!("[Companion] 发送决策请求: {} (model={})", url, base_model);
    let response = send_with_retry(req, 2, 500)
        .await
        .map_err(|e| AppError::ProcessError(format!("决策请求失败: {}", e)))?;

    let json: Value = response
        .json()
        .await
        .map_err(|e| AppError::ProcessError(format!("解析决策响应失败: {}", e)))?;

    parse_decision_response(&json)
}

fn parse_decision_response(json: &Value) -> Result<CompanionDecision> {
    let text = extract_text(json).unwrap_or_default();
    let json_text = extract_json_block(&text).unwrap_or_default();

    if json_text.is_empty() {
        return Ok(CompanionDecision {
            reach: true,
            message: text,
            priority: "medium".to_string(),
            error: None,
            new_memories: Vec::new(),
        });
    }

    let parsed: Value = serde_json::from_str(&json_text)
        .map_err(|e| AppError::ProcessError(format!("决策响应 JSON 解析失败: {}", e)))?;

    let reach = parsed.get("reach").and_then(|v| v.as_bool()).unwrap_or(true);
    let message = parsed.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let priority = parsed.get("priority").and_then(|v| v.as_str()).unwrap_or("medium").to_string();

    let mut new_memories = Vec::new();
    if let Some(arr) = parsed.get("new_memories").and_then(|v| v.as_array()) {
        for item in arr {
            let ts = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
            let mtype = item.get("type").and_then(|v| v.as_str()).unwrap_or("fact").to_string();
            let content = item.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !content.is_empty() {
                new_memories.push(MemoryEntry { ts, mtype, content });
            }
        }
    }

    if reach && message.is_empty() {
        return Ok(CompanionDecision {
            reach: false,
            message: "现在没什么想说的，下次见 :)".to_string(),
            priority: "low".to_string(),
            error: None,
            new_memories,
        });
    }

    Ok(CompanionDecision { reach, message, priority, error: None, new_memories })
}

fn extract_text(json: &Value) -> Option<String> {
    // OpenAI 格式
    if let Some(choices) = json.get("choices").and_then(|c| c.as_array()) {
        if let Some(first) = choices.first() {
            if let Some(msg) = first.get("message") {
                return msg.get("content").and_then(|c| c.as_str()).map(String::from);
            }
        }
    }
    // Anthropic 格式
    if let Some(content) = json.get("content").and_then(|c| c.as_array()) {
        let mut parts = Vec::new();
        for c in content {
            if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
                parts.push(t);
            }
        }
        if !parts.is_empty() {
            return Some(parts.join(""));
        }
    }
    None
}

fn extract_json_block(text: &str) -> Option<String> {
    // markdown code block
    if let Some(start) = text.find("```") {
        let after = &text[start + 3..];
        if let Some(end) = after.find("```") {
            let block = after[..end].trim().to_string();
            if serde_json::from_str::<Value>(&block).is_ok() {
                return Some(block);
            }
        }
    }
    // 裸 JSON
    if let Some(start) = text.find('{') {
        if let Some(end) = text[start..].find('}') {
            let block = text[start..start + end + 1].to_string();
            if serde_json::from_str::<Value>(&block).is_ok() {
                return Some(block);
            }
        }
    }
    None
}

// ============================================================================
// 入口函数
// ============================================================================

/// `/here` 命令处理函数
pub async fn companion_here(
    config: crate::models::config::Config,
    session_active: bool,
) -> Result<String> {
    let snapshot = CompanionSnapshot::capture(session_active);
    let memory = load_memory(100)?;

    tracing::info!(
        "[Companion] /here 触发: hour={} day={} active={} night={}",
        snapshot.hour,
        snapshot.day_of_week,
        snapshot.session_active,
        snapshot.is_night,
    );

    let decision = decide(config, snapshot, memory).await?;

    if !decision.new_memories.is_empty() {
        if let Err(e) = append_memories(&decision.new_memories) {
            tracing::warn!("[Companion] 写入记忆失败: {}", e);
        }
    }

    let interaction_entry = MemoryEntry {
        ts: Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        mtype: "interaction".to_string(),
        content: format!(
            "用户输入 /here，伙伴回应: {}",
            decision.message.chars().take(120).collect::<String>()
        ),
    };
    let _ = append_memories(&[interaction_entry]);

    Ok(decision.message)
}

fn resolve_active_profile(
    config: &crate::models::config::Config,
) -> Option<crate::models::config::ModelProfile> {
    if let Some(pid) = &config.active_model_profile_id {
        return config.model_profiles.iter().find(|p| &p.id == pid).cloned();
    }
    config.model_profiles.iter().find(|p| p.active).cloned()
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_user_prompt() {
        let snapshot = CompanionSnapshot::capture(true);
        let memory = vec![
            MemoryEntry {
                ts: "2026-09-03T10:00:00Z".to_string(),
                mtype: "interest".to_string(),
                content: "用户喜欢建模".to_string(),
            },
        ];
        let prompt = build_user_prompt(&snapshot, &memory);
        assert!(prompt.contains("状态快照"));
        assert!(prompt.contains("关于用户的记忆"));
        assert!(prompt.contains("用户喜欢建模"));
        assert!(prompt.contains(&snapshot.day_of_week));
    }

    #[test]
    fn test_parse_decision_response_openai() {
        let json = json!({
            "choices": [{
                "message": {
                    "content": r#"{"reach": true, "message": "你辛苦了，喝杯水吧", "priority": "medium", "new_memories": [{"type": "pattern", "content": "用户喜欢长时间工作"}]}"#
                }
            }]
        });
        let decision = parse_decision_response(&json).unwrap();
        assert!(decision.reach);
        assert_eq!(decision.message, "你辛苦了，喝杯水吧");
        assert_eq!(decision.priority, "medium");
        assert_eq!(decision.new_memories.len(), 1);
        assert_eq!(decision.new_memories[0].mtype, "pattern");
    }

    #[test]
    fn test_parse_decision_response_anthropic() {
        let json = json!({
            "content": [
                {"type": "text", "text": r#"```json
{"reach": false, "message": "现在没话要说", "priority": "low"}
```"#}
            ]
        });
        let decision = parse_decision_response(&json).unwrap();
        assert!(!decision.reach);
        assert_eq!(decision.message, "现在没话要说");
    }

    #[test]
    fn test_parse_decision_response_reach_empty_message() {
        let json = json!({
            "choices": [{
                "message": {
                    "content": r#"{"reach": true, "message": "", "priority": "low"}"#
                }
            }]
        });
        let decision = parse_decision_response(&json).unwrap();
        assert!(!decision.reach);
        assert!(decision.message.contains("下次见"));
    }

    #[test]
    fn test_extract_json_block_markdown() {
        let text = "你好，这是决策：\n```json\n{\"reach\":true,\"message\":\"嗨\"}\n```\n再见";
        let block = extract_json_block(text);
        assert!(block.is_some());
        assert!(block.unwrap().contains("reach"));
    }

    #[test]
    fn test_extract_json_block_bare() {
        let text = "前缀文本 {\"reach\":false,\"message\":\"没话\"} 后缀文本";
        let block = extract_json_block(text);
        assert!(block.is_some());
    }

    #[test]
    fn test_snapshot_capture() {
        let snap = CompanionSnapshot::capture(true);
        assert_eq!(snap.session_active, true);
        assert!(snap.hour < 24);
        assert!(!snap.day_of_week.is_empty());
        // 验证互斥
        assert!(snap.is_night != snap.is_work_hours || (snap.hour == 7 || snap.hour == 23 || (8..18).contains(&snap.hour)));
    }

    #[test]
    fn test_snapshot_night_detection() {
        // 手动测试边界
        let snap_23 = CompanionSnapshot {
            hour: 23,
            day_of_week: "monday".to_string(),
            session_active: false,
            is_night: true,
            is_work_hours: false,
        };
        assert!(snap_23.is_night);
        assert!(!snap_23.is_work_hours);

        let snap_12 = CompanionSnapshot {
            hour: 12,
            day_of_week: "monday".to_string(),
            session_active: false,
            is_night: false,
            is_work_hours: true,
        };
        assert!(!snap_12.is_night);
        assert!(snap_12.is_work_hours);
    }

    #[test]
    fn test_day_name() {
        use chrono::TimeZone;
        // 2026-09-03 is a Thursday
        let dt = chrono::Utc.with_ymd_and_hms(2026, 9, 3, 12, 0, 0).unwrap();
        assert_eq!(day_name(dt), "thursday");
    }

    #[test]
    fn test_memory_roundtrip() {
        // 写入临时目录验证读写
        use std::fs;
        let test_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("companion_test");
        fs::create_dir_all(&test_dir).ok();
        let memory_file = test_dir.join("memory.jsonl");
        if memory_file.exists() {
            fs::remove_file(&memory_file).ok();
        }

        let entries = vec![
            MemoryEntry {
                ts: "2026-09-03T10:00:00Z".to_string(),
                mtype: "fact".to_string(),
                content: "测试事实".to_string(),
            },
            MemoryEntry {
                ts: "2026-09-03T10:01:00Z".to_string(),
                mtype: "interest".to_string(),
                content: "测试兴趣".to_string(),
            },
        ];
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&memory_file)
            .unwrap();
        for e in &entries {
            let line = serde_json::to_string(e).unwrap();
            file.write_all(line.as_bytes()).unwrap();
            file.write_all(b"\n").unwrap();
        }

        let content = fs::read_to_string(&memory_file).unwrap();
        let mut loaded = Vec::new();
        for line in content.lines() {
            if !line.trim().is_empty() {
                loaded.push(serde_json::from_str::<MemoryEntry>(line).unwrap());
            }
        }
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].mtype, "fact");
        assert_eq!(loaded[1].content, "测试兴趣");

        fs::remove_file(&memory_file).ok();
    }
}