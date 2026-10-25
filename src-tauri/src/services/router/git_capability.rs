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
use std::sync::{LazyLock, Mutex, OnceLock};

/// 能力 id
pub const GIT_CAP_ID: &str = "cap.git";

/// 写路径全局栅栏（master-plan 裁决 8：读无限并发 + 写 max=1）。
///
/// git2 的 index/repo 内部锁文件（index.lock etc.）不可并发写 —— 并行两次
/// commit/stage 会以 index.lock 冲突失写。旧命令层在 UI 单入口下无此问题，
/// 上总线后多入口（双面板 + AI + Web）必须串行写。
///
/// PR-2a B2（欠账清偿）：由裸 Mutex 升级为 **FIFO 票号队列闸**（polaris-gate-queue）。
/// 差异：OS mutex 不保证排队顺序（多入口竞争时后到可先得），票号轮转先到先得；
/// 队列深度可观测（pending()）。取消分级语义（PR-2a）：写动作已提交 git2 修改
/// 后不可安全半途杀（index.lock/引用文件撕裂）——取消仅承诺"排队中未开始"的
/// 任务可撤单，执行中的写必须完成或失败，读动作不承诺即时取消。此语义为
/// 文档级约定，前端取消入口（UI 卡片）后续接线。
static WRITE_GATE: LazyLock<polaris_gate_queue::WriteGate> =
    LazyLock::new(polaris_gate_queue::WriteGate::new);

/// PR-1 临时护栏：插件来源禁止的实施性（写/破坏性）动作集。
/// 完整矩阵（按动作细分 allow/deny + Remote token 分级）PR-2a 落地后替换本表。
const DESTRUCTIVE_ACTIONS: &[&str] = &[
    "commit_changes",
    "stage_file",
    "resolve_conflict_file",
    "unstage_file",
    "batch_stage",
    "batch_unstage",
    "batch_discard",
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
    "batch_discard",
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
        "discard_changes" | "batch_discard" => "discard",
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
    "batch_stage", "batch_unstage", "batch_discard", "commit_group", "get_worktree_diff", "get_index_diff",
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

/// 未知动作自纠文案（contracts::unsupported_action，错误即文档）：列出
/// KNOWN_ACTIONS 全集 + stash_list 别名，并指向 cap.help 发现入口——AI 按文案
/// 即可自纠，不再出现「仅回显非法动作名、合法动作无处可查」（2026-10-25 审计）。
fn unsupported_git_action(action: &str) -> String {
    let mut supported: Vec<&str> = KNOWN_ACTIONS.to_vec();
    // 别名：invoke 在 match 前归一 get_stash_list → stash_list（合法拼写）
    supported.push("get_stash_list");
    crate::contracts::unsupported_action(GIT_CAP_ID, action, &supported)
}

// ───────────────────────── 操作流水（FR-P2-4） ─────────────────────────

/// 操作流水上限（每 ws，超过丢最旧）。会话内滚动，见 spec §四。
const OPERATIONS_MAX: usize = 50;

/// 各仓库的最近操作记录（倒序：最新在 0）。共享 by ws_path。
static OPERATIONS: OnceLock<Mutex<HashMap<String, Vec<GitOperationEntry>>>> = OnceLock::new();

/// 动作 → 中文展示名（双消费方：操作流水 UI 文案 + `describe_actions()` 每动作
/// 中文名——2026-10-25 审计：中文名此前不经 describe 暴露，故本表须覆盖
/// KNOWN_ACTIONS 全集；漏登动作在 describe 中落 `_` 兜底并由 describe_contract
/// 测试点名）。
fn action_label(action: &str) -> &'static str {
    match action {
        "commit_changes" => "提交变更",
        "commit_group" => "分组提交",
        "stage_file" => "暂存文件",
        "unstage_file" => "取消暂存",
        "batch_stage" => "批量暂存",
        "batch_unstage" => "批量取消暂存",
        "batch_discard" => "批量丢弃变更",
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
        // ── 只读/查询动作（describe 中文说明用；操作流水只记写动作，故此前未列） ──
        "is_repository" => "是否 Git 仓库",
        "discover_repositories" => "发现嵌套仓库",
        "get_status" => "读取仓库状态",
        "get_diffs" => "提交间差异",
        "get_log" => "提交日志",
        "get_log_with_lanes" => "泳道日志",
        "get_commit_details" => "提交详情",
        "get_file_history" => "文件历史",
        "get_worktree_diff" => "工作区差异",
        "get_index_diff" => "暂存区差异",
        "get_worktree_file_diff" => "工作区单文件差异",
        "get_index_file_diff" => "暂存区单文件差异",
        "get_branches" => "分支列表",
        "get_tags" => "标签列表",
        "get_remotes" => "远程列表",
        "detect_host" => "识别 Git 托管主机",
        "stash_list" => "Stash 列表",
        "stash_show" => "查看 Stash 内容",
        "search_log" => "搜索提交历史",
        "get_reflog" => "Reflog",
        "blame_file" => "文件 Blame",
        "get_gitignore" => "读取 .gitignore",
        "add_to_gitignore" => "追加 .gitignore 规则",
        "get_gitignore_templates" => ".gitignore 模板",
        "get_pr_status" => "PR 状态",
        "undo_list" => "撤销快照列表",
        "get_operations" => "操作流水",
        "predict_conflicts" => "冲突预测",
        "get_conflict_state" => "冲突/序列状态",
        "resolve_conflict_file" => "解决冲突文件",
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

// （describe 协议生成的模块级 helper：PLUGIN_DENY_NOTE / action_docs /
// describe_actions / unsupported_git_action —— trait impl 只能含 trait 条目，
// 故置于 struct 之前。）

/// 写类动作的统一 Plugin 拒绝提示（describe 每个破坏性动作的 note；审计：此前仅
/// stage_file 有 note，同为 DESTRUCTIVE_ACTIONS 的 commit_changes/undo_restore/
/// undo_drop/clear_operations 无——经 cap_list 读 describe 的 AI 会误以为可调）。
const PLUGIN_DENY_NOTE: &str = "写类动作：Plugin（AI/插件）来源一律拒绝（PR-2a 权限矩阵落地前临时护栏）；仅本地面板（Bootstrap/Remote）可调，AI 无「确认后重试」通道";

/// 动作 → (params, returns) 协议说明（describe 精化表，键 = KNOWN_ACTIONS 成员）。
///
/// - 参数键名与 invoke match 臂的 require_string / optional_string / bool_or /
///   opt_usize / string_vec 提取一一对应（必填直书，可选 `?` 后缀并附缺省值）；
/// - returns 为 GitService 签名返回值的 serde 序列化结果（camelCase；`()` → null）；
/// - 兜底臂：KNOWN_ACTIONS 新动作漏登本表时仍以通用条目全量出现在 describe
///   （不漂移丢动作），由 describe_contract 测试与代码评审补精化。
fn action_docs(action: &str) -> (Value, &'static str) {
    let ws = "string（git 仓库目录绝对路径，必填）";
    match action {
        // ── 状态 / 只读 ─────────────────────────────────────────────
        "is_repository" => (
            json!({ "workspacePath": ws }),
            "bool（是否 git 仓库，裸 bool）",
        ),
        "discover_repositories" => (
            json!({
                "workspacePath": "string（搜索根目录绝对路径，必填）",
                "maxDepth?": "number（递归深度，默认 4）"
            }),
            "GitDiscoveredRepo[]（嵌套仓库清单，聚合工作区场景）",
        ),
        "get_status" => (
            json!({ "workspacePath": ws }),
            "GitRepositoryStatus（camelCase：分支/暂存/未暂存/冲突清单等）",
        ),
        "predict_conflicts" => (
            json!({ "workspacePath": ws, "branch?": "string（目标分支，缺省当前）" }),
            "GitConflictPrediction（确定性规则冲突风险清单，0 token，只读）",
        ),
        "get_conflict_state" => (
            json!({ "workspacePath": ws }),
            "GitSequenceState（merge/rebase/cherry-pick/revert 归一状态 + 冲突条目）",
        ),
        "get_diffs" => (
            json!({
                "workspacePath": ws,
                "baseCommit": "string（必填，基准提交）",
                "compareTo?": "string（缺省 = HEAD vs baseCommit；显式传入 = 任意两提交 tree-to-tree 对比）"
            }),
            "GitDiffEntry[]",
        ),
        "get_log" => (
            json!({
                "workspacePath": ws,
                "limit?": "number（默认 50）",
                "maxCount?": "number（limit 别名，旧前端兼容）",
                "skip?": "number",
                "branch?": "string"
            }),
            "GitCommit[]（裸数组）",
        ),
        "get_log_with_lanes" => (
            json!({
                "workspacePath": ws,
                "limit?": "number（默认 500）",
                "maxCount?": "number（limit 别名，旧前端兼容）",
                "skip?": "number",
                "branch?": "string"
            }),
            "GitLogPage（commits 含 refs 装饰 + rows 泳道数据）",
        ),
        "get_commit_details" => (
            json!({ "workspacePath": ws, "commitSha": "string（必填）" }),
            "GitCommitDetails（{ commit, files, totalAdditions, totalDeletions }）",
        ),
        "get_file_history" => (
            json!({
                "workspacePath": ws,
                "filePath": "string（必填）",
                "limit?": "number（默认 50）",
                "skip?": "number",
                "branch?": "string"
            }),
            "GitFileHistoryEntry[]（{ commit, file } 条目）",
        ),

        // ── 仓库初始化 ─────────────────────────────────────────────
        "init_repository" => (
            json!({ "workspacePath": ws, "initialBranch?": "string" }),
            "string（初始化结果信息）",
        ),

        // ── 提交 / 暂存 ────────────────────────────────────────────
        "commit_changes" => (
            json!({
                "workspacePath": ws,
                "message": "string（必填，提交信息）",
                "stageAll?": "bool（默认 false，暂存全部后提交）",
                "selectedFiles?": "string[]（指定提交的文件清单）"
            }),
            "string（新提交 sha）",
        ),
        "stage_file" => (
            json!({ "workspacePath": ws, "filePath": "string（必填）" }),
            "null（成功无载荷）",
        ),
        "resolve_conflict_file" => (
            json!({
                "workspacePath": ws,
                "filePath": "string（必填，冲突文件）",
                "content?": "string（写入内容；与 remove/side 三态互斥）",
                "remove?": "bool（true = 删除该文件）",
                "side?": "string（\"ours\"|\"theirs\"，还原对应侧 stage；缺省 theirs）"
            }),
            "null（解决后直落 staging）",
        ),
        "unstage_file" => (
            json!({ "workspacePath": ws, "filePath": "string（必填）" }),
            "null（成功无载荷）",
        ),
        "discard_changes" => (
            json!({ "workspacePath": ws, "filePath": "string（必填）" }),
            "null（丢弃该文件工作区变更）",
        ),
        "batch_stage" => (
            json!({ "workspacePath": ws, "filePaths": "string[]（必填）" }),
            "BatchStageResult",
        ),
        "batch_unstage" => (
            json!({ "workspacePath": ws, "filePaths": "string[]（必填）" }),
            "BatchOpResult",
        ),
        "batch_discard" => (
            json!({ "workspacePath": ws, "filePaths": "string[]（必填）" }),
            "BatchOpResult",
        ),
        "commit_group" => (
            json!({
                "workspacePath": ws,
                "message": "string（必填）",
                "files": "string[]（必填且非空，组内文件清单）"
            }),
            "string（新提交 sha；只提交组内文件，index 其它已暂存内容不受影响）",
        ),

        // ── Diff ───────────────────────────────────────────────────
        "get_worktree_diff" => (
            json!({ "workspacePath": ws }),
            "GitDiffEntry[]（工作区变更）",
        ),
        "get_index_diff" => (
            json!({ "workspacePath": ws }),
            "GitDiffEntry[]（暂存区变更）",
        ),
        "get_worktree_file_diff" => (
            json!({ "workspacePath": ws, "filePath": "string（必填）" }),
            "GitDiffEntry（单文件工作区差异）",
        ),
        "get_index_file_diff" => (
            json!({ "workspacePath": ws, "filePath": "string（必填）" }),
            "GitDiffEntry（单文件暂存差异）",
        ),

        // ── 分支 ───────────────────────────────────────────────────
        "get_branches" => (json!({ "workspacePath": ws }), "GitBranch[]"),
        "create_branch" => (
            json!({
                "workspacePath": ws,
                "name": "string（必填）",
                "checkout?": "bool（默认 false，创建后立即切换）",
                "startPoint?": "string（起点 commitish，缺省 HEAD）"
            }),
            "null（成功无载荷）",
        ),
        "checkout_branch" => (
            json!({ "workspacePath": ws, "name": "string（必填）" }),
            "null（成功无载荷）",
        ),
        "delete_branch" => (
            json!({ "workspacePath": ws, "name": "string（必填）", "force?": "bool（默认 false，强删未合并分支）" }),
            "null（成功无载荷；删除前自动留撤销快照）",
        ),
        "rename_branch" => (
            json!({ "workspacePath": ws, "oldName": "string（必填）", "newName": "string（必填）" }),
            "null（成功无载荷）",
        ),
        "merge_branch" => (
            json!({ "workspacePath": ws, "sourceBranch": "string（必填）", "noFF?": "bool（默认 false）" }),
            "GitMergeResult（冲突时 Err 带 CONFLICTS_DETECTED 结构化码）",
        ),
        "rebase_branch" => (
            json!({ "workspacePath": ws, "sourceBranch": "string（必填）" }),
            "GitRebaseResult（变基前自动留撤销快照）",
        ),
        "rebase_abort" => (
            json!({ "workspacePath": ws }),
            "null（中止进行中的 rebase）",
        ),
        "rebase_continue" => (json!({ "workspacePath": ws }), "GitRebaseResult"),
        "plan_interactive_rebase" => (
            json!({ "workspacePath": ws, "baseCommitish": "string（必填）" }),
            "GitRebasePlan（只读预览，不落盘）",
        ),
        "start_interactive_rebase" => (
            json!({
                "workspacePath": ws,
                "baseCommitish": "string（必填）",
                "todos": "GitRebaseTodoItem[]（面板 todo 序列，必填）",
                "autosquash?": "bool（默认 false）"
            }),
            "GitRebaseResult（GIT_SEQUENCE_EDITOR 注入面板 todo 执行）",
        ),

        // ── Cherry-pick / Revert / Reset / Checkout commit ─────────
        "cherry_pick" => (
            json!({ "workspacePath": ws, "commitSha": "string（必填）" }),
            "GitCherryPickResult",
        ),
        "cherry_pick_abort" => (
            json!({ "workspacePath": ws }),
            "null（中止进行中的 cherry-pick）",
        ),
        "cherry_pick_continue" => (json!({ "workspacePath": ws }), "GitCherryPickResult"),
        "revert" => (
            json!({ "workspacePath": ws, "commitSha": "string（必填）" }),
            "GitRevertResult",
        ),
        "revert_abort" => (
            json!({ "workspacePath": ws }),
            "null（中止进行中的 revert）",
        ),
        "revert_continue" => (json!({ "workspacePath": ws }), "GitRevertResult"),
        "reset" => (
            json!({
                "workspacePath": ws,
                "commitSha": "string（必填）",
                "mode": "string（必填：\"soft\"|\"mixed\"|\"hard\"；非法值报 Unknown reset mode 并列出合法值）"
            }),
            "null（成功无载荷；hard 模式自动留撤销快照）",
        ),
        "checkout_commit" => (
            json!({ "workspacePath": ws, "commitSha": "string（必填）" }),
            "null（进入 detached HEAD）",
        ),

        // ── 标签 ───────────────────────────────────────────────────
        "get_tags" => (json!({ "workspacePath": ws }), "GitTag[]"),
        "create_tag" => (
            json!({
                "workspacePath": ws,
                "name": "string（必填）",
                "commitish?": "string（打标对象，缺省 HEAD）",
                "message?": "string（附注信息）"
            }),
            "GitTag",
        ),
        "delete_tag" => (
            json!({ "workspacePath": ws, "name": "string（必填）" }),
            "null（成功无载荷）",
        ),

        // ── 远程 / 推送 / 拉取 ─────────────────────────────────────
        "get_remotes" => (json!({ "workspacePath": ws }), "GitRemote[]"),
        "add_remote" => (
            json!({ "workspacePath": ws, "name": "string（必填）", "url": "string（必填）" }),
            "GitRemote",
        ),
        "remove_remote" => (
            json!({ "workspacePath": ws, "name": "string（必填）" }),
            "null（成功无载荷）",
        ),
        "detect_host" => (
            json!({ "remoteUrl": "string（必填；本动作无 workspacePath）" }),
            "GitHostType（裸字符串值）",
        ),
        "push_branch" => (
            json!({
                "workspacePath": ws,
                "branchName": "string（必填）",
                "remoteName?": "string（默认 \"origin\"）",
                "force?": "bool（默认 false）",
                "remoteBranchName?": "string（远端分支名，缺省同名）",
                "leaseSha?": "string（force-with-lease 期望远端 sha；缺省按 remote-tracking 自动对照）"
            }),
            "null（成功无载荷）",
        ),
        "push_set_upstream" => (
            json!({
                "workspacePath": ws,
                "branchName": "string（必填）",
                "remoteName?": "string（默认 \"origin\"）",
                "remoteBranchName?": "string"
            }),
            "null（成功无载荷）",
        ),
        "pull" => (
            json!({
                "workspacePath": ws,
                "remoteName?": "string（默认 \"origin\"）",
                "branchName?": "string"
            }),
            "GitPullResult",
        ),
        "fetch" => (
            json!({ "workspacePath": ws, "remoteName?": "string", "prune?": "bool（默认 false，清理已删远端分支引用）" }),
            "string（fetch 结果摘要）",
        ),

        // ── Stash ──────────────────────────────────────────────────
        "stash_list" => (json!({ "workspacePath": ws }), "GitStashEntry[]"),
        "stash_save" => (
            json!({
                "workspacePath": ws,
                "message?": "string（stash 描述）",
                "includeUntracked?": "bool（默认 false，含未跟踪文件）"
            }),
            "string（stash 标识）",
        ),
        "stash_pop" => (
            json!({ "workspacePath": ws, "index?": "number（缺省最近一条）" }),
            "null（应用并删除该 stash）",
        ),
        "stash_apply" => (
            json!({ "workspacePath": ws, "index?": "number（缺省最近一条）" }),
            "null（应用但保留 stash）",
        ),
        "stash_drop" => (
            json!({ "workspacePath": ws, "index": "number（必填）" }),
            "null（成功无载荷）",
        ),
        "stash_show" => (
            json!({ "workspacePath": ws, "index?": "number（缺省最近一条）" }),
            "string（stash patch 文本）",
        ),

        // ── Amend / 搜索 / Reflog ──────────────────────────────────
        "amend_commit" => (
            json!({
                "workspacePath": ws,
                "message?": "string（缺省沿用原提交信息）",
                "stageAll?": "bool（默认 false）",
                "selectedFiles?": "string[]（追加暂存的文件清单）"
            }),
            "string（amend 后提交 sha）",
        ),
        "search_log" => (
            json!({
                "workspacePath": ws,
                "filter": "LogSearchFilter（必填对象：fixedStrings bool 必填；可选 grep/author/pickaxe/path/since/until/range）",
                "limit?": "number（默认 50）",
                "skip?": "number"
            }),
            "GitCommit[]（裸数组，作者/消息/路径组合检索）",
        ),
        "get_reflog" => (
            json!({ "workspacePath": ws, "branch?": "string", "limit?": "number" }),
            "GitReflogEntry[]",
        ),

        // ── Blame / gitignore ──────────────────────────────────────
        "blame_file" => (
            json!({ "workspacePath": ws, "filePath": "string（必填）" }),
            "GitBlameResult",
        ),
        "get_gitignore" => (json!({ "workspacePath": ws }), "GitIgnoreResult"),
        "save_gitignore" => (
            json!({ "workspacePath": ws, "content": "string（必填，整份文件内容）" }),
            "null（成功无载荷）",
        ),
        "add_to_gitignore" => (
            json!({ "workspacePath": ws, "rules": "string[]（必填，追加规则）" }),
            "null（成功无载荷）",
        ),
        "get_gitignore_templates" => (json!({}), "GitIgnoreTemplate[]（内置模板清单，无参数）"),

        // ── PR ─────────────────────────────────────────────────────
        "create_pr" => (
            json!({ "workspacePath": ws, "options": "CreatePROptions（必填对象）" }),
            "PullRequest",
        ),
        "get_pr_status" => (
            json!({ "workspacePath": ws, "prNumber": "number（必填）" }),
            "PullRequest",
        ),

        // ── Undo 快照 / 操作流水 ───────────────────────────────────
        "undo_list" => (
            json!({ "workspacePath": ws }),
            "UndoSnapshotMeta[]（危险操作自动留存的快照，倒序）",
        ),
        "undo_restore" => (
            json!({ "workspacePath": ws, "snapshotRef": "string（必填）" }),
            "UndoRestoreOutcome（stash apply / 重建被删分支 ref）",
        ),
        "undo_drop" => (
            json!({ "workspacePath": ws, "snapshotRef": "string（必填）" }),
            "null（连同 .restore. note 一并清理）",
        ),
        "get_operations" => (
            json!({ "workspacePath": ws }),
            "GitOperationEntry[]（写动作流水，倒序，每 ws 上限 50）",
        ),
        "clear_operations" => (json!({ "workspacePath": ws }), "null（清空本 ws 流水）"),

        // ── P3 提交风险 / 整理建议 ─────────────────────────────────
        "scan_commit_risk" => (
            json!({ "workspacePath": ws }),
            "GitCommitRiskReport（提交前风险扫描，只读纯本地）",
        ),
        "suggest_rebase_todos" => (
            json!({ "workspacePath": ws, "baseCommitish": "string（必填）" }),
            "GitRebaseSuggestion（fixup!/squash! 整理建议）",
        ),

        // 兜底：新动作漏登精化表时的通用条目（describe 仍全量出现，不丢动作）
        _ => (
            json!({ "workspacePath": ws }),
            "GitService 返回值的 camelCase JSON 序列化",
        ),
    }
}

/// describe actions 全量生成（单一来源，杜绝手写第二份动作清单——2026-10-25 审计：
/// 旧 describe 仅 12/77 动作 + "..." 占位）：动作键取 KNOWN_ACTIONS（与 invoke
/// match 由 every_known_action_is_handled 巡逻同源），中文说明取 action_label，
/// 参数/返回取 action_docs，写类动作统一加 Plugin 拒绝 note。常量加动作，
/// describe / 未知动作报错自动跟随。
fn describe_actions() -> Value {
    let mut actions = serde_json::Map::new();
    for a in KNOWN_ACTIONS {
        let (params, returns) = action_docs(a);
        let mut spec = serde_json::Map::new();
        spec.insert("label".into(), json!(action_label(a)));
        spec.insert("params".into(), params);
        spec.insert("returns".into(), json!(returns));
        if is_destructive(a) {
            spec.insert("note".into(), json!(PLUGIN_DENY_NOTE));
        }
        actions.insert((*a).to_string(), Value::Object(spec));
    }
    Value::Object(actions)
}

pub struct GitCapability;

impl Capability for GitCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(GIT_CAP_ID.to_string())
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }

    fn describe(&self) -> Value {
        // 2026-10-25 审计归一：summary 不再指向 plans/git-panel-p0-spec.md（AI 经
        // MCP 无该文件读取通道，且该文件并无动作清单——指针双向断裂）；全量动作
        // 清单即本 describe 的 actions（与 KNOWN_ACTIONS 常量同源生成，加动作自动跟随）。
        let summary = format!(
            "Git 仓库域唯一动作入口：{} 个动作覆盖仓库发现/状态/差异/日志/分支/标签/远程/stash/blame/撤销快照/冲突域的读写；action = 去 git_ 前缀命令名，camelCase 参数原样透传（全量清单即 actions，与源码 KNOWN_ACTIONS 同源）",
            KNOWN_ACTIONS.len()
        );
        crate::contracts::standard_describe(
            GIT_CAP_ID,
            "Git 仓库域",
            &summary,
            Some(
                "直调 GitService（命令层已整域摘除）；workspacePath 为 git 仓库目录绝对路径（无需在 Polaris 注册）。写路径经 polaris-gate-queue FIFO 队列闸（写 max=1，票号公平）；取消分级：排队未开始可撤单（前端入口未接线），执行中的写不承诺半途取消。错误通道带结构化 marker（router 拆包进 Reply.errorDetail）。标注「写类动作」的动作对 Plugin（AI/插件）来源一律拒绝（不存在确认后重试通道），仅本地面板（Bootstrap/Remote）可调。",
            ),
            describe_actions(),
        )
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
            // 错误即文档：列出合法动作全集 + cap.help 发现入口（AI 可据文案自纠）
            return Err(unsupported_git_action(&action));
        }

        // 写 max=1（裁决 8）：破坏性（写类）动作全局 FIFO 串联，读动作不受影响。
        // 生命周期覆盖整个动作调用 —— 含 GitService 内部的全部 git2 修改。
        // PR-2a B2：take 票号排队（FIFO），guard drop 放行下一票；取消语义见 WRITE_GATE doc注释。
        let _write_guard: Option<polaris_gate_queue::WriteGuard<'_>> = if is_destructive(a) {
            Some(WRITE_GATE.acquire())
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
            // compareTo 显式传入 = 任意两提交 tree-to-tree 对比；缺省 = HEAD vs base（旧语义）
            "get_diffs" => json_ok_svc(GitService::get_diff(
                &workspace(p)?,
                require_string(p, "baseCommit")?,
                optional_string(p, "compareTo").as_deref(),
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
            "batch_unstage" => {
                let files = string_vec(p, "filePaths");
                json_ok_svc(GitService::batch_unstage(&workspace(p)?, &files))
            }
            "batch_discard" => {
                let files = string_vec(p, "filePaths");
                json_ok_svc(GitService::batch_discard(&workspace(p)?, &files))
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
                Err(unsupported_git_action(&action))
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
            "batch_stage", "batch_unstage", "batch_discard", "commit_group", "get_worktree_diff", "get_index_diff",
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

    /// describe 契约巡逻（2026-10-25 审计）：standard_describe 标准形状
    /// （validate_describe 零违例）+ 动作键与 KNOWN_ACTIONS 全集一致
    /// （全量化：多一个幽灵动作 / 少一个漏登都失败，杜绝 "..." 占位）。
    #[test]
    fn describe_contract() {
        let d = GitCapability.describe();
        let problems = crate::contracts::validate_describe(GIT_CAP_ID, &d);
        assert!(problems.is_empty(), "describe 契约违例: {problems:?}");

        let actions = d.get("actions").and_then(|v| v.as_object()).unwrap();
        let mut declared: Vec<&str> = actions.keys().map(String::as_str).collect();
        declared.sort_unstable();
        let mut known = KNOWN_ACTIONS.to_vec();
        known.sort_unstable();
        assert_eq!(declared, known, "describe actions 与 KNOWN_ACTIONS 失同步");

        // 每动作：中文说明非空（不落 action_label 兜底）；写类动作必带 Plugin 拒绝 note
        for a in KNOWN_ACTIONS {
            let spec = &actions[*a];
            assert!(
                !spec["label"].as_str().unwrap_or_default().is_empty(),
                "动作 {a} 缺中文说明"
            );
            assert!(spec["params"].is_object(), "动作 {a} params 非对象");
            assert!(spec["returns"].is_string(), "动作 {a} returns 非字符串");
            if is_destructive(a) {
                let note = spec["note"].as_str().unwrap_or_default();
                assert!(note.contains("Plugin"), "写类动作 {a} 缺 Plugin 拒绝 note");
            }
        }
    }

    /// 未知动作错误文案可自纠：列出合法动作（含 stash_list 别名）+ cap.help 发现入口。
    /// 用审计点名的幽灵动作 diff 作反例（KNOWN_ACTIONS 无裸 diff，只有 get_diffs 家族）。
    #[test]
    fn unsupported_action_lists_known_actions_and_help_entry() {
        let msg = unsupported_git_action("diff");
        assert!(msg.contains("不支持动作: diff"), "实际: {msg}");
        assert!(msg.contains("get_diffs"), "实际: {msg}");
        assert!(msg.contains("get_stash_list"), "别名也应列出，实际: {msg}");
        assert!(msg.contains("cap.help show target=cap.git"), "实际: {msg}");
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
