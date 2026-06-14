//! 数据根目录迁移服务
//!
//! 负责把整个应用数据根目录从 `src` 搬到 `dst`，提供事务式语义：
//! 任何环节失败都回滚到旧根，**不会**让用户陷入"半搬运"状态。
//!
//! ## 流程概要（Move 模式）
//!
//! 1. 预检 (`precheck`)：路径合法、不嵌套、目标可写、空间足够
//! 2. 复制：`src/*` 递归复制到 `dst.<timestamp>.tmp/`
//! 3. 校验：文件数与总字节数与源端一致
//! 4. 提交：把 `dst.<timestamp>.tmp` 重命名为 `dst`
//! 5. 备份旧根：把原 `src` 重命名为 `src.bak.<timestamp>`（保留 7 天）
//!
//! Copy 模式跳过步骤 5，旧根保留原样。
//!
//! ## 失败回滚
//!
//! - 任意步骤失败 → 删除 `.tmp` 目录，配置不写回，旧根不动
//! - 步骤 4/5 之间失败：`dst` 已就绪但旧根未备份 → 仍然成功（用户视角是迁移完成），
//!   旧根删除留待 GC 处理

use crate::error::{AppError, Result};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 迁移模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MigrateMode {
    /// 移动：成功后将旧根重命名为 `.bak.<timestamp>`
    Move,
    /// 复制：旧根保留原样
    Copy,
}

/// 迁移报告
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateReport {
    /// 迁移前的旧根
    pub old_root: PathBuf,
    /// 迁移后的新根
    pub new_root: PathBuf,
    /// 迁移模式
    pub mode: MigrateMode,
    /// 复制的文件总数
    pub file_count: u64,
    /// 复制的总字节数
    pub bytes_copied: u64,
    /// 旧根备份路径（Move 模式才有）
    pub backup_path: Option<PathBuf>,
    /// 是否需要重启（日志/会话句柄）
    pub requires_restart: bool,
}

/// 目录大小与文件计数
#[derive(Debug, Default, Clone, Copy)]
struct DirStats {
    file_count: u64,
    bytes: u64,
}

fn dir_stats(dir: &Path) -> std::io::Result<DirStats> {
    let mut stats = DirStats::default();
    if !dir.exists() {
        return Ok(stats);
    }
    walk(dir, &mut |entry, meta| {
        if meta.is_file() {
            stats.file_count += 1;
            stats.bytes += meta.len();
        }
        Ok(())
    })?;
    Ok(stats)
}

fn walk<F>(dir: &Path, f: &mut F) -> std::io::Result<()>
where
    F: FnMut(&std::fs::DirEntry, &std::fs::Metadata) -> std::io::Result<()>,
{
    let rd = std::fs::read_dir(dir)?;
    for entry in rd {
        let entry = entry?;
        let meta = entry.metadata()?;
        f(&entry, &meta)?;
        if meta.is_dir() {
            walk(&entry.path(), f)?;
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let meta = entry.metadata()?;
        if meta.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if meta.is_file() {
            std::fs::copy(&from, &to)?;
        }
        // symlinks/其他类型暂不处理（应用数据下不会出现）
    }
    Ok(())
}

/// 判断 `inner` 是否在 `outer` 内（含等于）
fn is_descendant(outer: &Path, inner: &Path) -> bool {
    match (outer.canonicalize(), inner.canonicalize()) {
        (Ok(o), Ok(i)) => i.starts_with(&o),
        // 任一路径不存在时（新根是用户刚选的空目录），退到原始字符串前缀比较
        _ => inner.starts_with(outer),
    }
}

fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}

/// 迁移预检
pub fn precheck(src: &Path, dst: &Path) -> Result<()> {
    if dst.as_os_str().is_empty() {
        return Err(AppError::ConfigError("目标路径为空".to_string()));
    }
    if !dst.is_absolute() {
        return Err(AppError::ConfigError("目标路径必须为绝对路径".to_string()));
    }
    // 同一路径：no-op，由调用方处理
    if src == dst {
        return Ok(());
    }
    // 不允许嵌套：dst 不能在 src 内（避免递归复制）
    if is_descendant(src, dst) && src != dst {
        return Err(AppError::ConfigError(
            "目标路径不能位于源路径之内（嵌套）".to_string(),
        ));
    }
    // 也不允许 src 在 dst 内（同样会循环包含）
    if is_descendant(dst, src) && src != dst {
        return Err(AppError::ConfigError(
            "源路径位于目标路径之内（嵌套），无法迁移".to_string(),
        ));
    }
    // 目标父目录必须存在或可创建（先创建一次试试）
    if let Some(parent) = dst.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::ConfigError(format!("无法创建目标父目录 {:?}: {}", parent, e))
            })?;
        }
    }
    // 目标若已存在且非空，拒绝
    if dst.exists() {
        let mut iter = std::fs::read_dir(dst).map_err(|e| {
            AppError::ConfigError(format!("无法读取目标目录 {:?}: {}", dst, e))
        })?;
        if iter.next().is_some() {
            return Err(AppError::ConfigError(format!(
                "目标目录非空，请选择空目录或不存在的路径: {:?}",
                dst
            )));
        }
    }
    Ok(())
}

/// 执行迁移
pub fn migrate(src: &Path, dst: &Path, mode: MigrateMode) -> Result<MigrateReport> {
    precheck(src, dst)?;

    if src == dst {
        return Ok(MigrateReport {
            old_root: src.to_path_buf(),
            new_root: dst.to_path_buf(),
            mode,
            file_count: 0,
            bytes_copied: 0,
            backup_path: None,
            requires_restart: false,
        });
    }

    // 旧根不存在或为空：直接创建目标目录，无需复制
    let stats_before = dir_stats(src).map_err(|e| {
        AppError::ConfigError(format!("无法统计源目录 {:?}: {}", src, e))
    })?;

    if stats_before.file_count == 0 {
        std::fs::create_dir_all(dst).map_err(|e| {
            AppError::ConfigError(format!("无法创建目标目录 {:?}: {}", dst, e))
        })?;
        return Ok(MigrateReport {
            old_root: src.to_path_buf(),
            new_root: dst.to_path_buf(),
            mode,
            file_count: 0,
            bytes_copied: 0,
            backup_path: None,
            requires_restart: false,
        });
    }

    // 1. 复制到 .tmp（与 dst 同父目录，确保后续 rename 在同盘符）
    let tmp_name = format!(
        "{}.migrating.{}.tmp",
        dst.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("polaris-data"),
        timestamp()
    );
    let tmp_dst = dst
        .parent()
        .map(|p| p.join(&tmp_name))
        .unwrap_or_else(|| PathBuf::from(&tmp_name));

    if let Err(e) = copy_dir_recursive(src, &tmp_dst) {
        let _ = std::fs::remove_dir_all(&tmp_dst);
        return Err(AppError::ConfigError(format!(
            "复制到临时目录失败 {:?}: {}",
            tmp_dst, e
        )));
    }

    // 2. 校验
    let stats_after = match dir_stats(&tmp_dst) {
        Ok(s) => s,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp_dst);
            return Err(AppError::ConfigError(format!(
                "校验临时目录失败: {}",
                e
            )));
        }
    };
    if stats_after.file_count != stats_before.file_count
        || stats_after.bytes != stats_before.bytes
    {
        let _ = std::fs::remove_dir_all(&tmp_dst);
        return Err(AppError::ConfigError(format!(
            "迁移校验失败：源 {} 文件 / {} 字节，目标 {} 文件 / {} 字节",
            stats_before.file_count,
            stats_before.bytes,
            stats_after.file_count,
            stats_after.bytes
        )));
    }

    // 3. 提交：rename .tmp -> dst
    if let Err(e) = std::fs::rename(&tmp_dst, dst) {
        let _ = std::fs::remove_dir_all(&tmp_dst);
        return Err(AppError::ConfigError(format!(
            "提交新目录失败 (rename {:?} -> {:?}): {}",
            tmp_dst, dst, e
        )));
    }

    // 4. 处理旧根
    let backup_path = match mode {
        MigrateMode::Copy => None,
        MigrateMode::Move => {
            let bak = src
                .parent()
                .map(|p| {
                    let bak_name = format!(
                        "{}.bak.{}",
                        src.file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("polaris-data"),
                        timestamp()
                    );
                    p.join(bak_name)
                })
                .unwrap_or_else(|| {
                    PathBuf::from(format!("polaris-data.bak.{}", timestamp()))
                });
            // 旧根改名失败不阻塞迁移（dst 已就绪，用户已可用），仅记录
            match std::fs::rename(src, &bak) {
                Ok(_) => Some(bak),
                Err(e) => {
                    tracing::warn!(
                        "[data_migrator] Move 模式下旧根备份失败 {:?} -> {:?}: {}（dst 已就绪，迁移仍视为成功）",
                        src, bak, e
                    );
                    None
                }
            }
        }
    };

    Ok(MigrateReport {
        old_root: src.to_path_buf(),
        new_root: dst.to_path_buf(),
        mode,
        file_count: stats_after.file_count,
        bytes_copied: stats_after.bytes,
        backup_path,
        requires_restart: true,
    })
}

/// 清理超过 `max_age_secs` 的 .bak 备份
///
/// 在应用启动时调用一次，避免备份目录无限堆积。失败不阻塞主流程。
pub fn gc_old_backups(parent: &Path, max_age_secs: u64) {
    let Ok(rd) = std::fs::read_dir(parent) else {
        return;
    };
    let now = SystemTime::now();
    for entry in rd.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        // 仅匹配 *.bak.<digits>
        let Some(idx) = name_str.rfind(".bak.") else {
            continue;
        };
        let suffix = &name_str[idx + 5..];
        if !suffix.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age.as_secs() > max_age_secs {
            let path = entry.path();
            tracing::info!(
                "[data_migrator] 清理过期备份 {:?}（age={}s）",
                path,
                age.as_secs()
            );
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("polaris-migrator-{}-{}", name, uuid::Uuid::new_v4()))
    }

    fn write_tree(root: &Path) {
        std::fs::create_dir_all(root.join("config")).unwrap();
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::create_dir_all(root.join("todo")).unwrap();
        std::fs::write(root.join("config").join("config.json"), b"{}").unwrap();
        std::fs::write(root.join("logs").join("app.log"), b"hello").unwrap();
        std::fs::write(root.join("todo").join("todos.json"), b"[]").unwrap();
    }

    #[test]
    fn copy_mode_keeps_src() {
        let src = unique_tmp("copy-src");
        let dst = unique_tmp("copy-dst");
        write_tree(&src);

        let report = migrate(&src, &dst, MigrateMode::Copy).unwrap();
        assert_eq!(report.file_count, 3);
        assert!(report.bytes_copied > 0);
        assert!(report.backup_path.is_none());
        assert!(src.exists());
        assert!(dst.join("config/config.json").exists());
        assert!(dst.join("logs/app.log").exists());

        std::fs::remove_dir_all(&src).ok();
        std::fs::remove_dir_all(&dst).ok();
    }

    #[test]
    fn move_mode_renames_src_to_bak() {
        let src = unique_tmp("move-src");
        let dst = unique_tmp("move-dst");
        write_tree(&src);

        let report = migrate(&src, &dst, MigrateMode::Move).unwrap();
        assert!(!src.exists(), "src 应已被改名");
        assert!(dst.exists());
        let bak = report.backup_path.expect("Move 模式应有 backup_path");
        assert!(bak.exists() && bak.to_string_lossy().contains(".bak."));

        std::fs::remove_dir_all(&bak).ok();
        std::fs::remove_dir_all(&dst).ok();
    }

    #[test]
    fn nested_dst_in_src_is_rejected() {
        let src = unique_tmp("nest-src");
        write_tree(&src);
        let dst = src.join("inner");

        let err = migrate(&src, &dst, MigrateMode::Copy).unwrap_err();
        match err {
            AppError::ConfigError(msg) => assert!(msg.contains("嵌套")),
            other => panic!("expected ConfigError, got {:?}", other),
        }

        std::fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn nonempty_dst_is_rejected() {
        let src = unique_tmp("ne-src");
        let dst = unique_tmp("ne-dst");
        write_tree(&src);
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(dst.join("foo"), b"bar").unwrap();

        let err = migrate(&src, &dst, MigrateMode::Copy).unwrap_err();
        match err {
            AppError::ConfigError(msg) => assert!(msg.contains("非空")),
            other => panic!("expected ConfigError, got {:?}", other),
        }

        std::fs::remove_dir_all(&src).ok();
        std::fs::remove_dir_all(&dst).ok();
    }

    #[test]
    fn empty_src_creates_empty_dst() {
        let src = unique_tmp("empty-src");
        let dst = unique_tmp("empty-dst");
        std::fs::create_dir_all(&src).unwrap();

        let report = migrate(&src, &dst, MigrateMode::Copy).unwrap();
        assert_eq!(report.file_count, 0);
        assert!(dst.exists());

        std::fs::remove_dir_all(&src).ok();
        std::fs::remove_dir_all(&dst).ok();
    }

    #[test]
    fn relative_path_is_rejected() {
        let src = unique_tmp("rel-src");
        write_tree(&src);
        let err = migrate(&src, Path::new("relative/path"), MigrateMode::Copy).unwrap_err();
        match err {
            AppError::ConfigError(msg) => assert!(msg.contains("绝对路径")),
            other => panic!("expected ConfigError, got {:?}", other),
        }
        std::fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn gc_only_removes_expired_bak_dirs() {
        let parent = unique_tmp("gc");
        std::fs::create_dir_all(&parent).unwrap();

        // 一个未过期的 .bak.<时间戳>
        let recent = parent.join("data.bak.9999999999");
        std::fs::create_dir_all(&recent).unwrap();

        // 一个非 .bak. 后缀的目录（不应被删）
        let other = parent.join("ordinary");
        std::fs::create_dir_all(&other).unwrap();

        gc_old_backups(&parent, 86400 * 7);

        assert!(recent.exists(), "未过期的 .bak 应保留");
        assert!(other.exists(), "非 .bak 命名的目录不应被处理");

        std::fs::remove_dir_all(&parent).ok();
    }
}
