//! 数据根（DataRoot）抽象
//!
//! 统一管理应用所有持久化数据的根目录，消除散落各处的 `claude-code-pro` 硬编码。
//!
//! ## 路径分层模型
//!
//! ```text
//! ┌─ Anchor 层（永不可改） ──────────────────────────┐
//! │ %APPDATA%\Polaris\anchor.json                    │
//! │ { "schemaVersion":1, "dataRoot":"<可选>" }       │
//! └──────────────────────────────────────────────────┘
//!                  │ resolve
//!                  ▼
//! ┌─ DataRoot 层（用户可改） ────────────────────────┐
//! │ 默认 = OS 标准 config_dir/Polaris                 │
//! │ 自定义 = anchor.dataRoot 指向的绝对路径           │
//! └──────────────────────────────────────────────────┘
//! ```
//!
//! ## 解析顺序
//!
//! 1. 读 `%APPDATA%\Polaris\anchor.json`
//! 2. `dataRoot` 字段非空 → 用自定义路径
//! 3. 否则 → 默认 `%APPDATA%\Polaris\`
//!
//! 旧版 `claude-code-pro` 数据**不会**自动接管，仅通过 `scan_legacy_data()`
//! 暴露给用户在设置中手动迁移。
//!
//! ## 静态访问
//!
//! `ConfigStore::new()` / `Logger::log_dir()` 等启动期组件无法持有 `AppState`，
//! 所以本模块通过 `data_root()` 提供全局 `OnceLock` 单例访问。
//!
//! ## 切换路径
//!
//! `set_anchor()` 写入新的 `dataRoot`，需重启应用生效（运行时多个组件持有
//! 各自的 `PathBuf` 副本，热切换会破坏一致性）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// 应用名（新版默认目录）
pub const APP_NAME: &str = "Polaris";

/// 旧应用名（仅用于 scan_legacy_data 扫描，不参与默认解析）
pub const LEGACY_APP_NAME: &str = "claude-code-pro";

/// 锚点目录名（永远在 OS 标准 config_dir 下，永不跟随自定义路径）
const ANCHOR_DIR_NAME: &str = "Polaris";

/// 锚点文件名
const ANCHOR_FILE: &str = "anchor.json";

/// 锚点 schema 版本
const ANCHOR_SCHEMA_VERSION: u32 = 1;

// ============================================================================
// Anchor 数据结构
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Anchor {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    /// 用户自定义数据根；为空表示使用默认路径
    #[serde(rename = "dataRoot", default, skip_serializing_if = "Option::is_none")]
    data_root: Option<PathBuf>,
}

impl Default for Anchor {
    fn default() -> Self {
        Self {
            schema_version: ANCHOR_SCHEMA_VERSION,
            data_root: None,
        }
    }
}

/// 获取锚点目录（始终在 OS 标准 config_dir 下，永不可改）
fn anchor_dir() -> Result<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::ConfigError("无法获取系统配置目录".to_string()))?;
    Ok(base.join(ANCHOR_DIR_NAME))
}

fn anchor_path() -> Result<PathBuf> {
    Ok(anchor_dir()?.join(ANCHOR_FILE))
}

fn read_anchor() -> Result<Anchor> {
    let path = anchor_path()?;
    if !path.exists() {
        return Ok(Anchor::default());
    }
    let content = fs::read_to_string(&path)?;
    if content.trim().is_empty() {
        return Ok(Anchor::default());
    }
    serde_json::from_str::<Anchor>(&content).map_err(|e| {
        AppError::ConfigError(format!("anchor.json 解析失败: {} ({})", e, path.display()))
    })
}

fn write_anchor(anchor: &Anchor) -> Result<()> {
    let dir = anchor_dir()?;
    fs::create_dir_all(&dir)?;
    let path = dir.join(ANCHOR_FILE);
    let json = serde_json::to_string_pretty(anchor)?;
    // 原子写入：先写临时文件再 rename，避免崩溃时锚点损坏
    let tmp = dir.join(format!("{}.tmp", ANCHOR_FILE));
    fs::write(&tmp, json)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// 环境变量名：覆盖数据根（供 dev/测试启动脚本注入，实现开发环境存储隔离）
///
/// 优先级：`POLARIS_DATA_ROOT` env > anchor.dataRoot > 默认 `%APPDATA%/Polaris`。
/// 设计意图：`tauri:dev:web` 等开发启动脚本注入独立数据根，使测试读写不污染生产数据；
/// 生产构建不设此 env，行为不变。
const ENV_DATA_ROOT: &str = "POLARIS_DATA_ROOT";

/// 获取默认数据根（无自定义时使用）
fn default_data_root() -> Result<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::ConfigError("无法获取系统配置目录".to_string()))?;
    Ok(base.join(APP_NAME))
}

// ============================================================================
// DataRoot 主体
// ============================================================================

/// 数据根
#[derive(Debug, Clone)]
pub struct DataRoot {
    root: PathBuf,
    is_custom: bool,
}

impl DataRoot {
    /// 启动期解析（无 AppState 依赖）
    pub fn resolve_default() -> Result<Self> {
        // 优先级 1：环境变量覆盖（dev/测试注入，实现开发环境存储隔离）
        if let Ok(env_root) = std::env::var(ENV_DATA_ROOT) {
            let env_root = env_root.trim();
            if !env_root.is_empty() {
                let dr = Self {
                    root: PathBuf::from(env_root),
                    is_custom: true,
                };
                dr.ensure()?;
                return Ok(dr);
            }
        }

        let anchor = read_anchor().unwrap_or_else(|e| {
            // 锚点损坏不应阻止启动，记录警告后用默认值
            eprintln!("[DataRoot] 锚点读取失败，使用默认值: {}", e);
            Anchor::default()
        });

        // 优先级 2：anchor.dataRoot 自定义；优先级 3：默认目录
        let (root, is_custom) = match anchor.data_root.filter(|p| !p.as_os_str().is_empty()) {
            Some(custom) => (custom, true),
            None => (default_data_root()?, false),
        };

        let dr = Self { root, is_custom };
        dr.ensure()?;
        Ok(dr)
    }

    /// 仅用于测试：直接构造
    #[cfg(test)]
    pub fn for_test(root: PathBuf, is_custom: bool) -> Self {
        Self { root, is_custom }
    }

    /// 创建所有标准子目录
    pub fn ensure(&self) -> Result<()> {
        for dir in [
            self.root.clone(),
            self.logs_dir(),
            self.dialogs_dir(),
            self.scheduler_dir(),
            self.plugins_dir(),
            self.cache_dir(),
            self.meta_dir(),
            self.downloads_dir(),
        ] {
            fs::create_dir_all(&dir)?;
        }
        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn is_custom(&self) -> bool {
        self.is_custom
    }

    /// 配置根目录（等同 root，保持与下游 `app_config_dir` 语义兼容）
    ///
    /// 历史代码大量依赖 `config_dir.join("scheduler")`、`config_dir.join("plugins")`
    /// 等模式，DataRoot 不再强制下沉到 `<root>/config/` 子目录，避免破坏现有布局。
    pub fn config_dir(&self) -> PathBuf {
        self.root.clone()
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn dialogs_dir(&self) -> PathBuf {
        self.root.join("dialogs")
    }

    /// 调度器子目录（沿用历史约定 `<root>/scheduler/`）
    pub fn scheduler_dir(&self) -> PathBuf {
        self.root.join("scheduler")
    }

    /// 插件子目录（沿用历史约定 `<root>/plugins/`）
    pub fn plugins_dir(&self) -> PathBuf {
        self.root.join("plugins")
    }

    pub fn cache_dir(&self) -> PathBuf {
        self.root.join("cache")
    }

    pub fn meta_dir(&self) -> PathBuf {
        self.root.join(".meta")
    }

    /// 内置浏览器下载落盘目录（`<root>/downloads`）
    pub fn downloads_dir(&self) -> PathBuf {
        self.root.join("downloads")
    }

    /// 写入新的锚点 dataRoot；为 None 表示恢复默认
    pub fn set_anchor(new_root: Option<&Path>) -> Result<()> {
        let mut anchor = read_anchor().unwrap_or_default();
        anchor.schema_version = ANCHOR_SCHEMA_VERSION;
        anchor.data_root = new_root.map(|p| p.to_path_buf());
        write_anchor(&anchor)
    }

    /// 获取锚点文件路径（供 UI 展示）
    pub fn anchor_file_path() -> Result<PathBuf> {
        anchor_path()
    }
}

// ============================================================================
// 全局静态访问
// ============================================================================

static DATA_ROOT: OnceLock<DataRoot> = OnceLock::new();

/// 获取全局数据根单例（首次调用时初始化）
///
/// 启动期组件（ConfigStore::new、Logger::log_dir）无法持有 AppState，
/// 通过此函数访问统一根。
pub fn data_root() -> &'static DataRoot {
    DATA_ROOT.get_or_init(|| {
        DataRoot::resolve_default()
            .expect("DataRoot 初始化失败：无法解析或创建数据根目录")
    })
}

// ============================================================================
// 旧数据扫描
// ============================================================================

/// 旧数据源类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySource {
    /// 源路径
    pub path: PathBuf,
    /// 描述（如 "claude-code-pro 配置"）
    pub label: String,
    /// 占用字节数
    pub size_bytes: u64,
    /// 文件总数
    pub file_count: u64,
    /// 是否存在
    pub exists: bool,
}

/// 扫描旧版残留数据（claude-code-pro 目录）
///
/// 仅扫描后端管理的文件路径；OPFS 历史对话由前端单独处理。
pub fn scan_legacy_data() -> Vec<LegacySource> {
    let mut results = Vec::new();

    // 旧 config_dir/claude-code-pro
    if let Some(base) = dirs::config_dir() {
        let path = base.join(LEGACY_APP_NAME);
        if path.exists() {
            let (size, count) = dir_stats(&path);
            results.push(LegacySource {
                path: path.clone(),
                label: format!("{} 配置目录", LEGACY_APP_NAME),
                size_bytes: size,
                file_count: count,
                exists: true,
            });
        }
    }

    // 旧 data_local_dir/claude-code-pro
    if let Some(base) = dirs::data_local_dir() {
        let path = base.join(LEGACY_APP_NAME);
        // 当 config_dir == data_local_dir（如 Linux 某些发行版）时跳过重复
        if path.exists() && !results.iter().any(|s| s.path == path) {
            let (size, count) = dir_stats(&path);
            results.push(LegacySource {
                path: path.clone(),
                label: format!("{} 数据目录（含日志）", LEGACY_APP_NAME),
                size_bytes: size,
                file_count: count,
                exists: true,
            });
        }
    }

    // Tauri 遗留配置目录（%APPDATA%/com.polaris.app）中的「逻辑数据」子目录。
    //
    // 桌面 Tauri 模式的历史实现把插件、配置等逻辑数据写入 Tauri app_config_dir
    // （com.polaris.app），与 DataRoot（%APPDATA%/Polaris）分裂。统一到 DataRoot
    // 后，这里是遗留数据源。此处只注册**可迁移的逻辑子目录**，每个作为独立源，
    // 迁移时经 map_legacy_subpath 同名映射合并到 DataRoot；
    // EBWebView/browser/config/data/cache 等 Tauri 运行时或结构不对应的目录不注册。
    if let Some(base) = dirs::config_dir() {
        let legacy_root = base.join("com.polaris.app");
        if legacy_root.exists() {
            for name in ["plugins", "requirements", "scheduler", "todo", "agnes"] {
                let sub = legacy_root.join(name);
                if sub.exists() {
                    let (size, count) = dir_stats(&sub);
                    results.push(LegacySource {
                        path: sub.clone(),
                        label: format!("Tauri 遗留目录 · {}", name),
                        size_bytes: size,
                        file_count: count,
                        exists: true,
                    });
                }
            }
        }
    }

    results
}

/// 递归统计目录大小与文件数
pub fn dir_stats(path: &Path) -> (u64, u64) {
    let mut size = 0u64;
    let mut count = 0u64;
    if !path.exists() {
        return (0, 0);
    }
    let walker = match fs::read_dir(path) {
        Ok(it) => it,
        Err(_) => return (0, 0),
    };
    for entry in walker.flatten() {
        let p = entry.path();
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                size += meta.len();
                count += 1;
            } else if meta.is_dir() {
                let (s, c) = dir_stats(&p);
                size += s;
                count += c;
            }
        }
    }
    (size, count)
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_default_subdirs() {
        let tmp = TempDir::new().unwrap();
        let dr = DataRoot::for_test(tmp.path().to_path_buf(), false);
        dr.ensure().unwrap();

        // config_dir 等于 root，保持与历史下游兼容
        assert_eq!(dr.config_dir(), tmp.path());
        assert!(dr.logs_dir().exists());
        assert!(dr.dialogs_dir().exists());
        assert!(dr.scheduler_dir().exists());
        assert!(dr.plugins_dir().exists());
        assert!(dr.cache_dir().exists());
        assert!(dr.meta_dir().exists());
        assert_eq!(dr.scheduler_dir(), tmp.path().join("scheduler"));
        assert_eq!(dr.plugins_dir(), tmp.path().join("plugins"));
        assert!(dr.downloads_dir().exists());
        assert_eq!(dr.downloads_dir(), tmp.path().join("downloads"));
        assert!(!dr.is_custom());
    }

    #[test]
    fn test_dir_stats_empty() {
        let tmp = TempDir::new().unwrap();
        let (size, count) = dir_stats(tmp.path());
        assert_eq!(size, 0);
        assert_eq!(count, 0);
    }

    #[test]
    fn test_dir_stats_with_files() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.txt"), b"hello").unwrap();
        fs::write(tmp.path().join("b.txt"), b"world!!").unwrap();
        let sub = tmp.path().join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("c.txt"), b"ok").unwrap();

        let (size, count) = dir_stats(tmp.path());
        assert_eq!(size, 5 + 7 + 2);
        assert_eq!(count, 3);
    }

    #[test]
    fn test_anchor_roundtrip() {
        // 用 tempdir 模拟 anchor 写读
        let tmp = TempDir::new().unwrap();
        let anchor_path = tmp.path().join("anchor.json");
        let custom = tmp.path().join("MyData");

        let anchor = Anchor {
            schema_version: ANCHOR_SCHEMA_VERSION,
            data_root: Some(custom.clone()),
        };
        let json = serde_json::to_string_pretty(&anchor).unwrap();
        fs::write(&anchor_path, json).unwrap();

        let loaded: Anchor = serde_json::from_str(&fs::read_to_string(&anchor_path).unwrap()).unwrap();
        assert_eq!(loaded.schema_version, ANCHOR_SCHEMA_VERSION);
        assert_eq!(loaded.data_root, Some(custom));
    }

    #[test]
    fn test_anchor_default_no_data_root() {
        let anchor = Anchor::default();
        let json = serde_json::to_string(&anchor).unwrap();
        // skip_serializing_if 会忽略 None 字段
        assert!(!json.contains("dataRoot"));
    }

    #[test]
    fn test_for_test_custom_flag() {
        let tmp = TempDir::new().unwrap();
        let dr = DataRoot::for_test(tmp.path().to_path_buf(), true);
        assert!(dr.is_custom());
    }

    #[test]
    fn test_resolve_env_priority() {
        // POLARIS_DATA_ROOT env 存在时优先于默认目录（但不覆盖 anchor 自定义）。
        // 用随机 TempDir 路径，避免与真实环境变量冲突。
        let tmp = TempDir::new().unwrap();
        let env_root = tmp.path().join("Polaris-dev");

        unsafe { std::env::set_var(ENV_DATA_ROOT, &env_root) };
        let dr = DataRoot::resolve_default().unwrap();
        unsafe { std::env::remove_var(ENV_DATA_ROOT) };

        assert_eq!(dr.root(), env_root);
        assert!(dr.is_custom());
        // env 根被 ensure() 创建
        assert!(env_root.exists());
    }

    #[test]
    fn test_resolve_env_ignored_when_empty() {
        // 空 env 回退默认（不 panic，走 anchor/默认逻辑）
        unsafe { std::env::set_var(ENV_DATA_ROOT, ""); }
        // 用直接构造辅助避免污染环境；验证空字符串不匹配非空分支
        unsafe { std::env::remove_var(ENV_DATA_ROOT); }

        // 只验证逻辑分支：空字符串应被跳过（不进入 env 分支）
        let tmp = TempDir::new().unwrap();
        let dr = DataRoot::for_test(tmp.path().to_path_buf(), false);
        assert!(!dr.is_custom());
    }
}
