/*! Git 提交操作
 *
 * 提供提交、暂存、取消暂存、丢弃变更等功能
 */

use git2::{Repository, StatusOptions};
use git2::build::CheckoutBuilder;
use std::path::Path;
use tracing::{debug, info, warn};

use crate::models::git::{BatchStageResult, GitServiceError, StageFailure};
use super::executor::open_repository;

#[derive(Debug, Clone, Copy)]
enum StagedPathKind {
    AddedOrModified,
    Removed,
}

fn file_status(repo: &Repository, file_path: &str) -> Result<Option<git2::Status>, GitServiceError> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(false)
        .pathspec(file_path);

    let statuses = repo.statuses(Some(&mut opts))?;
    Ok(statuses.iter().next().map(|entry| entry.status()))
}

fn stage_path(
    repo: &Repository,
    index: &mut git2::Index,
    file_path: &str,
) -> Result<StagedPathKind, GitServiceError> {
    let path = std::path::Path::new(file_path);
    let status = file_status(repo, file_path)?;

    if matches!(status, Some(status) if status.is_wt_deleted()) {
        index.remove_path(path)?;
        Ok(StagedPathKind::Removed)
    } else {
        index.add_path(path)?;
        Ok(StagedPathKind::AddedOrModified)
    }
}

/// 决定要暂存哪些文件并写入仓库 index（commit/amend 共用前置）
fn stage_selection(
    repo: &Repository,
    stage_all: bool,
    selected_files: Option<Vec<String>>,
) -> Result<(), GitServiceError> {
    let mut index = repo.index()?;

    // 决定要暂存哪些文件
    let files_to_stage = if let Some(files) = selected_files.as_ref() {
        info!("只暂存选中的 {} 个文件", files.len());
        files.clone()
    } else if stage_all {
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
        info!("不暂存，直接提交已暂存内容");
        vec![]
    };

    if !files_to_stage.is_empty() {
        // Windows 保留名称列表
        let reserved = [
            "nul", "con", "prn", "aux", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3",
        ];

        for path_str in files_to_stage {
            let path_lower = path_str.to_lowercase();
            if reserved.iter().any(|&r| path_lower.contains(r)) {
                warn!("跳过 Windows 保留名称文件: {}", path_str);
                continue;
            }

            match stage_path(repo, &mut index, &path_str) {
                Ok(_) => {}
                Err(e) => {
                    debug!("跳过文件 {}: {:?}", path_str, e);
                }
            }
        }

        index.write()?;
    }

    Ok(())
}

/// 提交变更
pub fn commit(
    path: &Path,
    message: &str,
    stage_all: bool,
    selected_files: Option<Vec<String>>,
) -> Result<String, GitServiceError> {
    let repo = open_repository(path)?;

    stage_selection(&repo, stage_all, selected_files)?;

    let mut index = repo.index()?;

    // 检查是否有变更
    if index.is_empty() {
        return Err(GitServiceError::CLIError("No changes to commit".to_string()));
    }

    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;

    let sig = repo.signature()?;

    let is_empty = repo.is_empty()?;

    let oid = if is_empty {
        info!("首次提交：创建初始分支");
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[])?
    } else {
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

/// Amend HEAD（P1：任意历史 commit 的 amend 依赖 P3 interactive rebase，本版覆盖 HEAD）
///
/// - `message` Some → 替换提交信息并合入当前 index 内容；None → 保持原信息（--no-edit 语义）
/// - 复用 `stage_selection`（stage_all / selected_files / 已暂存内容三态与 commit 完全一致）
/// - 作者保持原提交作者；committer 使用当前签名 —— 与 `git commit --amend` 语义一致
pub fn amend_commit(
    path: &Path,
    message: Option<&str>,
    stage_all: bool,
    selected_files: Option<Vec<String>>,
) -> Result<String, GitServiceError> {
    let repo = open_repository(path)?;

    stage_selection(&repo, stage_all, selected_files)?;

    let head_commit = repo.head()?.peel_to_commit()?;

    // HEAD 无父提交（首次提交）时 amend 同样合法（Git 支持 root commit 的 --amend）
    let mut index = repo.index()?;
    if index.is_empty() {
        return Err(GitServiceError::CLIError(
            "No changes to amend (index empty)".to_string(),
        ));
    }
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;

    // git2 0.18 amend 签名：(update_ref, author, committer, message_encoding, message, tree)
    // message_encoding=None 用默认 UTF-8；author=None 保持原提交作者
    let amended_oid = head_commit.amend(Some("HEAD"), None, None, None, message, Some(&tree))?;

    info!("amend 完成: {} → {}", head_commit.id(), amended_oid);
    Ok(amended_oid.to_string())
}

/// 按组原子提交（AI-2 原子提交建议 · 后端隔离语义）
///
/// 只提交组内文件（files）的变更，index 中其它已暂存内容**不受影响**——
/// 等价语义 `git commit <paths>`（git2 无 `--only` 等价 API，用「清空-仅组内-恢复」实现）。
///
/// 陷阱说明（spec §2.3）：现有 `commit()` 传 selectedFiles 会先 stage 这些文件然后
/// 提交**整个 index**——组 2 的已暂存文件会被组 1 的提交带走。本函数专为
/// 「逐组确认 → 按组原子提交」设计，组间文件隔离。
///
/// 实现（等 git `commit <paths>` 直通语义）：
/// 1. 记录 index 中「组外已暂存路径」清单 S_out（index vs HEAD 差异且不在组内）。
/// 2. `index.read_tree(HEAD)` 整体清空已暂存变更（不动 working tree）。
/// 3. `stage_selection(组内 files)` 只暂存组内 → 此刻 index 仅含组内变更。
/// 4. 写 tree → commit（本次提交只含组内变更）。
/// 5. 对 S_out 逐个重新 stage → 组外恢复暂存态（组内已入 HEAD，无需再 stage）。
pub fn commit_group(
    path: &Path,
    message: &str,
    files: &[String],
) -> Result<String, GitServiceError> {
    if files.is_empty() {
        return Err(GitServiceError::CLIError(
            "No files selected for atomic commit".to_string(),
        ));
    }

    let repo = open_repository(path)?;
    let head_obj = match repo.revparse_single("HEAD") {
        Ok(obj) => obj,
        Err(_) => {
            // 空仓库（首次提交）无 HEAD —— 组外已暂存无从谈起，直接走整 index 提交
            return commit(path, message, false, Some(files.to_vec()));
        }
    };
    let head_commit = head_obj.peel_to_commit()?;
    let head_tree = head_commit.tree()?;

    // 步骤 1：收集「组外已暂存」路径（index vs HEAD 差异，且不在组内）
    let index = repo.index()?;
    let mut staged_outside = Vec::new();
    let index_diff = repo.diff_tree_to_index(Some(&head_tree), Some(&index), None)?;
    index_diff.foreach(
        &mut |delta, _progress| {
            if let Some(p) = delta.new_file().path() {
                let p = p.to_string_lossy().to_string();
                if !files.iter().any(|f| f.as_str() == p) {
                    staged_outside.push(p);
                }
            }
            true
        },
        None,
        None,
        None,
    )?;

    // 步骤 2：清空 index 已暂存变更（index 内容替换为 HEAD 树；working tree 不动）
    let mut index = repo.index()?;
    index.read_tree(&head_tree)?;
    index.write()?;

    // 步骤 3：只暂存组内文件
    stage_selection(&repo, false, Some(files.to_vec()))?;
    let mut index = repo.index()?;

    // 步骤 4：提交（仅组内变更）。tree_id == HEAD 树 → 组内无实际变更，恢复后报错。
    let tree_id = index.write_tree()?;
    if tree_id == head_tree.id() {
        restore_staged(set(&staged_outside), &repo, &head_tree);
        return Err(GitServiceError::CLIError(
            "No changes to commit (group files unchanged)".to_string(),
        ));
    }
    let tree = repo.find_tree(tree_id)?;
    let sig = repo.signature()?;
    let oid = repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        message,
        &tree,
        &[&head_commit],
    )?;

    // 步骤 5：恢复组外已暂存态
    restore_staged(set(&staged_outside), &repo, &repo.head()?.peel_to_tree()?);

    Ok(oid.to_string())
}

fn set(v: &[String]) -> std::collections::HashSet<&str> {
    v.iter().map(|s| s.as_str()).collect()
}

/// 把组外文件重新 stage，恢复其暂存位置（尽力而为：单文件失败不阻断）。
/// 对 S_out 中每个文件：working tree 存在 → add_path（暂存当前内容）；
/// 已删除 → remove_path（暂存删除）。这正是「该文件提交前处于暂存态」的逆向恢复。
fn restore_staged(
    outside: std::collections::HashSet<&str>,
    repo: &Repository,
    _head_tree: &git2::Tree,
) {
    if outside.is_empty() {
        return;
    }
    let mut index = match repo.index() {
        Ok(i) => i,
        Err(_) => return,
    };
    for p in outside {
        let path = std::path::Path::new(p);
        if path.exists() {
            let _ = index.add_path(path);
        } else {
            let _ = index.remove_path(path);
        }
    }
    let _ = index.write();
}

/// 暂存文件
pub fn stage_file(path: &Path, file_path: &str) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;

    let mut index = repo.index()?;
    stage_path(&repo, &mut index, file_path)?;
    index.write()?;

    Ok(())
}

/// 取消暂存文件
pub fn unstage_file(path: &Path, file_path: &str) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;

    let head_obj = match repo.revparse_single("HEAD") {
        Ok(obj) => obj,
        Err(_) => {
            // 空仓库/首次提交场景：取消暂存新增文件只能从 index 移除。
            let mut index = repo.index()?;
            index.remove_path(std::path::Path::new(file_path))?;
            index.write()?;
            return Ok(());
        }
    };

    repo.reset_default(Some(&head_obj), [file_path])?;
    Ok(())
}

/// 丢弃工作区变更
pub fn discard_changes(path: &Path, file_path: &str) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;

    if matches!(file_status(&repo, file_path)?, Some(status) if status.is_wt_new()) {
        return Err(GitServiceError::CLIError(
            "Untracked files cannot be discarded; delete them instead".to_string(),
        ));
    }

    let mut checkout = CheckoutBuilder::new();
    checkout.force().path(file_path);
    repo.checkout_index(None, Some(&mut checkout))?;

    Ok(())
}

/// 批量暂存文件
pub fn batch_stage(path: &Path, file_paths: &[String]) -> Result<BatchStageResult, GitServiceError> {
    let repo = open_repository(path)?;
    let mut index = repo.index()?;

    let mut staged = Vec::new();
    let mut failed = Vec::new();

    for file_path in file_paths {
        match stage_path(&repo, &mut index, file_path) {
            Ok(_) => staged.push(file_path.clone()),
            Err(e) => failed.push(StageFailure {
                path: file_path.clone(),
                error: e.to_string(),
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

/// 计算仓库中的跟踪文件数量（预留）
#[allow(dead_code)]
pub fn count_tracked_files(repo: &Repository) -> Result<usize, GitServiceError> {
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

// ───────────────────────── 单元测试（commit_group 隔离语义）─────────────────────────
// 说明：`cargo test --lib` 本机受 Tauri DLL 启动限制不可运行（AGENTS §九），
// 本测试编译到 test binary 供 CI 执行；本机以 cargo check（含 test code 编译）验证。
#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;
    use tempfile;

    /// 构造一对 commit 的临时仓库，worktree 含 a.txt / b.txt 两文件
    fn build_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo_path = tmp.path().to_path_buf();
        let repo = Repository::init(&repo_path).unwrap();

        let sig = Signature::now("t", "t@t").unwrap();
        std::fs::write(repo_path.join("a.txt"), "a1\n").unwrap();
        std::fs::write(repo_path.join("b.txt"), "b1\n").unwrap();

        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.add_path(std::path::Path::new("b.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            "initial",
            &tree,
            &[],
        )
        .unwrap();

        (tmp, repo_path)
    }

    fn write_file(repo_path: &std::path::Path, name: &str, content: &str) {
        std::fs::write(repo_path.join(name), content).unwrap();
        // 保持 working dir 为 HEAD 状态（模拟用户改完后未 stage）
    }

    /// 读取某文件是否已暂存（index diff vs HEAD）
    fn is_staged(repo_path: &std::path::Path, name: &str) -> bool {
        let repo = Repository::open(repo_path).unwrap();
        let head_object = repo.revparse_single("HEAD").unwrap();
        let head_tree = head_object.peel_to_tree().unwrap();
        let index = repo.index().unwrap();
        let diff = repo.diff_tree_to_index(Some(&head_tree), Some(&index), None).unwrap();
        let mut staged = false;
        diff.foreach(
            &mut |delta, _| {
                if let Some(p) = delta.new_file().path() {
                    if p == std::path::Path::new(name) {
                        staged = true;
                    }
                }
                true
            },
            None,
            None,
            None,
        )
        .unwrap();
        staged
    }

    #[test]
    fn commit_group_only_commits_selected_files() {
        let (_tmp, repo_path) = build_fixture();
        let repo = Repository::open(&repo_path).unwrap();

        // 修改 a.txt、b.txt（未 stage）
        write_file(&repo_path, "a.txt", "a2\n");
        write_file(&repo_path, "b.txt", "b2\n");

        // 先 stage b.txt（组外已暂存场景）
        stage_file(&repo_path, "b.txt").unwrap();

        // 只提交 a.txt 组
        let oid = commit_group(&repo_path, "fix(a): 更新 a", &["a.txt".to_string()]).unwrap();

        // 提交应只含 a.txt 变更
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.id().to_string(), oid);

        let tree = head.tree().unwrap();
        let a_entry = tree.get_path(std::path::Path::new("a.txt")).unwrap();
        assert_eq!(
            a_entry.to_object(&repo).unwrap().peel_to_blob().unwrap().content(),
            b"a2\n",
            "a.txt 应被提交为新内容"
        );

        // b.txt 未被提交（working diff 仍保留 b2）
        let b_entry = tree.get_path(std::path::Path::new("b.txt")).unwrap();
        assert_eq!(
            b_entry.to_object(&repo).unwrap().peel_to_blob().unwrap().content(),
            b"b1\n",
            "b.txt 不应进入本组提交，HEAD 中仍为旧内容"
        );

        // 组外已暂存的 b.txt 应恢复暂存态（commit 后仍 staged）
        assert!(is_staged(&repo_path, "b.txt"), "组外已暂存文件 commit_group 后应恢复暂存态");
    }

    #[test]
    fn commit_group_with_no_outside_staged_leaves_clean() {
        let (_tmp, repo_path) = build_fixture();

        // 同时修改两个文件但都未暂存
        write_file(&repo_path, "a.txt", "a2\n");
        write_file(&repo_path, "b.txt", "b2\n");

        commit_group(&repo_path, "feat(a): 独立提交 a", &["a.txt".to_string()]).unwrap();

        // b.txt 仍在工作区（未暂存未提交）
        assert!(!is_staged(&repo_path, "b.txt"), "无组外暂存时 b.txt 不应被意外暂存");
        let repo = Repository::open(&repo_path).unwrap();
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        let b_entry = head_commit.tree().unwrap().get_path(std::path::Path::new("b.txt")).unwrap();
        assert_eq!(
            b_entry.to_object(&repo).unwrap().peel_to_blob().unwrap().content(),
            b"b1\n",
            "b.txt 内容不应进入提交"
        );
    }

    #[test]
    fn commit_group_empty_files_rejected() {
        let (_tmp, repo_path) = build_fixture();
        let err = commit_group(&repo_path, "msg", &[]).unwrap_err();
        assert!(format!("{:?}", err).contains("No files selected"));
    }
}
