//! PermissionPromptRegistry —— Prompt 裁决的用户审批登记（P1-g，2026-10-24 审计）
//!
//! 背景：dispatch 的 `PermissionVerdict::Prompt` 此前 Phase 0 直接安全失败
//! （「需用户审批，Phase 0 暂不支持」），导致「AI 重启插件需用户确认」这类
//! 门控无法落地；同时 AI 对插件的高危操控（stop_for_plugin / uninstall）完全裸奔。
//!
//! 设计（**非阻塞审批**，兼容 dispatch 的同步契约与任意调用线程）：
//! 1. dispatch 遇 Prompt → `has_approval`？无 → `request_approval`：
//!    登记 pending（requestId → 请求快照）+ 经 EventAdapter 广播
//!    `permission.prompt` 事件（Tauri/WS 双通道到前端）→ dispatch 返回
//!    「待审批」错误（AI 收到后告知用户 / 等待批准后重试）。
//! 2. 用户在前端确认 → `respond_permission_request` command → `resolve`：
//!    批准 → 记录批准摘要（capability+action+source_kind，10 分钟 TTL）；
//!    拒绝 → 仅清 pending。
//! 3. AI 重试同一调用 → policy 再次 Prompt → `has_approval` 命中 → dispatch 放行。
//!
//! 为什么不用阻塞等待：dispatch 是同步函数，调用方横跨 spawn_blocking /
//! 独立 runtime / tokio worker，同步阻塞等待 UI 应答会卡死宿主线程；
//! 「批准 + 重试」模式与 respond_plugin_card 同构，语义清晰且零线程风险。

use crate::contracts::{Event, PermissionPromptSink, PermissionRequest, Source};
use crate::services::router::event_adapter::EventAdapter;
use chrono::Utc;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 批准有效期：同一 (capability, action, source) 摘要在该窗口内重试直接放行
const APPROVAL_TTL: Duration = Duration::from_secs(10 * 60);

/// 摘要（批准粒度）：capability + action + source 变体名。
/// 不含参数——批准的是「这一类动作」而非某一次具体调用（与语义一致：用户
/// 批准的是「AI 停这个插件的服务」这一动作类型）。
fn digest_of(req: &PermissionRequest) -> String {
    let source_kind = match &req.source {
        Source::Bootstrap => "Bootstrap",
        Source::Remote { .. } => "Remote",
        Source::Plugin { .. } => "Plugin",
    };
    format!(
        "{}|{}|{}",
        req.capability.0,
        req.action.clone().unwrap_or_default(),
        source_kind
    )
}

#[derive(Debug)]
struct PendingEntry {
    capability: String,
    action: Option<String>,
    source_kind: &'static str,
    /// 登记时刻（诊断预留；审批摘要粒度不含时间）
    #[allow(dead_code)]
    created_at_ms: i64,
}

/// 审批登记表（实现契约 PermissionPromptSink）
pub struct PermissionPromptRegistry {
    /// 未决请求：requestId → 快照（前端确认时回填）
    pending: Mutex<HashMap<String, PendingEntry>>,
    /// 已批准摘要：digest → 过期时刻
    approvals: Mutex<HashMap<String, Instant>>,
    /// 事件广播（kind=permission.prompt → Tauri/WS 到前端）
    broadcaster: Arc<EventAdapter>,
}

impl PermissionPromptRegistry {
    pub fn new(broadcaster: Arc<EventAdapter>) -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            broadcaster,
        }
    }

    /// 清理过期批准（惰性，每次 resolve/request 时顺带）
    fn gc_approvals(&self) {
        let mut approvals = self.approvals.lock().unwrap();
        approvals.retain(|_, expires| *expires > Instant::now());
    }
}

impl PermissionPromptSink for PermissionPromptRegistry {
    fn request_approval(&self, req: &PermissionRequest) -> Result<String, String> {
        self.gc_approvals();
        let request_id = uuid::Uuid::new_v4().to_string();
        let source_kind = match &req.source {
            Source::Bootstrap => "Bootstrap",
            Source::Remote { .. } => "Remote",
            Source::Plugin { .. } => "Plugin",
        };
        let caller = match &req.source {
            Source::Plugin { caller } => caller.0.clone(),
            _ => String::new(),
        };
        self.pending.lock().unwrap().insert(
            request_id.clone(),
            PendingEntry {
                capability: req.capability.0.clone(),
                action: req.action.clone(),
                source_kind,
                created_at_ms: Utc::now().timestamp_millis(),
            },
        );

        // 广播审批请求（前端确认卡；EventAdapter → EventBroadcaster → WS，
        // 桌面经 lib.rs 中继 → Tauri emit）
        self.broadcaster.broadcast(Event {
            seq: 0,
            kind: "permission.prompt".into(),
            payload: serde_json::json!({
                "requestId": request_id,
                "capability": req.capability.0,
                "action": req.action,
                "sourceKind": source_kind,
                "caller": caller,
                "resource": req.resource,
            }),
            trace: crate::contracts::TraceId(format!("prompt-{}", request_id)),
        });
        Ok(request_id)
    }

    fn has_approval(&self, req: &PermissionRequest) -> bool {
        self.gc_approvals();
        self.approvals
            .lock()
            .unwrap()
            .contains_key(&digest_of(req))
    }

    fn resolve(&self, request_id: &str, approved: bool) -> Result<bool, String> {
        let entry = self.pending.lock().unwrap().remove(request_id);
        let Some(entry) = entry else {
            return Ok(false); // 不存在/已处理：幂等返回 false
        };
        if approved {
            let digest = format!(
                "{}|{}|{}",
                entry.capability, entry.action.clone().unwrap_or_default(), entry.source_kind
            );
            self.approvals
                .lock()
                .unwrap()
                .insert(digest, Instant::now() + APPROVAL_TTL);
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{CapabilityId, PluginId, Source};

    fn make_registry() -> Arc<PermissionPromptRegistry> {
        Arc::new(PermissionPromptRegistry::new(Arc::new(EventAdapter::new(16))))
    }

    fn plugin_req(action: Option<&str>) -> PermissionRequest {
        PermissionRequest {
            capability: CapabilityId("cap.pluginServiceManager".into()),
            resource: "cap.pluginServiceManager".into(),
            source: Source::Plugin { caller: PluginId("polaris-dispatch".into()) },
            action: action.map(String::from),
        }
    }

    #[test]
    fn approval_flow_roundtrip() {
        let reg = make_registry();
        let req = plugin_req(Some("stop_for_plugin"));
        assert!(!reg.has_approval(&req), "初始无批准");

        let id = reg.request_approval(&req).unwrap();
        assert!(reg.resolve(&id, true).unwrap());
        assert!(reg.has_approval(&req), "批准后 has_approval 命中");

        // 不同 action 不共享批准
        let other = plugin_req(Some("autostart"));
        assert!(!reg.has_approval(&other));
    }

    #[test]
    fn deny_clears_pending_and_grants_no_approval() {
        let reg = make_registry();
        let req = plugin_req(Some("stop_for_plugin"));
        let id = reg.request_approval(&req).unwrap();
        assert!(reg.resolve(&id, false).unwrap());
        assert!(!reg.has_approval(&req));
        // 重复 resolve 幂等 false
        assert!(!reg.resolve(&id, true).unwrap());
    }
}
