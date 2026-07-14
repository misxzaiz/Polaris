//! 数据根（DataRoot）相关 Tauri 命令
//!
//! 暴露给前端：
//! - `get_data_root_info` —— 当前数据根的路径、状态、子目录占用统计
//! - `scan_legacy_data` —— 扫描旧版 claude-code-pro 残留数据
//! - `open_path_in_explorer` —— 调用系统资源管理器打开路径
//! - `migrate_legacy_data` —— 把旧版残留数据合并到当前数据根
//!
//! P3 阶段会再加 set_data_root（切换数据根）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{AppError, Result};
use crate::services::data_root::{data_root, dir_stats, scan_legacy_data, DataRoot, LegacySource};

// ============================================================================
// 数据结构
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubdirInfo {
    pub name: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub file_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRootInfo {
    /// 当前数据根绝对路径
    pub root: PathBuf,
    /// 锚点文件路径（永远固定在 OS 标准 config_dir/Polaris/anchor.json）
    pub anchor_file: PathBuf,
    /// 是否使用了用户自定义路径
    pub is_custom: bool,
    /// 数据根总占用（递归字节数）
    pub total_size_bytes: u64,
    /// 总文件数
    pub total_file_count: u64,
    /// 各子目录详情
    pub subdirs: Vec<SubdirInfo>,
}

// ============================================================================
// 共享实现（供 Tauri 命令 + Web IPC 复用）
// ============================================================================

const SUBDIR_NAMES: &[&str] = &[
    "config",
    "logs",
    "dialogs",
    "scheduler",
    "plugins",
    "cache",
    ".meta",
];

/// 获取当前数据根信息（含子目录占用）
pub fn data_root_info_inner() -> Result<DataRootInfo> {
    let dr = data_root();
    let root = dr.root().to_path_buf();

    let anchor_file = DataRoot::anchor_file_path()?;

    // 总占用 = 直接对 root 递归
    let (total_size_bytes, total_file_count) = dir_stats(&root);

    // 注意：config_dir == root，避免在 subdirs 里重复计入。
    // 这里我们列出"语义子目录"：以 root 为父，名字为 SUBDIR_NAMES 的实际目录。
    let subdirs = SUBDIR_NAMES
        .iter()
        .map(|name| {
            let path = root.join(name);
            let (size_bytes, file_count) = dir_stats(&path);
            SubdirInfo {
                name: (*name).to_string(),
                path,
                size_bytes,
                file_count,
            }
        })
        .collect();

    Ok(DataRootInfo {
        root,
        anchor_file,
        is_custom: dr.is_custom(),
        total_size_bytes,
        total_file_count,
        subdirs,
    })
}

/// 扫描旧版残留
pub fn scan_legacy_data_inner() -> Result<Vec<LegacySource>> {
    Ok(scan_legacy_data())
}

/// 在系统资源管理器中打开路径
pub fn open_path_in_explorer_inner(path: PathBuf) -> Result<()> {
    if !path.exists() {
        return Err(AppError::InvalidPath(format!(
            "路径不存在: {}",
            path.display()
        )));
    }

    // tauri_plugin_opener 在 lib 里已初始化；这里直接走 OS 命令兜底，
    // 让 web 模式（无 Tauri runtime）也能用。
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer")
            .arg(&path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| AppError::IoError(e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::IoError(e))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::IoError(e))?;
    }
    Ok(())
}

// ============================================================================
// Tauri 命令包装
// ============================================================================

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn get_data_root_info() -> Result<DataRootInfo> {
    data_root_info_inner()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn scan_legacy_data_cmd() -> Result<Vec<LegacySource>> {
    scan_legacy_data_inner()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn open_path_in_explorer(path: String) -> Result<()> {
    open_path_in_explorer_inner(PathBuf::from(path))
}

// ============================================================================
// 旧数据迁移
// ============================================================================

/// 迁移选项
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateOptions {
    /// 用户选定的源路径（必须是 scan_legacy_data 返回的路径之一）
    pub sources: Vec<PathBuf>,
    /// 冲突时是否覆盖目标
    /// - false（默认）：合并模式，同内容跳过、异内容写入 *.legacy-{ts} 副本
    /// - true：覆盖模式，旧版直接替换新版（不可逆）
    #[serde(default)]
    pub overwrite: bool,
}

/// 单文件迁移结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateItem {
    pub source: PathBuf,
    pub target: PathBuf,
    pub status: MigrateStatus,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrateStatus {
    /// 复制成功
    Copied,
    /// 目标已存在内容相同，跳过
    Skipped,
    /// 冲突，写到 *.legacy-{ts}.<ext>
    Conflicted,
    /// 失败
    Failed,
}

/// 迁移报告
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateReport {
    pub success_count: u64,
    pub skipped_count: u64,
    pub conflict_count: u64,
    pub error_count: u64,
    pub log_file: PathBuf,
    pub items: Vec<MigrateItem>,
}

/// 旧目录子项 → 数据根目标子项的语义映射
///
/// 旧 claude-code-pro 内的子目录直接对应到新 Polaris 同名子目录。
/// 例外：`logs/` 不迁移（旧日志价值低、占空间），`sessions/` 落到 `cache/sessions`。
///
/// **重要**：根级文件（rel 只有一个分量）必须返回不带尾分隔符的纯文件名，
/// 否则 Windows 会把目标当作目录，fs::copy 报 os error 267。
fn map_legacy_subpath(rel: &Path) -> Option<PathBuf> {
    let mut comps = rel.components();
    let first = comps.next()?;
    let first_name = first.as_os_str().to_string_lossy();
    let rest: PathBuf = comps.collect();

    let mapped_root: PathBuf = match first_name.as_ref() {
        // 跳过：旧日志
        "logs" => return None,
        // 改路径：sessions → cache/sessions
        "sessions" => PathBuf::from("cache").join("sessions"),
        // 同名直接复用
        other => PathBuf::from(other),
    };

    // rest 为空时不要 join，避免在 Windows 上产生尾部分隔符
    if rest.as_os_str().is_empty() {
        Some(mapped_root)
    } else {
        Some(mapped_root.join(rest))
    }
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 比较文件内容（同大小才比对，否则视为不同）
fn files_equal(a: &Path, b: &Path) -> bool {
    let (Ok(meta_a), Ok(meta_b)) = (fs::metadata(a), fs::metadata(b)) else {
        return false;
    };
    if meta_a.len() != meta_b.len() {
        return false;
    }
    // 仅在小文件时做内容比对，避免大文件全读；大文件 fallback 到"不同"
    if meta_a.len() > 4 * 1024 * 1024 {
        return false;
    }
    let (Ok(buf_a), Ok(buf_b)) = (fs::read(a), fs::read(b)) else {
        return false;
    };
    buf_a == buf_b
}

/// 复制单文件，处理冲突
///
/// `overwrite=true` 时：异内容直接覆盖目标（破坏性）。
/// `overwrite=false` 时：异内容写入 `<name>.legacy-{ts}.<ext>` 副本，原目标保持不变。
fn copy_file_with_conflict(src: &Path, dst: &Path, ts: u64, overwrite: bool) -> MigrateItem {
    let target_dir = match dst.parent() {
        Some(d) => d,
        None => {
            return MigrateItem {
                source: src.to_path_buf(),
                target: dst.to_path_buf(),
                status: MigrateStatus::Failed,
                message: Some("无法解析目标父目录".to_string()),
            };
        }
    };
    if let Err(e) = fs::create_dir_all(target_dir) {
        return MigrateItem {
            source: src.to_path_buf(),
            target: dst.to_path_buf(),
            status: MigrateStatus::Failed,
            message: Some(format!("创建目标目录失败: {}", e)),
        };
    }

    if dst.exists() {
        if files_equal(src, dst) {
            return MigrateItem {
                source: src.to_path_buf(),
                target: dst.to_path_buf(),
                status: MigrateStatus::Skipped,
                message: Some("目标已存在且内容相同".to_string()),
            };
        }

        // 异内容冲突：根据 overwrite 选择策略
        if overwrite {
            return match fs::copy(src, dst) {
                Ok(_) => MigrateItem {
                    source: src.to_path_buf(),
                    target: dst.to_path_buf(),
                    status: MigrateStatus::Copied,
                    message: Some("已覆盖目标（旧版替换新版）".to_string()),
                },
                Err(e) => MigrateItem {
                    source: src.to_path_buf(),
                    target: dst.to_path_buf(),
                    status: MigrateStatus::Failed,
                    message: Some(format!("覆盖失败: {}", e)),
                },
            };
        }

        // 默认合并模式：写 .legacy-{ts} 副本
        let stem = dst
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = dst
            .extension()
            .map(|s| format!(".{}", s.to_string_lossy()))
            .unwrap_or_default();
        let alt_name = format!("{}.legacy-{}{}", stem, ts, ext);
        let alt = target_dir.join(alt_name);
        return match fs::copy(src, &alt) {
            Ok(_) => MigrateItem {
                source: src.to_path_buf(),
                target: alt,
                status: MigrateStatus::Conflicted,
                message: Some("目标已存在内容不同，已写入 .legacy 副本".to_string()),
            },
            Err(e) => MigrateItem {
                source: src.to_path_buf(),
                target: alt,
                status: MigrateStatus::Failed,
                message: Some(format!("写入 .legacy 副本失败: {}", e)),
            },
        };
    }

    match fs::copy(src, dst) {
        Ok(_) => MigrateItem {
            source: src.to_path_buf(),
            target: dst.to_path_buf(),
            status: MigrateStatus::Copied,
            message: None,
        },
        Err(e) => MigrateItem {
            source: src.to_path_buf(),
            target: dst.to_path_buf(),
            status: MigrateStatus::Failed,
            message: Some(format!("复制失败: {}", e)),
        },
    }
}

/// 递归遍历源目录，对每个文件触发 cb
fn walk_files<F: FnMut(&Path, &Path)>(src_root: &Path, base: &Path, cb: &mut F) {
    let walker = match fs::read_dir(base) {
        Ok(it) => it,
        Err(_) => return,
    };
    for entry in walker.flatten() {
        let p = entry.path();
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                if let Ok(rel) = p.strip_prefix(src_root) {
                    cb(&p, rel);
                }
            } else if meta.is_dir() {
                walk_files(src_root, &p, cb);
            }
        }
    }
}

/// 校验源路径是否为合法的旧数据源（必须出现在 scan_legacy_data 中）
fn validate_source(src: &Path) -> Result<()> {
    let allowed = scan_legacy_data();
    let canonical = fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
    let ok = allowed.iter().any(|s| {
        let candidate = fs::canonicalize(&s.path).unwrap_or_else(|_| s.path.clone());
        candidate == canonical
    });
    if !ok {
        return Err(AppError::ValidationError(format!(
            "非法迁移源: {} (必须是 scan_legacy_data 返回的路径之一)",
            src.display()
        )));
    }
    Ok(())
}

/// 实际迁移逻辑（共享实现）
pub fn migrate_legacy_data_inner(options: MigrateOptions) -> Result<MigrateReport> {
    let dr = data_root();
    let target_root = dr.root().to_path_buf();
    let ts = now_ts();
    let mut items: Vec<MigrateItem> = Vec::new();

    for src in &options.sources {
        if let Err(e) = validate_source(src) {
            items.push(MigrateItem {
                source: src.clone(),
                target: PathBuf::new(),
                status: MigrateStatus::Failed,
                message: Some(e.to_string()),
            });
            continue;
        }
        if !src.exists() {
            items.push(MigrateItem {
                source: src.clone(),
                target: PathBuf::new(),
                status: MigrateStatus::Failed,
                message: Some("源路径不存在".to_string()),
            });
            continue;
        }

        // 安全检查：不能把数据根自身或其子路径作为源
        let src_canonical = fs::canonicalize(src).unwrap_or_else(|_| src.clone());
        let target_canonical =
            fs::canonicalize(&target_root).unwrap_or_else(|_| target_root.clone());
        if src_canonical == target_canonical || src_canonical.starts_with(&target_canonical) {
            items.push(MigrateItem {
                source: src.clone(),
                target: PathBuf::new(),
                status: MigrateStatus::Failed,
                message: Some("源路径与当前数据根重叠，禁止迁移".to_string()),
            });
            continue;
        }

        // 收集本源所有文件
        let mut pending: Vec<(PathBuf, PathBuf)> = Vec::new();
        walk_files(src, src, &mut |p, rel| {
            let Some(mapped) = map_legacy_subpath(rel) else {
                // 被过滤的（如 logs/）记一条 skipped
                items.push(MigrateItem {
                    source: p.to_path_buf(),
                    target: PathBuf::new(),
                    status: MigrateStatus::Skipped,
                    message: Some("按规则跳过（如旧日志）".to_string()),
                });
                return;
            };
            pending.push((p.to_path_buf(), target_root.join(mapped)));
        });

        for (src_file, dst_file) in pending {
            items.push(copy_file_with_conflict(
                &src_file,
                &dst_file,
                ts,
                options.overwrite,
            ));
        }
    }

    // 统计
    let mut success = 0u64;
    let mut skipped = 0u64;
    let mut conflict = 0u64;
    let mut error = 0u64;
    for it in &items {
        match it.status {
            MigrateStatus::Copied => success += 1,
            MigrateStatus::Skipped => skipped += 1,
            MigrateStatus::Conflicted => conflict += 1,
            MigrateStatus::Failed => error += 1,
        }
    }

    // 写日志
    fs::create_dir_all(dr.meta_dir())?;
    let log_file = dr.meta_dir().join(format!("migration-{}.json", ts));
    let report = MigrateReport {
        success_count: success,
        skipped_count: skipped,
        conflict_count: conflict,
        error_count: error,
        log_file: log_file.clone(),
        items,
    };
    if let Ok(json) = serde_json::to_string_pretty(&report) {
        let _ = fs::write(&log_file, json);
    }

    Ok(report)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn migrate_legacy_data(options: MigrateOptions) -> Result<MigrateReport> {
    migrate_legacy_data_inner(options)
}

// ============================================================================
// 切换数据根
// ============================================================================

/// 切换模式
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SetDataRootMode {
    /// 仅切换锚点，旧数据原地保留，新位置从零开始
    SwitchOnly,
    /// 复制所有数据到新位置成功后再切换锚点
    MoveData,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDataRootOptions {
    /// 新的数据根绝对路径；None 表示恢复默认
    pub new_path: Option<PathBuf>,
    pub mode: SetDataRootMode,
}

/// 路径校验结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetValidation {
    pub ok: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    /// 拟切换的目标绝对路径（None=恢复默认时为默认路径）
    pub resolved_path: PathBuf,
    /// 当前数据根占用，参考用
    pub current_size_bytes: u64,
}

/// 切换报告
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDataRootReport {
    pub old_root: PathBuf,
    pub new_root: PathBuf,
    pub mode: String,
    /// 复制详情（move_data 模式）；switch_only 为 None
    pub move_report: Option<MoveReport>,
    /// 切换成功后必须重启
    pub restart_required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveReport {
    pub success_count: u64,
    pub skipped_count: u64,
    pub conflict_count: u64,
    pub error_count: u64,
    pub log_file: PathBuf,
    pub items_truncated: bool,
    pub items: Vec<MigrateItem>,
}

/// 解析"恢复默认"对应的路径（与 DataRoot::resolve_default 默认分支一致）
fn resolve_default_root() -> Result<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::ConfigError("无法获取系统配置目录".to_string()))?;
    Ok(base.join(crate::services::data_root::APP_NAME))
}

pub fn validate_target_inner(opts: &SetDataRootOptions) -> Result<TargetValidation> {
    let dr = data_root();
    let current_root = dr.root().to_path_buf();

    let resolved = match &opts.new_path {
        Some(p) => p.clone(),
        None => resolve_default_root()?,
    };

    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // 1. 必须绝对路径
    if !resolved.is_absolute() {
        errors.push(format!("路径必须是绝对路径: {}", resolved.display()));
    }

    // 2. 不能与当前根相同
    let current_canonical =
        fs::canonicalize(&current_root).unwrap_or_else(|_| current_root.clone());
    let resolved_canonical = fs::canonicalize(&resolved).unwrap_or_else(|_| resolved.clone());
    if current_canonical == resolved_canonical {
        errors.push("目标路径与当前数据根相同".to_string());
    }

    // 3. 不能是当前根的子路径
    if resolved_canonical.starts_with(&current_canonical) && resolved_canonical != current_canonical
    {
        errors.push("目标路径在当前数据根内部，禁止设置".to_string());
    }
    // 4. 当前根不能是目标的子路径（move 后会丢失数据）
    if current_canonical.starts_with(&resolved_canonical) && current_canonical != resolved_canonical
    {
        errors.push("目标路径包含当前数据根，禁止设置".to_string());
    }

    // 5. 不能在程序安装目录内（current_exe 的父级）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(install_dir) = exe.parent() {
            let install_canonical =
                fs::canonicalize(install_dir).unwrap_or_else(|_| install_dir.to_path_buf());
            if resolved_canonical.starts_with(&install_canonical) {
                errors.push("目标路径位于程序安装目录内，禁止设置（卸载会清空数据）".to_string());
            }
        }
    }

    // 6. 可创建并可写
    if errors.is_empty() {
        if let Err(e) = fs::create_dir_all(&resolved) {
            errors.push(format!("无法创建目标目录: {}", e));
        } else {
            // 试写测试文件
            let probe = resolved.join(".polaris-write-test");
            match fs::write(&probe, b"ok") {
                Ok(_) => {
                    let _ = fs::remove_file(&probe);
                }
                Err(e) => errors.push(format!("目标目录不可写: {}", e)),
            }
        }
    }

    // 7. 目标若已有数据，给警告
    if errors.is_empty() {
        if let Ok(rd) = fs::read_dir(&resolved) {
            let has_content = rd
                .flatten()
                .any(|entry| entry.file_name() != ".polaris-write-test");
            if has_content {
                warnings.push(
                    "目标目录非空，已有内容将与迁移文件合并（同名以 .legacy-* 后缀保留）"
                        .to_string(),
                );
            }
        }
    }

    let (current_size_bytes, _) = dir_stats(&current_root);

    Ok(TargetValidation {
        ok: errors.is_empty(),
        errors,
        warnings,
        resolved_path: resolved,
        current_size_bytes,
    })
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn validate_data_root_target(options: SetDataRootOptions) -> Result<TargetValidation> {
    validate_target_inner(&options)
}

/// 把目录全部内容复制到目标根（按文件粒度，复用 copy_file_with_conflict）
///
/// 切换数据根场景下默认 `overwrite=false`，与迁移合并语义一致：
/// 目标根理论上应是新建空目录，冲突仅在异常重试时才出现，保留 .legacy 副本更安全。
fn move_root_contents(src_root: &Path, dst_root: &Path, ts: u64) -> MoveReport {
    let mut items: Vec<MigrateItem> = Vec::new();

    walk_files(src_root, src_root, &mut |p, rel| {
        let target = dst_root.join(rel);
        items.push(copy_file_with_conflict(p, &target, ts, false));
    });

    let mut success = 0u64;
    let mut skipped = 0u64;
    let mut conflict = 0u64;
    let mut error = 0u64;
    for it in &items {
        match it.status {
            MigrateStatus::Copied => success += 1,
            MigrateStatus::Skipped => skipped += 1,
            MigrateStatus::Conflicted => conflict += 1,
            MigrateStatus::Failed => error += 1,
        }
    }

    // 写日志到目标根的 .meta（迁移成功后，新数据根才是权威）
    let _ = fs::create_dir_all(dst_root.join(".meta"));
    let log_file = dst_root
        .join(".meta")
        .join(format!("relocation-{}.json", ts));
    let truncated = items.len() > 5000;
    let log_payload = MoveReport {
        success_count: success,
        skipped_count: skipped,
        conflict_count: conflict,
        error_count: error,
        log_file: log_file.clone(),
        items_truncated: truncated,
        items: if truncated {
            // 仅保留前 5000 条，避免日志过大
            items.iter().take(5000).cloned().collect()
        } else {
            items.clone()
        },
    };
    if let Ok(json) = serde_json::to_string_pretty(&log_payload) {
        let _ = fs::write(&log_file, json);
    }
    log_payload
}

pub fn set_data_root_inner(options: SetDataRootOptions) -> Result<SetDataRootReport> {
    // 1. 校验
    let validation = validate_target_inner(&options)?;
    if !validation.ok {
        return Err(AppError::ValidationError(format!(
            "目标路径不合法: {}",
            validation.errors.join("; ")
        )));
    }

    let dr = data_root();
    let old_root = dr.root().to_path_buf();
    let new_root = validation.resolved_path.clone();

    // 2. 确保目标根所有子目录就绪
    fs::create_dir_all(&new_root)?;
    for sub in ["logs", "dialogs", "scheduler", "plugins", "cache", ".meta"] {
        fs::create_dir_all(new_root.join(sub))?;
    }

    let mut move_report: Option<MoveReport> = None;

    if options.mode == SetDataRootMode::MoveData {
        let ts = now_ts();
        let report = move_root_contents(&old_root, &new_root, ts);
        // 任何关键失败都视为迁移失败：不切锚点
        if report.error_count > 0 {
            return Err(AppError::ConfigError(format!(
                "数据复制失败 {} 个文件，已写入日志 {}；锚点未切换。",
                report.error_count,
                report.log_file.display()
            )));
        }
        move_report = Some(report);

        // 标记旧根为 superseded（不删除，留 7 天供用户回滚）
        let superseded_marker = old_root
            .join(".meta")
            .join(format!("superseded-{}.json", ts));
        let _ = fs::create_dir_all(old_root.join(".meta"));
        let payload = serde_json::json!({
            "supersededAt": ts,
            "newRoot": new_root,
            "note": "此目录已被切换为新数据根；保留 7 天后可手动清理。",
        });
        if let Ok(json) = serde_json::to_string_pretty(&payload) {
            let _ = fs::write(&superseded_marker, json);
        }
    }

    // 3. 写锚点（最后一步，所有先决条件成功后才切换）
    let anchor_target = if options.new_path.is_none() {
        // 恢复默认 → 清空 dataRoot 字段
        None
    } else {
        Some(new_root.clone())
    };
    DataRoot::set_anchor(anchor_target.as_deref())?;

    Ok(SetDataRootReport {
        old_root,
        new_root,
        mode: match options.mode {
            SetDataRootMode::SwitchOnly => "switch_only".to_string(),
            SetDataRootMode::MoveData => "move_data".to_string(),
        },
        move_report,
        restart_required: true,
    })
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn set_data_root(options: SetDataRootOptions) -> Result<SetDataRootReport> {
    set_data_root_inner(options)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn map_legacy_subpath_root_file_no_trailing_separator() {
        // 修复 bug：根级文件不应带尾分隔符
        let mapped = map_legacy_subpath(Path::new("config.json")).unwrap();
        let s = mapped.to_string_lossy();
        assert!(
            !s.ends_with('\\') && !s.ends_with('/'),
            "根级文件路径不应带尾分隔符，实际: {:?}",
            s
        );
        assert_eq!(mapped, PathBuf::from("config.json"));
    }

    #[test]
    fn map_legacy_subpath_nested_file() {
        let mapped = map_legacy_subpath(Path::new("scheduler/tasks.json")).unwrap();
        assert_eq!(mapped, PathBuf::from("scheduler").join("tasks.json"));
    }

    #[test]
    fn map_legacy_subpath_logs_filtered() {
        assert!(map_legacy_subpath(Path::new("logs/app.log")).is_none());
        assert!(map_legacy_subpath(Path::new("logs")).is_none());
    }

    #[test]
    fn map_legacy_subpath_sessions_relocated() {
        let mapped = map_legacy_subpath(Path::new("sessions/abc.jsonl")).unwrap();
        assert_eq!(
            mapped,
            PathBuf::from("cache").join("sessions").join("abc.jsonl")
        );
        // sessions 自身（罕见）也不应带尾分隔符
        let mapped_root = map_legacy_subpath(Path::new("sessions")).unwrap();
        assert_eq!(mapped_root, PathBuf::from("cache").join("sessions"));
    }

    #[test]
    fn copy_file_overwrite_replaces_target() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src.txt");
        let dst = tmp.path().join("dst.txt");
        std::fs::write(&src, b"new").unwrap();
        std::fs::write(&dst, b"old").unwrap();

        let item = copy_file_with_conflict(&src, &dst, 0, true);
        matches!(item.status, MigrateStatus::Copied);
        assert_eq!(std::fs::read(&dst).unwrap(), b"new");
    }

    #[test]
    fn copy_file_no_overwrite_writes_legacy_suffix() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src.txt");
        let dst = tmp.path().join("dst.txt");
        std::fs::write(&src, b"new").unwrap();
        std::fs::write(&dst, b"old").unwrap();

        let item = copy_file_with_conflict(&src, &dst, 1234, false);
        matches!(item.status, MigrateStatus::Conflicted);
        // 原 dst 内容不变
        assert_eq!(std::fs::read(&dst).unwrap(), b"old");
        // .legacy 副本含新内容
        let legacy = tmp.path().join("dst.legacy-1234.txt");
        assert!(legacy.exists());
        assert_eq!(std::fs::read(&legacy).unwrap(), b"new");
    }

    #[test]
    fn copy_file_same_content_skipped() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src.txt");
        let dst = tmp.path().join("dst.txt");
        std::fs::write(&src, b"same").unwrap();
        std::fs::write(&dst, b"same").unwrap();

        let item = copy_file_with_conflict(&src, &dst, 0, true);
        matches!(item.status, MigrateStatus::Skipped);
    }
}
