//! 统一数据根目录抽象
//!
//! Polaris 的应用自身数据曾散落在多个根：
//! - `app.path().app_config_dir()` → `<Roaming>/com.polaris.app`（MCP 数据：todo/scheduler/requirement）
//! - `dirs::config_dir()/claude-code-pro` → `<Roaming>/claude-code-pro`（遗留命名：config/plugins/integrations）
//! - `dirs::data_local_dir()/claude-code-pro` → `<Local>/claude-code-pro`（遗留命名：logs/sessions）
//!
//! 本模块将所有路径解析集中到 `DataRoot`，支持用户在配置中通过 `Config.data_root` 覆盖默认值。
//!
//! ## 三层结构
//!
//! 统一根 `<DataRoot>` 包含三个子目录：
//! - `config/` — 配置类数据（config.json、plugins、integrations、todo、scheduler、requirement）
//! - `data/` — 运行数据（logs、sessions）
//! - `mcp/` — MCP 专用数据
//!
//! 老用户首次启动时，`DataRoot::resolve_default()` 自动检测历史路径：
//! - 若存在 `com.polaris.app` → 使用它作为默认根（兼容 MCP 数据）
//! - 若存在 `claude-code-pro` → 使用它作为默认根（兼容配置/日志）
//! - 否则 → 新命名 `Polaris`

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
    /// 用户自定义根（Phase 2 由用户通过设置界面指定）
    root: PathBuf,
    /// 是否来自用户自定义
    is_custom: bool,
}

impl DataRoot {
    /// 通过自定义路径构建
    pub fn from_custom(custom: PathBuf) -> Self {
        Self {
            root: custom,
            is_custom: true,
        }
    }

    /// 显式构建
    pub fn from_parts(root: PathBuf) -> Self {
        Self { root, is_custom: false }
    }

    /// 解析默认根（基于系统目录 + 命名兼容策略）
    ///
    /// 检测历史路径，优先使用已存在的目录，避免破坏老用户数据。
    pub fn resolve_default() -> Self {
        // 按优先级检查历史路径是否存在且有数据
        let legacy_com_polaris = dirs::config_dir()
            .as_ref()
            .map(|d| d.join("com.polaris.app"))
            .filter(|p| p.exists() && has_data(p));
        let legacy_claude = dirs::config_dir()
            .as_ref()
            .map(|d| d.join(LEGACY_APP_NAME))
            .filter(|p| p.exists() && has_data(p));
        let legacy_data_local = dirs::data_local_dir()
            .as_ref()
            .map(|d| d.join(LEGACY_APP_NAME))
            .filter(|p| p.exists() && has_data(p));

        // 有数据时优先使用已有根
        let root = legacy_com_polaris
            .or(legacy_claude)
            .or(legacy_data_local)
            .unwrap_or_else(|| dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join(DEFAULT_APP_NAME));

        Self {
            root,
            is_custom: false,
        }
    }

    /// 综合解析（含用户配置覆盖）
    pub fn resolve(custom_root: Option<PathBuf>) -> Self {
        match custom_root {
            Some(p) if !p.as_os_str().is_empty() => Self::from_custom(p),
            _ => Self::resolve_default(),
        }
    }

    /// 共享 Arc 包装
    pub fn shared(self) -> Arc<DataRoot> {
        Arc::new(self)
    }

    // ========== 访问器 ==========

    /// 统一根目录
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 是否为用户自定义
    pub fn is_custom(&self) -> bool {
        self.is_custom
    }

    // ========== 标准子目录 ==========

    /// 配置类数据根目录（与历史 `com.polaris.app` / `claude-code-pro` 等价）
    pub fn config_dir(&self) -> PathBuf {
        self.root.join("config")
    }

    /// 主配置文件路径
    pub fn config_file(&self) -> PathBuf {
        self.config_dir().join("config.json")
    }

    /// 运行数据目录（logs、sessions）
    pub fn data_dir(&self) -> PathBuf {
        self.root.join("data")
    }

    /// 日志目录
    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir().join("logs")
    }

    /// 会话默认目录
    pub fn sessions_dir(&self) -> PathBuf {
        self.data_dir().join("sessions")
    }

    /// MCP 数据目录
    pub fn mcp_dir(&self) -> PathBuf {
        self.root.join("mcp")
    }

    /// Todo 数据目录
    pub fn todo_dir(&self) -> PathBuf {
        self.config_dir().join("todo")
    }

    /// 调度器数据目录
    pub fn scheduler_dir(&self) -> PathBuf {
        self.config_dir().join("scheduler")
    }

    /// 需求数据目录
    pub fn requirements_dir(&self) -> PathBuf {
        self.config_dir().join("requirements")
    }

    /// 插件目录
    pub fn plugins_dir(&self) -> PathBuf {
        self.config_dir().join("plugins")
    }

    /// LSP 配置目录
    pub fn lsp_dir(&self) -> PathBuf {
        self.config_dir().join("lsp")
    }

    /// 集成管理器目录
    pub fn integrations_dir(&self) -> PathBuf {
        self.config_dir().join("integrations")
    }

    /// 获取三个子路径信息（供前端显示）
    pub fn sub_paths(&self) -> SubPaths {
        SubPaths {
            config: self.config_dir(),
            data: self.data_dir(),
            mcp: self.mcp_dir(),
        }
    }
}

/// 子路径信息（供前端显示用）
#[derive(Debug, Clone)]
pub struct SubPaths {
    pub config: PathBuf,
    pub data: PathBuf,
    pub mcp: PathBuf,
}

/// 判断目录是否有数据文件
fn has_data(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .ok()
        .map(|mut rd| rd.next().is_some())
        .unwrap_or(false)
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
    fn custom_root_uses_same_base() {
        let tmp = std::env::temp_dir().join(format!("polaris-test-{}", uuid::Uuid::new_v4()));
        let dr = DataRoot::from_custom(tmp.clone());
        assert_eq!(dr.root(), tmp.as_path());
        assert!(dr.is_custom());
        assert_eq!(dr.config_dir(), tmp.join("config"));
        assert_eq!(dr.logs_dir(), tmp.join("data").join("logs"));
        assert_eq!(dr.mcp_dir(), tmp.join("mcp"));
        assert_eq!(dr.todo_dir(), tmp.join("config").join("todo"));
    }

    #[test]
    fn resolve_with_none_falls_back_to_default() {
        let dr = DataRoot::resolve(None);
        assert!(!dr.is_custom());
        assert!(dr.root().is_absolute() || dr.root().starts_with("."));
    }

    #[test]
    fn resolve_with_custom_uses_custom() {
        let tmp = std::env::temp_dir().join("polaris-resolve-test");
        let dr = DataRoot::resolve(Some(tmp.clone()));
        assert!(dr.is_custom());
        assert_eq!(dr.root(), tmp.as_path());
    }

    #[test]
    fn sub_paths_are_consistent() {
        let dr = DataRoot::from_custom(PathBuf::from("/tmp/roots"));
        let sp = dr.sub_paths();
        assert_eq!(sp.config, PathBuf::from("/tmp/roots/config"));
        assert_eq!(sp.data, PathBuf::from("/tmp/roots/data"));
        assert_eq!(sp.mcp, PathBuf::from("/tmp/roots/mcp"));
    }
}
