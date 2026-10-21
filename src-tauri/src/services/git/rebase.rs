/*! Git Rebase 操作
 *
 * 提供分支变基、中止、继续等功能
 */

use std::path::Path;
use tracing::info;

use crate::models::git::{
    GitRebasePlan, GitRebaseResult, GitRebaseSuggestion, GitRebaseTodoAction, GitRebaseTodoItem,
    GitServiceError,
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
                new_message: None,
            })
        })
        .collect::<Result<Vec<_>, GitServiceError>>()?;

    Ok(GitRebasePlan {
        base_commitish: base_commitish.to_string(),
        first_locked: !commits.is_empty(),
        commits,
    })
}

/// AI-8：检测 fixup!/squash! 提交并产出建议 todo 序列（只读，纯本地零 AI）
///
/// 语义对齐 `git rebase --autosquash` 的目标匹配（subject 前缀匹配，大小写不敏感）：
/// - `fixup! X` / `squash! X` → 移动到最近一个 subject 以 X 开头的 pick 之后
///   （含其 fixup/squash 连段尾部，保证校验器「必须紧跟 pick」成立）
/// - rest 为空或仍是 fixup!/squash! 链（对 fixup! 的 fixup!）→ 无法安全构组，保持原位 pick 进 unmatched
/// - 找不到目标 → 保持原位 pick 进 unmatched（如实报告，不假装成功）
///
/// 建议序列经 validate_todos 兜底；极端情况降级为原 plan 原序（moved=0，如实记录）。
pub fn suggest_rebase_todos(
    path: &Path,
    base_commitish: &str,
) -> Result<GitRebaseSuggestion, GitServiceError> {
    let plan = plan_interactive_rebase(path, base_commitish)?;
    let (commits, moved_count, mut unmatched) = assemble_suggestions(&plan.commits);

    // 防御兜底：建议序列必须过校验器（构造上应恒过；万一失败按原 plan 原序降级，不静默出错序）
    let commits = if validate_todos(&commits).is_err() {
        unmatched.clear();
        plan.commits.clone()
    } else {
        commits
    };

    Ok(GitRebaseSuggestion {
        base_commitish: base_commitish.to_string(),
        commits,
        moved_count,
        unmatched,
    })
}

/// 纯重排核心：pick 原位保留；`fixup!/squash! X` 插到最近 subject 前缀命中（大小写不敏感）
/// 的 pick 连段尾部。返回（建议序列, 移动数, unmatched short shas）。
fn assemble_suggestions(
    commits: &[GitRebaseTodoItem],
) -> (Vec<GitRebaseTodoItem>, usize, Vec<String>) {
    let mut out: Vec<GitRebaseTodoItem> = Vec::with_capacity(commits.len());
    let mut moved_count = 0usize;
    let mut unmatched: Vec<String> = Vec::new();

    for item in commits {
        let annotate = item
            .subject
            .strip_prefix("fixup! ")
            .map(|rest| (GitRebaseTodoAction::Fixup, rest.trim()));
        let annotate = annotate.or_else(|| {
            item.subject
                .strip_prefix("squash! ")
                .map(|rest| (GitRebaseTodoAction::Squash, rest.trim()))
        });

        let Some((action, rest)) = annotate else {
            out.push(item.clone());
            continue;
        };

        let rest_lc = rest.to_lowercase();
        let resolvable = !rest_lc.is_empty()
            && !rest_lc.starts_with("fixup! ")
            && !rest_lc.starts_with("squash! ");

        let inserted = if resolvable {
            // 最近（rposition）一个 subject 前缀命中且为 pick 的项
            let idx = out.iter().rposition(|c| {
                c.action == GitRebaseTodoAction::Pick
                    && c.subject.to_lowercase().starts_with(&rest_lc)
            });
            match idx {
                Some(mut i) => {
                    // 跳过该 pick 之后的连续 fixup/squash 连段，插到组尾
                    while i + 1 < out.len()
                        && matches!(
                            out[i + 1].action,
                            GitRebaseTodoAction::Fixup | GitRebaseTodoAction::Squash
                        )
                    {
                        i += 1;
                    }
                    out.insert(
                        i + 1,
                        GitRebaseTodoItem {
                            sha: item.sha.clone(),
                            subject: item.subject.clone(),
                            action,
                            new_message: None,
                        },
                    );
                    true
                }
                None => false,
            }
        } else {
            false
        };

        if inserted {
            moved_count += 1;
        } else {
            unmatched.push(item.sha[..7.min(item.sha.len())].to_string());
            out.push(GitRebaseTodoItem {
                sha: item.sha.clone(),
                subject: item.subject.clone(),
                action: GitRebaseTodoAction::Pick,
                new_message: None,
            });
        }
    }

    (out, moved_count, unmatched)
}

/// todo 行渲染：`<action> <full-sha> <subject>`
fn render_todo_line(item: &GitRebaseTodoItem) -> String {
    // subject 内换行削平（summary 已单行，防御外部传入）
    let subject = item.subject.replace(['\r', '\n'], " ");
    format!("{} {} {}", item.action.as_keyword(), item.sha, subject)
}

/// 校验面板 todo：非空；首项必须 pick；squash/fixup 的前一项必须是 pick 或 reword
/// （git 语义：squash 组必须紧跟一个会有产出的提交行——pick/reword 均产生提交；
/// drop 会隔断组）——失败给 CLIError 文案
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
            && !matches!(
                pair[0].action,
                GitRebaseTodoAction::Pick | GitRebaseTodoAction::Reword
            )
        {
            return Err(GitServiceError::CLIError(format!(
                "interactive rebase: '{}' must directly follow a pick or reword (sha {})",
                pair[1].action.as_keyword(),
                &pair[1].sha[..7.min(pair[1].sha.len())],
            )));
        }
    }
    Ok(())
}

/// reword 消息文件与顺序表写入（C1：不依赖 GIT_EDITOR 人工交互）。
///
/// 做法：每个 reword 项预写 `reword-K.txt`（新消息原文），并按 todo 顺序构造
/// `reword-order.txt`（文件名清单）。GIT_EDITOR 脚本每个 reword 提交触发一次，
/// 每次从顺序表弹出头部文件名、把对应消息文件 copy 覆盖编辑目标——git 按todo
/// 顺序逐个调起编辑器，弹出行序即执行序，天然对齐。
/// 返回（reword 总数）；无 reword → 0（不写文件）。
fn write_reword_assets(temp_dir: &std::path::Path, todos: &[GitRebaseTodoItem]) -> Result<usize, GitServiceError> {
    let mut k = 0usize;
    let mut order = String::new();
    for item in todos {
        if item.action != GitRebaseTodoAction::Reword {
            continue;
        }
        let msg_name = format!("reword-{}.txt", k);
        // 消息含 \r\n → 统一 \n（git msg 文件惯例；尾部补 \n 保证文件合法）
        let body = item
            .new_message
            .as_deref()
            .unwrap_or(&item.subject)
            .replace("\r\n", "\n");
        std::fs::write(temp_dir.join(&msg_name), if body.ends_with('\n') { body } else { body + "\n" })?;
        order.push_str(&msg_name);
        order.push('\n');
        k += 1;
    }
    if k > 0 {
        std::fs::write(temp_dir.join("reword-order.txt"), &order)?;
    }
    Ok(k)
}

/// GIT_EDITOR 重排脚本（每个 reword 提交一次）：弹出 order 头部文件 → copy 覆盖编辑目标。
/// batch 语义：set /p 读首行；more +1 出队。缺文件/表空 → 不覆盖（保留 git 默认消息，
/// reword 退化为原消息——安全网失败不阻塞 rebase 主体）。
const REWORD_EDITOR_SCRIPT_BODY: &str = "\r\n@echo off\r\nsetlocal\r\nset \"ORDER=%~dp0reword-order.txt\"\r\nif not exist \"%ORDER%\" exit /b 0\r\nset /p FIRST=<\"%ORDER%\"\r\nif not defined FIRST exit /b 0\r\nif not exist \"%~dp0%FIRST%\" exit /b 0\r\ncopy /Y \"%~dp0%FIRST%\" \"%~1\" >nul\r\nmore +1 \"%ORDER%\" > \"%ORDER%.next\"\r\nmove /Y \"%ORDER%.next\" \"%ORDER%\" >nul\r\nendlocal\r\n";

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

        // C1 reword：预写消息文件 + 顺序表；有 reword 时启用 GIT_EDITOR 消息重放脚本
        let reword_count = write_reword_assets(&temp_dir, todos)?;
        let editor_script_path = temp_dir.join("reword_editor.cmd");
        if reword_count > 0 {
            std::fs::write(&editor_script_path, REWORD_EDITOR_SCRIPT_BODY)?;
        }

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
        // C1：有 reword → GIT_EDITOR 脚本按顺序回放新消息（todo 行序 = 编辑器触发序）
        if reword_count > 0 {
            command.env("GIT_EDITOR", format!("\"{}\"", editor_script_path.display()));
        }

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
            new_message: None,
        }
    }

    fn item_r(action: GitRebaseTodoAction, sha: &str, subject: &str, msg: &str) -> GitRebaseTodoItem {
        GitRebaseTodoItem {
            sha: sha.to_string(),
            subject: subject.to_string(),
            action,
            new_message: Some(msg.to_string()),
        }
    }

    #[test]
    fn todo_line_render_picks_keywords() {
        let line = render_todo_line(&item(GitRebaseTodoAction::Pick, "abcdef1234567890", "fix: bug"));
        assert_eq!(line, "pick abcdef1234567890 fix: bug");
        let line = render_todo_line(&item(GitRebaseTodoAction::Fixup, "abcdef1234567890", "fixup! fix: bug"));
        assert_eq!(line, "fixup abcdef1234567890 fixup! fix: bug");
        // C1 reword：todo 行仍是 `reword <sha> <旧 subject>`；新消息走 msg 文件通道
        let line = render_todo_line(&item_r(
            GitRebaseTodoAction::Reword,
            "abcdef1234567890",
            "old subject",
            "new subject",
        ));
        assert_eq!(line, "reword abcdef1234567890 old subject");
    }

    #[test]
    fn validate_reword_and_squash_grouping() {
        // reword 之后的 squash 合法（reword 产生提交，组前驱成立）
        let todos = vec![
            item(GitRebaseTodoAction::Pick, "a1", "root"),
            item_r(GitRebaseTodoAction::Reword, "a2", "old", "new message"),
            item(GitRebaseTodoAction::Squash, "a3", "fixup! old"),
        ];
        assert!(validate_todos(&todos).is_ok());

        // drop 隔断后接 squash 仍非法
        let todos = vec![
            item(GitRebaseTodoAction::Pick, "a1", "root"),
            item(GitRebaseTodoAction::Drop, "a2", "mid"),
            item(GitRebaseTodoAction::Squash, "a3", "fixup! root"),
        ];
        assert!(validate_todos(&todos).is_err());
    }

    #[test]
    fn reword_assets_written_in_todo_order() {
        // C1：消息文件按 reword 出现序编号；order 表与 todo 行序一致；无 reword → 无文件
        let dir = std::env::temp_dir().join(format!(
            "polaris-rebase-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let todos = vec![
            item(GitRebaseTodoAction::Pick, "a1", "root"),
            item_r(GitRebaseTodoAction::Reword, "a2", "old2", "new two\nbody line"),
            item(GitRebaseTodoAction::Fixup, "a3", "fixup! root"),
            item_r(GitRebaseTodoAction::Reword, "a4", "old4", "new four"),
        ];
        assert_eq!(write_reword_assets(&dir, &todos).unwrap(), 2);

        let order = std::fs::read_to_string(dir.join("reword-order.txt")).unwrap();
        assert_eq!(order, "reword-0.txt\nreword-1.txt\n");
        let m0 = std::fs::read_to_string(dir.join("reword-0.txt")).unwrap();
        assert_eq!(m0, "new two\nbody line\n"); // 尾部补 \n，正文保留
        let m1 = std::fs::read_to_string(dir.join("reword-1.txt")).unwrap();
        assert_eq!(m1, "new four\n");

        // 无 reword → 不写 order 表
        let only_picks = vec![item(GitRebaseTodoAction::Pick, "b1", "x")];
        assert_eq!(write_reword_assets(&dir, &only_picks).unwrap(), 0);
        assert!(!dir.join("reword-order-2.txt").exists());

        std::fs::remove_dir_all(&dir).ok();
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

    // ───────────── AI-8 assemble_suggestions 纯重排核心 ─────────────

    #[test]
    fn suggest_moves_fixup_after_matching_target() {
        let commits = [
            item(GitRebaseTodoAction::Pick, "111111111111", "feat: add a"),
            item(GitRebaseTodoAction::Pick, "222222222222", "fixup! feat: add a"),
            item(GitRebaseTodoAction::Pick, "333333333333", "docs: read me"),
        ];
        let (out, moved, unmatched) = assemble_suggestions(&commits);
        assert_eq!(moved, 1);
        assert!(unmatched.is_empty());
        // fixup! 移到目标后，后续 pick 位置不变
        assert_eq!(out[0], item(GitRebaseTodoAction::Pick, "111111111111", "feat: add a"));
        assert_eq!(out[1], item(GitRebaseTodoAction::Fixup, "222222222222", "fixup! feat: add a"));
        assert_eq!(out[2], item(GitRebaseTodoAction::Pick, "333333333333", "docs: read me"));
        assert!(validate_todos(&out).is_ok());
    }

    #[test]
    fn suggest_matches_case_insensitive_and_latest_target() {
        let commits = [
            item(GitRebaseTodoAction::Pick, "111111111111", "Fix: B"),
            item(GitRebaseTodoAction::Pick, "222222222222", "fix: b"),
            item(GitRebaseTodoAction::Pick, "333333333333", "fixup! FIX: B"),
        ];
        let (out, moved, _) = assemble_suggestions(&commits);
        assert_eq!(moved, 1);
        // 最近（第三个之前的 222…）命中
        assert_eq!(out[2], item(GitRebaseTodoAction::Fixup, "333333333333", "fixup! FIX: B"));
        assert_eq!(out[2].sha, "333333333333");
    }

    #[test]
    fn suggest_squash_prefix_and_group_tail_insertion() {
        // 两个 squash! 指向同一目标：都插到组尾（squash 后接 squash 合法——前一动作非 group 时紧跟 pick）
        let commits = [
            item(GitRebaseTodoAction::Pick, "111111111111", "feat: x"),
            item(GitRebaseTodoAction::Pick, "222222222222", "squash! feat: x"),
            item(GitRebaseTodoAction::Pick, "333333333333", "squash! FEAT: X"),
        ];
        let (out, moved, _) = assemble_suggestions(&commits);
        assert_eq!(moved, 2);
        assert_eq!(out[1].action, GitRebaseTodoAction::Squash);
        assert_eq!(out[2].action, GitRebaseTodoAction::Squash);
        assert!(validate_todos(&out).is_ok());
    }

    #[test]
    fn suggest_unmatched_keeps_pick_in_place() {
        let commits = [
            item(GitRebaseTodoAction::Pick, "111111111111", "feat: a"),
            item(GitRebaseTodoAction::Pick, "222222222222", "fixup! no such target"),
            item(GitRebaseTodoAction::Pick, "333333333333", "docs: r"),
        ];
        let (out, moved, unmatched) = assemble_suggestions(&commits);
        assert_eq!(moved, 0);
        assert_eq!(unmatched, vec!["2222222".to_string()]);
        // 保持原位 pick，序与输入一致
        assert_eq!(out[1], item(GitRebaseTodoAction::Pick, "222222222222", "fixup! no such target"));
        assert!(validate_todos(&out).is_ok());
    }

    #[test]
    fn suggest_rejects_fixup_of_fixup_chain() {
        // 对 fixup! 的 fixup!：不构链（校验器约束），保持原位 pick + unmatched
        let commits = [
            item(GitRebaseTodoAction::Pick, "111111111111", "feat: a"),
            item(GitRebaseTodoAction::Pick, "222222222222", "fixup! feat: a"),
            item(GitRebaseTodoAction::Pick, "333333333333", "fixup! fixup! feat: a"),
        ];
        let (out, moved, unmatched) = assemble_suggestions(&commits);
        assert_eq!(moved, 1, "只有第一条 fixup! 可安全构组");
        assert_eq!(unmatched, vec!["3333333".to_string()]);
        assert_eq!(out[2], item(GitRebaseTodoAction::Pick, "333333333333", "fixup! fixup! feat: a"));
        assert!(validate_todos(&out).is_ok());
    }

    #[test]
    fn suggest_empty_rest_is_unmatched() {
        let commits = [
            item(GitRebaseTodoAction::Pick, "111111111111", "feat: a"),
            item(GitRebaseTodoAction::Pick, "222222222222", "fixup!   "),
        ];
        let (_, moved, unmatched) = assemble_suggestions(&commits);
        assert_eq!(moved, 0);
        assert_eq!(unmatched, vec!["2222222".to_string()]);
    }
}
