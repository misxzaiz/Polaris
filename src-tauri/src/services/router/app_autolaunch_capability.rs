//! cap.app.autolaunch —— 开机自启（OS 登录自启宿主进程）
//!
//! 分工（plans/autostart-boot-launch-spec.md §3.1）：
//! - **意图写入不在本能力**：`Config.autoLaunch` 由前端设置流经 cap.config 顶层
//!   透传落盘（与其它设置字段同一条保存链）；本能力只读意图（`AutolaunchIntent`）。
//! - `status`：supported 判定（`data_root::is_isolated`）+ OS 事实查询 + 意图回显。
//!   supported=false（隔离环境 / web 端无此 cap）时前端隐藏开关。
//! - `apply`：读意图 → ensure OS 事实（幂等；见 `services::autolaunch::ensure`）。
//! - Remote 源被 policy_permission 内置 deny：手机/远端不应能改桌面机的登录行为。
//!
//! 命名说明：仓库既有 "autostart"（pluginServiceManager:autostart /
//! contributes.services[].autoStart）指插件后台服务随宿主自启，与本能力无关，
//! 故本能力用 tauri 插件同款命名 autolaunch 以避撞名。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::contracts::{standard_describe, unsupported_action, Capability, CapabilityId, Context};
use crate::services::autolaunch::{self, AutolaunchBackend, AutolaunchIntent};
use crate::services::data_root::is_isolated;

const CAP_ID: &str = "cap.app.autolaunch";
pub const AUTOLAUNCH_ACTIONS: &[&str] = &["status", "apply"];

const ISOLATED_REASON: &str =
    "隔离环境（dev 数据根覆盖 / test-profile 测试包）不支持注册开机项：正式版与测试包 \
     productName 同名，注册会争同一个 OS 启动键";

/// cap.app.autolaunch —— 开机自启能力
///
/// 不持 AppHandle（仿 config_capability 可测性原则）：OS 细节经 `AutolaunchBackend`
/// 注入、意图经 `AutolaunchIntent` 注入，单测用 mock 覆盖全部分支（不触真实数据根）。
pub struct AppAutolaunchCapability {
    intent: Arc<dyn AutolaunchIntent>,
    backend: Arc<dyn AutolaunchBackend>,
}

impl AppAutolaunchCapability {
    pub fn new(
        intent: Arc<dyn AutolaunchIntent>,
        backend: Arc<dyn AutolaunchBackend>,
    ) -> Self {
        Self { intent, backend }
    }

    /// status 纯逻辑（supported 由调用方注入 `is_isolated()` 反值，便于测试覆盖两分支）
    fn status_value(&self, supported: bool) -> Result<Value, String> {
        let configured = self.intent.configured()?;
        if !supported {
            return Ok(json!({
                "supported": false,
                "enabled": Option::<bool>::None,
                "configured": configured,
                "reason": ISOLATED_REASON,
            }));
        }
        let enabled = self.backend.is_enabled()?;
        Ok(json!({
            "supported": true,
            "enabled": enabled,
            "configured": configured,
        }))
    }

    /// describe 文档体（独立关联函数：describe 契约测试无需构造实例）
    fn describe_doc() -> Value {
        standard_describe(
            CAP_ID,
            "开机自启",
            "OS 登录自启宿主：status 查询事实与意图，apply 幂等对账（意图=Config.autoLaunch，\
             事实=OS 启动项；意图写入走设置流→cap.config，不在本能力）",
            Some(
                "apply 会注册/注销宿主的开机启动项（Windows HKCU Run），幂等 ensure；\
                 隔离环境（dev/test-profile）supported=false 拒绝；Remote 源被内置 deny",
            ),
            json!({
                "status": { "params": {}, "returns": "{ supported: bool, enabled: bool|null, configured: bool, reason?: string }；supported=false 时 enabled 为 null" },
                "apply": { "params": {}, "returns": "{ supported: true, configured: bool, enabled: bool, changed: bool }；读 Config.autoLaunch 意图并 ensure OS 事实，幂等" },
            }),
        )
    }
}

impl Capability for AppAutolaunchCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        Self::describe_doc()
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| {
                format!("cap.app.autolaunch 需要 action 参数（{AUTOLAUNCH_ACTIONS:?}）")
            })?;
        match action {
            "status" => self.status_value(!is_isolated()),
            "apply" => {
                if is_isolated() {
                    return Err(ISOLATED_REASON.to_string());
                }
                let configured = self.intent.configured()?;
                let outcome = autolaunch::ensure(configured, self.backend.as_ref())?;
                Ok(json!({
                    "supported": true,
                    "configured": outcome.configured,
                    "enabled": outcome.enabled,
                    "changed": outcome.changed,
                }))
            }
            other => Err(unsupported_action(CAP_ID, other, AUTOLAUNCH_ACTIONS)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::Source;
    use crate::contracts::validate_describe;
    use std::sync::Mutex as StdMutex;

    /// mock 后端：注册状态可断言，写操作可注入失败
    struct MockBackend {
        registered: StdMutex<bool>,
        fail_next_write: StdMutex<bool>,
    }

    impl MockBackend {
        fn new(registered: bool) -> Self {
            Self {
                registered: StdMutex::new(registered),
                fail_next_write: StdMutex::new(false),
            }
        }

        fn arm_failure(&self) {
            *self.fail_next_write.lock().unwrap() = true;
        }
    }

    impl AutolaunchBackend for MockBackend {
        fn enable(&self) -> Result<(), String> {
            if *self.fail_next_write.lock().unwrap() {
                return Err("mock enable 失败".into());
            }
            *self.registered.lock().unwrap() = true;
            Ok(())
        }

        fn disable(&self) -> Result<(), String> {
            if *self.fail_next_write.lock().unwrap() {
                return Err("mock disable 失败".into());
            }
            *self.registered.lock().unwrap() = false;
            Ok(())
        }

        fn is_enabled(&self) -> Result<bool, String> {
            Ok(*self.registered.lock().unwrap())
        }
    }

    /// 测试 Context（与 voice/mcp capability 测试同款形态）
    struct TestCtx {
        source: Source,
    }

    impl Context for TestCtx {
        fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
            Err("not implemented".into())
        }

        fn storage(&self) -> Result<&dyn crate::contracts::Storage, String> {
            Err("not implemented".into())
        }

        fn check_permission(
            &self,
            _req: &crate::contracts::PermissionRequest,
        ) -> Result<crate::contracts::PermissionVerdict, String> {
            Ok(crate::contracts::PermissionVerdict::Allow)
        }

        fn source(&self) -> &Source {
            &self.source
        }

        fn caller_id(&self) -> &crate::contracts::PluginId {
            static PLUGIN_ID: std::sync::OnceLock<crate::contracts::PluginId> =
                std::sync::OnceLock::new();
            PLUGIN_ID.get_or_init(|| crate::contracts::PluginId("test".into()))
        }

        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }

    /// 意图 mock：固定返回 configured（2026-10-31 修复：12a198ed 提交的测试引用了
    /// 未定义的 FixedIntent，整个 lib test 目标无法编译）
    struct FixedIntent(bool);

    impl AutolaunchIntent for FixedIntent {
        fn configured(&self) -> Result<bool, String> {
            Ok(self.0)
        }
    }

    fn make_cap(intent: bool, registered: bool) -> AppAutolaunchCapability {
        AppAutolaunchCapability::new(
            Arc::new(FixedIntent(intent)),
            Arc::new(MockBackend::new(registered)),
        )
    }

    #[test]
    fn describe_contract() {
        let cap = make_cap(false, false);
        let d = cap.describe();
        let problems = validate_describe(CAP_ID, &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");
        let actions = d["actions"].as_object().unwrap();
        assert_eq!(actions.len(), AUTOLAUNCH_ACTIONS.len());
        for name in AUTOLAUNCH_ACTIONS {
            assert!(actions.contains_key(*name), "describe 缺动作 {name}");
        }
    }

    #[test]
    fn ensure_noop_when_consistent() {
        let b = MockBackend::new(true);
        let out = autolaunch::ensure(true, &b).unwrap();
        assert!(!out.changed);
        assert!(out.enabled && out.configured);

        let b = MockBackend::new(false);
        let out = autolaunch::ensure(false, &b).unwrap();
        assert!(!out.changed);
        assert!(!out.enabled);
    }

    #[test]
    fn ensure_enable_and_disable_reconcile() {
        let b = MockBackend::new(false);
        let out = autolaunch::ensure(true, &b).unwrap();
        assert!(out.changed && out.enabled);
        assert!(b.is_enabled().unwrap());

        let out = autolaunch::ensure(false, &b).unwrap();
        assert!(out.changed && !out.enabled);
        assert!(!b.is_enabled().unwrap());
    }

    #[test]
    fn ensure_os_failure_propagates() {
        // OS 写失败只报错：调用方不持有可写意图，漂移方向恒为「意图开/事实关」，
        // 下次启动 reconcile 自愈
        let b = MockBackend::new(false);
        b.arm_failure();
        let err = autolaunch::ensure(true, &b).unwrap_err();
        assert!(err.contains("enable"));
        assert!(!b.is_enabled().unwrap(), "失败后事实不变");
    }

    #[test]
    fn status_unsupported_reports_reason_and_null_fact() {
        let cap = make_cap(false, false);
        let v = cap.status_value(false).unwrap();
        assert_eq!(v["supported"], false);
        assert!(v["enabled"].is_null(), "隔离环境事实应为 null");
        assert_eq!(v["configured"], false);
        assert!(v["reason"].as_str().unwrap().contains("隔离环境"));
    }

    #[test]
    fn status_supported_reports_fact_and_intent() {
        let cap = make_cap(false, true);
        let v = cap.status_value(true).unwrap();
        assert_eq!(v["supported"], true);
        assert_eq!(v["enabled"], true);
        assert_eq!(v["configured"], false);
    }

    #[test]
    fn invoke_status_and_apply_flow() {
        let cap = make_cap(true, false);
        let ctx = TestCtx {
            source: Source::Bootstrap,
        };
        let v = cap
            .invoke(json!({"action": "status"}), &ctx)
            .expect("status 应成功（测试环境非隔离）");
        assert_eq!(v["configured"], true);
        assert_eq!(v["enabled"], false);

        let v = cap
            .invoke(json!({"action": "apply"}), &ctx)
            .expect("apply 应成功");
        assert_eq!(v["changed"], true);
        assert_eq!(v["enabled"], true);
        // 再 apply：幂等，无写
        let v = cap.invoke(json!({"action": "apply"}), &ctx).unwrap();
        assert_eq!(v["changed"], false);
    }

    #[test]
    fn invoke_rejects_unknown_action_with_selfheal_hint() {
        let cap = make_cap(false, false);
        let ctx = TestCtx {
            source: Source::Bootstrap,
        };
        let err = cap
            .invoke(json!({"action": "nope"}), &ctx)
            .unwrap_err();
        assert!(err.contains("status"), "错误应列出合法动作: {err}");
        assert!(err.contains("apply"), "错误应列出合法动作: {err}");
    }
}
