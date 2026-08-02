//! 用量统计命令
//!
//! 查询代理层拦截的 API 用量数据，覆盖所有经过代理的请求路径。
//! 数据来源：UsageDb 全局单例（代理 handler 在转发响应时写入）。

use crate::error::AppError;
use crate::services::usage_db::{self, UsageSummary, ModelUsageStats, DailyUsageStats, UsageLogEntry};

/// 获取用量汇总（按时间范围/模型/引擎筛选）
#[tauri::command]
pub fn get_usage_summary(
    start_date: Option<i64>,
    end_date: Option<i64>,
    model: Option<String>,
    engine_id: Option<String>,
) -> Result<UsageSummary, AppError> {
    let db = usage_db::get_usage_db()
        .ok_or_else(|| AppError::StateError("用量数据库未初始化".to_string()))?;
    db.get_summary(start_date, end_date, model.as_deref(), engine_id.as_deref())
}

/// 按模型分组统计
#[tauri::command]
pub fn get_usage_model_stats(
    start_date: Option<i64>,
    end_date: Option<i64>,
    engine_id: Option<String>,
) -> Result<Vec<ModelUsageStats>, AppError> {
    let db = usage_db::get_usage_db()
        .ok_or_else(|| AppError::StateError("用量数据库未初始化".to_string()))?;
    db.get_model_stats(start_date, end_date, engine_id.as_deref())
}

/// 按天统计趋势
#[tauri::command]
pub fn get_usage_daily_trends(
    start_date: Option<i64>,
    end_date: Option<i64>,
    model: Option<String>,
    engine_id: Option<String>,
) -> Result<Vec<DailyUsageStats>, AppError> {
    let db = usage_db::get_usage_db()
        .ok_or_else(|| AppError::StateError("用量数据库未初始化".to_string()))?;
    db.get_daily_trends(start_date, end_date, model.as_deref(), engine_id.as_deref())
}

/// 获取最近 N 条记录
#[tauri::command]
pub fn get_usage_recent_logs(
    limit: Option<i64>,
    start_date: Option<i64>,
    end_date: Option<i64>,
    model: Option<String>,
    engine_id: Option<String>,
) -> Result<Vec<UsageLogEntry>, AppError> {
    let db = usage_db::get_usage_db()
        .ok_or_else(|| AppError::StateError("用量数据库未初始化".to_string()))?;
    db.get_recent_logs(limit.unwrap_or(20), start_date, end_date, model.as_deref(), engine_id.as_deref())
}