//! cap.git —— Git 面板域的唯一动作入口（PR-1 上收 RouterBus；PR-2b 命令层整域摘除）
//!
//! 上位文档：`plans/git-panel-master-plan.md`（裁决 1/4/5/8）+ `plans/git-panel-p0-spec.md`。
//!
//! # 形态（PR-1 修正案：invoke 兼容 shim 的后端落点）
//!
//! - `action` = 去 `git_` 前缀的原命令名（如 `git_get_status` → `get_status`），
//!   payload 其余字段 = 原命令参数（camelCase **原样透传**，master-plan 裁决 3：
//!   casing 维持现状，P2 起新协议才定标）。
//! - 唯一入口：PR-2b 起本能力直调 `services::git::GitService`（业务核），旧命令层
//!   `commands/git.rs` 已整域摘除（对齐 todo_capability 范式，不留双轨）。camelCase
//!   参数提取与旧命令签名一一对应，保证「能力返回 JSON ≡ 旧命令 Ok(T) 序列化」。
//! - `Reply` 错误通道仅 `Result<Value, String>`（router/mod.rs 契约），错误串格式
//!   `message (details)`，对齐前端 `parseGitError` 的呈现习惯。结构化错误载荷 P2a 扩。
//!
//! # 能力内二级校验（裁决 4：不拆多 cap）
//!
//! 破坏性动作（写类）对 `Source::Plugin`（AI/插件进程内调用方）直接拒绝；
//! `Bootstrap`（桌面主窗口）与 `Remote`（Web 桥）放行 —— 完整权限矩阵在 PR-2a 落地。
//!
//! # 并发（PR-2a 前的现状语义）
//!
//! 读动作天然并发；commit/pull 等旧命令的 spawn_blocking 包装被并发抑制（master-plan
//! 裁决 8：写 max=1 队列 + progress 合流在 PR-2a 落地为 queue/exec 轴）。

use crate::contracts::{Capability, CapabilityId, Context};
use crate::models::git::{
    CreatePROptions, GitError, GitHostType, GitServiceError, LogSearchFilter,
};
use crate::services::git::{GitService, ResetMode};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

/// 能力 id
pub const GIT_CAP_ID: &str = "cap.git";

/// 写路径全局栅栏（master-plan 裁决 8：读无限并发 + 写 max=1）。
///
/// git2 的 index/repo 内部锁文件（index.lock etc.）不可并发写 —— 并行两次
/// commit/stage 会以 index.lock 冲突失写。旧命令层在 UI 单入口下无此问题，
/// 上总线后多入口（双面板 + AI + Web）必须串行写。PR-2a 后续把此栅栏升级为
/// 带队列/取消语义的写入任务队列；本版为最简互斥（行为等价于"用户只点一次"）。
static WRITE_GATE: Mutex<()> = Mutex::new(());

/// PR-1 临时护栏：插件来源禁止的实施性（写/破坏性）动作集。
/// 完整矩阵（按动作细分 allow/deny + Remote token 分级）PR-2a 落地后替换本表。
const DESTRUCTIVE_ACTIONS: &[&str] = &[
    "commit_changes",
    "stage_file",
    "unstage_file",
    "batch_stage",
    "commit_group",
    "discard_changes",
    "reset",
    "init_repository",
    "create_branch",
    "checkout_branch",
    "delete_branch",
    "rename_branch",
    "merge_branch",
    "rebase_branch",
    "rebase_abort",
    "rebase_continue",
    "cherry_pick",
    "cherry_pick_abort",
    "cherry_pick_continue",
    "revert",
    "revert_abort",
    "revert_continue",
    "checkout_commit",
    "create_tag",
    "delete_tag",
    "add_remote",
    "remove_remote",
    "push_branch",
    "push_set_upstream",
    "pull",
    "fetch",
    "stash_save",
    "stash_pop",
    "stash_drop",
    "stash_apply",
    "amend_commit",
    "save_gitignore",
    "add_to_gitignore",
    "create_pr",
];

/// PR-1 临时护栏判定。
fn is_destructive(action: &str) -> bool {
    DESTRUCTIVE_ACTIONS.contains(&action)
}

/// 已注册动作全集（与下方 invoke match 一一对应；alias 在 match 前归一，
/// 故 stash_list 与 get_stash_list 都接受）。新增动作必须两处同改。
const KNOWN_ACTIONS: &[&str] = &[
    "is_repository", "discover_repositories", "get_status", "get_diffs",
    "get_log", "get_log_with_lanes", "get_commit_details", "get_file_history", "init_repository",
    "commit_changes", "stage_file", "unstage_file", "discard_changes",
    "batch_stage", "commit_group", "get_worktree_diff", "get_index_diff",
    "get_worktree_file_diff", "get_index_file_diff", "get_branches",
    "create_branch", "checkout_branch", "delete_branch", "rename_branch",
    "merge_branch", "rebase_branch", "rebase_abort", "rebase_continue",
    "cherry_pick", "cherry_pick_abort", "cherry_pick_continue", "revert",
    "revert_abort", "revert_continue", "reset", "checkout_commit",
    "get_tags", "create_tag", "delete_tag", "get_remotes", "add_remote",
    "remove_remote", "detect_host", "push_branch", "push_set_upstream",
    "pull", "fetch", "stash_list", "stash_save", "stash_pop", "stash_drop",
    "stash_apply", "stash_show",
    "amend_commit", "search_log", "get_reflog",
    "blame_file", "get_gitignore", "save_gitignore", "add_to_gitignore",
    "get_gitignore_templates", "create_pr", "get_pr_status",
];

// ───────────────────────── 参数提取 helpers ─────────────────────────

fn require_string<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Missing required argument: {}", key))
}

fn optional_string(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(|v| v.as_str()).map(String::from)
}

fn bool_or(params: &Value, key: &str, default: bool) -> bool {
    params
        .get(key)
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

fn opt_usize(params: &Value, key: &str) -> Option<usize> {
    params
        .get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
}

fn string_vec(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn require_u64(params: &Value, key: &str) -> Result<u64, String> {
    params
        .get(key)
        .and_then(|v| v.as_u64())
        .ok_or_else(|| format!("Missing required argument: {}", key))
}

/// GitError → 错误通道串：`message (details)`（对齐前端 parseGitError 细节呈现）
fn git_err(e: GitError) -> String {
    match e.details {
        Some(d) => format!("{} ({})", e.message, d),
        None => e.message,
    }
}

/// GitServiceError → 错误通道串（经既有 From<GitServiceError> for GitError 统一整形）
fn svc_err(e: GitServiceError) -> String {
    git_err(GitError::from(e))
}

/// Result<T, GitServiceError> → Ok(Value) | Err(错误通道串)
fn json_ok_svc<T: serde::Serialize>(r: Result<T, GitServiceError>) -> Result<Value, String> {
    let v = serde_json::to_value(r.map_err(svc_err)?)
        .map_err(|e| format!("serialize git result failed: {}", e))?;
    Ok(v)
}

fn workspace(params: &Value) -> Result<PathBuf, String> {
    Ok(PathBuf::from(require_string(params, "workspacePath")?))
}

// ───────────────────────── 能力本体 ─────────────────────────

pub struct GitCapability;

impl Capability for GitCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(GIT_CAP_ID.to_string())
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }

    fn describe(&self) -> Value {
        json!({
            "summary": "Git 域动作入口：状态/差异/提交/分支/远程/标签/stash/blame 读写（完整动作清单见 plans/git-panel-p0-spec.md）",
            "actions": {
                "get_status":   { "params": { "workspacePath": "string" }, "returns": "GitRepositoryStatus(camels)" },
                "get_diffs":    { "params": { "workspacePath": "string", "baseCommit": "string" } },
                "get_log":      { "params": { "workspacePath": "string", "limit?": "number", "skip?": "number", "branch?": "string" } },
                "get_log_with_lanes": { "params": { "workspacePath": "string", "limit?": "number", "skip?": "number", "branch?": "string" }, "returns": "GitLogPage(commits+rows)" },
                "stage_file":   { "params": { "workspacePath": "string", "filePath": "string" }, "note": "写类动作，Plugin 来源在 PR-2a 矩阵落地前被拒" },
                "commit_changes":{ "params": { "workspacePath": "string", "message": "string", "stageAll?": "bool", "selectedFiles?": "string[]" } },
                "...": "其余动作与旧 git_* 命令一一对应（action=去前缀命令名）"
            },
            "note": "PR-2b 形态：直调 GitService（命令层已摘除）；casing 维持 camelCase 现状（裁决 3）。结构化错误载荷新增于 PR-2a。"
        })
    }

    fn invoke(&self, params: Value, ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required field: action".to_string())?
            .to_string();

        // 二级校验：写类动作禁止 Plugin 来源（Bootstrap/Remote 放行）
        if is_destructive(&action)
            && matches!(ctx.source(), crate::contracts::Source::Plugin { .. })
        {
            return Err(format!(
                "cap.git: Plugin 来源禁止破坏性 git 操作 '{}'（P2a 权限矩阵落地前临时护栏）",
                action
            ));
        }

        let p = &params;
        // 别名兼容：旧前端存在 git_get_stash_list / git_stash_list 两种写法
        let a: &str = if action == "get_stash_list" { "stash_list" } else { action.as_str() };

        if !KNOWN_ACTIONS.contains(&a) {
            return Err(format!("Unknown cap.git action: {}", action));
        }

        // 写 max=1（裁决 8）：破坏性（写类）动作全局串联，读动作不受影响。
        // 生命周期覆盖整个动作调用 —— 含 GitService 内部的全部 git2 修改。
        let _write_guard: Option<std::sync::MutexGuard<'_, ()>> = if is_destructive(a) {
            Some(WRITE_GATE.lock().map_err(|_| {
                "cap.git write gate poisoned（前一写动作 panic）".to_string()
            })?)
        } else {
            None
        };

        match a {
            // ── 状态 / 只读 ─────────────────────────────────────────────
            "is_repository" => Ok(json!(GitService::is_repository(
                &workspace(p)?
            ))),
            "discover_repositories" => json_ok_svc(GitService::discover_repositories(
                &workspace(p)?,
                opt_usize(p, "maxDepth").unwrap_or(4),
            )),
            "get_status" => json_ok_svc(GitService::get_status(&workspace(p)?)),
            "get_diffs" => json_ok_svc(GitService::get_diff(
                &workspace(p)?,
                require_string(p, "baseCommit")?,
            )),
            "get_log" => {
                let branch = optional_string(p, "branch");
                json_ok_svc(GitService::get_log(
                    &workspace(p)?,
                    opt_usize(p, "limit").or_else(|| opt_usize(p, "maxCount")),
                    opt_usize(p, "skip"),
                    branch.as_deref(),
                ))
            }
            // P2 泳道图：commits（含 refs 装饰）+ rows（lane 数据）同一次返回
            "get_log_with_lanes" => {
                let branch = optional_string(p, "branch");
                json_ok_svc(GitService::get_log_with_lanes(
                    &workspace(p)?,
                    opt_usize(p, "limit").or_else(|| opt_usize(p, "maxCount")),
                    opt_usize(p, "skip"),
                    branch.as_deref(),
                ))
            }
            "get_commit_details" => json_ok_svc(GitService::get_commit_details(
                &workspace(p)?,
                require_string(p, "commitSha")?,
            )),
            "get_file_history" => {
                let branch = optional_string(p, "branch");
                json_ok_svc(GitService::get_file_history(
                    &workspace(p)?,
                    require_string(p, "filePath")?,
                    opt_usize(p, "limit"),
                    opt_usize(p, "skip"),
                    branch.as_deref(),
                ))
            }

            // ── 仓库初始化 ─────────────────────────────────────────────
            "init_repository" => {
                let ib = optional_string(p, "initialBranch");
                json_ok_svc(GitService::init_repository(
                    &workspace(p)?,
                    ib.as_deref(),
                ))
            }

            // ── 提交 / 暂存 ────────────────────────────────────────────
            "commit_changes" => {
                let files = p.get("selectedFiles").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect::<Vec<_>>()
                });
                json_ok_svc(GitService::commit(
                    &workspace(p)?,
                    require_string(p, "message")?,
                    bool_or(p, "stageAll", false),
                    files,
                ))
            }
            "stage_file" => json_ok_svc(GitService::stage_file(
                &workspace(p)?,
                require_string(p, "filePath")?,
            )),
            "unstage_file" => json_ok_svc(GitService::unstage_file(
                &workspace(p)?,
                require_string(p, "filePath")?,
            )),
            "discard_changes" => json_ok_svc(GitService::discard_changes(
                &workspace(p)?,
                require_string(p, "filePath")?,
            )),
            "batch_stage" => {
                let files = string_vec(p, "filePaths");
                json_ok_svc(GitService::batch_stage(&workspace(p)?, &files))
            }
            "commit_group" => {
                let files = string_vec(p, "files");
                if files.is_empty() {
                    return Err("Missing required argument: files".to_string());
                }
                json_ok_svc(GitService::commit_group(
                    &workspace(p)?,
                    require_string(p, "message")?,
                    &files,
                ))
            }

            // ── Diff ───────────────────────────────────────────────────
            "get_worktree_diff" => json_ok_svc(GitService::get_worktree_diff(&workspace(p)?)),
            "get_index_diff" => json_ok_svc(GitService::get_index_diff(&workspace(p)?)),
            "get_worktree_file_diff" => json_ok_svc(GitService::get_worktree_file_diff(
                &workspace(p)?,
                require_string(p, "filePath")?,
            )),
            "get_index_file_diff" => json_ok_svc(GitService::get_index_file_diff(
                &workspace(p)?,
                require_string(p, "filePath")?,
            )),

            // ── 分支 ───────────────────────────────────────────────────
            "get_branches" => json_ok_svc(GitService::get_branches(&workspace(p)?)),
            "create_branch" => {
                let start_point = optional_string(p, "startPoint");
                json_ok_svc(GitService::create_branch(
                    &workspace(p)?,
                    require_string(p, "name")?,
                    bool_or(p, "checkout", false),
                    start_point.as_deref(),
                ))
            }
            "checkout_branch" => json_ok_svc(GitService::checkout_branch(
                &workspace(p)?,
                require_string(p, "name")?,
            )),
            "delete_branch" => json_ok_svc(GitService::delete_branch(
                &workspace(p)?,
                require_string(p, "name")?,
                bool_or(p, "force", false),
            )),
            "rename_branch" => json_ok_svc(GitService::rename_branch(
                &workspace(p)?,
                require_string(p, "oldName")?,
                require_string(p, "newName")?,
            )),
            "merge_branch" => json_ok_svc(GitService::merge_branch(
                &workspace(p)?,
                require_string(p, "sourceBranch")?,
                bool_or(p, "noFF", false),
            )),
            "rebase_branch" => json_ok_svc(GitService::rebase_branch(
                &workspace(p)?,
                require_string(p, "sourceBranch")?,
            )),
            "rebase_abort" => json_ok_svc(GitService::rebase_abort(&workspace(p)?)),
            "rebase_continue" => json_ok_svc(GitService::rebase_continue(&workspace(p)?)),

            // ── Cherry-pick / Revert / Reset / Checkout commit ─────────
            "cherry_pick" => json_ok_svc(GitService::cherry_pick(
                &workspace(p)?,
                require_string(p, "commitSha")?,
            )),
            "cherry_pick_abort" => json_ok_svc(GitService::cherry_pick_abort(&workspace(p)?)),
            "cherry_pick_continue" => json_ok_svc(GitService::cherry_pick_continue(&workspace(p)?)),
            "revert" => json_ok_svc(GitService::revert(
                &workspace(p)?,
                require_string(p, "commitSha")?,
            )),
            "revert_abort" => json_ok_svc(GitService::revert_abort(&workspace(p)?)),
            "revert_continue" => json_ok_svc(GitService::revert_continue(&workspace(p)?)),
            "reset" => {
                let reset_mode = match require_string(p, "mode")? {
                    "soft" => ResetMode::Soft,
                    "mixed" => ResetMode::Mixed,
                    "hard" => ResetMode::Hard,
                    other => {
                        return Err(format!(
                            "Unknown reset mode: {}. Expected: soft, mixed, or hard",
                            other
                        ))
                    }
                };
                json_ok_svc(GitService::reset(
                    &workspace(p)?,
                    require_string(p, "commitSha")?,
                    reset_mode,
                ))
            }
            "checkout_commit" => json_ok_svc(GitService::checkout_commit(
                &workspace(p)?,
                require_string(p, "commitSha")?,
            )),

            // ── 标签 ───────────────────────────────────────────────────
            "get_tags" => json_ok_svc(GitService::get_tags(&workspace(p)?)),
            "create_tag" => {
                let commitish = optional_string(p, "commitish");
                let message = optional_string(p, "message");
                json_ok_svc(GitService::create_tag(
                    &workspace(p)?,
                    require_string(p, "name")?,
                    commitish.as_deref(),
                    message.as_deref(),
                ))
            }
            "delete_tag" => json_ok_svc(GitService::delete_tag(
                &workspace(p)?,
                require_string(p, "name")?,
            )),

            // ── 远程 / 推送 / 拉取 ─────────────────────────────────────
            "get_remotes" => json_ok_svc(GitService::get_remotes(&workspace(p)?)),
            "add_remote" => json_ok_svc(GitService::add_remote(
                &workspace(p)?,
                require_string(p, "name")?,
                require_string(p, "url")?,
            )),
            "remove_remote" => json_ok_svc(GitService::delete_remote(
                &workspace(p)?,
                require_string(p, "name")?,
            )),
            "detect_host" => {
                let host: GitHostType =
                    GitService::detect_git_host(require_string(p, "remoteUrl")?);
                Ok(serde_json::to_value(host)
                    .map_err(|e| format!("serialize host failed: {}", e))?)
            }
            "push_branch" => {
                let remote_branch = optional_string(p, "remoteBranchName");
                json_ok_svc(GitService::push_branch(
                    &workspace(p)?,
                    require_string(p, "branchName")?,
                    optional_string(p, "remoteName").unwrap_or_else(|| "origin".to_string()).as_str(),
                    bool_or(p, "force", false),
                    remote_branch.as_deref(),
                    // P1：force-with-lease 期望远端 sha（可选；None 时按 remote-tracking 自动对照）
                    optional_string(p, "leaseSha").as_deref(),
                ))
            }
            "push_set_upstream" => {
                let remote_branch = optional_string(p, "remoteBranchName");
                let remote = optional_string(p, "remoteName").unwrap_or_else(|| "origin".to_string());
                json_ok_svc(GitService::push_set_upstream(
                    &workspace(p)?,
                    require_string(p, "branchName")?,
                    remote.as_str(),
                    remote_branch.as_deref(),
                ))
            }
            // P1：fetch（网络写类 —— 更新 remote-tracking refs；auto-fetch 调度默认关 = 前端设置项）
            "fetch" => json_ok_svc(GitService::fetch(
                &workspace(p)?,
                optional_string(p, "remoteName").as_deref(),
                bool_or(p, "prune", false),
            )),
            "pull" => {
                let branch = optional_string(p, "branchName");
                json_ok_svc(GitService::pull(
                    &workspace(p)?,
                    optional_string(p, "remoteName").unwrap_or_else(|| "origin".to_string()).as_str(),
                    branch.as_deref(),
                ))
            }

            // ── Stash ──────────────────────────────────────────────────
            "stash_list" => json_ok_svc(GitService::stash_list(&workspace(p)?)),
            "stash_save" => {
                let msg = optional_string(p, "message");
                json_ok_svc(GitService::stash_save(
                    &workspace(p)?,
                    msg.as_deref(),
                    bool_or(p, "includeUntracked", false),
                ))
            }
            "stash_pop" => json_ok_svc(GitService::stash_pop(&workspace(p)?, opt_usize(p, "index"))),
            // P1：apply（保留 stash）与 show（读 patch —— 只读）
            "stash_apply" => json_ok_svc(GitService::stash_apply(&workspace(p)?, opt_usize(p, "index"))),
            "stash_show" => json_ok_svc(GitService::stash_show(&workspace(p)?, opt_usize(p, "index"))),
            "stash_drop" => json_ok_svc(GitService::stash_drop(
                &workspace(p)?,
                require_u64(p, "index")? as usize,
            )),

            // ── P1：amend / 搜索 / reflog ───────────────────────────────
            "amend_commit" => {
                let message = optional_string(p, "message");
                let selected = string_vec(p, "selectedFiles");
                let files_arg = if selected.is_empty() { None } else { Some(selected) };
                json_ok_svc(GitService::amend_commit(
                    &workspace(p)?,
                    message.as_deref(),
                    bool_or(p, "stageAll", false),
                    files_arg,
                ))
            }
            "search_log" => {
                let filter: LogSearchFilter = serde_json::from_value(
                    p.get("filter").cloned().unwrap_or(Value::Null),
                )
                .map_err(|e| format!("Invalid log filter: {}", e))?;
                json_ok_svc(GitService::search_log(
                    &workspace(p)?,
                    &filter,
                    opt_usize(p, "limit"),
                    opt_usize(p, "skip"),
                ))
            }
            "get_reflog" => json_ok_svc(GitService::get_reflog(
                &workspace(p)?,
                optional_string(p, "branch").as_deref(),
                opt_usize(p, "limit"),
            )),

            // ── Blame / gitignore ──────────────────────────────────────
            "blame_file" => json_ok_svc(GitService::blame_file(
                &workspace(p)?,
                require_string(p, "filePath")?,
            )),
            "get_gitignore" => json_ok_svc(GitService::get_gitignore(&workspace(p)?)),
            "save_gitignore" => json_ok_svc(GitService::save_gitignore(
                &workspace(p)?,
                require_string(p, "content")?,
            )),
            "add_to_gitignore" => {
                let rules = string_vec(p, "rules");
                json_ok_svc(GitService::add_to_gitignore(&workspace(p)?, &rules))
            }
            "get_gitignore_templates" => {
                let t = GitService::get_gitignore_templates();
                Ok(serde_json::to_value(t)
                    .map_err(|e| format!("serialize templates failed: {}", e))?)
            }

            // ── PR ─────────────────────────────────────────────────────
            "create_pr" => {
                let options: CreatePROptions = serde_json::from_value(
                    p.get("options").cloned().unwrap_or(Value::Null),
                )
                .map_err(|e| format!("Invalid PR options: {}", e))?;
                json_ok_svc(GitService::create_pr(&workspace(p)?, &options))
            }
            "get_pr_status" => json_ok_svc(GitService::get_pr_status(
                &workspace(p)?,
                require_u64(p, "prNumber")?,
            )),

            _ => {
                let _ = a;
                // KNOWN_ACTIONS 守卫已在前拦截；此臂仅兜底 match 穷尽性
                Err(format!("Unknown cap.git action: {}", action))
            }
        }
    }
}

// KNOWN_ACTIONS 与 match 分支的同步由 tests::every_known_action_is_handled 巡逻：
// 新增动作须在 KNOWN_ACTIONS 与 match 两处同改。

// ───────────────────────── 单元测试 ─────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    /// KNOWN_ACTIONS 与 invoke match 分支同步巡逻：新增动作必须同时登记两处。
    #[test]
    fn every_known_action_is_handled() {
        let mut known: Vec<&str> = KNOWN_ACTIONS.to_vec();
        let mut handled = vec![
            "is_repository", "discover_repositories", "get_status", "get_diffs",
            "get_log", "get_log_with_lanes", "get_commit_details", "get_file_history", "init_repository",
            "commit_changes", "stage_file", "unstage_file", "discard_changes",
            "batch_stage", "commit_group", "get_worktree_diff", "get_index_diff",
            "get_worktree_file_diff", "get_index_file_diff", "get_branches",
            "create_branch", "checkout_branch", "delete_branch", "rename_branch",
            "merge_branch", "rebase_branch", "rebase_abort", "rebase_continue",
            "cherry_pick", "cherry_pick_abort", "cherry_pick_continue", "revert",
            "revert_abort", "revert_continue", "reset", "checkout_commit",
            "get_tags", "create_tag", "delete_tag", "get_remotes", "add_remote",
            "remove_remote", "detect_host", "push_branch", "push_set_upstream",
            "pull", "fetch", "stash_list", "stash_save", "stash_pop", "stash_drop",
            "stash_apply", "stash_show",
            "amend_commit", "search_log", "get_reflog",
            "blame_file", "get_gitignore", "save_gitignore", "add_to_gitignore",
            "get_gitignore_templates", "create_pr", "get_pr_status",
        ];
        known.sort();
        handled.sort();
        assert_eq!(known, handled, "KNOWN_ACTIONS 与 invoke match 分支失同步 —— 新动作需两处同改");
    }

    /// alias：get_stash_list 归一为 stash_list（均为只读，不在破坏性名单）
    #[test]
    fn get_stash_list_is_alias_of_stash_list() {
        assert!(!is_destructive("stash_list"));
        assert!(!is_destructive("get_stash_list"));
    }

    /// 破坏性名单覆盖核心写域（PR-2a 矩阵前护栏）
    #[test]
    fn destructive_covers_write_domain() {
        for a in ["commit_changes", "discard_changes", "reset", "push_branch", "pull",
                  "rebase_branch", "delete_branch", "stash_drop", "init_repository",
                  "fetch", "amend_commit", "stash_apply", "commit_group"] {
            assert!(is_destructive(a), "{} 应在破坏性名单", a);
        }
        // 只读动作不在名单（新 P1 读型动作同防护）
        for a in ["get_status", "get_log", "blame_file", "stash_list", "detect_host",
                  "stash_show", "search_log", "get_reflog"] {
            assert!(!is_destructive(a), "{} 不该被拒（只读）", a);
        }
    }

    /// 错误串格式：有 details → "msg (details)"；无 → "msg"
    #[test]
    fn git_error_string_format_matches_parse_git_error() {
        let with = git_err(GitError {
            code: "CONFLICT".into(),
            message: "Merge conflicts detected".into(),
            details: Some("README.md".into()),
        });
        assert_eq!(with, "Merge conflicts detected (README.md)");

        let without = git_err(GitError {
            code: "IO".into(),
            message: "access denied".into(),
            details: None,
        });
        assert_eq!(without, "access denied");
    }

    /// require_string 缺参错误信息
    #[test]
    fn require_string_reports_key() {
        let e = require_string(&json!({}), "workspacePath").unwrap_err();
        assert!(e.contains("workspacePath"));
        assert!(require_string(&json!({ "workspacePath": "x" }), "workspacePath").is_ok());
    }
}
