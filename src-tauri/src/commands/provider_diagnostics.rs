//! 供应商路由诊断壳命令（第七步阶段 A1：自 commands/chat.rs 搬移）
//!
//! 管理面诊断读取，属平台壳命令白名单（step7 §阶段 D），不进总线。
use crate::error::Result;
use tauri::State;
// 供应商路由日志查询（供前端"请求响应日志面板"使用）
// ============================================================================

/// 查询供应商分组路由日志。
///
/// - 不传 `since`：返回当前缓冲内全部日志（seq 升序）；
/// - 传 `since`：仅返回 seq 大于该值的增量日志（前端轮询续拉）。
///
/// 日志由 `start_chat_inner` 的 failover 循环在各决策点写入
/// （select_initial / select_next / apply 失败 / spawn 失败 / 绑定成功 / 全不可用）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn provider_route_logs(
    since: Option<u64>,
    state: State<'_, crate::AppState>,
) -> Result<Vec<crate::services::RouteLogEntry>> {
    Ok(match since {
        Some(s) => state.provider_router.logs_since(s).await,
        None => state.provider_router.all_logs().await,
    })
}

/// 清空路由日志缓冲。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn provider_route_logs_clear(state: State<'_, crate::AppState>) -> Result<()> {
    state.provider_router.clear_logs().await;
    Ok(())
}

/// 获取供应商调用统计快照。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn provider_stats(state: State<'_, crate::AppState>) -> Result<crate::services::ProviderStatsSnapshot> {
    let collector = state.profile_stats_collector.lock().await;
    Ok(collector.snapshot())
}

/// 清空供应商调用统计计数。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn provider_stats_clear(state: State<'_, crate::AppState>) -> Result<()> {
    let mut collector = state.profile_stats_collector.lock().await;
    collector.clear();
    let path = crate::services::data_root::data_root().root().join("provider-stats.json");
    collector.save_to_disk(&path);
    Ok(())
}

/// 获取失败调用日志（支持筛选 + 分页）。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn provider_failed_calls(
    filter: crate::services::FailedCallFilter,
    state: State<'_, crate::AppState>,
) -> Result<Vec<crate::services::FailedCallLog>> {
    let collector = state.failed_call_collector.lock().await;
    Ok(collector.list(&filter))
}

/// 清空失败调用日志。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn provider_failed_calls_clear(state: State<'_, crate::AppState>) -> Result<()> {
    let mut collector = state.failed_call_collector.lock().await;
    collector.clear();
    let path = crate::services::data_root::data_root().root().join("provider-failed-calls.jsonl");
    collector.save_to_disk(&path);
    Ok(())
}