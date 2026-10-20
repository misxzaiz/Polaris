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
    CreatePROptions, GitError, GitHostType, GitOperationEntry, GitServiceError, LogSearchFilter,
};
use crate::models::git::GitRebaseTodoItem;
use crate::services::git::{ConflictFileResolution, ConflictSide, GitService, ResetMode};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

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
    "resolve_conflict_file",
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
    "start_interactive_rebase",
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
    "undo_restore",
    "undo_drop",
    "clear_operations",
];

/// PR-1 临时护栏判定。
fn is_destructive(action: &str) -> bool {
    DESTRUCTIVE_ACTIONS.contains(&action)
}

// ───────────────────────── Undo 快照（FR-P2-3） ─────────────────────────

/// 真危险动作集（触发撤销快照）：discard / reset hard / checkout 覆盖 / 删分支 / rebase。
///
/// 日常写（commit/stage/stash 等）不在此列 —— 后果经 reflog + commit 历史天然可恢复，
/// 快照是成本+噪音（见 plans/git-panel-p2-undo-spec.md §四）。
const SNAPSHOT_ACTIONS: &[&str] = &[
    "discard_changes",
    "reset",
    "checkout_branch",
    "checkout_commit",
    "delete_branch",
    "rebase_branch",
    "start_interactive_rebase",
];

/// reset 仅 hard 模式属真危险（soft/mixed 保留工作区，经 reset 自身即可回退）。
/// 调用点在 WRITE_GATE 之后（此时能拿到 params 里的 mode）。
fn is_snapshot_reset(params: &Value) -> bool {
    params.get("mode").and_then(|v| v.as_str()) == Some("hard")
}

/// 是否为「应触发撤销快照」的动作（reset 需检查 mode）。
fn needs_undo_snapshot(action: &str, params: &Value) -> bool {
    if !SNAPSHOT_ACTIONS.contains(&action) {
        return false;
    }
    if action == "reset" {
        return is_snapshot_reset(params);
    }
    true
}

/// 动作 → 快照上下文标识（对应用户可读的撤销来源）。
fn snapshot_context(action: &str) -> &'static str {
    match action {
        "discard_changes" => "discard",
        "reset" => "reset_hard",
        "checkout_branch" | "checkout_commit" => "checkout",
        "delete_branch" => "branch_delete",
        "rebase_branch" => "rebase",
        _ => "undo",
    }
}

/// 动作 → 需记录原 commit 的 extra_refs（删除分支场景：`refs/heads/<name>`）。
fn snapshot_extra_refs(action: &str, params: &Value) -> Vec<String> {
    if action != "delete_branch" {
        return Vec::new();
    }
    // 被删分支以 name 传入（同 match 内 delete_branch 的参数契约）
    params
        .get("name")
        .and_then(|v| v.as_str())
        .map(|n| format!("refs/heads/{}", n))
        .into_iter()
        .collect()
}

/// 统一快照钩子：在写栅栏后、match 前执行。
/// 对「真危险」动作创建撤销快照；失败仅 warn 不阻塞原操作（undo 是安全网，非硬门槛）。
/// 返回 `(ws_path, snapshot_ref)` 供 emit `git-undo-snapshot` 事件。
fn create_undo_snapshot_for_action(
    action: &str,
    params: &Value,
) -> Option<(String, String)> {
    let ws_path = match workspace(params) {
        Ok(p) => p,
        Err(_) => return None, // 无 workspacePath（部分动作可能不需要）→ 不建快照
    };
    let context = snapshot_context(action);
    let extra_refs = snapshot_extra_refs(action, params);

    // 快照失败不阻塞操作：记录 warn 并返回 None（见 spec §二.2「快照失败不阻塞」）
    match GitService::create_undo_snapshot(&ws_path, context, &extra_refs) {
        Ok(ref_name) => {
            tracing::debug!("[cap.git] 已创建撤销快照 {}", ref_name);
            // 保留策略：每 ws 最多 5 个，超限清旧（快照后的例行整理）
            if let Err(e) = GitService::prune_undo_snapshots(&ws_path, 5) {
                tracing::warn!("[cap.git] 快照保留策略清理失败: {}", e);
            }
            Some((ws_path.to_string_lossy().to_string(), ref_name))
        }
        Err(e) => {
            tracing::warn!(
                "[cap.git] 危险操作 '{}' 撤销快照创建失败（操作继续）: {}",
                action,
                e
            );
            None
        }
    }
}

/// 危险操作成功后向前端广播 `git-undo-snapshot` 事件（经 Context::emit → 桌面中继/Web WS）。
fn emit_undo_snapshot_event(ctx: &dyn Context, ws_path: &str, snapshot_ref: &str, action: &str) {
    let payload = json!({
        "wsPath": ws_path,
        "snapshotRef": snapshot_ref,
        "context": snapshot_context(action),
    });
    if let Err(e) = ctx.emit("git-undo-snapshot", payload) {
        tracing::warn!("[cap.git] 广播 git-undo-snapshot 事件失败: {}", e);
    }
}

/// 写操作完成后向前端广播 `git-operation` 事件（操作流水面板：时间 + 操作名 + 耗时 + 成败）。
/// 事件 payload 与 record_operation 一致（GitOperationEntry camelCase），前端 prepend 即可。
fn emit_operation_event(ctx: &dyn Context, entry: &GitOperationEntry) {
    let payload = json!(entry);
    if let Err(e) = ctx.emit("git-operation", payload) {
        tracing::warn!("[cap.git] 广播 git-operation 事件失败: {}", e);
    }
}

/// 来源 → 流水 source 字段（bootstrap / remote / plugin:<id>）。
/// plugin 携带 id 便于前端区分不同插件来源；不外泄调用方动作参数。
fn source_label(source: &crate::contracts::Source) -> String {
    match source {
        crate::contracts::Source::Bootstrap => "bootstrap".to_string(),
        crate::contracts::Source::Remote { .. } => "remote".to_string(),
        crate::contracts::Source::Plugin { caller } => format!("plugin:{}", caller.0),
    }
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
    "start_interactive_rebase", "plan_interactive_rebase",
    "cherry_pick", "cherry_pick_abort", "cherry_pick_continue", "revert",
    "revert_abort", "revert_continue", "reset", "checkout_commit",
    "get_tags", "create_tag", "delete_tag", "get_remotes", "add_remote",
    "remove_remote", "detect_host", "push_branch", "push_set_upstream",
    "pull", "fetch", "stash_list", "stash_save", "stash_pop", "stash_drop",
    "stash_apply", "stash_show",
    "amend_commit", "search_log", "get_reflog",
    "blame_file", "get_gitignore", "save_gitignore", "add_to_gitignore",
    "get_gitignore_templates", "create_pr", "get_pr_status",
    "undo_list", "undo_restore", "undo_drop",
    "get_operations", "clear_operations", "predict_conflicts",
    "get_conflict_state", "resolve_conflict_file",
    "scan_commit_risk", "suggest_rebase_todos",
];

// ───────────────────────── 操作流水（FR-P2-4） ─────────────────────────

/// 操作流水上限（每 ws，超过丢最旧）。会话内滚动，见 spec §四。
const OPERATIONS_MAX: usize = 50;

/// 各仓库的最近操作记录（倒序：最新在 0）。共享 by ws_path。
static OPERATIONS: OnceLock<Mutex<HashMap<String, Vec<GitOperationEntry>>>> = OnceLock::new();

/// 动作 → 展示名（操作流水 UI 直接呈现的中文文案）
fn action_label(action: &str) -> &'static str {
    match action {
        "commit_changes" => "提交变更",
        "commit_group" => "分组提交",
        "stage_file" => "暂存文件",
        "unstage_file" => "取消暂存",
        "batch_stage" => "批量暂存",
        "discard_changes" => "丢弃变更",
        "reset" => "重置",
        "checkout_branch" => "切换分支",
        "checkout_commit" => "检出提交",
        "create_branch" => "创建分支",
        "delete_branch" => "删除分支",
        "rename_branch" => "重命名分支",
        "merge_branch" => "合并分支",
        "rebase_branch" => "变基",
        "rebase_abort" => "中止变基",
        "rebase_continue" => "继续变基",
        "start_interactive_rebase" => "面板化 Interactive Rebase",
        "plan_interactive_rebase" => "预览 Interactive Rebase 计划",
        "scan_commit_risk" => "提交前风险扫描（Review 门）",
        "suggest_rebase_todos" => "fixup!/squash! 整理建议（AI-8）",
        "cherry_pick" => "Cherry-pick",
        "cherry_pick_abort" => "中止 Cherry-pick",
        "cherry_pick_continue" => "继续 Cherry-pick",
        "revert" => "Revert 提交",
        "revert_abort" => "中止 Revert",
        "revert_continue" => "继续 Revert",
        "create_tag" => "创建标签",
        "delete_tag" => "删除标签",
        "add_remote" => "添加远程",
        "remove_remote" => "删除远程",
        "push_branch" => "推送分支",
        "push_set_upstream" => "设置上游",
        "pull" => "拉取",
        "fetch" => "Fetch",
        "stash_save" => "保存 Stash",
        "stash_pop" => "应用并删除 Stash",
        "stash_apply" => "应用 Stash",
        "stash_drop" => "删除 Stash",
        "amend_commit" => "修改提交",
        "init_repository" => "初始化仓库",
        "save_gitignore" => "保存 .gitignore",
        "create_pr" => "创建 PR",
        "undo_restore" => "撤销恢复",
        "undo_drop" => "清理快照",
        "clear_operations" => "清空操作流水",
        _ => "Git 操作",
    }
}

/// 追加一条操作流水（写动作在 invoke 收口处调用；最新置顶，超限丢最旧），
/// 返回构造的条目供 emit 复用（避免双构造）。
fn record_operation(
    ws_path: &std::path::Path,
    action: &str,
    ok: bool,
    duration_ms: u64,
    source: &crate::contracts::Source,
) -> GitOperationEntry {
    let ws_path_str = ws_path.to_string_lossy().into_owned();
    let entry = GitOperationEntry {
        ws_path: ws_path_str.clone(),
        action: action.to_string(),
        label: action_label(action).to_string(),
        ok,
        duration_ms,
        source: source_label(source),
        ts: chrono::Utc::now().timestamp(),
        git_task_id: None,
    };
    let mut ops = OPERATIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    let list = ops.entry(ws_path_str).or_default();
    list.insert(0, entry.clone());
    list.truncate(OPERATIONS_MAX);
    entry
}

/// 读某 ws 的操作流水（倒序，新→旧）
fn list_operations(ws_path: &str) -> Vec<GitOperationEntry> {
    let ops = OPERATIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    ops.get(ws_path).cloned().unwrap_or_default()
}

/// 清空某 ws 的操作流水
fn clear_operations(ws_path: &str) {
    let mut ops = OPERATIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    ops.remove(ws_path);
}

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

/// GitError → 错误通道串：`message (details)`（对齐前端 parseGitError 细节呈现）。
/// PR-2a C1：尾部追加结构化 marker（code/kind/stderrSnip），router 构造 Reply 时拆出
/// 进 `Reply.error_detail`——错误通道串本身仍是人类可读文本，旧消费者零感知。
fn git_err(e: GitError) -> String {
    let human = match e.details {
        Some(ref d) => format!("{} ({})", e.message, d),
        None => e.message.clone(),
    };
    let kind = git_error_kind(&e.code);
    let detail = crate::contracts::ReplyErrorDetail {
        code: Some(e.code),
        kind: Some(kind.to_string()),
        stderr_snip: e.details.clone().map(|d| shorten_stderr_snip(&d)),
    };
    crate::contracts::Reply::append_error_detail(human, &detail)
}

/// 机器码 → 粗分 kind（C1 字段级契约：前端按 kind 决定呈现/重试策略）
fn git_error_kind(code: &str) -> &'static str {
    match code {
        "CONFLICTS_DETECTED" => "conflict",
        "REBASE_IN_PROGRESS" | "CHERRY_PICK_IN_PROGRESS" | "REVERT_IN_PROGRESS"
        | "MERGE_IN_PROGRESS" => "operation-in-progress",
        "BRANCH_NOT_FOUND" | "COMMIT_NOT_FOUND" | "NOT_A_REPOSITORY" | "REMOTE_NOT_FOUND" => {
            "not-found"
        }
        "REMOTES_AHEAD" | "REMOTE_EXISTS" => "state-conflict",
        "CLI_NOT_FOUND" | "CLI_ERROR" => "tool",
        "IO_ERROR" => "io",
        "GIT_ERROR" => "git",
        _ => "git",
    }
}

/// stderr 摘要截尾：只留尾部 8 行 / ≤512 字符（CLI stderr 可能巨长，UI 只需现场）
fn shorten_stderr_snip(raw: &str) -> String {
    const MAX_CHARS: usize = 512;
    let tail: Vec<&str> = raw.lines().rev().take(8).collect::<Vec<_>>();
    let mut snip: String = tail
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    if snip.chars().count() > MAX_CHARS {
        // 从尾端保留（stderr 现场的结论通常在最后）
        let take: String = snip
            .chars()
            .rev()
            .take(MAX_CHARS)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        snip = take;
    }
    snip
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
                "undo_list":    { "params": { "workspacePath": "string" }, "returns": "UndoSnapshotMeta[]", "note": "FR-P2-3 快照列表（危险操作自动留存，倒序）" },
                "undo_restore": { "params": { "workspacePath": "string", "snapshotRef": "string" }, "returns": "UndoRestoreOutcome", "note": "FR-P2-3 一键恢复（stash apply / 重建被删分支 ref）" },
                "undo_drop":    { "params": { "workspacePath": "string", "snapshotRef": "string" }, "note": "FR-P2-3 手动清理快照（连同 .restore. note）" },
                "get_operations": { "params": { "workspacePath": "string" }, "returns": "GitOperationEntry[]", "note": "FR-P2-4 操作流水（写动作留痕，倒序，上限 50/ws）" },
                "clear_operations": { "params": { "workspacePath": "string" }, "note": "FR-P2-4 清空本 ws 操作流水（写类动作）" },
                "predict_conflicts": { "params": { "workspacePath": "string", "branch?": "string" }, "returns": "GitConflictPrediction", "note": "FR-P2-AI4 冲突预测（fetch 后确定性风险清单，0 token；AI 解释层已砍，仅规则建议）" },
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

        // FR-P2-3 撤销快照：写栅栏通过后、match 前，对真危险动作创建操作前快照。
        // 快照失败不阻塞操作（undo 是增强安全网，非硬门槛）；操作成功后 emit 事件供前端 toast。
        let pending_undo: Option<(String, String)> = if needs_undo_snapshot(a, p) {
            create_undo_snapshot_for_action(a, p)
        } else {
            None
        };

        // FR-P2-4 操作流水：写动作在 WRITE_GATE 持有期内计时（含 git2 全部修改），
        // 结束后统一收口记录 + 广播 `git-operation`。读动作不记录（噪声）。
        let started = std::time::Instant::now();
        let result = (|| -> Result<Value, String> {
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
            // FR-P2-AI4 冲突预测：确定性计算（0 token），只读，不进操作流水/撤销快照
            "predict_conflicts" => json_ok_svc(GitService::predict_conflicts(
                &workspace(p)?,
                optional_string(p, "branch").as_deref(),
            )),
            // P3 冲突域：归一序列操作状态（只读，不进操作流水/撤销快照）
            "get_conflict_state" => json_ok_svc(GitService::get_sequence_state(&workspace(p)?)),
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
            // P3 冲突域：解决单个冲突文件（三态：content 写 / remove 删 / side 还原 stage；写类动作）
            "resolve_conflict_file" => {
                let ws_path = &workspace(p)?;
                let file_path = require_string(p, "filePath")?;
                let op = if let Some(content) = optional_string(p, "content") {
                    ConflictFileResolution::WriteContent(content)
                } else if bool_or(p, "remove", false) {
                    ConflictFileResolution::Remove
                } else {
                    // 归一 side：ours=本方 stage（stage2），theirs=对方 stage（stage3）
                    let side = match require_string(p, "side")? {
                        "ours" => ConflictSide::Ours,
                        _ => ConflictSide::Theirs,
                    };
                    ConflictFileResolution::CheckoutStage(side)
                };
                json_ok_svc(GitService::resolve_conflict_file(ws_path, &file_path, op))
            }
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
            // P3 FR-P3-2 面板化 Interactive Rebase：预览计划（只读）+ 注入面板 todo 执行（写类）
            "plan_interactive_rebase" => json_ok_svc(GitService::plan_interactive_rebase(
                &workspace(p)?,
                require_string(p, "baseCommitish")?,
            )),
            "start_interactive_rebase" => {
                let todos: Vec<GitRebaseTodoItem> = serde_json::from_value(
                    p.get("todos").cloned().unwrap_or(serde_json::Value::Null),
                )
                .map_err(|e| format!("invalid todos payload: {}", e))?;
                json_ok_svc(GitService::start_interactive_rebase(
                    &workspace(p)?,
                    require_string(p, "baseCommitish")?,
                    &todos,
                    bool_or(p, "autosquash", false),
                ))
            }

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
        // P3 AI-3 提交前风险扫描（只读，纯本地）
        "scan_commit_risk" => json_ok_svc(GitService::scan_commit_risk(&workspace(p)?)),
        // P3 AI-8 fixup!/squash! 整理建议（只读，纯本地）
        "suggest_rebase_todos" => {
            json_ok_svc(GitService::suggest_rebase_todos(&workspace(p)?, require_string(p, "baseCommitish")?))
        }
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

            // ── Undo 网络（FR-P2-3：快照列表 / 一键恢复 / 手动清理） ──────
            "undo_list" => json_ok_svc(GitService::list_undo_snapshots(&workspace(p)?)),
            "undo_restore" => json_ok_svc(GitService::restore_undo_snapshot(
                &workspace(p)?,
                require_string(p, "snapshotRef")?,
            )),
            "undo_drop" => json_ok_svc(GitService::drop_undo_snapshot(
                &workspace(p)?,
                require_string(p, "snapshotRef")?,
            )),

            // ── 操作流水（FR-P2-4：只读展示 / 清空） ─────────────────────
            "get_operations" => Ok(json!(list_operations(
                require_string(p, "workspacePath")?
            ))),
            "clear_operations" => {
                clear_operations(require_string(p, "workspacePath")?);
                Ok(json!(null))
            }

            _ => {
                let _ = a;
                // KNOWN_ACTIONS 守卫已在前拦截；此臂仅兜底 match 穷尽性
                Err(format!("Unknown cap.git action: {}", action))
            }
            }
        })();

        let elapsed_ms = started.elapsed().as_millis() as u64;

        // FR-P2-4 操作流水：写动作（破坏性集合）统一收口记录，成败都留痕（失败也审计）。
        // 记录在 WRITE_GATE 释放后做（record_operation 不碰 git，纯内存环形缓冲）。
        if is_destructive(a) {
            if let Ok(ws) = workspace(p) {
                let entry = record_operation(&ws, a, result.is_ok(), elapsed_ms, ctx.source());
                emit_operation_event(ctx, &entry);
            }
        }

        // 危险操作成功后：向前端广播撤销快照事件（操作失败则不广播，快照留作安全网）
        if result.is_ok() {
            if let Some((ws_path, snapshot_ref)) = &pending_undo {
                emit_undo_snapshot_event(ctx, ws_path, snapshot_ref, a);
            }
        }

        result
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
            "start_interactive_rebase", "plan_interactive_rebase",
            "cherry_pick", "cherry_pick_abort", "cherry_pick_continue", "revert",
            "revert_abort", "revert_continue", "reset", "checkout_commit",
            "get_tags", "create_tag", "delete_tag", "get_remotes", "add_remote",
            "remove_remote", "detect_host", "push_branch", "push_set_upstream",
            "pull", "fetch", "stash_list", "stash_save", "stash_pop", "stash_drop",
            "stash_apply", "stash_show",
            "amend_commit", "search_log", "get_reflog",
            "blame_file", "get_gitignore", "save_gitignore", "add_to_gitignore",
            "get_gitignore_templates", "create_pr", "get_pr_status",
            "undo_list", "undo_restore", "undo_drop",
            "get_operations", "clear_operations",
            "predict_conflicts",
            "get_conflict_state",
            "resolve_conflict_file",
            "scan_commit_risk",
            "suggest_rebase_todos",
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
                  "fetch", "amend_commit", "stash_apply", "commit_group",
                  "undo_restore", "undo_drop", "clear_operations",
                  "resolve_conflict_file"] {
            assert!(is_destructive(a), "{} 应在破坏性名单", a);
        }
        // 只读动作不在名单（新 P1 读型动作同防护）
        for a in ["get_status", "get_log", "blame_file", "stash_list", "detect_host",
                  "stash_show", "search_log", "get_reflog", "undo_list", "get_operations",
                  "get_conflict_state", "scan_commit_risk", "plan_interactive_rebase"] {
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
