//! cap.app.update —— 应用自动更新（触发即自更新，无二次确认）
//!
//! 分工（plans/auto-update-plan.md §5）：
//! - 意图（更新源配置）不在本能力：`Config.update` 由前端设置流经 cap.config
//!   顶层透传落盘（与 autoLaunch 同链）；本能力只读意图（`UpdateIntent`）。
//! - `status`：当前版本 + 源配置回显 + 最新版本检查（不安装，只读可对 Remote 放行）。
//! - `run`：读意图 → spawn 后台任务（backend.check → download_and_install），
//!   **立即返回 started**；进度经装配时注入的 emit 通道广播 `update.progress` /
//!   `update.completed` 事件。触发即跑到底，不弹任何确认 UI（spec 核心诉求：
//!   手机远程触发 → 电脑自装自重启）。
//! - 执行体经 `UpdateBackend` trait 注入（生产 = TauriUpdateBackend，tauri-app
//!   feature 下编译），本文件不引用 tauri / updater——Web-only 构建不挂。
//! - 权限：status/run 对已鉴权 Remote 放行（policy_permission 内置 require_auth
//!   规则，手机/Web 触发是本能力的核心场景）；未鉴权 Remote 维持 deny。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::contracts::{standard_describe, unsupported_action, Capability, CapabilityId, Context};
use crate::services::auto_update::{UpdateBackend, UpdateIntent};

const CAP_ID: &str = "cap.app.update";
pub const APP_UPDATE_ACTIONS: &[&str] = &["status", "run"];

/// 进度/完成事件广播通道（生产 = AppHandle emit + EventBroadcaster 双通道，
/// 由 lib.rs 装配处注入；测试 = 收集到 Vec 断言）
pub type UpdateEmit = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// run 动作的运行状态闸：防并发重入（两次 run 同时下载会互相干扰 MSI/临时文件）
static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// cap.app.update 能力
///
/// 不持 AppHandle（仿 autolaunch 可测性原则）：执行体经 `UpdateBackend` 注入、
/// 意图经 `UpdateIntent` 注入、事件经 `UpdateEmit` 注入，单测用 mock 全覆盖。
pub struct AppUpdateCapability {
    intent: Arc<dyn UpdateIntent>,
    backend: Arc<dyn UpdateBackend>,
    emit: UpdateEmit,
}

impl AppUpdateCapability {
    pub fn new(
        intent: Arc<dyn UpdateIntent>,
        backend: Arc<dyn UpdateBackend>,
        emit: UpdateEmit,
    ) -> Self {
        Self {
            intent,
            backend,
            emit,
        }
    }

    /// 当前宿主版本：编译期取 `CARGO_PKG_VERSION`。
    /// 与 tauri.conf.json 的 version 由发布流程保持同步（发布脚本统一 bump 两处）。
    fn current_version() -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    /// describe 文档体（独立关联函数：describe 契约测试无需构造实例）
    fn describe_doc() -> Value {
        standard_describe(
            CAP_ID,
            "应用自动更新",
            "宿主自更新：status 查询版本与源配置，run 触发即自动「下载→安装→重启」\
             （无二次确认，触发即跑到底）；进度经 update.progress 事件广播",
            Some(
                "run 会重启宿主进程（新版本替换旧版本）；对已鉴权 Remote 放行\
                 （手机/Web 远程触发是核心场景）；源配置 Config.update 走 cap.config 保存流",
            ),
            json!({
                "status": { "params": {}, "returns": "{ currentVersion: string, source: object, latestVersion: string|null, updateAvailable: bool }" },
                "run": { "params": { "force": "bool（可选，true 忽略版本比较强制重装）" }, "returns": "{ started: true, version?: string }；下载安装完成后宿主自动重启" },
            }),
        )
    }

    /// status 逻辑（backend 检查失败不致命——只读动作用户可重试）
    fn status_value(&self, latest: Option<&crate::services::auto_update::UpdateInfo>) -> Value {
        let source = self
            .intent
            .source_config()
            .unwrap_or_default();
        let current = Self::current_version();
        let (latest_version, update_available) = match latest {
            Some(info) => {
                let has = crate::services::auto_update::version_gt(&info.version, &current);
                (Some(info.version.clone()), has)
            }
            None => (None, false),
        };
        json!({
            "currentVersion": current,
            "source": source,
            "latestVersion": latest_version,
            "updateAvailable": update_available,
        })
    }
}

impl Capability for AppUpdateCapability {
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
                format!("cap.app.update 需要 action 参数（{APP_UPDATE_ACTIONS:?}）")
            })?;
        match action {
            "status" => {
                // status 是同步 invoke：网络检查在后台早已无法回填，这里回显
                // 意图配置 + 当前版本；最新版本由 run/status 的后台检查广播。
                // 设计取舍：invoke 契约是同步的（X5 900s 护栏），网络检查放 run 的
                // 后台任务；status 只回显本地事实（零网络，稳定快）。
                Ok(self.status_value(None))
            }
            "run" => {
                let force = params
                    .get("force")
                    .and_then(|f| f.as_bool())
                    .unwrap_or(false);
                let source = self.intent.source_config()?;
                // 防重入：上一次 run 还在下载/安装时拒绝新的 run
                if RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    return Err("已有更新任务进行中（run 不可重入；等待 update.completed 或重启）".into());
                }
                let backend = self.backend.clone();
                let emit = self.emit.clone();
                tokio::spawn(async move {
                    let _guard = RunningGuard;
                    let result = run_update_flow(backend, source, force, emit).await;
                    if let Err(e) = result {
                        tracing::warn!("cap.app.update run 失败: {e}");
                    }
                });
                Ok(json!({ "started": true }))
            }
            other => Err(unsupported_action(CAP_ID, other, APP_UPDATE_ACTIONS)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

/// RUNNING 标志的 RAII 守卫：任务退出（含 panic）时复位
struct RunningGuard;
impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// run 的完整流程（后台任务体）：check → 比较 → download_and_install → completed
async fn run_update_flow(
    backend: Arc<dyn UpdateBackend>,
    source: crate::models::config::UpdateSourceConfig,
    force: bool,
    emit: UpdateEmit,
) -> Result<(), String> {
    emit(
        "update.progress",
        json!({ "stage": "checking", "percent": 0 }),
    );

    let checked = backend.check(&source).await?;
    if let Some(info) = &checked {
        let current = current_host_version();
        if !force && !crate::services::auto_update::version_gt(&info.version, &current) {
            emit(
                "update.completed",
                json!({ "updated": false, "reason": "up-to-date", "currentVersion": current }),
            );
            return Ok(());
        }
        emit(
            "update.progress",
            json!({ "stage": "downloading", "percent": 0, "version": info.version }),
        );
    } else if !force {
        let current = current_host_version();
        emit(
            "update.completed",
            json!({ "updated": false, "reason": "no-update", "currentVersion": current }),
        );
        return Ok(());
    }

    // 触发即跑到底：进度回调经 emit 广播；安装完成后 backend 内部重启
    // （Windows updater 默认 restart_after_install=true；Local 源 backend 自行 restart）
    let emit_for_progress = emit.clone();
    let result = backend
        .download_and_install(
            &source,
            Box::new(move |percent, stage| {
                emit_for_progress(
                    "update.progress",
                    json!({ "stage": stage, "percent": percent }),
                );
            }),
        )
        .await;

    match result {
        Ok(()) => {
            emit("update.completed", json!({ "updated": true }));
            Ok(())
        }
        Err(e) => {
            emit(
                "update.completed",
                json!({ "updated": false, "reason": "error", "error": e }),
            );
            Err(e)
        }
    }
}

/// 宿主当前版本（run 流程里的版本比较用）
fn current_host_version() -> String {
    AppUpdateCapability::current_version()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::Source;
    use crate::contracts::validate_describe;
    use crate::models::config::UpdateSourceConfig;
    use crate::services::auto_update::UpdateInfo;
    use std::sync::Mutex as StdMutex;

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

    /// mock 意图源
    struct FixedIntent(UpdateSourceConfig);
    impl UpdateIntent for FixedIntent {
        fn source_config(&self) -> Result<UpdateSourceConfig, String> {
            Ok(self.0.clone())
        }
    }

    /// mock 后端：可编程 check 结果 / install 结果，记录进度回调
    struct MockBackend {
        check_result: StdMutex<Result<Option<UpdateInfo>, String>>,
        install_result: StdMutex<Result<(), String>>,
        progress_log: StdMutex<Vec<(u32, String)>>,
    }

    impl MockBackend {
        fn with_update(version: &str) -> Self {
            Self {
                check_result: StdMutex::new(Ok(Some(UpdateInfo {
                    version: version.into(),
                    body: None,
                }))),
                install_result: StdMutex::new(Ok(())),
                progress_log: StdMutex::new(Vec::new()),
            }
        }

        fn up_to_date() -> Self {
            Self {
                check_result: StdMutex::new(Ok(None)),
                install_result: StdMutex::new(Ok(())),
                progress_log: StdMutex::new(Vec::new()),
            }
        }

        fn install_fails(msg: &str) -> Self {
            Self {
                check_result: StdMutex::new(Ok(Some(UpdateInfo {
                    version: "99.0.0".into(),
                    body: None,
                }))),
                install_result: StdMutex::new(Err(msg.into())),
                progress_log: StdMutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl UpdateBackend for MockBackend {
        async fn check(
            &self,
            _source: &UpdateSourceConfig,
        ) -> Result<Option<UpdateInfo>, String> {
            self.check_result.lock().unwrap().clone()
        }

        async fn download_and_install(
            &self,
            _source: &UpdateSourceConfig,
            mut on_progress: Box<dyn FnMut(u32, &str) + Send>,
        ) -> Result<(), String> {
            for (pct, stage) in [(1u32, "downloading"), (50, "downloading"), (0, "installing")] {
                on_progress(pct, stage);
                self.progress_log.lock().unwrap().push((pct, stage.into()));
            }
            self.install_result.lock().unwrap().clone()
        }
    }

    type EventLog = StdMutex<Vec<(String, Value)>>;

    fn make_emit() -> (UpdateEmit, Arc<EventLog>) {
        let log: Arc<EventLog> = Arc::new(StdMutex::new(Vec::new()));
        let l = log.clone();
        let emit: UpdateEmit = Arc::new(move |kind: &str, payload: Value| {
            l.lock().unwrap().push((kind.to_string(), payload));
        });
        (emit, log)
    }

    /// 等待后台任务落完成事件（测试内简单轮询，最多 ~2s）
    fn wait_for_completed(log: &Arc<EventLog>) -> Vec<(String, Value)> {
        for _ in 0..200 {
            if log.lock().unwrap().iter().any(|(k, _)| k == "update.completed") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let events = log.lock().unwrap().clone();
        events
    }

    fn make_cap(
        backend: Arc<dyn UpdateBackend>,
        source_type: &str,
    ) -> AppUpdateCapability {
        let (emit, _) = make_emit();
        let intent = UpdateSourceConfig {
            source_type: source_type.into(),
            ..Default::default()
        };
        AppUpdateCapability::new(Arc::new(FixedIntent(intent)), backend, emit)
    }

    #[test]
    fn describe_contract() {
        let cap = make_cap(Arc::new(MockBackend::up_to_date()), "github");
        let d = cap.describe();
        let problems = validate_describe(CAP_ID, &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");
        let actions = d["actions"].as_object().unwrap();
        assert_eq!(actions.len(), APP_UPDATE_ACTIONS.len());
        for name in APP_UPDATE_ACTIONS {
            assert!(actions.contains_key(*name), "describe 缺动作 {name}");
        }
    }

    #[test]
    fn status_echoes_intent_without_network() {
        let cap = make_cap(Arc::new(MockBackend::up_to_date()), "github");
        let ctx = TestCtx { source: Source::Bootstrap };
        let v = cap.invoke(json!({"action": "status"}), &ctx).unwrap();
        assert_eq!(v["source"]["sourceType"], "github");
        assert_eq!(v["currentVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(v["latestVersion"], Value::Null, "status 零网络，无最新版本");
        assert_eq!(v["updateAvailable"], false);
    }

    #[tokio::test]
    async fn run_up_to_date_broadcasts_no_update() {
        let (emit, log) = make_emit();
        let intent = UpdateSourceConfig::default();
        let cap = AppUpdateCapability::new(
            Arc::new(FixedIntent(intent)),
            Arc::new(MockBackend::up_to_date()),
            emit,
        );
        let ctx = TestCtx { source: Source::Bootstrap };
        let v = cap.invoke(json!({"action": "run"}), &ctx).unwrap();
        assert_eq!(v["started"], true);
        let events = wait_for_completed(&log);
        let completed = events.iter().find(|(k, _)| k == "update.completed").unwrap();
        assert_eq!(completed.1["updated"], false);
        assert_eq!(completed.1["reason"], "no-update");
    }

    #[tokio::test]
    async fn run_with_update_broadcasts_progress_and_completed() {
        let (emit, log) = make_emit();
        let intent = UpdateSourceConfig::default();
        let cap = AppUpdateCapability::new(
            Arc::new(FixedIntent(intent)),
            Arc::new(MockBackend::with_update("99.0.0")),
            emit,
        );
        let ctx = TestCtx { source: Source::Bootstrap };
        let v = cap.invoke(json!({"action": "run"}), &ctx).unwrap();
        assert_eq!(v["started"], true);
        let events = wait_for_completed(&log);
        let kinds: Vec<&str> = events.iter().map(|(k, _)| k.as_str()).collect();
        assert!(kinds.contains(&"update.progress"), "应有进度事件: {kinds:?}");
        let completed = events.iter().find(|(k, _)| k == "update.completed").unwrap();
        assert_eq!(completed.1["updated"], true);
    }

    #[tokio::test]
    async fn run_install_failure_reports_error_event() {
        let (emit, log) = make_emit();
        let intent = UpdateSourceConfig::default();
        let cap = AppUpdateCapability::new(
            Arc::new(FixedIntent(intent)),
            Arc::new(MockBackend::install_fails("msiexec 失败")),
            emit,
        );
        let ctx = TestCtx { source: Source::Bootstrap };
        let v = cap.invoke(json!({"action": "run"}), &ctx).unwrap();
        assert_eq!(v["started"], true);
        let events = wait_for_completed(&log);
        let completed = events.iter().find(|(k, _)| k == "update.completed").unwrap();
        assert_eq!(completed.1["updated"], false);
        assert_eq!(completed.1["reason"], "error");
        assert_eq!(completed.1["error"], "msiexec 失败");
    }

    #[tokio::test]
    async fn run_force_installs_even_when_up_to_date() {
        // force=true 时即使无更新也走安装（Local 源重装同版本场景）
        let (emit, log) = make_emit();
        let intent = UpdateSourceConfig {
            source_type: "local".into(),
            ..Default::default()
        };
        let cap = AppUpdateCapability::new(
            Arc::new(FixedIntent(intent)),
            Arc::new(MockBackend::up_to_date()),
            emit,
        );
        let ctx = TestCtx { source: Source::Bootstrap };
        let v = cap
            .invoke(json!({"action": "run", "force": true}), &ctx)
            .unwrap();
        assert_eq!(v["started"], true);
        let events = wait_for_completed(&log);
        let completed = events.iter().find(|(k, _)| k == "update.completed").unwrap();
        assert_eq!(completed.1["updated"], true, "force 应跳过 up-to-date 短路");
    }

    #[tokio::test]
    async fn run_rejects_concurrent_invocation() {
        // 第一个 run 占住 RUNNING 闸（慢 mock），第二个 run 立即拒绝
        struct SlowBackend;
        #[async_trait::async_trait]
        impl UpdateBackend for SlowBackend {
            async fn check(
                &self,
                _source: &UpdateSourceConfig,
            ) -> Result<Option<UpdateInfo>, String> {
                Ok(Some(UpdateInfo { version: "99.0.0".into(), body: None }))
            }
            async fn download_and_install(
                &self,
                _source: &UpdateSourceConfig,
                _on_progress: Box<dyn FnMut(u32, &str) + Send>,
            ) -> Result<(), String> {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                Ok(())
            }
        }
        let (emit, _log) = make_emit();
        let intent = UpdateSourceConfig::default();
        let cap = AppUpdateCapability::new(
            Arc::new(FixedIntent(intent)),
            Arc::new(SlowBackend),
            emit,
        );
        let ctx = TestCtx { source: Source::Bootstrap };
        let first = cap.invoke(json!({"action": "run"}), &ctx).unwrap();
        assert_eq!(first["started"], true);
        // 立即第二次：RUNNING 闸应拒绝
        let second = cap.invoke(json!({"action": "run"}), &ctx);
        assert!(second.is_err(), "并发 run 应被拒绝");
        let err = second.unwrap_err();
        assert!(err.contains("不可重入"), "错误应说明重入: {err}");
        // 等第一个跑完，闸应复位（Drop 守卫）
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let third = cap.invoke(json!({"action": "run"}), &ctx);
        assert!(third.is_ok(), "任务结束后闸应复位（RAII 守卫）");
    }

    #[test]
    fn invoke_rejects_unknown_action_with_selfheal_hint() {
        let cap = make_cap(Arc::new(MockBackend::up_to_date()), "github");
        let ctx = TestCtx { source: Source::Bootstrap };
        let err = cap.invoke(json!({"action": "nope"}), &ctx).unwrap_err();
        assert!(err.contains("status"), "错误应列出合法动作: {err}");
        assert!(err.contains("run"), "错误应列出合法动作: {err}");
    }
}
