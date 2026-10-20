// Git 序列操作机（C11：merge/rebase/cherry-pick/revert 四合一状态探测）
//
// 归一从 .git/{MERGE_HEAD, REBASE_HEAD, rebase-merge, CHERRY_PICK_HEAD, REVERT_HEAD}
// 读取当前进行中的序列操作类型 + 冲突条目 + rebase 步数回读。
//
// 三条纪律（master-plan C11 裁决）：
// 1. Continue 一律从状态回读，不信任 stderr 包含 "CONFLICT"；
// 2. 交叉守卫：四操作入口统一查 get_sequence_state，kind != None 即报对应 InProgress；
// 3. 冲突枚举统一走 index.conflicts()，按 stage 构造 GitConflictEntry
//    （kind 区分 text/binary/deleted_by_*/rename_delete，C10 非内容冲突全穿帮修复）。
//
// 幂等：get_sequence_state 是纯只读，不写 index / 不移动状态文件，可任意次调用。
// 详细方案见 plans/git-panel-p3-conflict-merger-spec.md。

use std::path::Path;

use git2::Repository;

use crate::models::git::{
    GitConflictEntry, GitConflictKind, GitSequenceKind, GitSequenceState, GitServiceError,
};
use super::executor::open_repository;

/// 探测当前序列操作类型（Git 原生优先级：rebase-merge > MERGE_HEAD > REBASE_HEAD
/// > CHERRY_PICK_HEAD > REVERT_HEAD > 无）。
fn detect_kind(repo: &Repository) -> GitSequenceKind {
    let git_dir = repo.path(); // 含 .git/（可为 .git 文件 + gitdir）
    let has = |name: &str| git_dir.join(name).exists();

    // rebase-merge 是目录（interactive/merge rebase）；rebase-apply 是目录（非 -i 老式）
    if has("rebase-merge") || has("rebase-apply") {
        return GitSequenceKind::Rebase;
    }
    if has("MERGE_HEAD") {
        return GitSequenceKind::Merge;
    }
    if has("REBASE_HEAD") {
        return GitSequenceKind::Rebase;
    }
    if has("CHERRY_PICK_HEAD") {
        return GitSequenceKind::CherryPick;
    }
    if has("REVERT_HEAD") {
        return GitSequenceKind::Revert;
    }
    GitSequenceKind::None
}

/// rebase 步数回读（rebase-merge/msgnum + end）：当前步（1 起）与总步数。
/// rebase-apply 阶段无这些文件 → None（老式 rebase 步数不可得，前端跳过进度显示）。
fn read_rebase_steps(repo: &Repository) -> (Option<usize>, Option<usize>) {
    let dir = repo.path().join("rebase-merge");
    if !dir.exists() {
        // rebase-apply 老式（非 -i）：done + next 存在，但没有总步数
        let apply = repo.path().join("rebase-apply");
        if apply.exists() {
            return (None, None);
        }
        return (None, None);
    }
    let read_num = |name: &str| -> Option<usize> {
        let text = std::fs::read_to_string(dir.join(name)).ok()?;
        text.trim().parse().ok()
    };
    (read_num("msgnum"), read_num("end"))
}

/// 二进制检测：内容含 NUL 字节（git xdiff 侧视二进制，不会产出可解析 marker）。
fn is_binary_bytes(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

/// 从仓库按 oid 读 stage 条目的 blob 内容。
fn repo_blob_content(repo: &Repository, entry: &git2::IndexEntry) -> Result<Vec<u8>, git2::Error> {
    if entry.id.is_zero() {
        return Err(git2::Error::from_str("zero oid stage"));
    }
    let blob = repo.find_blob(entry.id)?;
    Ok(blob.content().to_vec())
}

/// 读 stage 条目为 UTF-8 文本（非 UTF-8 → None，调用方降级 binary 防吐乱字节）。
fn blob_utf8(repo: &Repository, entry: &git2::IndexEntry) -> Option<String> {
    let bytes = repo_blob_content(repo, entry).ok()?;
    String::from_utf8(bytes).ok()
}

/// 枚举全部冲突条目（C10：kind + stages 一次到位）。
fn enumerate_conflicts(repo: &Repository) -> Vec<GitConflictEntry> {
    let mut result = Vec::new();
    let index = match repo.index() {
        Ok(i) => i,
        Err(_) => return result,
    };
    let conflicts = match index.conflicts() {
        Ok(c) => c,
        Err(_) => return result,
    };
    for conflict in conflicts.flatten() {
        if let Some(entry) = build_conflict(repo, conflict) {
            result.push(entry);
        }
    }
    result
}

/// 构造单个冲突条目（含三方内容读取 + kind 判定）
fn build_conflict(repo: &Repository, conflict: git2::IndexConflict) -> Option<GitConflictEntry> {
    let (our, their, ancestor) = (conflict.our, conflict.their, conflict.ancestor);

    let path_bytes = our
        .as_ref()
        .map(|e| e.path.as_slice())
        .or_else(|| their.as_ref().map(|e| e.path.as_slice()))
        .or_else(|| ancestor.as_ref().map(|e| e.path.as_slice()));
    let path = path_bytes.map(|b| String::from_utf8_lossy(b).to_string());
    let path = path?;

    // 任一侧 blob 二进制（含 NUL）→ Binary
    let any_binary = [&our, &their, &ancestor]
        .iter()
        .filter_map(|e| e.as_ref())
        .any(|e| repo_blob_content(repo, e).map(|b| is_binary_bytes(&b)).unwrap_or(false));
    if any_binary {
        return Some(GitConflictEntry {
            path,
            kind: GitConflictKind::Binary,
            base: None,
            ours: None,
            theirs: None,
        });
    }

    // 纯 stage 存在性：删取代物价
    match (our.is_some(), their.is_some()) {
        (true, false) => {
            return Some(GitConflictEntry {
                path,
                kind: GitConflictKind::DeletedByUs,
                base: None,
                ours: None,
                theirs: None,
            });
        }
        (false, true) => {
            return Some(GitConflictEntry {
                path,
                kind: GitConflictKind::DeletedByThem,
                base: None,
                ours: None,
                theirs: None,
            });
        }
        _ => {}
    }

    // 文本冲突：读三方全文（非 UTF-8 降级 Binary 防吐乱字节）
    let base = ancestor.as_ref().and_then(|e| blob_utf8(repo, e));
    let ours = our.as_ref().and_then(|e| blob_utf8(repo, e));
    let theirs = their.as_ref().and_then(|e| blob_utf8(repo, e));
    let has_content = base.is_some() || ours.is_some() || theirs.is_some();
    if !has_content {
        // 三方都不可读 → 降级 binary（不乱吐）
        return Some(GitConflictEntry {
            path,
            kind: GitConflictKind::Binary,
            base: None,
            ours: None,
            theirs: None,
        });
    }

    Some(GitConflictEntry {
        path,
        kind: GitConflictKind::Text,
        base,
        ours,
        theirs,
    })
}

/// 归一序列操作状态（唯一权威入口）。
///
/// - kind：探测 `.git` 状态文件；
/// - conflicts：index.conflicts() 枚举（kind + stages）；
/// - 步数：rebase 时 msgnum/end 回读。
pub fn get_sequence_state(path: &Path) -> Result<GitSequenceState, GitServiceError> {
    let repo = open_repository(path)?;
    let kind = detect_kind(&repo);
    let has_conflicts = repo.index().map(|i| i.has_conflicts()).unwrap_or(false);
    let conflicts = if has_conflicts {
        enumerate_conflicts(&repo)
    } else {
        vec![]
    };
    let (current_step, total_steps) = if kind == GitSequenceKind::Rebase {
        read_rebase_steps(&repo)
    } else {
        (None, None)
    };

    Ok(GitSequenceState {
        kind,
        has_conflicts,
        conflicts,
        current_step,
        total_steps,
    })
}

/// 交叉守卫检查：操作进行中时返回对应的 InProgress 错误。
/// merge/rebase/cherry-pick/revert 四操作入口统一调用（C11，替代 branch.rs:250 的
/// 只查 has_conflicts）。
pub fn guard_no_sequence(path: &Path) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;
    match detect_kind(&repo) {
        GitSequenceKind::None => Ok(()),
        GitSequenceKind::Merge => Err(GitServiceError::MergeInProgress),
        GitSequenceKind::Rebase => Err(GitServiceError::RebaseInProgress),
        GitSequenceKind::CherryPick => Err(GitServiceError::CherryPickInProgress),
        GitSequenceKind::Revert => Err(GitServiceError::RevertInProgress),
    }
}

/// 冲突解决完成后标记为「已暂存/完成」用：把当前冲突文件全部 add 进 index
/// （直落 staging，供 continue 消化）。调用方仅在用户确认文件级解决后使用。
/// 删除类冲突（工作区文件已删）add 会失败，跳过不报错。
pub fn stage_conflicted_files(path: &Path) -> Result<Vec<String>, GitServiceError> {
    let repo = open_repository(path)?;
    let mut index = repo.index()?;
    // 先收集路径，避免 index 可变借用与 conflicts 不可变借用冲突
    let mut paths = Vec::new();
    {
        let conflicts = index.conflicts()?;
        for conflict in conflicts.flatten() {
            let p = conflict
                .our
                .as_ref()
                .map(|e| e.path.as_slice())
                .or_else(|| conflict.their.as_ref().map(|e| e.path.as_slice()));
            if let Some(b) = p {
                paths.push(String::from_utf8_lossy(b).to_string());
            }
        }
    }
    let mut staged = Vec::new();
    for p in &paths {
        if index.add_path(std::path::Path::new(p)).is_ok() {
            staged.push(p.clone());
        }
    }
    index.write()?;
    Ok(staged)
}

/// 解决单个冲突文件：以指定内容写回工作区文件，然后暂存（直落 staging）。
///
/// 仅适用于 Text 类冲突（有内容可写）。`deleted_by_*` 文件工作区已删，
/// 写盘前先确认文件在 index/HEAD 中曾存在；不存在则跳过写盘仅做 add。
/// 完成后调用方应重新读取 `get_sequence_state` 刷新冲突清单。
pub fn resolve_conflict_file(path: &Path, file_path: &str, content: &str) -> Result<(), GitServiceError> {
    use super::commit::stage_file;

    let repo = open_repository(path)?;
    let full_path = path.join(file_path);

    // 工作区文件存在于 index/HEAD 才写盘（Text 冲突必有；删类冲突跳过写，仅 add 让 git 识别为已解决）
    let trackable = {
        let index = repo.index()?;
        index.get_path(std::path::Path::new(file_path), 0).is_some()
    };
    if trackable {
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&full_path, content)?;
    }

    stage_file(path, file_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, RepositoryInitOptions, Signature};

    /// 构造带未完成 merge 的仓库（含文本冲突）。
    /// 返回 (TempDir, 路径)。调用方处理后用 detect 系列断言。
    fn build_conflict_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().to_path_buf();

        let repo = Repository::init_opts(&path, RepositoryInitOptions::new().initial_head("main"))
            .unwrap();
        let sig = Signature::now("t", "t@t").unwrap();

        // main 基线 c1（含 file.txt）
        std::fs::write(path.join("file.txt"), "a\nb\nc\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("refs/heads/main"), &sig, &sig, "c1", &tree, &[])
            .unwrap();

        // 分支 feature：改 file.txt 成 "a\nX\nc\n"
        let head = repo.head().unwrap();
        let parent = repo.find_commit(head.target().unwrap()).unwrap();
        let mut tree_builder = repo.treebuilder(None).unwrap();
        let blob = repo.blob(b"a\nX\nc\n").unwrap();
        tree_builder.insert("file.txt", blob, 0o100644).unwrap();
        let ftree_id = tree_builder.write().unwrap();
        let ftree = repo.find_tree(ftree_id).unwrap();
        repo.commit(
            Some("refs/heads/feature"),
            &sig,
            &sig,
            "feature change",
            &ftree,
            &[&parent],
        )
        .unwrap();

        // 回 main：改 file.txt 成 "a\nY\nc\n"（与 feature 冲突）
        let mut tree_builder = repo.treebuilder(None).unwrap();
        let blob = repo.blob(b"a\nY\nc\n").unwrap();
        tree_builder.insert("file.txt", blob, 0o100644).unwrap();
        let mtree_id = tree_builder.write().unwrap();
        let mtree = repo.find_tree(mtree_id).unwrap();
        repo.commit(Some("refs/heads/main"), &sig, &sig, "main change", &mtree, &[&parent])
            .unwrap();

        // 执行 merge feature（产生冲突，MERGE_HEAD 写入）
        let _ = force_merge(&repo, "feature");

        (tmp, path)
    }

    /// 显式执行冲突 merge，制造 MERGE_HEAD + index 冲突
    fn force_merge(repo: &Repository, branch: &str) -> Result<(), git2::Error> {
        let branch_ref = repo.find_branch(branch, git2::BranchType::Local)?;
        let oid = branch_ref.get().target().unwrap();
        let annotated = repo.find_annotated_commit(oid)?;
        repo.merge(&[&annotated], None, None)
    }

    #[test]
    fn detects_merge_kind() {
        let (_tmp, path) = build_conflict_fixture();
        let state = get_sequence_state(&path).expect("state");
        assert_eq!(state.kind, GitSequenceKind::Merge, "冲突 merge 应探测为 Merge");
        assert!(state.has_conflicts);
        assert!(state.current_step.is_none(), "merge 无步数");
    }

    #[test]
    fn enumerates_text_conflict() {
        let (_tmp, path) = build_conflict_fixture();
        let state = get_sequence_state(&path).unwrap();
        assert!(!state.conflicts.is_empty(), "应有冲突条目");
        let entry = state.conflicts.iter().find(|e| e.path == "file.txt").expect("file.txt");
        assert_eq!(entry.kind, GitConflictKind::Text);
        assert!(entry.ours.as_deref().unwrap_or("").contains("Y"), "ours=本地改动");
        assert!(entry.theirs.as_deref().unwrap_or("").contains("X"), "theirs=对方改动");
    }

    #[test]
    fn guard_blocks_merge_when_in_progress() {
        let (_tmp, path) = build_conflict_fixture();
        let err = guard_no_sequence(&path);
        assert!(matches!(err, Err(GitServiceError::MergeInProgress)), "merge 进行中应拦截");
    }

    #[test]
    fn none_when_no_sequence() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().to_path_buf();
        let repo = Repository::init_opts(&path, RepositoryInitOptions::new().initial_head("main"))
            .unwrap();
        let sig = Signature::now("t", "t@t").unwrap();
        std::fs::write(path.join("a.txt"), "x\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("refs/heads/main"), &sig, &sig, "c", &tree, &[])
            .unwrap();

        let state = get_sequence_state(&path).expect("state");
        assert_eq!(state.kind, GitSequenceKind::None);
        assert!(!state.has_conflicts);
        assert!(state.conflicts.is_empty());
        assert!(guard_no_sequence(&path).is_ok());
    }
}