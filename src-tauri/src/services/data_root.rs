//! 统一数据根目录抽象
//!
//! Polaris 的应用自身数据曾散落在多个根：
//! - `dirs::config_dir()/claude-code-pro`（遗留）
//! - `app.path().app_config_dir()` = `<config_dir>/com.polaris.app`
//! - `dirs::data_local_dir()/claude-code-pro/{logs,sessions}`（遗留）
//!
//! 本模块将所有路径解析集中到 `DataRoot` 中，并支持用户在配置中
//! 通过 `Config.data_root` 覆盖默认值（用于"自定义存储路径"功能）。
//!
//! ## 双根设计
//!
//! 出于历史与平台习惯：
//! - **config root**：用于 config.json / 插件 / 集成 / lsp 等可被备份的"轻"数据
//! - **data root**：用于 logs / sessions 等会快速增长的"重"数据
//!
//! 当用户未自定义 `Config.data_root` 时：
//! - config root = `dirs::config_dir()/<app_name>`
//! - data root   = `dirs::data_local_dir()/<app_name>`
//!
//! 当用户**自定义**了 `Config.data_root` 时（用户感知是单一目录）：
//! - config root = data root = `<custom>`（在自定义目录下统一存放）
//!
//! ## 命名兼容
//!
//! - 老用户：磁盘上若已存在 `claude-code-pro/`，优先沿用以避免破坏。
//! - 新用户：使用新名 `Polaris`。
//! - 自定义路径：直接使用用户提供的目录，无名称约束。

use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 历史遗留 app 命名（保留以兼容老用户磁盘数据）
pub const LEGACY_APP_NAME: &str = "claude-code-pro";
/// 新版默认 app 命名
pub const DEFAULT_APP_NAME: &str = "Polaris";

/// 选择 app_name：若已存在 LEGACY 目录则继续使用，否则用 DEFAULT
fn pick_app_name<F: Fn() -> Option<PathBuf>>(base_resolver: F) -> &'static str {
    if let Some(base) = base_resolver() {
        if base.join(LEGACY_APP_NAME).exists() {
            return LEGACY_APP_NAME;
        }
    }
    DEFAULT_APP_NAME
}

/// 应用数据根目录
///
/// 通过 `Arc<DataRoot>` 共享，所有需要落盘的服务/命令都从 `AppState`
/// 取该实例，禁止再就地 `dirs::config_dir() / app.path().app_config_dir()`。
#[derive(Debug, Clone)]
pub struct DataRoot {
    /// 配置类数据根（config.json、plugins/、integrations/、lsp/、todo/、scheduler/、requirements/）
    config_root: PathBuf,
    /// 大数据根（logs/、sessions/）
    data_root: PathBuf,
    /// 是否来自用户自定义（true = `Config.data_root` 命中）
    is_custom: bool,
}

impl DataRoot {
    /// 通过自定义路径构建（用户在设置界面指定）
    ///
    /// 自定义模式下 config_root == data_root，简化用户心智。
    pub fn from_custom(custom: PathBuf) -> Self {
        Self {
            config_root: custom.clone(),
            data_root: custom,
            is_custom: true,
        }
    }

    /// 显式构建（测试 / 特殊场景）
    pub fn from_parts(config_root: PathBuf, data_root: PathBuf) -> Self {
        Self {
            config_root,
            data_root,
            is_custom: false,
        }
    }

    /// 解析默认根（基于系统目录 + 命名兼容策略）
    ///
    /// 优先级：
    /// 1. Tauri `app_config_dir`（若提供，用 identifier `com.polaris.app`）
    ///    注意：当前 Tauri identifier 是 `com.polaris.app`，与磁盘上 `claude-code-pro`
    ///    并存。我们**不**采用 Tauri 路径作为 config_root 默认（避免数据双写），
    ///    保持与历史 `dirs::config_dir()/<app_name>` 一致。
    /// 2. `dirs::config_dir()/<app_name>` + `dirs::data_local_dir()/<app_name>`
    /// 3. 兜底 `./polaris-data`
    pub fn resolve_default() -> Self {
        let app_name = pick_app_name(dirs::config_dir);

        let config_root = dirs::config_dir()
            .map(|d| d.join(app_name))
            .unwrap_or_else(|| PathBuf::from(".").join("polaris-data"));

        // data_root 单独看 data_local_dir 是否已有 LEGACY，不强行同步 app_name
        let data_app_name = pick_app_name(dirs::data_local_dir);
        let data_root = dirs::data_local_dir()
            .map(|d| d.join(data_app_name))
            .unwrap_or_else(|| config_root.clone());

        Self {
            config_root,
            data_root,
            is_custom: false,
        }
    }

    /// 综合解析（含用户配置覆盖）
    ///
    /// 调用方应在启动期解析一次后注入 `AppState`。
    pub fn resolve(custom_data_root: Option<PathBuf>) -> Self {
        match custom_data_root {
            Some(p) if !p.as_os_str().is_empty() => Self::from_custom(p),
            _ => Self::resolve_default(),
        }
    }

    /// 共享 Arc 包装（便于在 AppState 中持有）
    pub fn shared(self) -> Arc<DataRoot> {
        Arc::new(self)
    }

    // ========== 访问器 ==========

    /// 配置类数据根目录（与历史 `claude-code-pro` config 子树等价）
    pub fn config_root(&self) -> &Path {
        &self.config_root
    }

    /// 大数据根目录
    pub fn data_root(&self) -> &Path {
        &self.data_root
    }

    /// 是否为用户自定义
    pub fn is_custom(&self) -> bool {
        self.is_custom
    }

    // ========== 标准子目录 ==========

    /// 主配置文件所在目录（`config.json` 的父目录）
    pub fn config_dir(&self) -> PathBuf {
        self.config_root.clone()
    }

    /// 主配置文件路径
    pub fn config_file(&self) -> PathBuf {
        self.config_root.join("config.json")
    }

    /// 日志目录
    pub fn logs_dir(&self) -> PathBuf {
        self.data_root.join("logs")
    }

    /// 会话默认目录（用户未设置 `Config.session_dir` 时使用）
    pub fn sessions_dir(&self) -> PathBuf {
        self.data_root.join("sessions")
    }

    /// Todo 数据目录
    pub fn todo_dir(&self) -> PathBuf {
        self.config_root.join("todo")
    }

    /// 调度器数据目录
    pub fn scheduler_dir(&self) -> PathBuf {
        self.config_root.join("scheduler")
    }

    /// 需求数据目录
    pub fn requirements_dir(&self) -> PathBuf {
        self.config_root.join("requirements")
    }

    /// 插件目录
    pub fn plugins_dir(&self) -> PathBuf {
        self.config_root.join("plugins")
    }

    /// LSP 配置目录
    pub fn lsp_dir(&self) -> PathBuf {
        self.config_root.join("lsp")
    }

    /// 集成管理器目录
    pub fn integrations_dir(&self) -> PathBuf {
        self.config_root.join("integrations")
    }
}

impl Default for DataRoot {
    fn default() -> Self {
        Self::resolve_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_root_uses_same_path_for_config_and_data() {
        let tmp = std::env::temp_dir().join(format!("polaris-test-{}", uuid::Uuid::new_v4()));
        let dr = DataRoot::from_custom(tmp.clone());
        assert_eq!(dr.config_root(), tmp.as_path());
        assert_eq!(dr.data_root(), tmp.as_path());
        assert!(dr.is_custom());
        assert_eq!(dr.config_file(), tmp.join("config.json"));
        assert_eq!(dr.logs_dir(), tmp.join("logs"));
        assert_eq!(dr.todo_dir(), tmp.join("todo"));
    }

    #[test]
    fn from_parts_keeps_dual_root() {
        let cfg = PathBuf::from("/tmp/cfg");
        let data = PathBuf::from("/tmp/data");
        let dr = DataRoot::from_parts(cfg.clone(), data.clone());
        assert_eq!(dr.config_root(), cfg.as_path());
        assert_eq!(dr.data_root(), data.as_path());
        assert!(!dr.is_custom());
    }

    #[test]
    fn resolve_with_none_falls_back_to_default() {
        let dr = DataRoot::resolve(None);
        assert!(!dr.is_custom());
        assert!(dr.config_root().is_absolute() || dr.config_root().starts_with("."));
    }

    #[test]
    fn resolve_with_empty_path_falls_back_to_default() {
        let dr = DataRoot::resolve(Some(PathBuf::new()));
        assert!(!dr.is_custom());
    }

    #[test]
    fn resolve_with_custom_uses_custom() {
        let tmp = std::env::temp_dir().join("polaris-resolve-test");
        let dr = DataRoot::resolve(Some(tmp.clone()));
        assert!(dr.is_custom());
        assert_eq!(dr.config_root(), tmp.as_path());
    }
}
