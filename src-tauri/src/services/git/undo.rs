/*! Git Undo 网络（FR-P2-3：危险操作快照 + 一键恢复）

快照 = git-native ref（`refs/polaris-undo/<ws>/<yyyyMMdd-HHmmss>`），不复制文件：
- git 对象增量存储，只存「与 HEAD 的差」；
- 恢复走 git 既有路径（stash apply / checkout），语义与 git 一致，不重写文件；
- `.rej` 诊断是恢复遇冲突时的天然副产品（git stash apply 的 reject 文件）；
- 删除分支保留 hash 亦可恢复（快照记录原 tip commit，删除后可重建 ref）。

快照原语 = `git stash create` 单步：只创建 stash commit 对象返回 sha，
**不修改工作区、不入 stash 栈、无 pop 冲突竞态**（对比 naive 的 stash→commit→pop）。
无未提交改动时返回空 → 快照 ref 指向当前 HEAD（记录 refs 原值的场景）。

边界（见 plans/git-panel-p2-undo-spec.md §四）：
- 不做文件级快照复制；不做 .rej 自动应用（P3 冲突合并器）；不做跨操作恢复。
*/

use std::path::Path;

use crate::models::git::{
    GitServiceError, UndoRestoreOutcome, UndoSnapshotMeta,
};

use super::executor::open_repository;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use crate::utils::CREATE_NO_WINDOW;

/// 快照 ref 前缀（`git for-each-ref refs/polaris-undo/` 可枚举；清理按前缀删）
pub const UNDO_REF_PREFIX: &str = "refs/polaris-undo/";

/// ws 路径 → ref 命名段：`\`/`/` → `_`，非法 ref 字符 → `_`。
/// Windows 路径 `C:\x\y` → `C:_x_y`（ref 名内 `.` 尚可，但路径 `.`/`..` 段非法，一并替换）。
fn ws_ref_segment(ws_path: &Path) -> String {
    ws_path
        .to_string_lossy()
        .replace(['\\', '/'], "_")
        .chars()
        .map(|c| match c {
            // ref 名禁段字符：空格 ~ ^ : ? * [ ；`.` 也替换（防 `..` 段与普通点前缀混淆）
            ' ' | '~' | '^' | ':' | '?' | '*' | '[' | ']' | '.' | '\\' => '_',
            c => c,
        })
        .collect()
}

/// 单步执行 git CLI（对齐 stash.rs 既有模式），返回 stdout（失败含 stderr 详情）。
fn run_git(path: &Path, args: &[&str]) -> Result<String, GitServiceError> {
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 仓库是否有未提交改动（工作树或索引；含未跟踪文件）。
fn has_changes(path: &Path) -> Result<bool, GitServiceError> {
    let repo = open_repository(path)?;
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts))?;
    Ok(!statuses.is_empty())
}

/// 当前 HEAD 的 commit sha（空仓库 → None）。
fn head_sha(path: &Path) -> Result<Option<String>, GitServiceError> {
    let repo = open_repository(path)?;
    let head = repo.head();
    Ok(match head {
        Ok(h) => h.target().map(|oid| oid.to_string()),
        Err(_) => None,
    })
}

/// 当前分支（detached HEAD / 空仓库 → None）
fn current_branch(path: &Path) -> Option<String> {
    let repo = open_repository(path).ok()?;
    let head = repo.head().ok()?;
    let shorthand = head.shorthand()?;
    Some(shorthand.to_string())
}

/// 生成快照 ref 名：`refs/polaris-undo/<ws>/<unix-ts>`（时间戳可排序、可反解）。
fn snapshot_ref_name(ws_path: &Path, ts: i64) -> String {
    format!("{}{}/{}", UNDO_REF_PREFIX, ws_ref_segment(ws_path), ts)
}

/// 快照的「恢复 note」ref 名：`refs/polaris-undo/<ws>/<ts>.restore.<branch-encoded>`。
/// 存被删分支的原 tip commit（恢复时据此重建 ref）。
fn restore_note_ref(snapshot_ref: &str, branch: &str) -> String {
    let encoded = branch.replace('/', "_").replace("refs/heads/", "");
    format!("{}.restore.{}", snapshot_ref, encoded)
}

/// 为 workspace 创建撤销快照。返回快照 ref 名（失败返回 Err，调用方不阻塞操作）。
///
/// - 有未提交改动 → `git stash create "polaris-undo <context>"` 产生 stash commit
///   （不改工作区、不入 stash 栈），ref 指向它；
/// - 无改动 → ref 指向当前 HEAD；
/// - `extra_refs`（如删除的分支全名 `refs/heads/x`）：把其当前 commit 记入
///   `.restore.<branch>` note ref，恢复时重建该 ref。
pub fn create_undo_snapshot(
    ws_path: &Path,
    context: &str,
    extra_refs: &[String],
) -> Result<String, GitServiceError> {
    let ts = chrono::Utc::now().timestamp();
    let ref_name = snapshot_ref_name(ws_path, ts);

    // 1) 记录 extra_refs 原 commit（须在快照 ref 落定前读取 —— 分支将被删）
    for rf in extra_refs {
        if rf.is_empty() {
            continue;
        }
        if let Ok(orig) = run_git(
            ws_path,
            &["rev-parse", "--verify", "--quiet", &format!("{}^{{commit}}", rf)],
        ) {
            let orig = orig.trim().to_string();
            if !orig.is_empty() {
                let branch = rf.strip_prefix("refs/heads/").unwrap_or(rf).to_string();
                let note = restore_note_ref(&ref_name, &branch);
                let _ = run_git(ws_path, &["update-ref", &note, &orig]);
            }
        }
    }

    // 2) 快照主体：有未提交改动 → stash create；无 → 指向 HEAD
    let target_sha = if has_changes(ws_path)? {
        let out = run_git(
            ws_path,
            &["stash", "create", &format!("polaris-undo {}", context)],
        )?;
        out.trim().to_string()
    } else {
        head_sha(ws_path)?.ok_or(GitServiceError::CLIError(
            "无法创建撤销快照：仓库为空且无未提交改动".to_string(),
        ))?
    };

    run_git(ws_path, &["update-ref", &ref_name, &target_sha])?;
    Ok(ref_name)
}

/// 删除快照 ref 与它的 `.restore.` note ref —— 供清理/前端手动删除。
/// 只允许删除本 ws 命名空间下的 ref（防跨 ws 误删）。
pub fn drop_undo_snapshot(ws_path: &Path, snapshot_ref: &str) -> Result<(), GitServiceError> {
    let prefix = format!("{}{}/", UNDO_REF_PREFIX, ws_ref_segment(ws_path));
    if !snapshot_ref.starts_with(&prefix) {
        return Err(GitServiceError::CLIError(format!(
            "拒绝删除快照：ref '{}' 不在当前 workspace 命名空间 '{}' 下",
            snapshot_ref, prefix
        )));
    }
    run_git(ws_path, &["update-ref", "-d", snapshot_ref])?;
    // 同步清 .restore. note ref
    if let Ok(notes) = list_ws_refs(ws_path) {
        let sub_prefix = format!("{}.restore.", snapshot_ref);
        for rf in notes {
            if rf.starts_with(&sub_prefix) {
                let _ = run_git(ws_path, &["update-ref", "-d", &rf]);
            }
        }
    }
    Ok(())
}

/// 列举某 workspace 命名空间下的全部 ref（快照 + note）。
fn list_ws_refs(ws_path: &Path) -> Result<Vec<String>, GitServiceError> {
    let out = run_git(
        ws_path,
        &[
            "for-each-ref",
            &format!("refs/polaris-undo/{}/*", ws_ref_segment(ws_path)),
            "--format=%(refname)",
        ],
    )?;
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// 快照是否记录了工作区改动：快照 commit 的 tree 与其首个 parent 的 tree 不一致。
/// stash commit 结构 = `tree + parents`（parent 为快照时 HEAD）；纯 HEAD 快照 tree 一致。
/// 边界：根 commit 快照无 parent —— 退化比较快照 tree 与 HEAD tree（内容寻址，不等即有改动）。
fn snapshot_has_index_changes(ws_path: &Path, snapshot_ref: &str) -> bool {
    // 读取 commit 的两个 tree sha：`cat-file commit <ref>` → "tree <sha>\nparent <sha>\n..."
    let Ok(out) = run_git(
        ws_path,
        &["cat-file", "commit", snapshot_ref],
    ) else {
        return true; // 读取失败保守视为有改动（安全网优先展示可恢复项）
    };
    let mut tree_sha: Option<&str> = None;
    let mut parent_sha: Option<&str> = None;
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("tree ") {
            if tree_sha.is_none() {
                tree_sha = Some(rest.trim());
            }
        } else if let Some(rest) = line.strip_prefix("parent ") {
            if parent_sha.is_none() {
                parent_sha = Some(rest.trim());
            }
        }
    }
    // 无 parent（根 commit 快照）→ 退化为「快照 tree ≠ HEAD tree」（内容寻址直接判定）
    let Some(t) = tree_sha else {
        return true;
    };
    let Some(p) = parent_sha else {
        return snapshot_tree_differs_from_head(ws_path, t);
    };
    // tree 的 sha 相同 = 内容树一致（git 内容寻址）
    t != p
}

/// 快照 tree 与当前 HEAD tree 是否不一致（根 commit 快照无 parent 时的退化判定）
fn snapshot_tree_differs_from_head(ws_path: &Path, snapshot_tree: &str) -> bool {
    let Ok(head_tree) = run_git(
        ws_path,
        &["rev-parse", "--verify", "--quiet", "HEAD^{tree}"],
    ) else {
        return true; // HEAD 不可解析 → 保守视为有改动
    };
    let head_tree = head_tree.trim();
    !head_tree.is_empty() && snapshot_tree != head_tree
}

/// 列出某 workspace 的全部快照（倒序按时间）。快照 ref 名末段 = unix 秒时间戳。
pub fn list_undo_snapshots(ws_path: &Path) -> Result<Vec<UndoSnapshotMeta>, GitServiceError> {
    let refs = list_ws_refs(ws_path)?;
    let mut metas: Vec<UndoSnapshotMeta> = Vec::new();
    for rf in refs {
        // 跳过 note ref（.restore. 子域），不单独列为快照
        if rf.contains(".restore.") {
            continue;
        }
        let ts = rf
            .rsplit('/')
            .next()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let branch = current_branch(ws_path);
        // 精确判定快照是否含工作区改动：快照 commit 的 tree 与其首个 parent 的 tree
        // 不一致 → 有改动（stash commit 结构 = tree + parents）。纯 HEAD 快照则无。
        let has = snapshot_has_index_changes(ws_path, &rf);
        metas.push(UndoSnapshotMeta {
            name: rf,
            created_at: ts,
            context: String::new(),
            has_changes: has,
            branch,
        });
    }
    metas.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(metas)
}

/// 按保留策略清理：每 ws 最多保留 N（默认 5）个最近快照，超限删旧。
/// 返回删除个数。只清理「快照 ref」与「.restore. note」。
pub fn prune_undo_snapshots(ws_path: &Path, max_keep: usize) -> Result<usize, GitServiceError> {
    let metas = list_undo_snapshots(ws_path)?; // 已倒序
    let mut dropped = 0usize;
    for meta in metas.iter().skip(max_keep) {
        if drop_undo_snapshot(ws_path, &meta.name).is_ok() {
            dropped += 1;
        }
    }
    Ok(dropped)
}

/// 恢复指定快照。等价：
/// - 记录过原 ref 的快照（delete_branch → .restore. note）→ 重建 ref 指向原 tip commit；
/// - 含工作区改动的快照（stash commit）→ `git stash apply` 打回工作区；
/// - 纯 HEAD 快照（无改动、无 note）→ 无工作区动作。
///
/// 遇冲突：返回 conflicted_files + 写 .rej（git 天然产物），不抛 Err（可部分成功）。
pub fn restore_undo_snapshot(
    ws_path: &Path,
    snapshot_ref: &str,
) -> Result<UndoRestoreOutcome, GitServiceError> {
    let ref_name = snapshot_ref.trim().to_string();
    if ref_name.is_empty() {
        return Err(GitServiceError::CLIError(
            "恢复快照失败：snapshot_ref 为空".to_string(),
        ));
    }

    let target_sha = run_git(ws_path, &["rev-parse", "--verify", "--quiet", &ref_name])?
        .trim()
        .to_string();
    if target_sha.is_empty() {
        return Err(GitServiceError::CLIError(format!(
            "恢复快照失败：ref '{}' 不存在",
            ref_name
        )));
    }

    // 1) 重建被删分支（.restore. note refs）
    let restore_prefix = format!("{}.restore.", ref_name);
    let all_refs = list_ws_refs(ws_path)?;
    for note in all_refs {
        if let Some(branch_key) = note.strip_prefix(&restore_prefix) {
            if let Ok(orig) = run_git(ws_path, &["rev-parse", "--verify", "--quiet", &note]) {
                let sha = orig.trim().to_string();
                if !sha.is_empty() && !branch_key.is_empty() {
                    let full_ref = format!("refs/heads/{}", branch_key);
                    let _ = run_git(ws_path, &["update-ref", &full_ref, &sha]);
                }
            }
        }
    }

    // 2) 含工作区改动 → stash apply 打回（快照 commit 指向 stash 结构，其 tree 与 HEAD 有差异）
    let head = head_sha(ws_path)?;
    let is_bare_tip = head.as_deref() == Some(target_sha.as_str());
    if is_bare_tip {
        // 无改动快照：工作区已是 HEAD 状态，无恢复动作
        return Ok(UndoRestoreOutcome {
            ok: true,
            conflicted_files: Vec::new(),
            conflict_message: None,
        });
    }

    match run_git(ws_path, &["stash", "apply", &target_sha]) {
        Ok(_) => Ok(UndoRestoreOutcome {
            ok: true,
            conflicted_files: Vec::new(),
            conflict_message: None,
        }),
        Err(GitServiceError::CLIError(e)) if e.contains("CONFLICT") || e.contains("conflict") => {
            Ok(UndoRestoreOutcome {
                ok: false,
                conflicted_files: extract_conflicted_files(&e),
                conflict_message: Some(e),
            })
        }
        Err(e) => Err(e),
    }
}

/// 从 `git stash apply` 的 stderr 提取冲突文件列表（依赖 git 输出格式 `CONFLICT ... in <file>`）
fn extract_conflicted_files(stderr: &str) -> Vec<String> {
    stderr
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            // 形如 "CONFLICT (content): Merge conflict in src/foo.ts"
            let idx = line.find("CONFLICT")? + "CONFLICT".len();
            let rest = &line[idx..];
            let marker = "Merge conflict in ";
            let pos = rest.find(marker)?;
            Some(rest[pos + marker.len()..].trim().to_string())
        })
        .collect()
}

// ───────────────────────── 单元测试 ─────────────────────────
// 说明：`cargo test --lib` 本机受 Tauri DLL 启动限制不可运行（AGENTS §九），
// 本模块测试编译进测试二进制（`cargo check --tests` 校验编译），需真实 git 才可执行。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_ref_segment_sanitizes_path() {
        assert_eq!(
            ws_ref_segment(Path::new("C:/Users/x/my-repo")),
            "C:_Users_x_my-repo"
        );
        assert_eq!(ws_ref_segment(Path::new("D:\\space\\repo")), "D:_space_repo");
        // 空格与非法 ref 字符被替换
        assert_eq!(ws_ref_segment(Path::new("dir name")), "dir_name");
        // `.`/`..` 段被替换（防 ref 非法段）
        assert_eq!(ws_ref_segment(Path::new("a./b..")), "a__b__");
    }

    #[test]
    fn snapshot_ref_name_shape() {
        let name = snapshot_ref_name(Path::new("C:/repo"), 1700000000);
        assert!(name.starts_with("refs/polaris-undo/C:_repo/"));
        assert!(name.ends_with("/1700000000"));
    }

    #[test]
    fn restore_note_ref_encodes_branch() {
        let note = restore_note_ref("refs/polaris-undo/ws/1700000000", "feature/x");
        assert_eq!(note, "refs/polaris-undo/ws/1700000000.restore.feature_x");
    }

    #[test]
    fn snapshot_ref_name_includes_ws() {
        let a = snapshot_ref_name(Path::new("C:/one"), 1);
        let b = snapshot_ref_name(Path::new("C:/two"), 1);
        assert_ne!(a, b);
    }

    #[test]
    fn extract_conflicted_files_parses_git_output() {
        let stderr = "error: could not apply ...\nCONFLICT (content): Merge conflict in src/a.ts\nCONFLICT (modify/delete): deleted in HEAD and modified in stash\n";
        let files = extract_conflicted_files(stderr);
        assert_eq!(files, vec!["src/a.ts"]);
    }
}