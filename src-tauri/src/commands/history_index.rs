//! 会话历史索引命令（统一时间线查询 / 全文搜索 / 标注）
//!
//! 数据来自 `<DataRoot>/dialogs/index.db`（SQLite），self + native 会话统一成行。
//! inner 函数同时服务 Tauri IPC 与 Web HTTP dispatch。

use crate::error::Result;
use crate::services::dialog_index::{
    history_mark_inner, history_query_inner, history_search_inner, HistoryMarks,
    HistoryQueryParams, HistoryQueryResult, HistorySessionRow,
};

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn history_query(params: HistoryQueryParams) -> Result<HistoryQueryResult> {
    history_query_inner(params)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn history_search(
    query: String,
    workspace_path: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<HistorySessionRow>> {
    history_search_inner(&query, workspace_path.as_deref(), limit.unwrap_or(50))
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn history_mark(id: String, marks: HistoryMarks) -> Result<()> {
    history_mark_inner(&id, marks)
}
