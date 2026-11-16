//! cap.usage —— 用量统计能力（K-R5 批E2：commands/usage.rs 的 tauri command 收口）
//!
//! 数据来源：UsageDb 全局单例（代理 handler 转发响应时写入）。
//! 前端 tokenAnalyticsStore 与 AI/插件统一经本能力查询；Web 端 /api/ipc
//! 的 usage 分支保留（同一 usage_db 实现）。
//!
//! 动作协议（payload `{ "action": ... }`，参数 camelCase，与原命令一致）：
//! - `summary`       `{ startDate?, endDate?, model?, engineId? }` → UsageSummary
//! - `model_stats`   `{ startDate?, endDate?, engineId? }`         → ModelUsageStats[]
//! - `engine_stats`  `{ startDate?, endDate?, model? }`            → EngineUsageStats[]
//! - `daily_trends`  `{ startDate?, endDate?, engineId?, model? }` → DailyUsageStats[]
//! - `recent_logs`   `{ limit?, offset?, startDate?, endDate?, model?, engineId? }` → UsageLogEntry[]

use crate::contracts::{standard_describe, unsupported_action, Capability, CapabilityId, Context, Value};

const CAP_ID: &str = "cap.usage";

pub const USAGE_ACTIONS: &[&str] = &[
    "summary",
    "model_stats",
    "engine_stats",
    "daily_trends",
    "recent_logs",
];

pub struct UsageCapability;

fn opt_i64(params: &Value, k: &str) -> Option<i64> {
    params.get(k).and_then(|v| v.as_i64())
}

fn opt_str<'a>(params: &'a Value, k: &str) -> Option<&'a str> {
    params.get(k).and_then(|v| v.as_str())
}

fn db() -> Result<&'static crate::services::usage_db::UsageDb, String> {
    crate::services::usage_db::get_usage_db()
        .ok_or_else(|| "用量数据库未初始化".to_string())
}

impl UsageCapability {
    fn dispatch_action(&self, params: &Value) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("cap.usage 需要 action 参数（{:?}）", USAGE_ACTIONS))?;
        match action {
            "summary" => {
                let r = db()
                    .and_then(|d| d.get_summary(
                        opt_i64(params, "startDate"),
                        opt_i64(params, "endDate"),
                        opt_str(params, "model"),
                        opt_str(params, "engineId"),
                    ).map_err(|e| e.to_string()))?;
                serde_json::to_value(r).map_err(|e| e.to_string())
            }
            "model_stats" => {
                let r = db()
                    .and_then(|d| d.get_model_stats(
                        opt_i64(params, "startDate"),
                        opt_i64(params, "endDate"),
                        opt_str(params, "engineId"),
                    ).map_err(|e| e.to_string()))?;
                serde_json::to_value(r).map_err(|e| e.to_string())
            }
            "engine_stats" => {
                let r = db()
                    .and_then(|d| d.get_engine_stats(
                        opt_i64(params, "startDate"),
                        opt_i64(params, "endDate"),
                        opt_str(params, "model"),
                        opt_str(params, "engineId"),
                    ).map_err(|e| e.to_string()))?;
                serde_json::to_value(r).map_err(|e| e.to_string())
            }
            "daily_trends" => {
                let r = db()
                    .and_then(|d| d.get_daily_trends(
                        opt_i64(params, "startDate"),
                        opt_i64(params, "endDate"),
                        opt_str(params, "engineId"),
                        opt_str(params, "model"),
                    ).map_err(|e| e.to_string()))?;
                serde_json::to_value(r).map_err(|e| e.to_string())
            }
            "recent_logs" => {
                let r = db()
                    .and_then(|d| d.get_recent_logs(
                        opt_i64(params, "limit").unwrap_or(50),
                        opt_i64(params, "offset").unwrap_or(0),
                        opt_i64(params, "startDate"),
                        opt_i64(params, "endDate"),
                        opt_str(params, "model"),
                        opt_str(params, "engineId"),
                    ).map_err(|e| e.to_string()))?;
                serde_json::to_value(r).map_err(|e| e.to_string())
            }
            other => Err(unsupported_action(CAP_ID, other, USAGE_ACTIONS)),
        }
    }
}

impl Capability for UsageCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        standard_describe(
            CAP_ID,
            "用量统计",
            "代理层 API 用量查询（汇总/按模型/按引擎/日趋势/明细日志），只读",
            None,
            serde_json::json!({
                "summary": { "params": { "startDate?": "int(ms)", "endDate?": "int(ms)", "model?": "string", "engineId?": "string" }, "returns": "UsageSummary" },
                "model_stats": { "params": { "startDate?": "int(ms)", "endDate?": "int(ms)", "engineId?": "string" }, "returns": "ModelUsageStats[]" },
                "engine_stats": { "params": { "startDate?": "int(ms)", "endDate?": "int(ms)", "model?": "string" }, "returns": "EngineUsageStats[]" },
                "daily_trends": { "params": { "startDate?": "int(ms)", "endDate?": "int(ms)", "engineId?": "string", "model?": "string" }, "returns": "DailyUsageStats[]" },
                "recent_logs": { "params": { "limit?": "int", "offset?": "int", "startDate?": "int(ms)", "endDate?": "int(ms)", "model?": "string", "engineId?": "string" }, "returns": "UsageLogEntry[]" },
            }),
        )
    }

    fn invoke(&self, payload: Value, _ctx: &dyn Context) -> Result<Value, String> {
        self.dispatch_action(&payload)
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}
