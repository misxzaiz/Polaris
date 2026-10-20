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

/// 冲突侧（stage 还原语义用：ours=stage2 / theirs=stage3）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictSide {
    Ours,
    Theirs,
}

/// 冲突文件解决动作（三态语义，见 resolve_conflict_file 文档）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConflictFileResolution {
    /// 写回显式内容（编辑器拼合结果 / 删类「保留修改」文本）
    WriteContent(String),
    /// 还原指定侧 stage 内容（binary / delete-modify 的整文件取舍）
    CheckoutStage(ConflictSide),
    /// 接受删除（删盘上文件 + 移除 index 冲突 stages）
    Remove,
}

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

    // 按 stage 存在性判 delete/modify（git 语义：某侧 stage 缺失 = 该侧删除了文件。
    // 修复：旧实现把 (our 有,their 无) 标成 DeletedByUs，与 git 约定及本模型文档
    // 注释（DeletedByUs=本地删、对方改）相反，UI 的「接受删除」会按反侧执行。
    // 同时补记幸存侧内容：删类冲突需要一个非空 stage 内容供「保留修改」直接解决。
    let ours_stage = our.as_ref().and_then(|e| blob_utf8(repo, e));
    let theirs_stage = their.as_ref().and_then(|e| blob_utf8(repo, e));
    match (our.is_some(), their.is_some()) {
        (true, false) => {
            // 对方删、本地改：stage3 缺失 → DeletedByThem；ours=本地修改内容
            return Some(GitConflictEntry {
                path,
                kind: GitConflictKind::DeletedByThem,
                base: None,
                ours: ours_stage,
                theirs: None,
            });
        }
        (false, true) => {
            // 本地删、对方改：stage2 缺失 → DeletedByUs；theirs=对方修改内容
            return Some(GitConflictEntry {
                path,
                kind: GitConflictKind::DeletedByUs,
                base: None,
                ours: None,
                theirs: theirs_stage,
            });
        }
        _ => {}
    }

    // 文本冲突：读三方全文（非 UTF-8 降级 Binary 防吐乱字节）
    let base = ancestor.as_ref().and_then(|e| blob_utf8(repo, e));
    let ours = ours_stage;
    let theirs = theirs_stage;
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

/// 解决单个冲突文件（三态语义）：
///
/// - `Write(content)`：把内容无条件写回工作区文件 + add（git 语义：写入即用
///   stage0 条目取代 1/2/3 冲突 stages，直落 staging）。
/// - `CheckoutStage(side)`：把指定侧的 stage（ours=2 / theirs=3）blob 原样写回
///   工作区 + add——binary / delete-modify 的「保留某侧修改」按 stage 还原，
///   与 `git checkout --ours/--theirs` 语义一致，不做任何文本化转换。
/// - `Remove`：删除盘上文件（若存在）+ 移除 index 内该路径全部冲突 stages——
///   表达「接受删除」，旧实现完全缺失此语义（曾把删除表达成保留修改）。
///
/// 修复要点（根因，P3 spec 跟进）：
/// 旧实现以 `index.get_path(path, 0)` 判 trackable，但冲突态的 index 只有
/// stage1/2/3（stage0 不存在）→ 写盘被恒跳过，最后 add 进 index 的是**磁盘上
/// 带 `<<<<<<<` marker 的原文**，产生「解决成功」的假象（静默穿帮）。
///
/// 完成后调用方应重新读取 `get_sequence_state` 刷新冲突清单。
pub fn resolve_conflict_file(
    path: &Path,
    file_path: &str,
    op: ConflictFileResolution,
) -> Result<(), GitServiceError> {
    use super::commit::stage_file;

    let repo = open_repository(path)?;
    let full_path = path.join(file_path);

    match op {
        ConflictFileResolution::WriteContent(content) => {
            // 写语义：无条件写盘（文件父目录一并确保存在）
            if let Some(parent) = full_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&full_path, content)?;
        }
        ConflictFileResolution::CheckoutStage(side) => {
            let stage_no = match side {
                ConflictSide::Ours => 2,
                ConflictSide::Theirs => 3,
            };
            let entry = {
                let index = repo.index()?;
                index.get_path(std::path::Path::new(file_path), stage_no).ok_or_else(|| {
                    GitServiceError::GitError(git2::Error::from_str(&format!(
                        "conflict stage {stage_no} missing for {file_path}"
                    )))
                })?
            };
            let bytes = repo_blob_content(&repo, &entry)?;
            if let Some(parent) = full_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&full_path, bytes)?;
        }
        ConflictFileResolution::Remove => {
            match std::fs::remove_file(&full_path) {
                Ok(()) => {}
                // 工作区本来就没有（本地删的工作区状态）→ 视为已删，继续移除 index
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            let mut index = repo.index()?;
            // 冲突条目可能分布在 stage1/2/3（stage0 通常缺席），逐 stage 全部移除
            for stage in 0..=2i32 {
                let _ = index.remove(std::path::Path::new(file_path), stage);
            }
            let _ = index.remove_path(std::path::Path::new(file_path));
            index.write()?;
            return Ok(());
        }
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

    /// 构造删/改（delete-modify）冲突仓库：本地（main）删除 del.txt，对方（feature）修改它
    fn build_delete_modify_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().to_path_buf();

        let repo = Repository::init_opts(&path, RepositoryInitOptions::new().initial_head("main"))
            .unwrap();
        let sig = Signature::now("t", "t@t").unwrap();

        // 基线 c1：del.txt（基线内容）+ other.txt
        std::fs::write(path.join("del.txt"), "base\n").unwrap();
        std::fs::write(path.join("other.txt"), "other\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("del.txt")).unwrap();
        index.add_path(std::path::Path::new("other.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("refs/heads/main"), &sig, &sig, "c1", &tree, &[])
            .unwrap();
        let head = repo.head().unwrap();
        let parent = repo.find_commit(head.target().unwrap()).unwrap();

        // feature：修改 del.txt（对方改）
        let mut tb = repo.treebuilder(None).unwrap();
        let blob = repo.blob(b"theirs-modized\n").unwrap();
        let blob2 = repo.blob(b"other\n").unwrap();
        tb.insert("del.txt", blob, 0o100644).unwrap();
        tb.insert("other.txt", blob2, 0o100644).unwrap();
        let ftree_id = tb.write().unwrap();
        let ftree = repo.find_tree(ftree_id).unwrap();
        repo.commit(Some("refs/heads/feature"), &sig, &sig, "feature modify", &ftree, &[&parent])
            .unwrap();

        // main：删除 del.txt（本地删）
        let mut tb = repo.treebuilder(None).unwrap();
        let blob2 = repo.blob(b"other\n").unwrap();
        tb.insert("other.txt", blob2, 0o100644).unwrap();
        let mtree_id = tb.write().unwrap();
        let mtree = repo.find_tree(mtree_id).unwrap();
        repo.commit(Some("refs/heads/main"), &sig, &sig, "main delete", &mtree, &[&parent])
            .unwrap();

        force_merge(&repo, "feature").ok();
        (tmp, path)
    }

    #[test]
    fn resolves_text_conflict_writes_content_and_stage0() {
        let (_tmp, path) = build_conflict_fixture();
        let resolved = "a\nresolved\nc\n";

        resolve_conflict_file(
            &path,
            "file.txt",
            ConflictFileResolution::WriteContent(resolved.into()),
        )
        .expect("text resolve");

        // 盘上内容 = 编辑器结果（旧实现的假解决 bug：写盘被跳过、暂存 marker 原文）
        let on_disk = String::from_utf8(std::fs::read(path.join("file.txt")).unwrap()).unwrap();
        assert_eq!(on_disk, resolved, "写盘必须命中编辑结果");

        // index 产生 stage0 条目，冲突清单不再包含该文件
        let repo = Repository::open(&path).unwrap();
        let index = repo.index().unwrap();
        assert!(
            index.get_path(std::path::Path::new("file.txt"), 0).is_some(),
            "解决后应有 stage0 条目"
        );
        let state = get_sequence_state(&path).unwrap();
        assert!(
            !state.conflicts.iter().any(|e| e.path == "file.txt"),
            "文本解决后冲突应消失"
        );
    }

    #[test]
    fn delete_modify_conflict_maps_kind_and_surviving_content() {
        let (_tmp, path) = build_delete_modify_fixture();
        let state = get_sequence_state(&path).unwrap();
        let entry = state
            .conflicts
            .iter()
            .find(|e| e.path == "del.txt")
            .expect("del.txt 冲突条目");

        // git 语义：本地删、对方改 → DeletedByUs，theirs=对方修改内容
        assert_eq!(entry.kind, GitConflictKind::DeletedByUs);
        assert!(entry.ours.is_none(), "本方 stage 缺失");
        assert!(
            entry.theirs.as_deref().unwrap_or_default().contains("theirs-modized"),
            "theirs 应带对方修改内容（旧实现缺失）"
        );
    }

    #[test]
    fn remove_resolution_uses_delete_semantics() {
        let (_tmp, path) = build_delete_modify_fixture();

        resolve_conflict_file(&path, "del.txt", ConflictFileResolution::Remove)
            .expect("remove resolve");

        // 盘上文件被删（git merge 把修改版留在盘上；接受删除必须真删）
        assert!(!path.join("del.txt").exists(), "接受删除后盘上不应再有文件");
        let after = get_sequence_state(&path).unwrap();
        assert!(
            !after.conflicts.iter().any(|e| e.path == "del.txt"),
            "index 中该路径冲突 stages 应全部移除"
        );
    }
}