//! 开机自启（OS 登录自启宿主进程）—— OS 执行体与对账
//!
//! 分工（plans/autostart-boot-launch-spec.md §2）：
//! - 意图真源：`Config.autoLaunch`。写入路径 = 前端设置流（SettingsPage buildPatch →
//!   cap.config 顶层透传 → ConfigStore 落盘），**本模块不写 config**——与其它设置
//!   字段同一条保存链，规避「新增配置保存丢失」两类坑（分组键清单遗漏 / 白名单
//!   section 字段拒绝）。
//! - 事实真源：OS 启动项（Windows: `HKCU\...\CurrentVersion\Run`）。
//! - 唯一 OS 写路径：`AutolaunchBackend`（tauri-plugin-autostart ManagerExt），
//!   enable/disable 均为幂等 ensure；注册值带 `--minimized`（lib.rs 装配处）。
//! - 对账：`ensure` 读意图 → ensure 事实。调用方两处：lib.rs setup 的启动
//!   reconcile（升级/挪目录后 Run 键路径漂移自愈）与 cap.app.autolaunch 的 apply。
//!
//! 隔离护栏见 `data_root::is_isolated`：dev/test-profile 环境 supported=false。

use std::sync::{Arc, Mutex};

use crate::services::config_store::ConfigStore;

/// OS 自启操作后端（trait 注入，可 mock 测试）
pub trait AutolaunchBackend: Send + Sync {
    fn enable(&self) -> Result<(), String>;
    fn disable(&self) -> Result<(), String>;
    fn is_enabled(&self) -> Result<bool, String>;
}

/// 意图源抽象：生产 = ConfigStore（`Config.autoLaunch`），测试 = 固定值。
/// 抽出来是因 `ConfigStore::new()` 会触碰真实数据根，单测不能构造真实 store。
pub trait AutolaunchIntent: Send + Sync {
    fn configured(&self) -> Result<bool, String>;
}

/// 生产意图源：共享 ConfigCapability 同一 config store Arc（读取路径单一）
pub struct StoreIntent(pub Arc<Mutex<ConfigStore>>);

impl AutolaunchIntent for StoreIntent {
    fn configured(&self) -> Result<bool, String> {
        let store = self
            .0
            .lock()
            .map_err(|e| format!("config 锁获取失败: {e}"))?;
        Ok(store.get().auto_launch)
    }
}

/// Tauri 官方 autostart 插件后端（仅 tauri-app 构建编译）
#[cfg(feature = "tauri-app")]
pub struct TauriAutolaunchBackend {
    app: tauri::AppHandle,
}

#[cfg(feature = "tauri-app")]
impl TauriAutolaunchBackend {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

#[cfg(feature = "tauri-app")]
impl AutolaunchBackend for TauriAutolaunchBackend {
    fn enable(&self) -> Result<(), String> {
        use tauri_plugin_autostart::ManagerExt;
        self.app
            .autolaunch()
            .enable()
            .map_err(|e| format!("开机自启注册失败: {e}"))
    }

    fn disable(&self) -> Result<(), String> {
        use tauri_plugin_autostart::ManagerExt;
        self.app
            .autolaunch()
            .disable()
            .map_err(|e| format!("开机自启注销失败: {e}"))
    }

    fn is_enabled(&self) -> Result<bool, String> {
        use tauri_plugin_autostart::ManagerExt;
        self.app
            .autolaunch()
            .is_enabled()
            .map_err(|e| format!("开机自启状态查询失败: {e}"))
    }
}

/// ensure 结果（意图 / 对账后事实 / 是否发生纠偏写）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApplyOutcome {
    /// config 意图（`Config.autoLaunch`）
    pub configured: bool,
    /// 对账后的 OS 事实
    pub enabled: bool,
    /// 本次是否执行了纠偏写（false = 事实已与意图一致，未触碰 OS）
    pub changed: bool,
}

/// 对账/应用：读意图 → ensure 事实。幂等，可重复调用。
///
/// 失败语义：OS 写失败只报错、不改意图——漂移方向恒为「意图开/事实关」，
/// 下次启动 reconcile 自愈（spec §2 写入顺序定案）。
pub fn ensure(configured: bool, backend: &dyn AutolaunchBackend) -> Result<ApplyOutcome, String> {
    let fact = backend.is_enabled()?;
    if fact == configured {
        return Ok(ApplyOutcome {
            configured,
            enabled: fact,
            changed: false,
        });
    }
    if configured {
        backend.enable()?;
    } else {
        backend.disable()?;
    }
    Ok(ApplyOutcome {
        configured,
        enabled: configured,
        changed: true,
    })
}

/// 启动期对账（lib.rs setup 调一次）：意图 ≠ 事实时纠偏，顺带把注册值刷成
/// 当前 exe 路径（升级/挪目录后漂移自愈）。幂等，崩溃重跑无害。
#[cfg(feature = "tauri-app")]
pub fn spawn_reconcile(
    config_store: Arc<Mutex<ConfigStore>>,
    backend: Arc<dyn AutolaunchBackend>,
) {
    tauri::async_runtime::spawn(async move {
        // async 块返回 ()，不能用 `?`——锁失败直接记 warn 退出本次对账
        let intent = match config_store.lock() {
            Ok(store) => store.get().auto_launch,
            Err(e) => {
                tracing::warn!("[Autolaunch] 启动对账失败（config 锁获取失败）: {e}");
                return;
            }
        };
        let outcome = ensure(intent, backend.as_ref());
        match outcome {
            Ok(o) if o.changed => tracing::info!(
                "[Autolaunch] 启动对账纠偏: 意图={} 事实={}",
                o.configured,
                o.enabled
            ),
            Ok(o) => tracing::info!(
                "[Autolaunch] 启动对账一致: 意图=事实={}（无写）",
                o.enabled
            ),
            Err(e) => tracing::warn!("[Autolaunch] 启动对账失败（下次启动重试）: {e}"),
        }
    });
}
