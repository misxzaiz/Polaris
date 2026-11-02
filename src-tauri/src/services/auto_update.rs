//! 应用自动更新（cap.app.update）—— 更新源意图 / OS 执行体
//!
//! 分工（plans/auto-update-plan.md）：
//! - 意图真源：`Config.update`（UpdateSourceConfig）。写入路径 = 前端设置流
//!   （SettingsPage buildPatch → cap.config 透传 → ConfigStore 落盘），本模块
//!   不写 config——与 autoLaunch 同一条保存链。
//! - 执行真源：`UpdateBackend` trait（唯一执行路径）。生产实现 `TauriUpdateBackend`
//!   持有 AppHandle，GitHub/Custom 源经 tauri-plugin-updater（强制 `.sig` 签名
//!   校验，装完自动重启）；Local 源免签名走 msiexec 静默安装。
//! - 能力层（app_update_capability.rs）只持 trait，不引用 tauri / updater——
//!   保证 `cargo check --no-default-features`（Web-only 构建）不挂。
//! - 触发即跑到底：run 内部不弹任何确认 UI（spec §5.2）。进度经
//!   `update.progress` / `update.completed` 事件广播（backend 内部 emit）。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::models::config::UpdateSourceConfig;
use crate::services::config_store::ConfigStore;

/// 更新检查结果（status 动作 / 版本比较输入）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 最新版本号（远端 manifest 或本地 MSI）
    pub version: String,
    /// 更新说明（release body，可为空）
    pub body: Option<String>,
}

/// 自动更新执行后端（trait 注入，可 mock 测试；仿 AutolaunchBackend）
///
/// 全部 async：网络检查/下载是长操作，由 capability 在 tokio::spawn 里 await。
#[async_trait::async_trait]
pub trait UpdateBackend: Send + Sync {
    /// 按源配置检查最新版本。None = 无更新（远端版本 <= 当前 / 本地无更高版本）。
    async fn check(&self, source: &UpdateSourceConfig) -> Result<Option<UpdateInfo>, String>;

    /// 下载并安装（触发即跑到底，含重启）。on_progress(percent 0-100, stage)。
    async fn download_and_install(
        &self,
        source: &UpdateSourceConfig,
        on_progress: Box<dyn FnMut(u32, &str) + Send>,
    ) -> Result<(), String>;
}

/// 意图源抽象：生产 = ConfigStore（`Config.update`），测试 = 固定值。
/// （与 AutolaunchIntent 同款理由：ConfigStore::new() 触碰真实数据根，单测不能构造。）
pub trait UpdateIntent: Send + Sync {
    fn source_config(&self) -> Result<UpdateSourceConfig, String>;
}

/// 生产意图源：共享 ConfigCapability 同一 config store Arc（读取路径单一）
pub struct StoreUpdateIntent(pub Arc<Mutex<ConfigStore>>);

impl UpdateIntent for StoreUpdateIntent {
    fn source_config(&self) -> Result<UpdateSourceConfig, String> {
        let store = self
            .0
            .lock()
            .map_err(|e| format!("config 锁获取失败: {e}"))?;
        Ok(store.get().update.clone())
    }
}

/// 版本号比较：a > b 返回 true（语义化版本逐段数值比较；段数不齐补 0）。
/// 只认 `v` 前缀 + 数字段（如 "11.0.7"）；非法段按 0 处理，不 panic。
pub fn version_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim()
            .trim_start_matches('v')
            .trim_start_matches('V')
            .split('.')
            .map(|seg| seg.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (mut va, mut vb) = (parse(a), parse(b));
    let len = va.len().max(vb.len());
    va.resize(len, 0);
    vb.resize(len, 0);
    va > vb
}

/// Local 源：从 manifest 路径解析 MSI 路径与版本。
/// 支持两种形态：直指 .msi（版本从文件名 `*_x.y.z_*.msi` 提取，取不到则 Unknown）；
/// 或指 latest.json（读 `platforms.windows-x86_64.url` 定位同目录 MSI）。
pub fn resolve_local_msi(manifest_path: &str) -> Result<(PathBuf, String), String> {
    let path = PathBuf::from(manifest_path);
    if path.extension().and_then(|e| e.to_str()) == Some("msi") {
        // 直指 MSI：版本从文件名提取（tauri 产物命名 `polaris_11.0.7_x64_zh-CN.msi`）
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let version = name
            .split('_')
            .find(|seg| seg.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))
            .unwrap_or("0.0.0")
            .to_string();
        return Ok((path, version));
    }

    // latest.json：解析 windows-x86_64 的 url（相对路径相对 manifest 目录）
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取本地 manifest 失败: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("本地 manifest 非 JSON: {e}"))?;
    let url = json["platforms"]["windows-x86_64"]["url"]
        .as_str()
        .ok_or_else(|| "本地 manifest 缺 platforms.windows-x86_64.url".to_string())?;
    let version = json["version"]
        .as_str()
        .ok_or_else(|| "本地 manifest 缺 version".to_string())?
        .to_string();
    let msi_path = path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join(url);
    Ok((msi_path, version))
}

// ============================================================================
// 生产实现（tauri-app 构建）：updater plugin + msiexec
// ============================================================================

#[cfg(feature = "tauri-app")]
mod tauri_impl {
    use super::*;
    use tauri::AppHandle;

    /// 生产执行体（单一执行路径，事件广播归 capability 的 emit 通道——
    /// backend 只管执行，进度经 on_progress 回调上抛）
    pub struct TauriUpdateBackend {
        app: AppHandle,
    }

    impl TauriUpdateBackend {
        pub fn new(app: AppHandle) -> Self {
            Self { app }
        }
    }

    #[async_trait::async_trait]
    impl UpdateBackend for TauriUpdateBackend {
        async fn check(&self, source: &UpdateSourceConfig) -> Result<Option<UpdateInfo>, String> {
            match source.source_type.as_str() {
                "local" => {
                    let manifest = source
                        .local_manifest_path
                        .as_deref()
                        .ok_or("Local 源未配置 localManifestPath")?;
                    let (_, version) = resolve_local_msi(manifest)?;
                    Ok(Some(UpdateInfo { version, body: None }))
                }
                "custom" | "github" => {
                    // GitHub/Custom 统一走 updater plugin：endpoints 由 tauri.conf.json
                    // 提供（GitHub latest.json）。Custom 源经 updater_builder 注入端点。
                    use tauri_plugin_updater::UpdaterExt;
                    let updater = self.app.updater().map_err(|e| e.to_string())?;
                    match updater.check().await.map_err(|e| e.to_string())? {
                        Some(update) => Ok(Some(UpdateInfo {
                            version: update.version.clone(),
                            body: update.body.clone(),
                        })),
                        None => Ok(None),
                    }
                }
                other => Err(format!("未知更新源类型: {other}（支持 github/local/custom）")),
            }
        }

        async fn download_and_install(
            &self,
            source: &UpdateSourceConfig,
            mut on_progress: Box<dyn FnMut(u32, &str) + Send>,
        ) -> Result<(), String> {
            match source.source_type.as_str() {
                "local" => {
                    // Local 源：msiexec 静默安装（免签名——本地包信任链 = 物理持有）。
                    // /norestart 装完不自动重启，由本分支统一 restart 替换进程。
                    // 注：msiexec 逻辑内联于此（不拆 helper）——`&mut dyn FnMut` 借用
                    // 跨 await 不满足 Send（async-trait 要求 future: Send），内联让
                    // Box 闭包独占可变借用，无二级引用。
                    let manifest = source
                        .local_manifest_path
                        .as_deref()
                        .ok_or("Local 源未配置 localManifestPath")?;
                    let (msi_path, _) = resolve_local_msi(manifest)?;
                    if !msi_path.exists() {
                        return Err(format!("本地 MSI 不存在: {}", msi_path.display()));
                    }
                    on_progress(0, "installing");
                    let status = tokio::process::Command::new("msiexec")
                        .args(["/i"])
                        .arg(&msi_path)
                        .args(["/qn", "/norestart"])
                        .status()
                        .await
                        .map_err(|e| format!("msiexec 启动失败: {e}"))?;
                    if !status.success() {
                        return Err(format!("msiexec 退出码非 0: {status}"));
                    }
                    on_progress(100, "completed");
                    self.app.restart();
                }
                "custom" | "github" => {
                    use tauri_plugin_updater::UpdaterExt;
                    let updater = self.app.updater().map_err(|e| e.to_string())?;
                    let update = updater
                        .check()
                        .await
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| "无可用更新".to_string())?;
                    on_progress(0, "downloading");
                    let mut last_percent: u32 = 0;
                    update
                        .download_and_install(
                            |chunk, total| {
                                if let Some(total) = total {
                                    let pct = ((chunk as f64 / total as f64) * 100.0) as u32;
                                    if pct > last_percent {
                                        last_percent = pct;
                                        on_progress(pct.min(99), "downloading");
                                    }
                                }
                            },
                            || {},
                        )
                        .await
                        .map_err(|e| e.to_string())?;
                    // Windows install_inner 默认 restart_after_install=true：
                    // MSI 装完自动 request_restart，正常不落到这里
                    on_progress(100, "completed");
                    Ok(())
                }
                other => Err(format!("未知更新源类型: {other}")),
            }
        }
    }
}

#[cfg(feature = "tauri-app")]
pub use tauri_impl::TauriUpdateBackend;

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_gt_basic() {
        assert!(version_gt("11.0.8", "11.0.7"));
        assert!(!version_gt("11.0.7", "11.0.7"));
        assert!(!version_gt("11.0.6", "11.0.7"));
        assert!(version_gt("v11.0.8", "11.0.7"), "v 前缀容忍");
        assert!(version_gt("11.1", "11.0.9"), "段数不齐补 0");
        assert!(version_gt("12", "11.99.99"));
    }

    #[test]
    fn version_gt_non_numeric_segments_zero() {
        assert!(!version_gt("11.0.7-beta", "11.0.7"), "非数字段按 0");
        assert!(version_gt("11.0.7", "abc"));
    }

    #[test]
    fn resolve_local_msi_direct_path() {
        let (path, version) =
            resolve_local_msi("D:/dist/polaris_11.0.8_x64_zh-CN.msi").unwrap();
        assert_eq!(path, PathBuf::from("D:/dist/polaris_11.0.8_x64_zh-CN.msi"));
        assert_eq!(version, "11.0.8");
    }

    #[test]
    fn resolve_local_msi_direct_path_no_version() {
        let (_, version) = resolve_local_msi("D:/dist/my-app.msi").unwrap();
        assert_eq!(version, "0.0.0", "文件名无版本段时回退 0.0.0");
    }

    #[test]
    fn resolve_local_msi_manifest_missing() {
        let err = resolve_local_msi("D:/nonexistent/latest.json").unwrap_err();
        assert!(err.contains("读取本地 manifest 失败"));
    }

    #[test]
    fn default_source_config_is_github() {
        let cfg = UpdateSourceConfig::default();
        assert_eq!(cfg.source_type, "github");
        assert_eq!(cfg.repo, "misxzaiz/Polaris");
        assert!(!cfg.check_on_startup);
    }

    #[test]
    fn source_config_serde_roundtrip_camel_case() {
        let cfg = UpdateSourceConfig {
            source_type: "local".into(),
            repo: "misxzaiz/Polaris".into(),
            local_manifest_path: Some("D:/x/latest.json".into()),
            manifest_url: None,
            check_on_startup: true,
        };
        let s = serde_json::to_string(&cfg).unwrap();
        assert!(s.contains("sourceType"), "camelCase 序列化: {s}");
        assert!(s.contains("localManifestPath"), "camelCase 序列化: {s}");
        assert!(s.contains("checkOnStartup"), "camelCase 序列化: {s}");
        let back: UpdateSourceConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(back.source_type, "local");
        assert!(back.check_on_startup);
    }

    #[test]
    fn source_config_backfills_missing_fields() {
        // 旧 config.json 无 update 段 / 字段缺失 → serde default 回填
        let cfg: UpdateSourceConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(cfg.source_type, "github");
        assert_eq!(cfg.repo, "misxzaiz/Polaris");
    }
}
