/*! Git 冲突预测（FR-P2-AI4）
 *
 * fetch 后确定性计算：对方 ahead commits 涉及的文件 ∩ 本地 modified 文件。
 * 纯 git2 只读、0 token 消耗 —— AI 解释层已由 master-plan §1.2 砍掉，仅保留规则建议。
 * 详见 plans/git-panel-p2-conflict-predict-spec.md。
 */

use std::collections::HashSet;
use std::path::Path;

use git2::{BranchType, DiffOptions, Repository, Sort};

use crate::models::git::{
    GitConflictPrediction, GitIncomingCommitPreview, GitServiceError,
};
use super::executor::open_repository;
use super::status::parse_statuses;

/// 空预测（无上游 / 无 HEAD / 空仓库场景统一返回，不报错）
fn empty_prediction(branch: String, upstream: Option<String>) -> GitConflictPrediction {
    GitConflictPrediction {
        branch,
        upstream,
        behind: 0,
        incoming: vec![],
        local_modified: vec![],
        incoming_files: vec![],
        risk_files: vec![],
        advice: "none".to_string(),
    }
}

/// 本地已修改路径集合（staged + unstaged，不含纯 untracked）。
/// 对齐 PRD「本地 modified 文件」措辞 —— 未跟踪文件不与 pull 冲突判定。
fn local_modified_paths(repo: &Repository) -> Result<Vec<String>, GitServiceError> {
    let statuses = parse_statuses(repo)?;
    let mut paths: HashSet<String> = HashSet::new();
    for f in statuses.staged.iter().chain(statuses.unstaged.iter()) {
        paths.insert(f.path.clone());
    }
    let mut sorted: Vec<String> = paths.into_iter().collect();
    sorted.sort();
    Ok(sorted)
}

/// 冲突预测主函数。
///
/// - `branch` 缺省取当前 HEAD 分支；显式传入时按该本地分支计算（分支需有 upstream）。
/// - 无 upstream → 返回空预测（`upstream: None`，前端提示「无比较对象」）。
/// - 算法口径：incoming = `HEAD..<upstream>`（revwalk push upstream、hide HEAD）；
///   文件集 = 每笔 incoming commit 与第一父（根提交比空树）的 diff deltas 路径；
///   risk = incoming_files ∩ local_modified。
pub fn predict_conflicts(
    path: &Path,
    branch: Option<&str>,
) -> Result<GitConflictPrediction, GitServiceError> {
    let repo = open_repository(path)?;

    // 分支名：显式指定，或当前 HEAD shorthand
    let branch_name = match branch.map(str::trim).filter(|s| !s.is_empty()) {
        Some(b) => b.to_string(),
        None => repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()))
            .unwrap_or_default(),
    };
    if branch_name.is_empty() {
        return Ok(empty_prediction(String::new(), None));
    }

    // 本地分支（显式传入远程分支名如 origin/main 时 find_branch Local 失败 → 空预测）
    let local_branch = repo.find_branch(&branch_name, BranchType::Local).ok();
    let Some(local_branch) = local_branch else {
        return Ok(empty_prediction(branch_name, None));
    };
    let Some(upstream) = local_branch.upstream().ok() else {
        // 分支无上游：无比较对象，返回空预测（不报错，前端提示即可）
        return Ok(empty_prediction(branch_name, None));
    };
    let upstream_name = upstream.get().shorthand().map(|s| s.to_string());
    let Some(upstream_oid) = upstream.get().target() else {
        return Ok(empty_prediction(branch_name, upstream_name));
    };

    // 本地 HEAD（分离 HEAD 时无目标 → 空预测）
    let Some(head_oid) = repo.head().ok().and_then(|h| h.target()) else {
        return Ok(empty_prediction(branch_name, upstream_name));
    };

    // 对方领先计数（HEAD..upstream）
    let (_ahead, behind) = repo.graph_ahead_behind(head_oid, upstream_oid)?;

    // incoming commits + 涉及文件：HEAD..upstream，与第一父（根提交比空树）diff
    let mut incoming: Vec<GitIncomingCommitPreview> = Vec::new();
    let mut incoming_files_set: HashSet<String> = HashSet::new();
    {
        let mut revwalk = repo.revwalk()?;
        revwalk.set_sorting(Sort::TOPOLOGICAL)?;
        revwalk.push(upstream_oid)?;
        revwalk.hide(head_oid)?;

        for oid_res in revwalk {
            let oid = oid_res?;
            let commit = repo.find_commit(oid)?;
            let sha = oid.to_string();
            let short_sha = sha[..8.min(sha.len())].to_string();
            incoming.push(GitIncomingCommitPreview {
                sha: sha.clone(),
                short_sha,
                summary: commit.summary().unwrap_or("").to_string(),
            });

            let parent_tree = if commit.parent_count() > 0 {
                Some(commit.parent(0)?.tree()?)
            } else {
                None
            };
            let commit_tree = commit.tree()?;
            let mut opts = DiffOptions::new();
            opts.include_typechange(true);
            let diff = repo.diff_tree_to_tree(
                parent_tree.as_ref(),
                Some(&commit_tree),
                Some(&mut opts),
            )?;
            for delta in diff.deltas() {
                let p = delta.new_file().path().or(delta.old_file().path());
                if let Some(p) = p {
                    incoming_files_set.insert(p.to_string_lossy().to_string());
                }
            }
        }
    }

    let mut incoming_files: Vec<String> = incoming_files_set.into_iter().collect();
    incoming_files.sort();

    let local_modified = local_modified_paths(&repo)?;

    // 交集（两者均已排序 → 线性归并）
    let mut risk_files = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < incoming_files.len() && j < local_modified.len() {
        match incoming_files[i].cmp(&local_modified[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                risk_files.push(incoming_files[i].clone());
                i += 1;
                j += 1;
            }
        }
    }

    // 规则建议（master-plan §1.2：AI 砍掉，仅一条规则）：
    // risk 非空 ⇔ 本地 modified ∩ incoming 有重叠 → 建议先 commit/stash 再 pull
    let advice = if risk_files.is_empty() {
        "none"
    } else {
        "commitOrStash"
    }
    .to_string();

    Ok(GitConflictPrediction {
        branch: branch_name,
        upstream: upstream_name,
        behind,
        incoming,
        local_modified,
        incoming_files,
        risk_files,
        advice,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, RepositoryInitOptions, Signature};

    /// 构造分叉场景：
    /// - main 在 c1（含 a.txt / b.txt / c.txt）
    /// - 远端 origin/main 前进到 c2（只改 a.txt）
    /// - 本地工作区未提交改动：a.txt（冲突）+ b.txt（不冲突）
    ///
    /// 返回 (TempDir, 仓库路径, head_oid)。调用方可按需改工作区。
    fn build_fork_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().to_path_buf();

        // 显式 initial_head("main")：不依赖全局 init.defaultBranch，保持测试封闭
        let repo = Repository::init_opts(
            &path,
            RepositoryInitOptions::new().initial_head("main"),
        )
        .unwrap();
        let sig = Signature::now("t", "t@t").unwrap();

        // 提交 c1（main 起点）
        let commit = |repo: &Repository, file: &str, content: &str, msg: &str| -> git2::Oid {
            std::fs::write(path.join(file), content).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new(file)).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let parent: Option<git2::Commit> = if repo.head().is_ok() {
                let head = repo.head().unwrap();
                if let Some(target) = head.target() {
                    repo.find_commit(target).ok()
                } else {
                    None
                }
            } else {
                None
            };
            let parents: Vec<&git2::Commit> = parent.iter().collect();
            repo.commit(
                Some("refs/heads/main"),
                &sig,
                &sig,
                msg,
                &tree,
                &parents,
            )
            .unwrap()
        };

        let c1 = commit(&repo, "a.txt", "a1\n", "c1");
        // 让 b.txt / c.txt 也在 c1 提交里（一次性全提交，简化树）
        commit(&repo, "b.txt", "b1\n", "c1b");
        commit(&repo, "c.txt", "c1\n", "c1c");
        let _ = c1;

        // 设置上游跟踪：需真实 origin 远程 + fetch refspec（git2 upstream() 读 config 解析）
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("remote.origin.url", "file:///tmp/polaris-conflict-origin")
                .unwrap();
            cfg.set_str("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
                .unwrap();
            cfg.set_str("branch.main.remote", "origin").unwrap();
            cfg.set_str("branch.main.merge", "refs/heads/main").unwrap();
        }

        // 远端 origin/main = 新提交 c2（只改 a.txt）。先建远程引用指向 c2，
        // 需要以 main 为父构造 c2。
        // 手动构造：写入 a.txt 新内容 → 提交到独立 oid（父 = 当前 main tip）
        std::fs::write(path.join("a.txt"), "a2\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let main_tip = repo.head().unwrap().target().unwrap();
        let parent = repo.find_commit(main_tip).unwrap();
        let c2 = repo
            .commit(
                None,
                &sig,
                &sig,
                "c2 remote only",
                &tree,
                &[&parent],
            )
            .unwrap();
        // 更新 refs/remotes/origin/main 指向 c2
        let mut origin_ref = repo.reference(
            "refs/remotes/origin/main",
            c2,
            true,
            "set origin/main",
        ).unwrap();
        origin_ref.set_target(c2, "update").unwrap();

        // 把 index 拉回 HEAD（混合 reset：只动 index、不动 worktree），
        // 避免 c2 构建期污染 index（a.txt 会以 index=a2 挂在 staged，干扰本地 modified 集合）
        let head_oid = repo.head().unwrap().target().unwrap();
        repo.reset(
            repo.find_commit(head_oid).unwrap().as_object(),
            git2::ResetType::Mixed,
            None,
        )
        .unwrap();

        // 本地工作区改动：a.txt（与远端 c2 冲突）+ b.txt（不冲突）
        std::fs::write(path.join("a.txt"), "a1\nlocal\n").unwrap();
        std::fs::write(path.join("b.txt"), "b1\nlocal\n").unwrap();

        (tmp, path)
    }

    #[test]
    fn predicts_intersection_with_fork() {
        let (_tmp, path) = build_fork_fixture();

        let result = predict_conflicts(&path, None).expect("predict_conflicts 不应失败");

        assert_eq!(result.branch, "main");
        assert_eq!(result.upstream.as_deref(), Some("origin/main"));
        assert_eq!(result.behind, 1);

        // 本地 modified = a.txt + b.txt（b.txt 是工作区改动；a.txt 也是）
        assert!(result.local_modified.contains(&"a.txt".to_string()));
        assert!(result.local_modified.contains(&"b.txt".to_string()));

        // incoming files 至少含 a.txt
        assert!(result.incoming_files.contains(&"a.txt".to_string()));

        // risk = a.txt（双方都动，b.txt 未在 incoming）
        assert_eq!(result.risk_files, vec!["a.txt".to_string()]);
        assert_eq!(result.advice, "commitOrStash");

        // incoming 预览有一条（c2 remote only）
        assert_eq!(result.incoming.len(), 1);
        assert!(result.incoming[0].summary.contains("c2 remote only"));
    }

    #[test]
    fn safe_when_local_changes_are_disjoint() {
        let (_tmp, path) = build_fork_fixture();

        // 还原 a.txt 到 HEAD/index 内容（不再本地改动它），只剩 b.txt 改动
        std::fs::write(path.join("a.txt"), "a1\n").unwrap();

        let result = predict_conflicts(&path, None).expect("predict_conflicts 不应失败");

        // 本地 modified 只剩 b.txt；incoming 只动 a.txt → 交集空
        assert!(!result.local_modified.contains(&"a.txt".to_string()));
        assert!(result.risk_files.is_empty());
        assert_eq!(result.advice, "none");
    }

    #[test]
    fn no_upstream_returns_empty_prediction() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().to_path_buf();
        let repo = Repository::init_opts(
            &path,
            RepositoryInitOptions::new().initial_head("main"),
        )
        .unwrap();
        let sig = Signature::now("t", "t@t").unwrap();
        std::fs::write(path.join("a.txt"), "x\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("refs/heads/main"), &sig, &sig, "init", &tree, &[])
            .unwrap();

        let result = predict_conflicts(&path, None).expect("无上游不应报错");
        assert_eq!(result.upstream, None);
        assert_eq!(result.behind, 0);
        assert!(result.risk_files.is_empty());
        assert_eq!(result.advice, "none");
    }

    #[test]
    fn not_a_repository_errors() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let result = predict_conflicts(tmp.path(), None);
        assert!(result.is_err());
    }
}
