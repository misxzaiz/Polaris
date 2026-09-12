// A1 收尾：claude-history 核函数去 _state 参数 + 重写壳命令文件
import fs from 'node:fs'

let p = 'src-tauri/src/services/ai_history_core.rs'
let s = fs.readFileSync(p, 'utf8')
s = s.replace(
  `pub async fn list_claude_code_sessions(
    _state: &crate::AppState,
)`,
  'pub async fn list_claude_code_sessions(',
)
s = s.replace(
  `pub async fn get_claude_code_session_history(
    session_id: String,
    project_path: Option<String>,
    _state: &crate::AppState,
)`,
  `pub async fn get_claude_code_session_history(
    session_id: String,
    project_path: Option<String>,
)`,
)
fs.writeFileSync(p, s)

const body = `//! 会话历史壳命令（第七步阶段 A1：实现移入 services/ai_history_core.rs，命令签名不变）
//!
//! cap.history 迁移（阶段 B）后本文件整体摘除。
use crate::ai::{HistoryMessage, PagedResult, SessionMeta};

/// 列出会话（统一接口，支持分页）
#[tauri::command]
pub async fn list_sessions(
    engine_id: String,
    page: Option<usize>,
    page_size: Option<usize>,
    work_dir: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<PagedResult<SessionMeta>> {
    crate::services::ai_history_core::list_sessions(engine_id, page, page_size, work_dir, &state)
        .await
}

/// 获取会话历史（统一接口，支持分页）
#[tauri::command]
pub async fn get_session_history(
    session_id: String,
    engine_id: String,
    page: Option<usize>,
    page_size: Option<usize>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<PagedResult<HistoryMessage>> {
    crate::services::ai_history_core::get_session_history(session_id, engine_id, page, page_size, &state)
        .await
}

/// 删除会话
#[tauri::command]
pub async fn delete_session(
    session_id: String,
    engine_id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<()> {
    crate::services::ai_history_core::delete_session(session_id, engine_id, &state).await
}

/// 列出 Claude Code 会话（旧接口，保留向后兼容）
#[tauri::command]
pub async fn list_claude_code_sessions(
    work_dir: Option<String>,
) -> Result<Vec<crate::services::ai_history_core::ClaudeSessionMeta>> {
    crate::services::ai_history_core::list_claude_code_sessions(work_dir).await
}

/// 获取 Claude Code 会话历史消息（旧接口，保留向后兼容）
#[tauri::command]
pub async fn get_claude_code_session_history(
    session_id: String,
    project_path: Option<String>,
) -> Result<Vec<crate::services::ai_history_core::ClaudeHistoryMessage>> {
    crate::services::ai_history_core::get_claude_code_session_history(session_id, project_path).await
}
`
fs.writeFileSync('src-tauri/src/commands/session_history.rs', body)
console.log('done: core _state removed + 5 thin wrappers written')
