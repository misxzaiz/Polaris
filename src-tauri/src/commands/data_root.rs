//! 数据根目录管理命令
//!
//! 提供：
//! - `get_data_root_info`：当前根目录信息（路径、是否自定义、占用空间、旧版数据检测）
//! - `migrate_data_root`：把现有数据迁移到新根（事务式 + .bak 兜底）
//! - `detect_legacy_data`：探测旧版 `claude-code-pro` 残留数据

#[cfg(feature = "tauri-app")]
use tauri::State;

use crate::error::{AppError, Result};
use crate::services::data_migrator::{self, MigrateMode, MigrateReport};
use crate::services::data_root::{DataRoot, LEGACY_APP_NAME};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 当前数据根目录信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRootInfo {
    /// 当前生效的配置类数据根
    pub config_root: PathBuf,
    /// 当前生效的大数据根
    pub data_root: PathBuf,
    /// 是否为用户自定义（true 表示来自 `Config.data_root`）
    pub is_custom: bool,
    /// 当前根所占用的字节数（config + data 两根的合计）
    pub total_bytes: u64,
    /// 当前根包含的文件总数
    pub total_files: u64,
    /// 系统默认根（即未自定义时回落到的路径）
    pub default_config_root: PathBuf,
    /// 系统默认大数据根
    pub default_data_root: PathBuf,
    /// 是否检测到旧版 `claude-code-pro` 数据残留（仅当当前根 != 旧版根时有意义）
    pub legacy_present: bool,
    /// 旧版残留路径（如果存在）
    pub legacy_path: Option<PathBuf>,
}

/// 旧版数据信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDataInfo {
    pub path: PathBuf,
    pub bytes: u64,
    pub files: u64,
}

/// 迁移请求参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateRequest {
    pub new_root: PathBuf,
    #[serde(default = "default_mode")]
    pub mode: MigrateMode,
}

fn default_mode() -> MigrateMode {
    MigrateMode::Move
}

// ============================================================================
// 内部实现（Tauri / Web 共用）
// ============================================================================

fn dir_size_and_files(p: &Path) -> (u64, u64) {
    if !p.exists() {
        return (0, 0);
    }
    let mut bytes = 0u64;
    let mut files = 0u64;
    fn walk(dir: &Path, bytes: &mut u64, files: &mut u64) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let meta = entry.metadata()?;
            if meta.is_file() {
                *bytes += meta.len();
                *files += 1;
            } else if meta.is_dir() {
                walk(&entry.path(), bytes, files)?;
            }
        }
        Ok(())
    }
    let _ = walk(p, &mut bytes, &mut files);
    (bytes, files)
}

fn detect_legacy_path() -> Option<LegacyDataInfo> {
    // 仅检测 dirs::config_dir() 下的旧根（Phase 1 兼容路径），data_local_dir 同步看一下
    let cfg = dirs::config_dir().map(|d| d.join(LEGACY_APP_NAME));
    if let Some(p) = cfg {
        if p.exists() {
            let (bytes, files) = dir_size_and_files(&p);
            if files > 0 {
                return Some(LegacyDataInfo { path: p, bytes, files });
            }
        }
    }
    None
}

/// 公共导出：供 Web dispatcher 调用
pub fn detect_legacy_data_internal() -> Option<LegacyDataInfo> {
    detect_legacy_path()
}

/// 公共逻辑：给定 AppState 返回 DataRootInfo
pub fn build_info(state: &AppState) -> DataRootInfo {
    let dr = state.data_root.lock().unwrap().clone();
    let (cfg_bytes, cfg_files) = dir_size_and_files(dr.config_root());
    let (data_bytes, data_files) = if dr.config_root() == dr.data_root() {
        (0, 0)
    } else {
        dir_size_and_files(dr.data_root())
    };

    let default_dr = DataRoot::resolve_default();

    let legacy = detect_legacy_path();
    // 当前根已是旧版根，则不再提示"导入旧版"
    let legacy_present = match &legacy {
        Some(info) => dr.config_root() != info.path && dr.data_root() != info.path,
        None => false,
    };

    DataRootInfo {
        config_root: dr.config_root().to_path_buf(),
        data_root: dr.data_root().to_path_buf(),
        is_custom: dr.is_custom(),
        total_bytes: cfg_bytes + data_bytes,
        total_files: cfg_files + data_files,
        default_config_root: default_dr.config_root().to_path_buf(),
        default_data_root: default_dr.data_root().to_path_buf(),
        legacy_present,
        legacy_path: legacy.map(|i| i.path),
    }
}

/// 执行数据迁移（仅搬运文件，不修改 state 或 config）
pub fn do_migration(src: &Path, dst: &Path, mode: MigrateMode) -> Result<MigrateReport> {
    data_migrator::migrate(src, dst, mode)
}

/// 公共逻辑：执行迁移并写回 Config.data_root 和 AppState.data_root
pub fn perform_migration(
    state: &AppState,
    req: MigrateRequest,
) -> Result<MigrateReport> {
    let current = state.data_root.lock().unwrap().clone();
    let new_root = req.new_root.clone();

    let report = do_migration(&current.config_root(), &new_root, req.mode)?;

    // 写回 Config.data_root（让下次启动用新根）
    {
        let mut store = state.config_store.lock().map_err(|e| {
            AppError::ConfigError(format!("锁 ConfigStore 失败: {}", e))
        })?;
        let mut cfg = store.get().clone();
        cfg.data_root = Some(new_root.clone());
        store.update(cfg)?;
    }

    // 热更新 AppState.data_root，避免迁移后立刻 get_data_root_info 读到旧路径
    {
        let mut dr = state.data_root.lock().unwrap();
        *dr = Arc::new(DataRoot::resolve(Some(new_root)));
    }

    Ok(report)
}

// ============================================================================
// Tauri 命令
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn get_data_root_info(state: State<'_, AppState>) -> Result<DataRootInfo> {
    Ok(build_info(&state))
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn migrate_data_root(
    state: State<'_, AppState>,
    request: MigrateRequest,
) -> Result<MigrateReport> {
    perform_migration(&state, request)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn detect_legacy_data() -> Result<Option<LegacyDataInfo>> {
    Ok(detect_legacy_path())
}
