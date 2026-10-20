/*! Git Rebase 操作
 *
 * 提供分支变基、中止、继续等功能
 */

use std::path::Path;
use tracing::info;

use crate::models::git::{
    GitRebasePlan, GitRebaseResult, GitRebaseTodoAction, GitRebaseTodoItem, GitServiceError,
};
use super::executor::open_repository;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use super::utils::CREATE_NO_WINDOW;

/// 变基分支
pub fn rebase_branch(path: &Path, source_branch: &str) -> Result<GitRebaseResult, GitServiceError> {
    info!("开始变基操作: 当前分支 -> {}", source_branch);

    let repo = open_repository(path)?;

    // C11 交叉守卫：任何序列操作进行中均拒绝（merge/rebase/cherry-pick/revert 互斥）
    super::sequence::guard_no_sequence(path)?;

    // 获取当前分支
    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .unwrap_or_else(|| "HEAD".to_string());

    // 不能变基到自身
    if current_branch == source_branch {
        return Err(GitServiceError::CLIError(format!(
            "Cannot rebase branch '{}' onto itself",
            source_branch
        )));
    }

    // 获取目标分支的 commit
    let target_ref = repo
        .find_branch(source_branch, git2::BranchType::Local)
        .or_else(|_| repo.find_branch(source_branch, git2::BranchType::Remote))?;

    let target_commit_oid = target_ref
        .get()
        .target()
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

    // 执行变基操作
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["rebase", source_branch])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["rebase", source_branch])
        .current_dir(path)
        .output()?;

    let _stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
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
        // C11：冲突判定与步数归一从序列状态回读，不信任 stderr 包含 "CONFLICT"
        let state = super::sequence::get_sequence_state(path)?;
        let has_conflicts = state.has_conflicts;

        if has_conflicts {
            info!("变基遇到冲突: {} 个文件", state.conflicts.len());
            Ok(GitRebaseResult {
                success: false,
                has_conflicts: true,
                conflicts: state.conflicts,
                rebased_commits: 0,
                current_step: state.current_step.unwrap_or(1),
                total_steps: state.total_steps.unwrap_or(total_steps),
                finished: false,
            })
        } else {
            Err(GitServiceError::CLIError(stderr.to_string()))
        }
    }
}

/// 中止变基操作
pub fn rebase_abort(path: &Path) -> Result<(), GitServiceError> {
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["rebase", "--abort"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
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
    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(["rebase", "--continue"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(["rebase", "--continue"])
        .current_dir(path)
        .output()?;

    let _stdout = String::from_utf8_lossy(&output.stdout);
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
        // C11：Continue 一律从状态回读（步数存活，不信任 stderr 包含 "CONFLICT"）
        let state = super::sequence::get_sequence_state(path)?;
        let has_conflicts = state.has_conflicts;

        if has_conflicts {
            Ok(GitRebaseResult {
                success: false,
                has_conflicts: true,
                conflicts: state.conflicts,
                rebased_commits: 0,
                current_step: state.current_step.unwrap_or(1),
                total_steps: state.total_steps.unwrap_or(1),
                finished: false,
            })
        } else {
            Err(GitServiceError::CLIError(stderr.to_string()))
        }
    }
}

// ============================================================================
// Interactive Rebase（P3 FR-P3-2）
//
// 裁决实现路线（handoff §3.3）：git2 的 rebase API 对 -i 不可靠，CLI 是正解——
// 面板化 TODO 由前端编辑（reorder + pick/drop/squash/fixup），后端把面板结果
// 渲染为 git inner todo 文件，注入 `GIT_SEQUENCE_EDITOR`（一个只做 copy /Y 的
// cmd 脚本）让 `git rebase -i` 的交互编辑被我们的 todo 无声替换。
//
// reword 需要第二层编辑器编排（GIT_EDITOR），增量阶段未支持（如实标注）；
// 冲突复用既有 rebase_continue/rebase_abort + P3 冲突合并器闭环。
// ============================================================================

/// 面板化 Interactive Rebase 的预览计划（只读）：base..HEAD 应用序（老 → 新）
///
/// - 守卫：任何序列操作进行中即拒（C11 交叉守卫）
/// - subject 取 summary 单行；面板可再编辑顺序/动作
pub fn plan_interactive_rebase(
    path: &Path,
    base_commitish: &str,
) -> Result<GitRebasePlan, GitServiceError> {
    let repo = open_repository(path)?;
    super::sequence::guard_no_sequence(path)?;

    let base = repo
        .revparse_single(base_commitish)
        .map_err(|_| GitServiceError::BranchNotFound(base_commitish.to_string()))?
        .peel_to_commit()?;
    let head = repo.head()?.peel_to_commit()?;

    // revwalk 输出为新 → 老；面板/应用序为老 → 新
    let mut revwalk = repo.revwalk()?;
    revwalk.push_range(&format!("{}..{}", base.id(), head.id()))?;
    let mut shas: Vec<git2::Oid> = revwalk.collect::<Result<Vec<_>, _>>()?;
    shas.reverse();

    let commits = shas
        .into_iter()
        .map(|oid| {
            let commit = repo.find_commit(oid)?;
            let subject = commit.summary().unwrap_or_default().trim_end().to_string();
            Ok(GitRebaseTodoItem {
                sha: oid.to_string(),
                subject,
                action: GitRebaseTodoAction::Pick,
            })
        })
        .collect::<Result<Vec<_>, GitServiceError>>()?;

    Ok(GitRebasePlan {
        base_commitish: base_commitish.to_string(),
        first_locked: !commits.is_empty(),
        commits,
    })
}

/// todo 行渲染：`<action> <full-sha> <subject>`
fn render_todo_line(item: &GitRebaseTodoItem) -> String {
    // subject 内换行削平（summary 已单行，防御外部传入）
    let subject = item.subject.replace(['\r', '\n'], " ");
    format!("{} {} {}", item.action.as_keyword(), item.sha, subject)
}

/// 校验面板 todo：非空；首项必须 pick；squash/fixup 的前一项必须是 pick
/// （git 语义：squash 组必须紧跟一个 pick；drop 隔断组）——失败给 CLIError 文案
fn validate_todos(todos: &[GitRebaseTodoItem]) -> Result<(), GitServiceError> {
    if todos.is_empty() {
        return Err(GitServiceError::CLIError(
            "interactive rebase: empty todo list".into(),
        ));
    }
    if todos[0].action != GitRebaseTodoAction::Pick {
        return Err(GitServiceError::CLIError(
            "interactive rebase: first entry must be pick (squash/fixup must follow a pick)".into(),
        ));
    }
    for pair in todos.windows(2) {
        if matches!(pair[1].action, GitRebaseTodoAction::Squash | GitRebaseTodoAction::Fixup)
            && pair[0].action != GitRebaseTodoAction::Pick
        {
            return Err(GitServiceError::CLIError(format!(
                "interactive rebase: '{}' must directly follow a pick (sha {})",
                pair[1].action.as_keyword(),
                &pair[1].sha[..7.min(pair[1].sha.len())],
            )));
        }
    }
    Ok(())
}

/// 执行面板化 interactive rebase（写类，DESTRUCTIVE）：
///
/// 1. 渲染面板 todo → temp 目录 todo 文件
/// 2. 生成 `copy /Y <todo> <editor-file>` 的 cmd 脚本作为 GIT_SEQUENCE_EDITOR
///    （git-for-windows 的 msys 运行时可 spawn .cmd，路径引号包裹防解析歧义）
/// 3. `git rebase -i <base> [--autosquash]`；冲突/失败从序列状态回读（C11）
/// 4. temp 目录 best-effort 清理
pub fn start_interactive_rebase(
    path: &Path,
    base_commitish: &str,
    todos: &[GitRebaseTodoItem],
    autosquash: bool,
) -> Result<GitRebaseResult, GitServiceError> {
    let repo = open_repository(path)?;
    super::sequence::guard_no_sequence(path)?;
    validate_todos(todos)?;

    // base 必须可解析（面板源头为 plan 返回的 sha）
    let _ = repo
        .revparse_single(base_commitish)
        .map_err(|_| GitServiceError::BranchNotFound(base_commitish.to_string()))?;

    let temp_dir = std::env::temp_dir().join(format!(
        "polaris-rebase-todo-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&temp_dir)?;

    let result = (|| -> Result<GitRebaseResult, GitServiceError> {
        let todo_path = temp_dir.join("git-rebase-todo.txt");
        let mut todo_body = String::new();
        for item in todos {
            todo_body.push_str(&render_todo_line(item));
            todo_body.push('\n');
        }
        std::fs::write(&todo_path, todo_body)?;

        // 编辑器脚本：把我们的 todo 覆盖到 git 生成/指定的 todo 文件（%1）
        let script_path = temp_dir.join("apply_todo.cmd");
        std::fs::write(
            &script_path,
            "@echo off\r\ncopy /Y \"%~dp0git-rebase-todo.txt\" \"%~1\" >nul\r\n",
        )?;

        let mut args = vec!["rebase".to_string(), "-i".to_string()];
        if autosquash {
            args.push("--autosquash".to_string());
        }
        args.push(base_commitish.to_string());

        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut c = std::process::Command::new("git");
            c.creation_flags(CREATE_NO_WINDOW);
            c
        };
        #[cfg(not(windows))]
        let mut command = std::process::Command::new("git");

        command
            .args(&args)
            .current_dir(path)
            .env("GIT_SEQUENCE_EDITOR", format!("\"{}\"", script_path.display()));

        let output = command.output()?;
        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            info!("interactive rebase 完成: base={}", base_commitish);
            let collapsed = todos.iter().filter(|t| {
                matches!(t.action, GitRebaseTodoAction::Squash | GitRebaseTodoAction::Fixup)
            }).count();
            let picks = todos
                .iter()
                .filter(|t| t.action == GitRebaseTodoAction::Pick)
                .count();
            return Ok(GitRebaseResult {
                success: true,
                has_conflicts: false,
                conflicts: vec![],
                rebased_commits: picks - collapsed,
                current_step: todos.len(),
                total_steps: todos.len(),
                finished: true,
            });
        }

        // C11：冲突判定与步数归一从序列状态回读
        let state = super::sequence::get_sequence_state(path)?;
        if state.has_conflicts {
            info!("interactive rebase 冲突: {} 个文件", state.conflicts.len());
            return Ok(GitRebaseResult {
                success: false,
                has_conflicts: true,
                conflicts: state.conflicts,
                rebased_commits: 0,
                current_step: state.current_step.unwrap_or(1),
                total_steps: state.total_steps.unwrap_or(todos.len()),
                finished: false,
            });
        }
        Err(GitServiceError::CLIError(stderr.to_string()))
    })();

    // temp 清理（best effort；Windows 上残留目录无害）
    let _ = std::fs::remove_dir_all(&temp_dir);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::git::GitRebaseTodoItem;

    fn item(action: GitRebaseTodoAction, sha: &str, subject: &str) -> GitRebaseTodoItem {
        GitRebaseTodoItem {
            sha: sha.to_string(),
            subject: subject.to_string(),
            action,
        }
    }

    #[test]
    fn todo_line_render_picks_keywords() {
        let line = render_todo_line(&item(GitRebaseTodoAction::Pick, "abcdef1234567890", "fix: bug"));
        assert_eq!(line, "pick abcdef1234567890 fix: bug");
        let line = render_todo_line(&item(GitRebaseTodoAction::Fixup, "abcdef1234567890", "fixup! fix: bug"));
        assert_eq!(line, "fixup abcdef1234567890 fixup! fix: bug");
    }

    #[test]
    fn todo_line_subject_newlines_flattened() {
        // 防御：外部传入 subject 含换行必须削平（git todo 行内换行会破坏文件结构）
        let line = render_todo_line(&item(GitRebaseTodoAction::Drop, "aabbcc", "multi\r\nline\nsubject"));
        assert_eq!(line, "drop aabbcc multi  line subject");
    }

    #[test]
    fn validate_accepts_plain_picks() {
        let todos = vec![
            item(GitRebaseTodoAction::Pick, "aaaaaaaaaaaa", "one"),
            item(GitRebaseTodoAction::Pick, "bbbbbbbbbbbb", "two"),
        ];
        assert!(validate_todos(&todos).is_ok());
    }

    #[test]
    fn validate_rejects_empty_and_first_non_pick() {
        assert!(validate_todos(&[]).is_err());
        let todos = vec![
            item(GitRebaseTodoAction::Squash, "aaaaaaaaaaaa", "one"),
            item(GitRebaseTodoAction::Pick, "bbbbbbbbbbbb", "two"),
        ];
        assert!(validate_todos(&todos).is_err(), "首项必须 pick");
    }

    #[test]
    fn validate_rejects_squash_not_following_pick() {
        // drop 隔断 squash 组 → 非法
        let todos = vec![
            item(GitRebaseTodoAction::Pick, "aaaaaaaaaaaa", "one"),
            item(GitRebaseTodoAction::Drop, "bbbbbbbbbbbb", "two"),
            item(GitRebaseTodoAction::Squash, "cccccccccccc", "three"),
        ];
        assert!(validate_todos(&todos).is_err());
        // 紧跟 pick → 合法（连续 squash 也合法）
        let todos = vec![
            item(GitRebaseTodoAction::Pick, "aaaaaaaaaaaa", "one"),
            item(GitRebaseTodoAction::Squash, "bbbbbbbbbbbb", "two"),
            item(GitRebaseTodoAction::Fixup, "cccccccccccc", "three"),
        ];
        assert!(validate_todos(&todos).is_ok());
    }
}
