/**
 * Git 服务
 *
 * 提供所有 Git 操作的核心功能实现
 */

use crate::models::git::{self, *};
use git2::{
    BranchType, Diff, DiffDelta, DiffOptions, Oid, Repository, StatusOptions, IndexAddOption,
};
use std::path::Path;
use std::collections::HashMap;
use tracing::{debug, info, warn, error, instrument};
use bitflags::bitflags;

/// 最大内联 Diff 大小 (2MB)
const MAX_INLINE_DIFF_BYTES: usize = 2 * 1024 * 1024;

/// 文件状态位标记
bitflags! {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct FileStatusFlags: u16 {
        // 索引状态 (低 4 位)
        const INDEX_NEW      = 0b0000_0001;
        const INDEX_MODIFIED = 0b0000_0010;
        const INDEX_DELETED  = 0b0000_0100;
        const INDEX_RENAMED  = 0b0000_1000;

        // 工作区状态 (中 4 位)
        const WT_NEW         = 0b0001_0000;
        const WT_MODIFIED    = 0b0010_0000;
        const WT_DELETED     = 0b0100_0000;
        const WT_RENAMED     = 0b1000_0000;

        // 其他状态
        const CONFLICTED     = 0b0001_0000_0000;
    }
}

/// 文件状态信息（用于合并多个 Git 状态条目）
struct FileStatusInfo {
    path: String,
    flags: FileStatusFlags,
}

/// 已知的二进制文件扩展名
const BINARY_EXTENSIONS: &[&str] = &[
    // 图片
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "psd", "ai",
    // 压缩文件
    "zip", "gz", "tar", "rar", "7z", "bz2", "xz", "zst",
    // 可执行文件
    "exe", "dll", "so", "dylib", "app", "bin",
    // 字体
    "ttf", "otf", "woff", "woff2", "eot",
    // 媒体
    "mp3", "mp4", "avi", "mov", "wav", "flac", "ogg", "webm", "mkv",
    // Office
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    // 其他
    "sqlite", "db", "jar", "class", "pyc",
];

/// Git 服务
pub struct GitService;

impl GitService {
    // ========================================================================
    // 辅助函数
    // ========================================================================

    /// 根据文件扩展名检测是否为二进制文件
    fn is_binary_by_extension(path: &std::path::Path) -> bool {
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| {
                let ext_lower = ext.to_lowercase();
                BINARY_EXTENSIONS.contains(&ext_lower.as_str())
            })
            .unwrap_or(false)
    }

    /// 检测字节流是否为二进制内容
    fn is_binary_bytes(bytes: &[u8]) -> bool {
        const CHECK_SIZE: usize = 8192;
        let sample = &bytes[..bytes.len().min(CHECK_SIZE)];

        // 1. 检查 UTF-8 有效性
        if std::str::from_utf8(sample).is_err() {
            return true;
        }

        // 2. 检查 null 字节（文本文件中很少出现超过 10 个）
        let null_count = sample.iter().filter(|&&b| b == 0).count();
        if null_count > 10 {
            return true;
        }

        // 3. 检查特定二进制文件签名（魔术字节）
        if sample.len() >= 4 {
            // PNG: \x89PNG
            if sample.starts_with(b"\x89PNG") {
                return true;
            }
            // PDF: %PDF
            if sample.starts_with(b"%PDF") {
                return true;
            }
            // ZIP: PK\x03\x04
            if sample.starts_with(b"PK\x03\x04") {
                return true;
            }
            // RAR: Rar!
            if sample.starts_with(b"Rar!") {
                return true;
            }
            // ELF (可执行文件)
            if sample.starts_with(b"\x7fELF") {
                return true;
            }
            // Mach-O (macOS 可执行文件)
            if sample.starts_with(b"\xfe\xed\xfa") || sample.starts_with(b"\xcf\xfa\xed\xfe") {
                return true;
            }
            // PE (Windows 可执行文件)
            if sample.starts_with(b"MZ") {
                return true;
            }
        }

        false
    }

    // ========================================================================
    // 仓库操作
    // ========================================================================

    /// 检查路径是否为 Git 仓库
    pub fn is_repository(path: &Path) -> bool {
        Repository::open(path).is_ok()
    }

    /// 打开仓库
    fn open_repository(path: &Path) -> Result<Repository, GitServiceError> {
        Repository::open(path).map_err(GitServiceError::from)
    }

    /// 初始化 Git 仓库
    pub fn init_repository(path: &Path, initial_branch: Option<&str>) -> Result<String, GitServiceError> {
        let branch_name = initial_branch.unwrap_or("main");

        let repo = git2::Repository::init_opts(
            path,
            git2::RepositoryInitOptions::new()
                .initial_head(branch_name)
                .mkdir(true),
        )?;

        // 创建初始提交
        let sig = repo.signature()?;
        let tree_id = {
            let tree_builder = repo.treebuilder(None)?;
            tree_builder.write()?
        };
        let tree = repo.find_tree(tree_id)?;

        let oid = repo.commit(
            Some(&format!("refs/heads/{}", branch_name)),
            &sig,
            &sig,
            "Initial commit",
            &tree,
            &[],
        )?;

        Ok(oid.to_string())
    }

    // ========================================================================
    // 状态查询
    // ========================================================================

    /// 获取仓库状态
    #[instrument(skip(path))]
    pub fn get_status(path: &Path) -> Result<GitRepositoryStatus, GitServiceError> {
        debug!("开始获取仓库状态，路径: {:?}", path);

        let repo = match Self::open_repository(path) {
            Ok(r) => {
                debug!("仓库打开成功");
                r
            }
            Err(e) => {
                error!("仓库打开失败: {:?}", e);
                return Err(e);
            }
        };

        // 检查是否为空仓库
        let is_empty = repo.is_empty().unwrap_or(true);
        debug!("仓库是否为空: {}", is_empty);

        // 获取 HEAD 信息 - 处理引用不存在的情况
        let (branch, commit, short_commit) = if is_empty {
            // 空仓库：通过 HEAD 引用的 symbolic_target 获取分支名
            let branch_name = repo.find_reference("HEAD")
                .ok()
                .and_then(|r| r.symbolic_target().map(|s| s.to_string()))
                .and_then(|s| {
                    s.strip_prefix("refs/heads/")
                        .map(|s| s.to_string())
                        .or(Some(s))
                })
                .unwrap_or_default();
            debug!("空仓库分支名: {}", branch_name);
            (branch_name, String::new(), String::new())
        } else {
            match repo.head() {
                Ok(head) => {
                    let branch_name = head.shorthand().unwrap_or("HEAD").to_string();
                    match head.target() {
                        Some(oid) => {
                            let commit_str = oid.to_string();
                            let short_str = commit_str.chars().take(8).collect();
                            (branch_name, commit_str, short_str)
                        }
                        None => {
                            // HEAD 引用存在但无目标，可能是分离状态
                            (branch_name, String::new(), String::new())
                        }
                    }
                }
                Err(e) => {
                    // HEAD 引用不存在（可能是分支被删除但HEAD仍指向它）
                    warn!("无法获取 HEAD 引用: {:?}，尝试从其他来源获取状态", e);
                    // 尝试获取文件状态，即使 HEAD 有问题
                    (String::new(), String::new(), String::new())
                }
            }
        };

        // 计算领先/落后
        let (ahead, behind) = if !is_empty && !branch.is_empty() {
            Self::get_ahead_behind(&repo, &branch).unwrap_or((0, 0))
        } else {
            (0, 0)
        };

        // 获取文件状态
        let (staged, unstaged, untracked, conflicted) = Self::parse_statuses(&repo)?;

        Ok(GitRepositoryStatus {
            exists: true,
            branch,
            commit,
            short_commit,
            ahead,
            behind,
            staged,
            unstaged,
            untracked,
            conflicted,
            is_empty,
        })
    }

    /// 解析文件状态（重构版：合并多状态条目）
    fn parse_statuses(repo: &Repository) -> Result<
        (Vec<GitFileChange>, Vec<GitFileChange>, Vec<String>, Vec<String>),
        GitServiceError,
    > {
        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .include_ignored(false)
            .recurse_untracked_dirs(true);

        let statuses = repo.statuses(Some(&mut opts))?;

        // 使用 HashMap 合并同一文件的多个状态条目
        let mut file_map: HashMap<String, FileStatusInfo> = HashMap::new();

        for entry in statuses.iter() {
            let status = entry.status();
            let path = entry.path().unwrap_or("").to_string();

            if path.is_empty() {
                continue;
            }

            debug!("处理文件: {}, status: {:?}", path, status);
            debug!("  索引: new={} modified={} deleted={} renamed={}",
                status.is_index_new(), status.is_index_modified(),
                status.is_index_deleted(), status.is_index_renamed());
            debug!("  工作区: new={} modified={} deleted={} renamed={}",
                status.is_wt_new(), status.is_wt_modified(),
                status.is_wt_deleted(), status.is_wt_renamed());

            // 获取或创建文件状态信息
            let info = file_map.entry(path.clone()).or_insert_with(|| FileStatusInfo {
                path: path.clone(),
                flags: FileStatusFlags::empty(),
            });

            // 合并索引状态
            if status.is_index_new() { info.flags |= FileStatusFlags::INDEX_NEW; }
            if status.is_index_modified() { info.flags |= FileStatusFlags::INDEX_MODIFIED; }
            if status.is_index_deleted() { info.flags |= FileStatusFlags::INDEX_DELETED; }
            if status.is_index_renamed() { info.flags |= FileStatusFlags::INDEX_RENAMED; }

            // 合并工作区状态
            if status.is_wt_new() { info.flags |= FileStatusFlags::WT_NEW; }
            if status.is_wt_modified() { info.flags |= FileStatusFlags::WT_MODIFIED; }
            if status.is_wt_deleted() { info.flags |= FileStatusFlags::WT_DELETED; }
            if status.is_wt_renamed() { info.flags |= FileStatusFlags::WT_RENAMED; }
            if status.is_conflicted() { info.flags |= FileStatusFlags::CONFLICTED; }
        }

        // 根据合并后的状态进行分类
        let mut staged = Vec::new();
        let mut unstaged = Vec::new();
        let mut untracked = Vec::new();
        let mut conflicted = Vec::new();

        for (_path, info) in file_map.into_iter() {
            debug!("分类文件: {}", info.path);
            debug!("  索引状态: new={} mod={} del={} ren={}",
                info.flags.contains(FileStatusFlags::INDEX_NEW),
                info.flags.contains(FileStatusFlags::INDEX_MODIFIED),
                info.flags.contains(FileStatusFlags::INDEX_DELETED),
                info.flags.contains(FileStatusFlags::INDEX_RENAMED));
            debug!("  工作区状态: new={} mod={} del={} ren={}",
                info.flags.contains(FileStatusFlags::WT_NEW),
                info.flags.contains(FileStatusFlags::WT_MODIFIED),
                info.flags.contains(FileStatusFlags::WT_DELETED),
                info.flags.contains(FileStatusFlags::WT_RENAMED));

            // 冲突文件优先处理
            if info.flags.contains(FileStatusFlags::CONFLICTED) {
                conflicted.push(info.path.clone());
            }

            // === 已暂存区分类逻辑 ===
            let index_flags = FileStatusFlags::INDEX_NEW
                | FileStatusFlags::INDEX_MODIFIED
                | FileStatusFlags::INDEX_DELETED
                | FileStatusFlags::INDEX_RENAMED;

            // 如果文件在索引中有任何变更，则加入 staged 列表
            if info.flags.intersects(index_flags) {
                let status = if info.flags.contains(FileStatusFlags::INDEX_NEW) {
                    GitFileStatus::Added
                } else if info.flags.contains(FileStatusFlags::INDEX_DELETED) {
                    GitFileStatus::Deleted
                } else if info.flags.contains(FileStatusFlags::INDEX_RENAMED) {
                    GitFileStatus::Renamed
                } else {
                    GitFileStatus::Modified
                };

                debug!("  -> 加入 staged (状态: {:?})", status);
                staged.push(GitFileChange {
                    path: info.path.clone(),
                    status,
                    old_path: None,
                    additions: None,
                    deletions: None,
                });
            }

            // === 未暂存区分类逻辑 ===
            let wt_flags = FileStatusFlags::WT_NEW
                | FileStatusFlags::WT_MODIFIED
                | FileStatusFlags::WT_DELETED
                | FileStatusFlags::WT_RENAMED;

            // 关键：即使文件在索引中有变更，只要工作区也有变更，也要在 unstaged 中显示
            if info.flags.intersects(wt_flags) {
                // 如果是纯新增文件（untracked），放入 untracked
                if info.flags.contains(FileStatusFlags::WT_NEW)
                    && !info.flags.intersects(index_flags) {
                    untracked.push(info.path.clone());
                    debug!("  -> 加入 untracked (纯新增)");
                } else {
                    // 其他情况都视为修改，加入 unstaged
                    // 这包括：
                    // 1. 暂存区删除 + 工作区新增（如 11.md 的情况）
                    // 2. 暂存区修改 + 工作区修改
                    // 3. 纯工作区修改
                    let status = if info.flags.contains(FileStatusFlags::WT_NEW) {
                        GitFileStatus::Added
                    } else if info.flags.contains(FileStatusFlags::WT_DELETED) {
                        GitFileStatus::Deleted
                    } else if info.flags.contains(FileStatusFlags::WT_RENAMED) {
                        GitFileStatus::Renamed
                    } else {
                        GitFileStatus::Modified
                    };

                    debug!("  -> 加入 unstaged (状态: {:?})", status);
                    unstaged.push(GitFileChange {
                        path: info.path.clone(),
                        status,
                        old_path: None,
                        additions: None,
                        deletions: None,
                    });
                }
            }
        }

        info!("parse_statuses 完成: staged={}, unstaged={}, untracked={}, conflicted={}",
            staged.len(), unstaged.len(), untracked.len(), conflicted.len());
        debug!("  staged paths: {:?}", staged.iter().map(|f| &f.path).collect::<Vec<_>>());
        debug!("  unstaged paths: {:?}", unstaged.iter().map(|f| &f.path).collect::<Vec<_>>());
        debug!("  untracked paths: {:?}", untracked);

        Ok((staged, unstaged, untracked, conflicted))
    }

    /// 计算分支的领先/落后
    fn get_ahead_behind(repo: &Repository, branch_name: &str) -> Result<(usize, usize), GitServiceError> {
        let branch = repo
            .find_branch(branch_name, BranchType::Local)
            .or_else(|_| repo.find_branch(branch_name, BranchType::Remote))?;

        // 尝试获取上游分支
        let upstream = branch.upstream();

        if let Ok(upstream_branch) = upstream {
            let branch_oid = branch.get().target()
                .ok_or(GitServiceError::BranchNotFound(branch_name.to_string()))?;
            let upstream_oid = upstream_branch.get().target()
                .ok_or(GitServiceError::BranchNotFound("upstream".to_string()))?;

            Ok(repo.graph_ahead_behind(branch_oid, upstream_oid)?)
        } else {
            Ok((0, 0))
        }
    }

    // ========================================================================
    // Diff 操作
    // ========================================================================

    /// 获取 Diff（HEAD vs 指定 commit）
    pub fn get_diff(path: &Path, base_commit: &str) -> Result<Vec<GitDiffEntry>, GitServiceError> {
        let repo = Self::open_repository(path)?;

        let base_oid = Oid::from_str(base_commit)
            .map_err(|_| GitServiceError::CommitNotFound(base_commit.to_string()))?;
        let base_commit_obj = repo.find_commit(base_oid)
            .map_err(|_| GitServiceError::CommitNotFound(base_commit.to_string()))?;
        let base_tree = base_commit_obj.tree()?;

        let head = repo.head()?;
        let head_commit = head.peel_to_commit()?;
        let head_tree = head_commit.tree()?;

        // 计算 Diff
        let mut diff_opts = DiffOptions::new();
        diff_opts.include_typechange(true);

        let diff = repo.diff_tree_to_tree(
            Some(&base_tree),
            Some(&head_tree),
            Some(&mut diff_opts),
        )?;

        // 直接传递仓库引用，不再重新打开
        Self::convert_diff(&repo, &diff)
    }

    /// 获取工作区 Diff（未暂存的变更）
    pub fn get_worktree_diff(path: &Path) -> Result<Vec<GitDiffEntry>, GitServiceError> {
        let repo = Self::open_repository(path)?;

        let head = repo.head()?;
        let head_commit = head.peel_to_commit()?;
        let head_tree = head_commit.tree()?;

        let diff = repo.diff_tree_to_workdir(Some(&head_tree), None)?;

        // 直接传递仓库引用，不再重新打开
        Self::convert_diff(&repo, &diff)
    }

    /// 获取暂存区 Diff（已暂存的变更）
    pub fn get_index_diff(path: &Path) -> Result<Vec<GitDiffEntry>, GitServiceError> {
        let repo = Self::open_repository(path)?;

        let head = repo.head()?;
        let head_commit = head.peel_to_commit()?;
        let head_tree = head_commit.tree()?;

        let diff = repo.diff_tree_to_index(Some(&head_tree), None, None)?;

        // 直接传递仓库引用，不再重新打开
        Self::convert_diff(&repo, &diff)
    }

    /// 获取单个文件在工作区的 Diff（智能版）
    pub fn get_worktree_file_diff(path: &Path, file_path: &str) -> Result<GitDiffEntry, GitServiceError> {
        debug!("=== get_worktree_file_diff 开始 ===");
        debug!("工作区路径: {:?}", path);
        debug!("文件路径: {}", file_path);

        let repo = Self::open_repository(path)?;
        debug!("打开仓库成功");

        // 1. 获取文件的详细状态
        let mut status_opts = StatusOptions::new();
        status_opts.pathspec(file_path);
        status_opts.include_untracked(true);
        status_opts.recurse_untracked_dirs(false);

        let statuses = repo.statuses(Some(&mut status_opts))?;
        debug!("获取文件状态成功");

        if let Some(entry) = statuses.iter().next() {
            let status = entry.status();

            debug!("文件: {}, 状态: {:?}", file_path, status);
            debug!("  is_index_new: {}, is_index_modified: {}, is_index_deleted: {}",
                status.is_index_new(),
                status.is_index_modified(),
                status.is_index_deleted()
            );
            debug!("  is_wt_new: {}, is_wt_modified: {}, is_wt_deleted: {}",
                status.is_wt_new(),
                status.is_wt_modified(),
                status.is_wt_deleted()
            );

            // 2. 判断文件在工作区的状态，决定使用哪种 diff 方法
            // 如果文件在暂存区有变更（新增或修改），则显示"暂存区 vs 工作区"
            // 如果文件仅在暂存区删除但工作区存在，则显示"HEAD vs 工作区"
            // 否则（未暂存的变更），显示"HEAD vs 工作区"
            if status.is_index_new() || status.is_index_modified() {
                // 文件已暂存：显示暂存区 vs 工作区
                debug!("文件已暂存，使用 get_diff_index_to_workdir (暂存区 vs 工作区)");
                return Self::get_diff_index_to_workdir(&repo, file_path);
            }

            // 其他情况（未暂存、暂存区删除等）：显示 HEAD vs 工作区
            debug!("文件未暂存或暂存区删除，使用 get_diff_head_to_workdir_direct (HEAD vs 工作区)");
            return Self::get_diff_head_to_workdir_direct(&repo, file_path);
        }

        // 3. 如果没有获取到状态，可能是未跟踪文件，使用 HEAD vs 工作区
        debug!("未获取到文件状态，使用 get_diff_head_to_workdir_direct (HEAD vs 工作区)");
        Self::get_diff_head_to_workdir_direct(&repo, file_path)
    }

    /// 获取单个文件在暂存区的 Diff
    pub fn get_index_file_diff(path: &Path, file_path: &str) -> Result<GitDiffEntry, GitServiceError> {
        let repo = Self::open_repository(path)?;

        let head = repo.head()?;
        let head_commit = head.peel_to_commit()?;
        let head_tree = head_commit.tree()?;

        // 创建 DiffOptions 并指定路径
        let mut diffopts = DiffOptions::new();
        diffopts.pathspec(file_path);
        diffopts.ignore_case(false);

        let diff = repo.diff_tree_to_index(Some(&head_tree), None, Some(&mut diffopts))?;

        // 直接传递仓库引用，不再重新打开
        let entries = Self::convert_diff(&repo, &diff)?;
        entries.into_iter().next().ok_or_else(|| {
            GitServiceError::CLIError(format!("文件 {} 没有变更", file_path))
        })
    }

    /// 将 git2::Diff 转换为 GitDiffEntry
    fn convert_diff(repo: &Repository, diff: &Diff) -> Result<Vec<GitDiffEntry>, GitServiceError> {
        let mut entries = Vec::new();

        for delta in diff.deltas() {
            // 使用 DiffDelta API 获取文件路径
            let new_path = delta.new_file().path();
            let old_path = delta.old_file().path();

            let file_path = new_path
                .or(old_path)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            let old_file_path = if delta.status() == git2::Delta::Renamed || delta.status() == git2::Delta::Copied {
                old_path.map(|p| p.to_string_lossy().to_string())
            } else {
                None
            };

            let change_type = match delta.status() {
                git2::Delta::Added => DiffChangeType::Added,
                git2::Delta::Deleted => DiffChangeType::Deleted,
                git2::Delta::Modified => DiffChangeType::Modified,
                git2::Delta::Renamed => DiffChangeType::Renamed,
                git2::Delta::Copied => DiffChangeType::Copied,
                _ => DiffChangeType::Modified,
            };

            // 计算行数变化
            let (additions, deletions) = Self::compute_line_stats(&diff, &delta);

            // 检查是否为二进制文件
            let is_binary = delta.new_file().is_binary() || delta.old_file().is_binary();

            // 获取文件内容（如果不是二进制且不太大）
            let (old_content, new_content, content_omitted) = if is_binary {
                (None, None, Some(true))
            } else {
                Self::get_diff_content(&repo, &delta, &change_type)?
            };

            // 添加状态提示，帮助用户理解当前 diff 的比较基准
            let status_hint = Some(GitDiffStatusHint {
                has_conflict: false,
                message: None,
                current_view: "HEAD vs 暂存区".to_string(),  // diff_tree_to_index 比较 HEAD 和暂存区
            });

            entries.push(GitDiffEntry {
                file_path: file_path.clone(),
                old_file_path,
                change_type,
                old_content,
                new_content,
                additions: Some(additions),
                deletions: Some(deletions),
                is_binary,
                content_omitted,
                status_hint,
            });
        }

        Ok(entries)
    }

    /// 计算增删行数
    /// 注意：git2 0.18 版本的 Diff API 较为复杂，这里暂时返回 (0, 0)
    /// 可以通过后续分析 diff 内容来准确计算
    fn compute_line_stats(_diff: &Diff, _delta: &DiffDelta) -> (usize, usize) {
        // TODO: 实现准确的行数统计
        (0, 0)
    }

    /// 获取 Diff 的文件内容
    fn get_diff_content(
        repo: &Repository,
        delta: &DiffDelta,
        change_type: &DiffChangeType,
    ) -> Result<(Option<String>, Option<String>, Option<bool>), GitServiceError> {
        let old_content = if !matches!(change_type, DiffChangeType::Added) {
            let oid = delta.old_file().id();
            if !oid.is_zero() {
                match repo.find_blob(oid) {
                    Ok(blob) => {
                        if blob.size() > MAX_INLINE_DIFF_BYTES {
                            Some(None)
                        } else if blob.is_binary() {
                            Some(None)
                        } else {
                            Some(std::str::from_utf8(blob.content()).ok().map(|s| s.to_string()))
                        }
                    }
                    Err(_) => Some(None),
                }
            } else {
                Some(None)
            }
        } else {
            Some(None)
        };

        // 修复：当 OID 为零时（工作区文件），从文件系统读取
        let new_content = if !matches!(change_type, DiffChangeType::Deleted) {
            let oid = delta.new_file().id();
            if !oid.is_zero() {
                // 从 Git blob 读取（暂存区的情况）
                match repo.find_blob(oid) {
                    Ok(blob) => {
                        if blob.size() > MAX_INLINE_DIFF_BYTES {
                            Some(None)
                        } else if blob.is_binary() {
                            Some(None)
                        } else {
                            Some(std::str::from_utf8(blob.content()).ok().map(|s| s.to_string()))
                        }
                    }
                    Err(_) => Some(None),
                }
            } else {
                // OID 为零，尝试从工作区读取文件
                if let Some(path) = delta.new_file().path() {
                    let workdir = repo.workdir().ok_or(GitServiceError::NotARepository)?;
                    let full_path = workdir.join(path);

                    // 首先检查扩展名
                    if Self::is_binary_by_extension(&full_path) {
                        Some(None)
                    } else {
                        // 检查文件大小
                        let metadata = std::fs::metadata(&full_path);
                        if let Ok(meta) = metadata {
                            if meta.len() > MAX_INLINE_DIFF_BYTES as u64 {
                                Some(None)
                            } else {
                                // 读取字节并检测二进制
                                match std::fs::read(&full_path) {
                                    Ok(bytes) => {
                                        if Self::is_binary_bytes(&bytes) {
                                            Some(None)
                                        } else {
                                            // 确认是文本，转换为字符串
                                            std::str::from_utf8(&bytes).ok().map(|s| s.to_string()).map(Some)
                                        }
                                    }
                                    Err(_) => Some(None),
                                }
                            }
                        } else {
                            Some(None)
                        }
                    }
                } else {
                    Some(None)
                }
            }
        } else {
            Some(None)
        };

        // 计算是否省略内容
        // 只有当内容存在但被省略时（Some(None)），才标记为省略
        // None 表示没有内容（如新增文件的旧内容），不应该标记为省略
        let content_omitted = matches!(&old_content, Some(None))
            || matches!(&new_content, Some(None));

        // 提取内容
        let old = old_content.and_then(|o| o);
        let new = new_content.and_then(|n| n);

        Ok((
            old,
            new,
            if content_omitted { Some(true) } else { None },
        ))
    }

    /// 直接比较 HEAD 和工作区（绕过暂存区）
    fn get_diff_head_to_workdir_direct(
        repo: &Repository,
        file_path: &str,
    ) -> Result<GitDiffEntry, GitServiceError> {

        // 1. 获取 HEAD 内容
        let head = repo.head()?;
        let head_commit = head.peel_to_commit()?;
        let head_tree = head_commit.tree()?;

        let old_content: Option<Option<String>> = if let Ok(entry) = head_tree.get_path(std::path::Path::new(file_path)) {
            let obj = entry.to_object(&repo)?;
            if let Some(blob) = obj.as_blob() {
                if blob.size() > MAX_INLINE_DIFF_BYTES {
                    Some(None)  // 文件过大内容被省略
                } else if blob.is_binary() {
                    Some(None)  // 二进制文件内容被省略
                } else {
                    Some(std::str::from_utf8(blob.content()).ok().map(|s| s.to_string()))  // 内容存在
                }
            } else {
                Some(None)  // 读取失败，视为省略
            }
        } else {
            None  // 文件不存在
        };

        // 2. 读取工作区内容
        let workdir = repo.workdir().ok_or(GitServiceError::NotARepository)?;
        let full_path = workdir.join(file_path);

        let new_content: Option<Option<String>> = if full_path.exists() {
            // 首先检查扩展名
            if Self::is_binary_by_extension(&full_path) {
                Some(None)  // 二进制文件内容被省略
            } else {
                let metadata = std::fs::metadata(&full_path);
                if let Ok(meta) = metadata {
                    if meta.len() > MAX_INLINE_DIFF_BYTES as u64 {
                        Some(None)  // 文件过大内容被省略
                    } else {
                        match std::fs::read(&full_path) {
                            Ok(bytes) => {
                                let is_bin = Self::is_binary_bytes(&bytes);
                                if is_bin {
                                    Some(None)  // 二进制文件内容被省略
                                } else {
                                    Some(std::str::from_utf8(&bytes).ok().map(|s| s.to_string()))  // 内容存在
                                }
                            }
                            Err(_) => Some(None),  // 读取失败，视为省略
                        }
                    }
                } else {
                    Some(None)  // 无法获取元数据，视为省略
                }
            }
        } else {
            None  // 文件不存在
        };

        // 3. 判断变更类型
        let change_type = match (&old_content, &new_content) {
            (Some(_), Some(_)) => DiffChangeType::Modified,
            (Some(_), None) => DiffChangeType::Deleted,
            (None, Some(_)) => DiffChangeType::Added,
            (None, None) => return Err(GitServiceError::CLIError("文件无变更".into())),
        };

        // 4. 计算 content_omitted（在移动之前）
        let content_omitted = matches!(&old_content, Some(None))
            || matches!(&new_content, Some(None));

        // 5. 判断是否为二进制（在移动之前）
        let is_binary = matches!(&new_content, Some(None));

        // 6. 提取内容（flatten）
        let old = old_content.and_then(|o| o);
        let new = new_content.and_then(|n| n);

        // 7. 计算 diff 行数
        let (additions, deletions) = if !is_binary {
            if let (Some(old), Some(new)) = (&old, &new) {
                Self::compute_line_diff(old, new)
            } else {
                (0, 0)
            }
        } else {
            (0, 0)
        };

        // 8. 构建状态提示
        // 判断是否有冲突（暂存区和工作区都有变更的情况）
        let has_conflict = false; // HEAD vs 工作区通常没有冲突概念
        let message = None;

        let status_hint = Some(GitDiffStatusHint {
            has_conflict,
            message,
            current_view: "HEAD vs 工作区".to_string(),
        });

        Ok(GitDiffEntry {
            file_path: file_path.to_string(),
            old_file_path: None,
            change_type,
            old_content: old,
            new_content: new,
            additions: Some(additions),
            deletions: Some(deletions),
            is_binary,
            content_omitted: if content_omitted { Some(true) } else { None },
            status_hint,
        })
    }

    /// 比较暂存区和工作区
    fn get_diff_index_to_workdir(
        repo: &Repository,
        file_path: &str,
    ) -> Result<GitDiffEntry, GitServiceError> {
        debug!("=== get_diff_index_to_workdir 开始 ===");
        debug!("文件路径: {}", file_path);

        // 1. 获取暂存区内容
        let index = repo.index()?;
        debug!("获取暂存区 index 成功");

        // 获取索引中的条目
        let old_content: Option<Option<String>> = if let Some(entry) = index.get_path(std::path::Path::new(file_path), 0) {
            let id = entry.id;
            debug!("暂存区找到文件条目，blob id: {:?}", id);
            if let Ok(blob) = repo.find_blob(id) {
                if blob.size() > MAX_INLINE_DIFF_BYTES {
                    debug!("暂存区内容超过大小限制 ({} bytes)", MAX_INLINE_DIFF_BYTES);
                    Some(None)  // 文件存在但内容被省略
                } else if blob.is_binary() {
                    debug!("暂存区内容为二进制");
                    Some(None)  // 二进制文件内容被省略
                } else {
                    let content = std::str::from_utf8(blob.content()).ok().map(|s| s.to_string());
                    debug!("从 blob 读取暂存区内容成功，长度: {:?}", content.as_ref().map(|s| s.len()));
                    Some(content)  // 内容存在
                }
            } else {
                debug!("从 blob 读取暂存区内容失败");
                Some(None)  // 读取失败，视为省略
            }
        } else {
            debug!("暂存区中没有该文件条目");
            None  // 文件不存在
        };

        // 2. 读取工作区内容
        let workdir = repo.workdir().ok_or(GitServiceError::NotARepository)?;
        let full_path = workdir.join(file_path);
        debug!("工作区完整路径: {:?}", full_path);
        debug!("工作区文件是否存在: {}", full_path.exists());

        let new_content: Option<Option<String>> = if full_path.exists() {
            // 首先检查扩展名
            if Self::is_binary_by_extension(&full_path) {
                Some(None)  // 二进制文件内容被省略
            } else {
                match std::fs::read(&full_path) {
                    Ok(bytes) => {
                        let is_bin = Self::is_binary_bytes(&bytes);
                        debug!("从文件系统读取工作区内容成功，字节长度: {}", bytes.len());
                        debug!("是否为二进制文件: {}", is_bin);
                        if is_bin {
                            Some(None)  // 二进制文件内容被省略
                        } else if bytes.len() > MAX_INLINE_DIFF_BYTES {
                            debug!("工作区内容超过大小限制");
                            Some(None)  // 文件过大内容被省略
                        } else {
                            let content = std::str::from_utf8(&bytes).ok().map(|s| s.to_string());
                            debug!("工作区文本内容长度: {:?}", content.as_ref().map(|s| s.len()));
                            Some(content)  // 内容存在
                        }
                    }
                    Err(e) => {
                        debug!("从文件系统读取工作区内容失败: {:?}", e);
                        Some(None)  // 读取失败，视为省略
                    }
                }
            }
        } else {
            debug!("工作区文件不存在");
            None  // 文件不存在
        };

        let is_binary = matches!(&new_content, Some(None));

        // 3. 判断变更类型
        let change_type = match (&old_content, &new_content) {
            (Some(_), Some(_)) => {
                debug!("变更类型: Modified (暂存区和工作区都有内容)");
                DiffChangeType::Modified
            },
            (Some(_), None) => {
                debug!("变更类型: Deleted (只有暂存区有内容)");
                DiffChangeType::Deleted
            },
            (None, Some(_)) => {
                debug!("变更类型: Added (只有工作区有内容)");
                DiffChangeType::Added
            },
            (None, None) => {
                debug!("变更类型: 无变更 (暂存区和工作区都没有内容)");
                return Err(GitServiceError::CLIError("文件无变更".into()));
            }
        };

        // 4. 计算 content_omitted（在移动之前）
        // 只有当内容存在但被省略时（Some(None)），才标记为省略
        // None 表示文件不存在，不是省略
        let content_omitted = matches!(&old_content, Some(None))
            || matches!(&new_content, Some(None));

        // 5. 提取内容（flatten）
        let old = old_content.and_then(|o| o);
        let new = new_content.and_then(|n| n);

        // 6. 计算行数
        let (additions, deletions) = if !is_binary {
            if let (Some(old), Some(new)) = (&old, &new) {
                let (adds, dels) = Self::compute_line_diff(old, new);
                debug!("计算行 diff 完成: 新增 {} 行，删除 {} 行", adds, dels);
                (adds, dels)
            } else {
                debug!("无法计算行 diff: 缺少内容");
                (0, 0)
            }
        } else {
            debug!("跳过行 diff 计算: 二进制文件");
            (0, 0)
        };

        // 7. 状态提示
        let status_hint = Some(GitDiffStatusHint {
            has_conflict: true,
            message: Some("暂存区和工作区都有修改".to_string()),
            current_view: "暂存区 vs 工作区".to_string(),
        });

        debug!("=== get_diff_index_to_workdir 完成 ===");
        debug!("返回结果: file_path={}, change_type={:?}, is_binary={}, additions={}, deletions={}, content_omitted={}",
            file_path, change_type, is_binary, additions, deletions, content_omitted);

        Ok(GitDiffEntry {
            file_path: file_path.to_string(),
            old_file_path: None,
            change_type,
            old_content: old,
            new_content: new,
            additions: Some(additions),
            deletions: Some(deletions),
            is_binary,
            content_omitted: if content_omitted { Some(true) } else { None },
            status_hint,
        })
    }

    /// 计算行级 diff
    fn compute_line_diff(old: &str, new: &str) -> (usize, usize) {
        use similar::{ChangeTag, TextDiff};

        let diff = TextDiff::from_lines(old, new);

        let mut additions = 0;
        let mut deletions = 0;

        for op in diff.iter_all_changes() {
            match op.tag() {
                ChangeTag::Insert => additions += 1,
                ChangeTag::Delete => deletions += 1,
                _ => {}
            }
        }

        (additions, deletions)
    }

    // ========================================================================
    // 分支操作
    // ========================================================================

    /// 获取所有分支
    pub fn get_branches(path: &Path) -> Result<Vec<GitBranch>, GitServiceError> {
        let repo = Self::open_repository(path)?;

        // 获取当前分支名 - 处理空仓库的情况
        let current_branch = if repo.is_empty().unwrap_or(true) {
            // 空仓库：通过 HEAD 引用的 symbolic_target 获取分支名
            repo.find_reference("HEAD")
                .ok()
                .and_then(|r| r.symbolic_target().map(|s| s.to_string()))
                .and_then(|s| {
                    s.strip_prefix("refs/heads/")
                        .map(|s| s.to_string())
                        .or(Some(s))
                })
                .unwrap_or_default()
        } else {
            repo.head()
                .ok()
                .and_then(|h| h.shorthand().map(|s| s.to_string()))
                .unwrap_or_default()
        };

        let mut branches = Vec::new();

        // 本地分支
        let local_branches = repo.branches(Some(BranchType::Local))?;
        for branch_result in local_branches {
            let (branch, _) = branch_result?;
            if let Some(name) = branch.name()? {
                let commit_oid = branch.get().target().unwrap_or(git2::Oid::zero());
                let commit = repo.find_commit(commit_oid);

                let last_commit_date = commit.ok().and_then(|c| {
                    let time = c.time();
                    Some(i64::from(time.seconds()))
                });

                branches.push(GitBranch {
                    name: name.to_string(),
                    is_current: name == current_branch,
                    is_remote: false,
                    commit: commit_oid.to_string(),
                    ahead: None,
                    behind: None,
                    last_commit_date,
                });
            }
        }

        // 远程分支
        let remote_branches = repo.branches(Some(BranchType::Remote))?;
        for branch_result in remote_branches {
            let (branch, _) = branch_result?;
            if let Some(name) = branch.name()? {
                // 跳过远程 HEAD 引用
                if !name.ends_with("/HEAD") {
                    let commit_oid = branch.get().target().unwrap_or(git2::Oid::zero());

                    branches.push(GitBranch {
                        name: name.to_string(),
                        is_current: false,
                        is_remote: true,
                        commit: commit_oid.to_string(),
                        ahead: None,
                        behind: None,
                        last_commit_date: None,
                    });
                }
            }
        }

        Ok(branches)
    }

    /// 获取所有标签
    pub fn get_tags(path: &Path) -> Result<Vec<GitTag>, GitServiceError> {
        let repo = Self::open_repository(path)?;

        let mut tags = Vec::new();

        // 获取所有标签
        let tag_names = repo.tag_names(None)?;

        for tag_name_opt in tag_names.iter() {
            if let Some(tag_name) = tag_name_opt {
                // 查找标签引用
                let ref_name = format!("refs/tags/{}", tag_name);
                let reference = match repo.find_reference(&ref_name) {
                    Ok(r) => r,
                    Err(_) => continue,
                };

                // 获取标签指向的目标
                let target = match reference.target() {
                    Some(t) => t,
                    None => continue,
                };

                // 检查是否为 annotated 标签（tag 对象）或 lightweight 标签（直接指向 commit）
                let (commit_sha, is_annotated, message, tagger, timestamp) = if let Ok(tag_obj) = repo.find_tag(target) {
                    // Annotated 标签
                    let commit_oid = tag_obj.target_id();
                    let message = tag_obj.message().map(|s| s.to_string());
                    let tagger = tag_obj.tagger().map(|s| s.name().map(|n| n.to_string())).flatten();
                    let timestamp = tag_obj.tagger().map(|s| {
                        let time = s.when();
                        Some(i64::from(time.seconds()))
                    }).flatten();
                    (commit_oid.to_string(), true, message, tagger, timestamp)
                } else {
                    // Lightweight 标签 - 直接指向 commit
                    (target.to_string(), false, None, None, None)
                };

                // 生成短 SHA
                let short_sha = if commit_sha.len() >= 8 {
                    commit_sha[..8].to_string()
                } else {
                    commit_sha.clone()
                };

                tags.push(GitTag {
                    name: tag_name.to_string(),
                    is_annotated,
                    commit_sha,
                    short_sha,
                    message,
                    tagger,
                    timestamp,
                });
            }
        }

        // 按时间倒序排序（annotated 标签按创建时间，lightweight 标签按提交时间）
        tags.sort_by(|a, b| {
            let time_a = a.timestamp.unwrap_or(0);
            let time_b = b.timestamp.unwrap_or(0);
            time_b.cmp(&time_a)
        });

        Ok(tags)
    }

    /// 创建分支
    pub fn create_branch(
        path: &Path,
        name: &str,
        checkout: bool,
    ) -> Result<(), GitServiceError> {
        let repo = Self::open_repository(path)?;

        // 验证分支名
        if !git2::Branch::name_is_valid(name).unwrap_or(false) {
            return Err(GitServiceError::BranchNotFound(format!(
                "Invalid branch name: {}",
                name
            )));
        }

        // 检查是否为空仓库
        let is_empty = repo.is_empty().unwrap_or(true);

        if is_empty {
            // 空仓库：使用符号引用格式设置 HEAD，不需要分支引用存在
            if checkout {
                repo.set_head(&format!("ref: refs/heads/{}", name))?;
            }
            return Ok(());
        }

        // 非空仓库：正常创建分支
        let head = repo.head()?.peel_to_commit()?;

        repo.branch(name, &head, false)?;

        if checkout {
            // 切换到新分支
            let obj = repo.revparse_single(&format!("refs/heads/{}", name))?;
            repo.checkout_tree(&obj, None)?;
            repo.set_head(&format!("refs/heads/{}", name))?;
        }

        Ok(())
    }

    /// 切换分支
    pub fn checkout_branch(path: &Path, name: &str) -> Result<(), GitServiceError> {
        let repo = Self::open_repository(path)?;

        let obj = repo.revparse_single(name)?;
        repo.checkout_tree(&obj, None)?;
        repo.set_head(&format!("refs/heads/{}", name))?;

        Ok(())
    }

    /// 删除分支
    pub fn delete_branch(path: &Path, name: &str, force: bool) -> Result<(), GitServiceError> {
        let repo = Self::open_repository(path)?;

        // 获取当前分支名
        let current_branch = repo.head()
            .ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()))
            .unwrap_or_default();

        // 不能删除当前分支
        if name == current_branch {
            return Err(GitServiceError::CLIError(
                format!("Cannot delete the current branch '{}'", name)
            ));
        }

        // 查找分支
        let mut branch = repo.find_branch(name, BranchType::Local)?;

        // 检查是否已合并（如果不强制删除）
        if !force {
            // 获取当前 HEAD commit
            let head = repo.head()?.peel_to_commit()?;
            let head_oid = head.id();

            // 获取要删除的分支的 commit
            let branch_commit = branch.get().target()
                .ok_or_else(|| GitServiceError::BranchNotFound(name.to_string()))?;

            // 检查分支是否已合并到 HEAD
            let is_merged = repo.merge_base(head_oid, branch_commit)
                .map(|base| base == branch_commit)
                .unwrap_or(false);

            if !is_merged {
                return Err(GitServiceError::CLIError(
                    format!("Branch '{}' is not fully merged. Use force option to delete anyway.", name)
                ));
            }
        }

        // 删除分支
        branch.delete()?;

        Ok(())
    }

    /// 重命名分支
    pub fn rename_branch(
        path: &Path,
        old_name: &str,
        new_name: &str,
    ) -> Result<(), GitServiceError> {
        let repo = Self::open_repository(path)?;

        // 验证新分支名称 - 检查非法字符
        let invalid_chars = [' ', '~', '^', ':', '?', '*', '[', '\\'];
        if new_name.chars().any(|c| invalid_chars.contains(&c)) {
            return Err(GitServiceError::CLIError(
                format!("Invalid branch name '{}': contains illegal characters", new_name)
            ));
        }

        // 检查新名称是否已存在
        if repo.find_branch(new_name, BranchType::Local).is_ok() {
            return Err(GitServiceError::CLIError(
                format!("Branch '{}' already exists", new_name)
            ));
        }

        // 查找要重命名的分支
        let mut branch = repo.find_branch(old_name, BranchType::Local)?;

        // 检查是否为当前分支
        let current_branch = repo.head()
            .ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()))
            .unwrap_or_default();

        let is_current = old_name == current_branch;

        // 执行重命名
        branch.rename(new_name, true)?;

        // 如果是当前分支，更新 HEAD 引用
        if is_current {
            repo.set_head(&format!("refs/heads/{}", new_name))?;
        }

        Ok(())
    }

    /// 合并分支
    pub fn merge_branch(
        path: &Path,
        source_branch: &str,
        no_ff: bool,
    ) -> Result<GitMergeResult, GitServiceError> {
        info!("开始合并分支: {} -> 当前分支", source_branch);

        let repo = Self::open_repository(path)?;

        // 检查是否有正在进行的合并
        if repo.index()?.has_conflicts() {
            return Err(GitServiceError::MergeInProgress);
        }

        // 获取当前分支
        let current_branch = repo.head()
            .ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()))
            .unwrap_or_else(|| "HEAD".to_string());

        // 不能合并到自身
        if current_branch == source_branch {
            return Err(GitServiceError::CLIError(
                format!("Cannot merge branch '{}' into itself", source_branch)
            ));
        }

        // 获取源分支的引用
        let source_ref = repo.find_branch(source_branch, BranchType::Local)
            .or_else(|_| repo.find_branch(source_branch, BranchType::Remote))?;

        let source_commit_oid = source_ref.get().target()
            .ok_or_else(|| GitServiceError::BranchNotFound(source_branch.to_string()))?;

        // 创建 annotated commit
        let annotated_commit = repo.find_annotated_commit(source_commit_oid)?;

        // 获取当前 HEAD commit
        let head = repo.head()?;
        let head_commit = head.peel_to_commit()?;

        // 检查是否可以快进合并
        let can_fast_forward = !no_ff && {
            // 如果源分支是当前分支的祖先，则可以快进
            let merge_base = repo.merge_base(head_commit.id(), source_commit_oid)?;
            merge_base == head_commit.id()
        };

        if can_fast_forward {
            // 快进合并
            info!("执行快进合并");
            let source_commit = repo.find_commit(source_commit_oid)?;
            repo.checkout_tree(&source_commit.tree()?.as_object(), None)?;
            repo.set_head(&format!("refs/heads/{}", current_branch))?;

            return Ok(GitMergeResult {
                success: true,
                fast_forward: true,
                has_conflicts: false,
                conflicts: vec![],
                merged_commits: 1,
                files_changed: 0,
            });
        }

        // 普通合并
        info!("执行普通合并");

        // 执行合并 - 使用 merge 而不是 merge_commit
        repo.merge(&[&annotated_commit], None, None)?;

        // 检查是否有冲突
        let mut index = repo.index()?;
        let has_conflicts = index.has_conflicts();

        // 获取冲突文件列表
        let conflicts = if has_conflicts {
            let mut conflict_list = Vec::new();
            for conflict_result in index.conflicts()? {
                if let Ok(conflict) = conflict_result {
                    if let Some(our) = conflict.our {
                        let path = String::from_utf8_lossy(&our.path).to_string();
                        conflict_list.push(path);
                    } else if let Some(their) = conflict.their {
                        let path = String::from_utf8_lossy(&their.path).to_string();
                        conflict_list.push(path);
                    }
                }
            }
            conflict_list
        } else {
            vec![]
        };

        // 如果没有冲突，自动提交
        let (merged_commits, files_changed) = if !has_conflicts {
            // 计算 merged_commits（从 merge_base 到 source_commit 的提交数）
            let merge_base = repo.merge_base(head_commit.id(), source_commit_oid)?;
            let mut revwalk = repo.revwalk()?;
            revwalk.push_range(&format!("{}..{}", merge_base, source_commit_oid))?;
            let merged_count = revwalk.count();

            // 写入树并提交
            let tree_id = index.write_tree()?;
            let tree = repo.find_tree(tree_id)?;

            let sig = repo.signature()?;
            let message = format!("Merge branch '{}' into {}", source_branch, current_branch);

            let source_commit = repo.find_commit(source_commit_oid)?;
            repo.commit(
                Some("HEAD"),
                &sig,
                &sig,
                &message,
                &tree,
                &[&head_commit, &source_commit],
            )?;

            (merged_count, 0)
        } else {
            (0, 0)
        };

        Ok(GitMergeResult {
            success: !has_conflicts,
            fast_forward: false,
            has_conflicts,
            conflicts,
            merged_commits,
            files_changed,
        })
    }

    /// 变基分支
    pub fn rebase_branch(
        path: &Path,
        source_branch: &str,
    ) -> Result<GitRebaseResult, GitServiceError> {
        info!("开始变基操作: 当前分支 -> {}", source_branch);

        let repo = Self::open_repository(path)?;

        // 检查是否有正在进行的变基
        let rebase_state_path = path.join(".git").join("rebase-merge");
        if rebase_state_path.exists() {
            return Err(GitServiceError::RebaseInProgress);
        }

        // 检查是否有正在进行的合并
        if repo.index()?.has_conflicts() {
            return Err(GitServiceError::MergeInProgress);
        }

        // 获取当前分支
        let current_branch = repo.head()
            .ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()))
            .unwrap_or_else(|| "HEAD".to_string());

        // 不能变基到自身
        if current_branch == source_branch {
            return Err(GitServiceError::CLIError(
                format!("Cannot rebase branch '{}' onto itself", source_branch)
            ));
        }

        // 获取目标分支的 commit
        let target_ref = repo.find_branch(source_branch, BranchType::Local)
            .or_else(|_| repo.find_branch(source_branch, BranchType::Remote))?;

        let target_commit_oid = target_ref.get().target()
            .ok_or_else(|| GitServiceError::BranchNotFound(source_branch.to_string()))?;

        // 获取当前 HEAD commit
        let head = repo.head()?;
        let head_commit = head.peel_to_commit()?;

        // 找到共同祖先
        let merge_base = repo.merge_base(head_commit.id(), target_commit_oid)?;

        // 如果当前分支已经是最新的，无需变基
        if merge_base == head_commit.id() {
            return Ok(GitRebaseResult {
                success: true,
                has_conflicts: false,
                conflicts: vec![],
                rebased_commits: 0,
                current_step: 0,
                total_steps: 0,
                finished: true,
            });
        }

        // 获取需要变基的提交数
        let mut revwalk = repo.revwalk()?;
        revwalk.push_range(&format!("{}..{}", merge_base, head_commit.id()))?;
        let commits_to_rebase: Vec<_> = revwalk.collect::<Result<Vec<_>, _>>()?;
        let total_steps = commits_to_rebase.len();

        // 执行变基操作（使用 git CLI，因为 git2 的 rebase API 较复杂）
        let output = std::process::Command::new("git")
            .args(["rebase", source_branch])
            .current_dir(path)
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            // 变基成功
            info!("变基成功完成");
            Ok(GitRebaseResult {
                success: true,
                has_conflicts: false,
                conflicts: vec![],
                rebased_commits: total_steps,
                current_step: total_steps,
                total_steps,
                finished: true,
            })
        } else {
            // 检查是否有冲突
            let has_conflicts = stderr.contains("CONFLICT") 
                || stderr.contains("conflict")
                || stdout.contains("CONFLICT");

            // 获取冲突文件列表
            let conflicts = if has_conflicts {
                let mut conflict_list = Vec::new();
                
                // 使用 git diff --name-only --diff-filter=U 获取冲突文件
                let diff_output = std::process::Command::new("git")
                    .args(["diff", "--name-only", "--diff-filter=U"])
                    .current_dir(path)
                    .output()?;

                if diff_output.status.success() {
                    let diff_stdout = String::from_utf8_lossy(&diff_output.stdout);
                    for line in diff_stdout.lines() {
                        if !line.is_empty() {
                            conflict_list.push(line.to_string());
                        }
                    }
                }

                conflict_list
            } else {
                vec![]
            };

            // 获取当前步骤信息
            let current_step = if has_conflicts {
                // 从错误消息中尝试提取步骤信息
                // 格式通常是: "Rebasing (n/m)"
                let step_re = regex::Regex::new(r"Rebasing \((\d+)/(\d+)\)").unwrap();
                if let Some(caps) = step_re.captures(&stderr) {
                    caps[1].parse().unwrap_or(1)
                } else {
                    1
                }
            } else {
                0
            };

            if has_conflicts {
                info!("变基遇到冲突: {} 个文件", conflicts.len());
                Ok(GitRebaseResult {
                    success: false,
                    has_conflicts: true,
                    conflicts,
                    rebased_commits: 0,
                    current_step,
                    total_steps,
                    finished: false,
                })
            } else {
                // 其他错误
                Err(GitServiceError::CLIError(stderr.to_string()))
            }
        }
    }

    /// 中止变基操作
    pub fn rebase_abort(path: &Path) -> Result<(), GitServiceError> {
        let output = std::process::Command::new("git")
            .args(["rebase", "--abort"])
            .current_dir(path)
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(GitServiceError::CLIError(stderr.to_string()));
        }

        Ok(())
    }

    /// 继续变基操作
    pub fn rebase_continue(path: &Path) -> Result<GitRebaseResult, GitServiceError> {
        let output = std::process::Command::new("git")
            .args(["rebase", "--continue"])
            .current_dir(path)
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            Ok(GitRebaseResult {
                success: true,
                has_conflicts: false,
                conflicts: vec![],
                rebased_commits: 0,
                current_step: 0,
                total_steps: 0,
                finished: true,
            })
        } else {
            // 检查是否仍然有冲突
            let has_conflicts = stderr.contains("CONFLICT") 
                || stderr.contains("conflict");

            let conflicts = if has_conflicts {
                let diff_output = std::process::Command::new("git")
                    .args(["diff", "--name-only", "--diff-filter=U"])
                    .current_dir(path)
                    .output()?;

                if diff_output.status.success() {
                    String::from_utf8_lossy(&diff_output.stdout)
                        .lines()
                        .filter(|l| !l.is_empty())
                        .map(|l| l.to_string())
                        .collect()
                } else {
                    vec![]
                }
            } else {
                vec![]
            };

            if has_conflicts {
                Ok(GitRebaseResult {
                    success: false,
                    has_conflicts: true,
                    conflicts,
                    rebased_commits: 0,
                    current_step: 0,
                    total_steps: 0,
                    finished: false,
                })
            } else {
                Err(GitServiceError::CLIError(stderr.to_string()))
            }
        }
    }

    /// Cherry-pick 提交
    pub fn cherry_pick(
        path: &Path,
        commit_sha: &str,
    ) -> Result<GitCherryPickResult, GitServiceError> {
        info!("开始 cherry-pick 操作: {}", commit_sha);

        let repo = Self::open_repository(path)?;

        // 检查是否有正在进行的 cherry-pick
        let cherry_pick_state_path = path.join(".git").join("CHERRY_PICK_HEAD");
        if cherry_pick_state_path.exists() {
            return Err(GitServiceError::CherryPickInProgress);
        }

        // 检查是否有正在进行的合并
        if repo.index()?.has_conflicts() {
            return Err(GitServiceError::MergeInProgress);
        }

        // 执行 cherry-pick 操作
        let output = std::process::Command::new("git")
            .args(["cherry-pick", commit_sha])
            .current_dir(path)
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            // Cherry-pick 成功
            info!("Cherry-pick 成功完成");

            // 获取新提交的信息
            let new_commit_sha = repo.head()?.target()
                .map(|oid| oid.to_string())
                .unwrap_or_default();

            // 获取提交消息
            let commit_message = if let Ok(head) = repo.head() {
                if let Ok(commit) = head.peel_to_commit() {
                    commit.message().unwrap_or("").to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            };

            Ok(GitCherryPickResult {
                success: true,
                has_conflicts: false,
                conflicts: vec![],
                commit_sha: new_commit_sha,
                commit_message,
                finished: true,
            })
        } else {
            // 检查是否有冲突
            let has_conflicts = stderr.contains("CONFLICT")
                || stderr.contains("conflict")
                || stdout.contains("CONFLICT");

            // 获取冲突文件列表
            let conflicts = if has_conflicts {
                let mut conflict_list = Vec::new();

                // 使用 git diff --name-only --diff-filter=U 获取冲突文件
                let diff_output = std::process::Command::new("git")
                    .args(["diff", "--name-only", "--diff-filter=U"])
                    .current_dir(path)
                    .output()?;

                if diff_output.status.success() {
                    let diff_stdout = String::from_utf8_lossy(&diff_output.stdout);
                    for line in diff_stdout.lines() {
                        if !line.is_empty() {
                            conflict_list.push(line.to_string());
                        }
                    }
                }

                conflict_list
            } else {
                vec![]
            };

            if has_conflicts {
                info!("Cherry-pick 遇到冲突: {} 个文件", conflicts.len());
                Ok(GitCherryPickResult {
                    success: false,
                    has_conflicts: true,
                    conflicts,
                    commit_sha: commit_sha.to_string(),
                    commit_message: String::new(),
                    finished: false,
                })
            } else {
                // 其他错误（如空提交等）
                Err(GitServiceError::CLIError(stderr.to_string()))
            }
        }
    }

    /// 中止 Cherry-pick 操作
    pub fn cherry_pick_abort(path: &Path) -> Result<(), GitServiceError> {
        let output = std::process::Command::new("git")
            .args(["cherry-pick", "--abort"])
            .current_dir(path)
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(GitServiceError::CLIError(stderr.to_string()));
        }

        Ok(())
    }

    /// 继续 Cherry-pick 操作
    pub fn cherry_pick_continue(path: &Path) -> Result<GitCherryPickResult, GitServiceError> {
        let output = std::process::Command::new("git")
            .args(["cherry-pick", "--continue"])
            .current_dir(path)
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            // 获取新提交的信息
            let repo = Self::open_repository(path)?;
            let new_commit_sha = repo.head()?.target()
                .map(|oid| oid.to_string())
                .unwrap_or_default();

            let commit_message = if let Ok(head) = repo.head() {
                if let Ok(commit) = head.peel_to_commit() {
                    commit.message().unwrap_or("").to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            };

            Ok(GitCherryPickResult {
                success: true,
                has_conflicts: false,
                conflicts: vec![],
                commit_sha: new_commit_sha,
                commit_message,
                finished: true,
            })
        } else {
            // 检查是否仍然有冲突
            let has_conflicts = stderr.contains("CONFLICT")
                || stderr.contains("conflict");

            let conflicts = if has_conflicts {
                let diff_output = std::process::Command::new("git")
                    .args(["diff", "--name-only", "--diff-filter=U"])
                    .current_dir(path)
                    .output()?;

                if diff_output.status.success() {
                    String::from_utf8_lossy(&diff_output.stdout)
                        .lines()
                        .filter(|l| !l.is_empty())
                        .map(|l| l.to_string())
                        .collect()
                } else {
                    vec![]
                }
            } else {
                vec![]
            };

            if has_conflicts {
                Ok(GitCherryPickResult {
                    success: false,
                    has_conflicts: true,
                    conflicts,
                    commit_sha: String::new(),
                    commit_message: String::new(),
                    finished: false,
                })
            } else {
                Err(GitServiceError::CLIError(stderr.to_string()))
            }
        }
    }

    /// Revert 提交
    pub fn revert(
        path: &Path,
        commit_sha: &str,
    ) -> Result<GitRevertResult, GitServiceError> {
        info!("开始 revert 操作: {}", commit_sha);

        let repo = Self::open_repository(path)?;

        // 检查是否有正在进行的 revert
        let revert_state_path = path.join(".git").join("REVERT_HEAD");
        if revert_state_path.exists() {
            return Err(GitServiceError::RevertInProgress);
        }

        // 检查是否有正在进行的合并
        if repo.index()?.has_conflicts() {
            return Err(GitServiceError::MergeInProgress);
        }

        // 执行 revert 操作
        let output = std::process::Command::new("git")
            .args(["revert", commit_sha, "--no-edit"])
            .current_dir(path)
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            // Revert 成功
            info!("Revert 成功完成");

            // 获取新提交的信息
            let new_commit_sha = repo.head()?.target()
                .map(|oid| oid.to_string())
                .unwrap_or_default();

            // 获取提交消息
            let commit_message = if let Ok(head) = repo.head() {
                if let Ok(commit) = head.peel_to_commit() {
                    commit.message().unwrap_or("").to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            };

            Ok(GitRevertResult {
                success: true,
                has_conflicts: false,
                conflicts: vec![],
                commit_sha: new_commit_sha,
                commit_message,
                finished: true,
            })
        } else {
            // 检查是否有冲突
            let has_conflicts = stderr.contains("CONFLICT")
                || stderr.contains("conflict")
                || stdout.contains("CONFLICT");

            // 获取冲突文件列表
            let conflicts = if has_conflicts {
                let mut conflict_list = Vec::new();

                // 使用 git diff --name-only --diff-filter=U 获取冲突文件
                let diff_output = std::process::Command::new("git")
                    .args(["diff", "--name-only", "--diff-filter=U"])
                    .current_dir(path)
                    .output()?;

                if diff_output.status.success() {
                    let diff_stdout = String::from_utf8_lossy(&diff_output.stdout);
                    for line in diff_stdout.lines() {
                        if !line.is_empty() {
                            conflict_list.push(line.to_string());
                        }
                    }
                }

                conflict_list
            } else {
                vec![]
            };

            if has_conflicts {
                info!("Revert 遇到冲突: {} 个文件", conflicts.len());
                Ok(GitRevertResult {
                    success: false,
                    has_conflicts: true,
                    conflicts,
                    commit_sha: commit_sha.to_string(),
                    commit_message: String::new(),
                    finished: false,
                })
            } else {
                // 其他错误
                Err(GitServiceError::CLIError(stderr.to_string()))
            }
        }
    }

    /// 中止 Revert 操作
    pub fn revert_abort(path: &Path) -> Result<(), GitServiceError> {
        let output = std::process::Command::new("git")
            .args(["revert", "--abort"])
            .current_dir(path)
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(GitServiceError::CLIError(stderr.to_string()));
        }

        Ok(())
    }

    /// 继续 Revert 操作
    pub fn revert_continue(path: &Path) -> Result<GitRevertResult, GitServiceError> {
        let output = std::process::Command::new("git")
            .args(["revert", "--continue", "--no-edit"])
            .current_dir(path)
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            // 获取新提交的信息
            let repo = Self::open_repository(path)?;
            let new_commit_sha = repo.head()?.target()
                .map(|oid| oid.to_string())
                .unwrap_or_default();

            let commit_message = if let Ok(head) = repo.head() {
                if let Ok(commit) = head.peel_to_commit() {
                    commit.message().unwrap_or("").to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            };

            Ok(GitRevertResult {
                success: true,
                has_conflicts: false,
                conflicts: vec![],
                commit_sha: new_commit_sha,
                commit_message,
                finished: true,
            })
        } else {
            // 检查是否仍然有冲突
            let has_conflicts = stderr.contains("CONFLICT")
                || stderr.contains("conflict");

            let conflicts = if has_conflicts {
                let diff_output = std::process::Command::new("git")
                    .args(["diff", "--name-only", "--diff-filter=U"])
                    .current_dir(path)
                    .output()?;

                if diff_output.status.success() {
                    String::from_utf8_lossy(&diff_output.stdout)
                        .lines()
                        .filter(|l| !l.is_empty())
                        .map(|l| l.to_string())
                        .collect()
                } else {
                    vec![]
                }
            } else {
                vec![]
            };

            if has_conflicts {
                Ok(GitRevertResult {
                    success: false,
                    has_conflicts: true,
                    conflicts,
                    commit_sha: String::new(),
                    commit_message: String::new(),
                    finished: false,
                })
            } else {
                Err(GitServiceError::CLIError(stderr.to_string()))
            }
        }
    }

    /// 计算仓库中的跟踪文件数量
    fn count_tracked_files(repo: &Repository) -> Result<usize, GitServiceError> {
        let head = repo.head()?;
        let head_commit = head.peel_to_commit()?;
        let tree = head_commit.tree()?;

        let mut count = 0;
        tree.walk(git2::TreeWalkMode::PreOrder, |_root, _entry| {
            count += 1;
            git2::TreeWalkResult::Ok
        })?;

        Ok(count)
    }

    // ========================================================================
    // 提交操作
    // ========================================================================

    /// 提交变更
    pub fn commit(
        path: &Path,
        message: &str,
        stage_all: bool,
        selected_files: Option<Vec<String>>,
    ) -> Result<String, GitServiceError> {
        let repo = Self::open_repository(path)?;

        let mut index = repo.index()?;

        // 决定要暂存哪些文件
        // 优先级：selected_files > stage_all > 不暂存
        let files_to_stage = if let Some(ref files) = selected_files {
            // 有选中文件：只暂存选中的（无论 stage_all 是什么）
            info!("只暂存选中的 {} 个文件", files.len());
            files.clone()
        } else if stage_all {
            // 无选中且 stage_all=true：暂存所有变更
            info!("暂存所有变更文件");
            let mut opts = StatusOptions::new();
            opts.include_untracked(true)
                .include_ignored(false)
                .recurse_untracked_dirs(true);

            let statuses = repo.statuses(Some(&mut opts))?;

            let mut all_files = Vec::new();
            for entry in statuses.iter() {
                if let Some(path_str) = entry.path() {
                    all_files.push(path_str.to_string());
                }
            }
            all_files
        } else {
            // 无选中且 stage_all=false：不暂存，直接提交已暂存内容
            info!("不暂存，直接提交已暂存内容");
            vec![]
        };

        if !files_to_stage.is_empty() {
            // Windows 保留名称列表
            let reserved = ["nul", "con", "prn", "aux", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3"];

            let mut added_count = 0;
            let mut removed_count = 0;

            // 如果是 stage_all 模式（没有 selected_files），需要检查每个文件的状态
            let need_status_check = selected_files.is_none();

            let statuses = if need_status_check {
                let mut opts = StatusOptions::new();
                opts.include_untracked(true)
                    .include_ignored(false)
                    .recurse_untracked_dirs(true);
                Some(repo.statuses(Some(&mut opts))?)
            } else {
                None
            };

            for path_str in files_to_stage {
                // 检查是否为 Windows 保留名称
                let path_lower = path_str.to_lowercase();
                if reserved.iter().any(|&r| path_lower.contains(r)) {
                    warn!("跳过 Windows 保留名称文件: {}", path_str);
                    continue;
                }

                let path = std::path::Path::new(&path_str);

                // 如果需要检查状态，根据文件状态选择正确的操作
                if let Some(ref statuses) = statuses {
                    let status = statuses.iter()
                        .find(|e| e.path() == Some(&path_str))
                        .map(|e| e.status());

                    if let Some(status) = status {
                        if status.is_wt_deleted() {
                            match index.remove(path, 0) {
                                Ok(_) => {
                                    debug!("标记删除文件: {}", path_str);
                                    removed_count += 1;
                                }
                                Err(e) => {
                                    debug!("跳过删除文件 {}: {:?}", path_str, e);
                                }
                            }
                            continue;
                        }
                    }
                }

                // 文件新增或修改：添加到索引
                match index.add_path(path) {
                    Ok(_) => {
                        added_count += 1;
                    }
                    Err(e) => {
                        debug!("跳过文件 {}: {:?}", path_str, e);
                    }
                }
            }

            info!("已添加 {} 个文件，移除 {} 个文件到暂存区", added_count, removed_count);

            // 写入索引
            index.write()?;
        }

        // 检查是否有变更
        if index.is_empty() {
            return Err(GitServiceError::CLIError("No changes to commit".to_string()));
        }

        let tree_id = index.write_tree()?;
        let tree = repo.find_tree(tree_id)?;

        let sig = repo.signature()?;

        // 检查是否为空仓库（首次提交）
        let is_empty = repo.is_empty()?;

        let oid = if is_empty {
            info!("首次提交：创建初始分支");
            // 首次提交：没有父提交
            repo.commit(
                Some("HEAD"),
                &sig,
                &sig,
                message,
                &tree,
                &[],  // 空数组表示首次提交
            )?
        } else {
            // 正常提交：有父提交
            let head = repo.head()?;
            let parent_commit = head.peel_to_commit()?;

            repo.commit(
                Some("HEAD"),
                &sig,
                &sig,
                message,
                &tree,
                &[&parent_commit],
            )?
        };

        Ok(oid.to_string())
    }

    /// 暂存文件
    pub fn stage_file(path: &Path, file_path: &str) -> Result<(), GitServiceError> {
        let repo = Self::open_repository(path)?;

        let mut index = repo.index()?;
        index.add_path(std::path::Path::new(file_path))?;
        index.write()?;

        Ok(())
    }

    /// 取消暂存文件
    pub fn unstage_file(path: &Path, file_path: &str) -> Result<(), GitServiceError> {
        let repo = Self::open_repository(path)?;

        let mut index = repo.index()?;
        index.remove_path(std::path::Path::new(file_path))?;
        index.write()?;

        Ok(())
    }

    /// 丢弃工作区变更
    pub fn discard_changes(path: &Path, file_path: &str) -> Result<(), GitServiceError> {
        let repo = Self::open_repository(path)?;

        let mut index = repo.index()?;

        // 从 HEAD 恢复文件
        let head = repo.head()?;
        let head_commit = head.peel_to_commit()?;
        let head_tree = head_commit.tree()?;

        let entry = head_tree.get_path(std::path::Path::new(file_path))?;

        let obj = entry.to_object(&repo)?;
        let blob = obj.as_blob().ok_or(GitServiceError::CLIError(
            "Not a blob".to_string(),
        ))?;

        // 写入文件
        let workdir = repo.workdir().ok_or(GitServiceError::NotARepository)?;
        let full_path = workdir.join(file_path);

        std::fs::write(&full_path, blob.content())?;

        // 更新索引
        index.add_path(std::path::Path::new(file_path))?;
        index.write()?;

        Ok(())
    }

    // ========================================================================
    // 远程操作
    // ========================================================================

    /// 获取远程仓库
    pub fn get_remotes(path: &Path) -> Result<Vec<GitRemote>, GitServiceError> {
        let repo = Self::open_repository(path)?;

        let mut remotes = Vec::new();

        for remote in repo.remotes()?.iter() {
            if let Some(name) = remote {
                let remote = repo.find_remote(name)?;
                remotes.push(GitRemote {
                    name: name.to_string(),
                    fetch_url: remote.url().map(|s: &str| s.to_string()),
                    push_url: remote.pushurl().map(|s: &str| s.to_string()),
                });
            }
        }

        Ok(remotes)
    }

    /// 检测 Git Host 类型
    pub fn detect_git_host(remote_url: &str) -> GitHostType {
        if remote_url.contains("github.com") {
            GitHostType::GitHub
        } else if remote_url.contains("gitlab.com") {
            GitHostType::GitLab
        } else if remote_url.contains("dev.azure.com")
            || remote_url.contains("visualstudio.com")
        {
            GitHostType::AzureDevOps
        } else if remote_url.contains("bitbucket.org") {
            GitHostType::Bitbucket
        } else {
            GitHostType::Unknown
        }
    }

    /// 添加远程仓库
    pub fn add_remote(
        path: &Path,
        name: &str,
        url: &str,
    ) -> Result<GitRemote, GitServiceError> {
        let repo = Self::open_repository(path)?;

        // 检查远程仓库是否已存在
        if repo.find_remote(name).is_ok() {
            return Err(GitServiceError::RemoteExists(name.to_string()));
        }

        // 创建远程仓库
        let mut remote = repo.remote(name, url)?;

        Ok(GitRemote {
            name: name.to_string(),
            fetch_url: remote.url().map(|s| s.to_string()),
            push_url: remote.pushurl().map(|s| s.to_string()),
        })
    }

    /// 删除远程仓库
    pub fn delete_remote(path: &Path, name: &str) -> Result<(), GitServiceError> {
        let repo = Self::open_repository(path)?;

        // 检查远程仓库是否存在
        if repo.find_remote(name).is_err() {
            return Err(GitServiceError::RemoteNotFound(name.to_string()));
        }

        repo.remote_delete(name)?;

        Ok(())
    }

    // ========================================================================
    // PR 操作（通过 CLI）
    // ========================================================================

    /// 推送分支到远程
    pub fn push_branch(
        path: &Path,
        branch_name: &str,
        remote_name: &str,
        force: bool,
    ) -> Result<(), GitServiceError> {
        let output = std::process::Command::new("git")
            .arg("push")
            .arg(remote_name)
            .arg(branch_name)
            .arg(if force { "--force" } else { "--force-with-lease" })
            .current_dir(path)
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(GitServiceError::CLIError(stderr.to_string()));
        }

        Ok(())
    }

    /// 推送分支并设置上游
    pub fn push_set_upstream(
        path: &Path,
        branch_name: &str,
        remote_name: &str,
    ) -> Result<(), GitServiceError> {
        let output = std::process::Command::new("git")
            .arg("push")
            .arg("-u")
            .arg(remote_name)
            .arg(branch_name)
            .current_dir(path)
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(GitServiceError::CLIError(stderr.to_string()));
        }

        Ok(())
    }

    /// 创建 Pull Request
    pub fn create_pr(
        path: &Path,
        options: &CreatePROptions,
    ) -> Result<PullRequest, GitServiceError> {
        let remote_url = Self::get_remote_url(path, "origin")?;
        let host = Self::detect_git_host(&remote_url);

        match host {
            GitHostType::GitHub => Self::create_github_pr(path, options),
            GitHostType::GitLab => Self::create_gitlab_pr(path, options),
            GitHostType::AzureDevOps => Self::create_azure_pr(path, options),
            GitHostType::Bitbucket => Self::create_bitbucket_pr(path, options),
            GitHostType::Unknown => Err(GitServiceError::CLIError(
                "Unsupported Git host".to_string(),
            )),
        }
    }

    /// 获取远程 URL
    fn get_remote_url(path: &Path, remote_name: &str) -> Result<String, GitServiceError> {
        let repo = Self::open_repository(path)?;

        let remote = repo
            .find_remote(remote_name)
            .map_err(|_| GitServiceError::RemoteNotFound(remote_name.to_string()))?;

        remote
            .url()
            .ok_or_else(|| GitServiceError::CLIError("Remote has no URL".to_string()))
            .map(|s| s.to_string())
    }

    /// 使用 gh CLI 创建 GitHub PR
    fn create_github_pr(
        path: &Path,
        options: &CreatePROptions,
    ) -> Result<PullRequest, GitServiceError> {
        // 检查 gh 是否可用
        let check = std::process::Command::new("gh")
            .arg("--version")
            .output();

        if check.is_err() || !check.ok().map(|o| o.status.success()).unwrap_or(false) {
            return Err(GitServiceError::CLINotFound("gh".to_string()));
        }

        let mut cmd = std::process::Command::new("gh");
        cmd.arg("pr")
            .arg("create")
            .arg("--title")
            .arg(&options.title)
            .arg("--base")
            .arg(&options.base_branch)
            .arg("--head")
            .arg(&options.head_branch)
            .arg("--json")
            .arg("number,state,title,body,url,headRefName,baseRefName,createdAt,mergedAt,closedAt,author,additions,deletions,changedFiles");

        if let Some(body) = &options.body {
            cmd.arg("--body").arg(body);
        }

        if options.draft.unwrap_or(false) {
            cmd.arg("--draft");
        }

        if let Some(assignees) = &options.assignees {
            for assignee in assignees {
                cmd.arg("--assignee").arg(assignee);
            }
        }

        if let Some(labels) = &options.labels {
            for label in labels {
                cmd.arg("--label").arg(label);
            }
        }

        let output = cmd.current_dir(path).output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(GitServiceError::CLIError(stderr.to_string()));
        }

        // 解析 JSON 输出
        let json = String::from_utf8_lossy(&output.stdout);
        let pr_data: serde_json::Value = serde_json::from_str(&json)
            .map_err(|e| GitServiceError::CLIError(format!("Failed to parse PR info: {}", e)))?;

        Ok(PullRequest {
            number: pr_data["number"]
                .as_u64()
                .ok_or_else(|| GitServiceError::CLIError("Missing PR number".to_string()))?,
            url: pr_data["url"]
                .as_str()
                .ok_or_else(|| GitServiceError::CLIError("Missing PR URL".to_string()))?
                .to_string(),
            title: pr_data["title"]
                .as_str()
                .ok_or_else(|| GitServiceError::CLIError("Missing PR title".to_string()))?
                .to_string(),
            body: pr_data["body"].as_str().map(|s| s.to_string()),
            state: match pr_data["state"].as_str().unwrap_or("open") {
                "OPEN" => PRState::Open,
                "MERGED" => PRState::Merged,
                "CLOSED" => PRState::Closed,
                _ => PRState::Open,
            },
            head_branch: pr_data["headRefName"]
                .as_str()
                .ok_or_else(|| GitServiceError::CLIError("Missing head branch".to_string()))?
                .to_string(),
            base_branch: pr_data["baseRefName"]
                .as_str()
                .ok_or_else(|| GitServiceError::CLIError("Missing base branch".to_string()))?
                .to_string(),
            created_at: pr_data["createdAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp())
                .unwrap_or(0),
            updated_at: pr_data["createdAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp())
                .unwrap_or(0),
            merged_at: pr_data["mergedAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp()),
            closed_at: pr_data["closedAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp()),
            author: pr_data["author"]
                .as_object()
                .and_then(|o| o.get("login"))
                .and_then(|l| l.as_str())
                .unwrap_or("unknown")
                .to_string(),
            review_status: None,
            additions: pr_data["additions"].as_u64().map(|v| v as usize),
            deletions: pr_data["deletions"].as_u64().map(|v| v as usize),
            changed_files: pr_data["changedFiles"].as_u64().map(|v| v as usize),
        })
    }

    /// 使用 git CLI 创建 GitLab MR（暂不支持）
    fn create_gitlab_pr(
        _path: &Path,
        _options: &CreatePROptions,
    ) -> Result<PullRequest, GitServiceError> {
        Err(GitServiceError::CLIError(
            "GitLab MR creation not yet supported".to_string(),
        ))
    }

    /// 使用 az CLI 创建 Azure DevOps PR（暂不支持）
    fn create_azure_pr(
        _path: &Path,
        _options: &CreatePROptions,
    ) -> Result<PullRequest, GitServiceError> {
        Err(GitServiceError::CLIError(
            "Azure DevOps PR creation not yet supported".to_string(),
        ))
    }

    /// 使用 git CLI 创建 Bitbucket PR（暂不支持）
    fn create_bitbucket_pr(
        _path: &Path,
        _options: &CreatePROptions,
    ) -> Result<PullRequest, GitServiceError> {
        Err(GitServiceError::CLIError(
            "Bitbucket PR creation not yet supported".to_string(),
        ))
    }

    /// 获取 PR 状态
    pub fn get_pr_status(
        path: &Path,
        pr_number: u64,
    ) -> Result<PullRequest, GitServiceError> {
        let remote_url = Self::get_remote_url(path, "origin")?;
        let host = Self::detect_git_host(&remote_url);

        match host {
            GitHostType::GitHub => Self::get_github_pr_status(path, pr_number),
            _ => Err(GitServiceError::CLIError(
                "PR status check not supported for this host".to_string(),
            )),
        }
    }

    /// 获取 GitHub PR 状态
    fn get_github_pr_status(
        path: &Path,
        pr_number: u64,
    ) -> Result<PullRequest, GitServiceError> {
        let output = std::process::Command::new("gh")
            .arg("pr")
            .arg("view")
            .arg(pr_number.to_string())
            .arg("--json")
            .arg("number,state,title,body,url,headRefName,baseRefName,createdAt,mergedAt,closedAt,author,additions,deletions,changedFiles,reviews")
            .current_dir(path)
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(GitServiceError::CLIError(stderr.to_string()));
        }

        let json = String::from_utf8_lossy(&output.stdout);
        let pr_data: serde_json::Value = serde_json::from_str(&json)
            .map_err(|e| GitServiceError::CLIError(format!("Failed to parse PR info: {}", e)))?;

        // 解析审查状态
        let review_status = pr_data["reviews"]
            .as_array()
            .and_then(|reviews| {
                reviews.last().and_then(|latest| {
                    latest["state"].as_str().map(|s| match s {
                        "APPROVED" => PRReviewStatus::Approved,
                        "CHANGES_REQUESTED" => PRReviewStatus::ChangesRequested,
                        "COMMENTED" => PRReviewStatus::Commented,
                        "PENDING" => PRReviewStatus::Pending,
                        _ => PRReviewStatus::Pending,
                    })
                })
            });

        Ok(PullRequest {
            number: pr_data["number"]
                .as_u64()
                .ok_or_else(|| GitServiceError::CLIError("Missing PR number".to_string()))?,
            url: pr_data["url"]
                .as_str()
                .ok_or_else(|| GitServiceError::CLIError("Missing PR URL".to_string()))?
                .to_string(),
            title: pr_data["title"]
                .as_str()
                .ok_or_else(|| GitServiceError::CLIError("Missing PR title".to_string()))?
                .to_string(),
            body: pr_data["body"].as_str().map(|s| s.to_string()),
            state: match pr_data["state"].as_str().unwrap_or("open") {
                "OPEN" => PRState::Open,
                "MERGED" => PRState::Merged,
                "CLOSED" => PRState::Closed,
                _ => PRState::Open,
            },
            head_branch: pr_data["headRefName"]
                .as_str()
                .ok_or_else(|| GitServiceError::CLIError("Missing head branch".to_string()))?
                .to_string(),
            base_branch: pr_data["baseRefName"]
                .as_str()
                .ok_or_else(|| GitServiceError::CLIError("Missing base branch".to_string()))?
                .to_string(),
            created_at: pr_data["createdAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp())
                .unwrap_or(0),
            updated_at: pr_data["createdAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp())
                .unwrap_or(0),
            merged_at: pr_data["mergedAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp()),
            closed_at: pr_data["closedAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp()),
            author: pr_data["author"]
                .as_object()
                .and_then(|o| o.get("login"))
                .and_then(|l| l.as_str())
                .unwrap_or("unknown")
                .to_string(),
            review_status,
            additions: pr_data["additions"].as_u64().map(|v| v as usize),
            deletions: pr_data["deletions"].as_u64().map(|v| v as usize),
            changed_files: pr_data["changedFiles"].as_u64().map(|v| v as usize),
        })
    }

    // ========================================================================
    // Pull 操作
    // ========================================================================

    /// Pull 远程更新
    pub fn pull(
        path: &Path,
        remote_name: &str,
        branch_name: Option<&str>,
    ) -> Result<GitPullResult, GitServiceError> {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("pull")
            .arg(remote_name);

        if let Some(branch) = branch_name {
            cmd.arg(branch);
        }

        cmd.arg("--no-edit");

        let output = cmd.current_dir(path).output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(GitServiceError::CLIError(stderr.to_string()));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let fast_forward = stdout.contains("Fast-forward");

        Ok(GitPullResult {
            success: true,
            fast_forward,
            pulled_commits: 0,
            files_changed: 0,
            insertions: 0,
            deletions: 0,
            conflicts: vec![],
        })
    }

    // ========================================================================
    // 提交历史
    // ========================================================================

    /// 获取提交历史
    pub fn get_log(
        path: &Path,
        limit: Option<usize>,
        skip: Option<usize>,
        branch: Option<&str>,
    ) -> Result<Vec<GitCommit>, GitServiceError> {
        let repo = Self::open_repository(path)?;
        let mut revwalk = repo.revwalk()?;

        revwalk.set_sorting(git2::Sort::TIME)?;

        if let Some(branch_name) = branch {
            let ref_name = format!("refs/heads/{}", branch_name);
            revwalk.push_ref(&ref_name)?;
        } else {
            revwalk.push_head()?;
        }

        let limit = limit.unwrap_or(50);
        let skip = skip.unwrap_or(0);

        let mut commits = Vec::new();
        for (idx, oid_result) in revwalk.enumerate() {
            if idx < skip {
                continue;
            }
            if commits.len() >= limit {
                break;
            }

            let oid = oid_result?;
            let commit = repo.find_commit(oid)?;

            commits.push(GitCommit {
                sha: commit.id().to_string(),
                short_sha: commit.id().to_string()[..8].to_string(),
                message: commit.message().unwrap_or("").to_string(),
                author: commit.author().name().unwrap_or("").to_string(),
                author_email: commit.author().email().unwrap_or("").to_string(),
                timestamp: Some(commit.time().seconds()),
                parents: commit.parent_ids().map(|id| id.to_string()).collect(),
            });
        }

        Ok(commits)
    }

    // ========================================================================
    // 批量暂存
    // ========================================================================

    /// 批量暂存文件
    pub fn batch_stage(
        path: &Path,
        file_paths: &[String],
    ) -> Result<BatchStageResult, GitServiceError> {
        let repo = Self::open_repository(path)?;
        let mut index = repo.index()?;

        let mut staged = Vec::new();
        let mut failed = Vec::new();

        for file_path in file_paths {
            let path_obj = std::path::Path::new(file_path);

            match index.add_path(path_obj) {
                Ok(_) => staged.push(file_path.clone()),
                Err(e) => failed.push(StageFailure {
                    path: file_path.clone(),
                    error: e.message().to_string(),
                }),
            }
        }

        index.write()?;

        Ok(BatchStageResult {
            total: file_paths.len(),
            staged,
            failed,
        })
    }

    // ========================================================================
    // Stash 操作
    // ========================================================================

    /// 保存 Stash
    pub fn stash_save(
        path: &Path,
        message: Option<&str>,
        include_untracked: bool,
    ) -> Result<String, GitServiceError> {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("stash").arg("push");

        if let Some(msg) = message {
            cmd.arg("-m").arg(msg);
        }

        if include_untracked {
            cmd.arg("--include-untracked");
        }

        let output = cmd.current_dir(path).output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(GitServiceError::CLIError(stderr.to_string()));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// 获取 Stash 列表
    pub fn stash_list(path: &Path) -> Result<Vec<GitStashEntry>, GitServiceError> {
        let output = std::process::Command::new("git")
            .args(["stash", "list", "--format=%gd|%gs|%h|%ct"])
            .current_dir(path)
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut entries = Vec::new();

        for line in stdout.lines() {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 4 {
                let index_str = parts[0].trim_start_matches("stash@{").trim_end_matches("}");
                entries.push(GitStashEntry {
                    index: index_str.parse().unwrap_or(0),
                    message: parts[1].to_string(),
                    branch: String::new(),
                    commit_sha: parts[2].to_string(),
                    timestamp: parts[3].parse().unwrap_or(0),
                });
            }
        }

        Ok(entries)
    }

    /// 应用 Stash
    pub fn stash_pop(path: &Path, index: Option<usize>) -> Result<(), GitServiceError> {
        let stash_ref = index
            .map(|i| format!("stash@{{{}}}", i))
            .unwrap_or_else(|| "stash@{0}".to_string());

        let output = std::process::Command::new("git")
            .args(["stash", "pop", &stash_ref])
            .current_dir(path)
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(GitServiceError::CLIError(stderr.to_string()));
        }

        Ok(())
    }

    pub fn stash_drop(path: &Path, index: usize) -> Result<(), GitServiceError> {
        let stash_ref = format!("stash@{{{}}}", index);

        let output = std::process::Command::new("git")
            .args(["stash", "drop", &stash_ref])
            .current_dir(path)
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(GitServiceError::CLIError(stderr.to_string()));
        }

        Ok(())
    }
}

