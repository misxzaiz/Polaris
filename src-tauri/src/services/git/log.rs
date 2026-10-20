/*! Git 日志和 Blame 操作
 *
 * 提供提交历史查询、文件 Blame 等功能
 */

use std::path::Path;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use super::utils::CREATE_NO_WINDOW;

use git2::{DiffOptions, Oid, Repository};

use crate::models::git::{
    GitBlameLine, GitBlameResult, GitCommit, GitCommitDetails, GitCommitRef, GitFileHistoryEntry,
    GitLaneCell, GitLaneRow, GitLaneSemantic, GitLogPage, GitServiceError, LogSearchFilter,
};
use super::diff::convert_diff;
use super::executor::open_repository;
use super::lane_cache::{refs_fingerprint, LaneSemanticCache};

fn commit_to_model(commit: &git2::Commit<'_>) -> GitCommit {
    let sha = commit.id().to_string();
    GitCommit {
        sha: sha.clone(),
        short_sha: sha[..8.min(sha.len())].to_string(),
        message: commit.message().unwrap_or("").to_string(),
        author: commit.author().name().unwrap_or("").to_string(),
        author_email: commit.author().email().unwrap_or("").to_string(),
        timestamp: Some(commit.time().seconds()),
        parents: commit.parent_ids().map(|id| id.to_string()).collect(),
        refs: vec![],
    }
}

fn push_history_tip(
    repo: &Repository,
    revwalk: &mut git2::Revwalk<'_>,
    branch: Option<&str>,
) -> Result<(), GitServiceError> {
    let Some(branch_name) = branch.map(str::trim).filter(|name| !name.is_empty()) else {
        revwalk.push_head()?;
        return Ok(());
    };

    let ref_names = [
        format!("refs/heads/{}", branch_name),
        format!("refs/remotes/{}", branch_name),
    ];

    for ref_name in ref_names {
        if repo.find_reference(&ref_name).is_ok() {
            revwalk.push_ref(&ref_name)?;
            return Ok(());
        }
    }

    let object = repo
        .revparse_single(branch_name)
        .map_err(|_| GitServiceError::BranchNotFound(branch_name.to_string()))?;
    let commit = object
        .peel_to_commit()
        .map_err(|_| GitServiceError::BranchNotFound(branch_name.to_string()))?;
    revwalk.push(commit.id())?;

    Ok(())
}

/// 提交历史搜索（P1：UI 搜索 + AI-6「自然语言 → 搜索参数」编译器的动作端）
///
/// CLI 实现免费复用 git 的 grep/author/pickaxe/since 家族与分支范围（a..b / a...b），
/// 免 git2 revwalk 侧自造过滤器（裁决 5「不双实现」精神：git 已实现的不再手写）。
///
/// 参数语义：`filter` 各字段均可独立组合；`fixed_strings=true` 时用 --fixed-strings
/// （字面子串，AI-6 编译器把"包含 xx"的意图映射到该开关以避免正则注入歧义）。
pub fn search_log(
    path: &Path,
    filter: &LogSearchFilter,
    limit: Option<usize>,
    skip: Option<usize>,
) -> Result<Vec<GitCommit>, GitServiceError> {
    let limit = limit.unwrap_or(50);
    // 记录分隔符 = ASCII GS（%x1e），字段分隔符 = ASCII US（%x1f）
    // %B 为完整提交信息（可多行）——必须放在最后一个字段，按记录级切分解析
    const FORMAT: &str =
        "%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%ct%x1f%B%x1e";

    let mut args: Vec<String> = vec![
        "log".to_string(),
        format!("--format={}", FORMAT),
        "-n".to_string(),
        limit.to_string(),
    ];
    if let Some(skip_n) = skip {
        if skip_n > 0 {
            args.push(format!("--skip={}", skip_n));
        }
    }
    if filter.fixed_strings {
        args.push("--fixed-strings".to_string());
    }
    if let Some(grep) = &filter.grep {
        // -- 语法上含空格的 pattern 走 = 形式；以 '-' 开头的 pattern 前置 --grep=result
        let mut arg = "--grep=".to_string();
        arg.push_str(grep);
        args.push(arg);
    }
    if let Some(author) = &filter.author {
        args.push(format!("--author={}", author));
    }
    if let Some(pickaxe) = &filter.pickaxe {
        args.push("-S".to_string());
        args.push(pickaxe.clone());
    }
    if let Some(since) = &filter.since {
        args.push(format!("--since={}", since));
    }
    if let Some(until) = &filter.until {
        args.push(format!("--until={}", until));
    }
    if let Some(range) = &filter.range {
        args.push(range.clone());
    }
    if let Some(p) = &filter.path {
        args.push("--".to_string());
        args.push(p.clone());
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    #[cfg(windows)]
    let output = std::process::Command::new("git")
        .args(&arg_refs)
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    #[cfg(not(windows))]
    let output = std::process::Command::new("git")
        .args(&arg_refs)
        .current_dir(path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitServiceError::CLIError(stderr.to_string()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut commits = Vec::new();
    for record in stdout.split('\x1e') {
        let record = record.trim();
        if record.is_empty() {
            continue;
        }
        let parts: Vec<&str> = record.split('\x1f').collect();
        if parts.len() != 7 {
            continue;
        }
        commits.push(GitCommit {
            sha: parts[0].trim().to_string(),
            short_sha: parts[1].trim().to_string(),
            parents: parts[2]
                .split_whitespace()
                .map(String::from)
                .collect(),
            author: parts[3].trim().to_string(),
            author_email: parts[4].trim().to_string(),
            timestamp: Some(parts[5].trim().parse().unwrap_or(0)),
            message: parts[6]
                .trim_start()
                .trim_end()
                .to_string(),
            refs: vec![],
        });
    }

    Ok(commits)
}

/// 获取提交历史
pub fn get_log(    path: &Path,
    limit: Option<usize>,
    skip: Option<usize>,
    branch: Option<&str>,
) -> Result<Vec<GitCommit>, GitServiceError> {
    let repo = open_repository(path)?;
    let mut revwalk = repo.revwalk()?;

    // master-plan C6①：log 主遍历改拓扑序（Sort::TIME 与 lane 泳道拓扑序冲突，
    // 跨页重放在加权时间序下不可复现）。P2 lane 图与页 N 重放均依赖显式拓扑序。
    // 行为变化点：合并交叉处的展示顺序可能不同于旧时间序——这是裁决指定的
    // 协议级变化，前端面板不再自行重排（lane 算法直接消费本序）。
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL)?;

    push_history_tip(&repo, &mut revwalk, branch)?;

    let limit = limit.unwrap_or(50);
    let skip = skip.unwrap_or(0);

    let mut commits = Vec::new();
    for (idx, oid_result) in revwalk.enumerate() {
        if idx < skip {
            continue;
        }
        if commits.len() >= limit {
            break;
        }

        let oid = oid_result?;
        let commit = repo.find_commit(oid)?;

        commits.push(commit_to_model(&commit));
    }

    Ok(commits)
}

// ───────────────────────── P2 泳道图：refs 装饰 + lane 分配 ─────────────────────────
// 对齐 master-plan：lane 计算放 Rust 端（不放前端解析字符图）；refs 装饰与 log 同一次
// 查询返回，避免 N 次往返（PRD §2.1）。初版算法覆盖「单线主分支 + 合并分支」，
// 不做 git graph.c 的列收缩/合并（P2 增量，spec §四）。

/// 收集仓库全部 refs，按目标 commit sha 聚合为装饰（一次遍历，O(refs) 建表）
fn collect_commit_refs(repo: &Repository) -> std::collections::HashMap<String, Vec<GitCommitRef>> {
    let mut map: std::collections::HashMap<String, Vec<GitCommitRef>> = std::collections::HashMap::new();

    // HEAD 符号引用（指向当前分支）
    if let Ok(head) = repo.head() {
        if let Some(target) = head.target() {
            if let Ok(commit) = repo.find_commit(target) {
                let sha = commit.id().to_string();
                map.entry(sha).or_default().push(GitCommitRef {
                    name: "HEAD".to_string(),
                    kind: "head".to_string(),
                    target: "HEAD".to_string(),
                });
            }
        }
    }

    // 所有 refs（本地分支 / 远程分支 / tag）
    if let Ok(references) = repo.references() {
        for reference in references.flatten() {
            let Ok(obj) = reference.peel(git2::ObjectType::Commit) else {
                continue;
            };
            let sha = obj.id().to_string();

            let Some(short) = reference.shorthand() else { continue };
            let (kind, target_str) = if reference.is_tag() {
                ("tag", reference.name().unwrap_or(short).to_string())
            } else if reference
                .name()
                .is_some_and(|n| n.starts_with("refs/remotes/"))
            {
                ("remote", reference.name().unwrap_or(short).to_string())
            } else {
                ("local", reference.name().unwrap_or(short).to_string())
            };

            map.entry(sha).or_default().push(GitCommitRef {
                name: short.to_string(),
                kind: kind.to_string(),
                target: target_str,
            });
        }
    }

    map
}

/// 单行 lane 计算：给定拓扑序 commits（新→旧），分配泳道并生成格子
///
/// 简化算法（非 graph.c 四数组，覆盖「单线主分支 + 合并分支」）：
/// - 维护泳道池 `lanes: Vec<Option<String>>`，每个元素 = 该泳道「下一行应出现的 commit sha」。
/// - 对每个 commit C：
///   1. 找到 lane[i] == C.sha → C 落在此 lane；找不到 → 复用空闲 lane 或追加新 lane。
///   2. 消费 C：lanes[lane] = None；第一个父占原 lane，merge 的其余父占右侧空闲/新 lane。
///   3. 渲染：node = 本行 C 所在 lane（merge 多父 → merge 节点）；其余 lane 有等待者 → empty 贯穿线。
///   4. edge_down = 该 lane 下一行有内容（lanes[l] 有值）；merge 的其余父 lane 有 edge_up 指向 merge 节点 lane（斜线汇入）。
/// 单行 lane 计算：给定拓扑序 commits（新→旧），分配泳道并生成格子
///
/// graph.c 式收缩（P2 增量，spec `plans/git-panel-p2-lane-collapse-spec.md`）：
/// 在初版「单线 + 合并」基础上加入**列释放 + 收缩**语义：
/// - 维护 `processed: HashSet<sha>`（本页已输出的 commit）；
/// - 每行前置收缩：任何 lane 等待的 sha 已处理 → 释放为 None（消 ghost 竖线）；
/// - 父占位时，若父已处理 → 不占长期等待列（防「同一父多列等待」列泄漏）。
///
/// 行结构 / GitLaneRow 协议不变，前端零改动。
fn compute_lanes(commits: &[GitCommit]) -> Vec<GitLaneRow> {
    use std::collections::HashSet;

    let mut lanes: Vec<Option<String>> = Vec::new();
    let mut rows: Vec<GitLaneRow> = Vec::new();
    let mut processed: HashSet<String> = HashSet::new();

    for commit in commits {
        let is_merge = commit.parents.len() > 1;

        // 0. 前置收缩：等待的 commit 已处理 → 释放该列（ghost 竖线消除）
        for w in lanes.iter_mut() {
            if let Some(sha) = w {
                if processed.contains(sha) {
                    *w = None;
                }
            }
        }

        // 1. 定位 C 的泳道
        let lane = match lanes.iter().position(|w| w.as_deref() == Some(commit.sha.as_str())) {
            Some(i) => i,
            None => lanes
                .iter()
                .position(|w| w.is_none())
                .unwrap_or_else(|| {
                    lanes.push(None);
                    lanes.len() - 1
                }),
        };

        // 2. 消费 C，父提交占位
        lanes[lane] = None;
        let mut parent_lanes = vec![lane];
        for _ in 1..commit.parents.len() {
            let nl = lanes
                .iter()
                .enumerate()
                .skip(lane + 1)
                .find(|(_, w)| w.is_none())
                .map(|(i, _)| i)
                .unwrap_or_else(|| {
                    lanes.push(None);
                    lanes.len() - 1
                });
            parent_lanes.push(nl);
        }
        for (idx, p) in commit.parents.iter().enumerate() {
            if let Some(pl) = parent_lanes.get(idx) {
                // 已处理的父 → 占位后立即置 None（不占长期等待列 → 防列泄漏）
                if processed.contains(p) {
                    lanes[*pl] = None;
                } else {
                    lanes[*pl] = Some(p.clone());
                }
            }
        }

        // 3. 渲染本行
        let mut cells = Vec::new();
        for (l, lane_wait) in lanes.iter().enumerate() {
            let has_down = lane_wait.is_some();
            let node = if l == lane {
                if is_merge {
                    "merge"
                } else {
                    "commit"
                }
            } else if has_down {
                "empty"
            } else {
                "none"
            };
            cells.push(GitLaneCell {
                lane: l,
                node: node.to_string(),
                edge_down: if has_down { Some(l) } else { None },
                edge_up: None,
            });
        }
        // merge 斜线：其余父 lane 的 cell 标 edge_up → merge 节点 lane
        if is_merge {
            for &pl in parent_lanes.iter().skip(1) {
                if let Some(cell) = cells.get_mut(pl) {
                    cell.edge_up = Some(lane);
                }
            }
        }

        rows.push(GitLaneRow {
            sha: commit.sha.clone(),
            cells,
            refs: commit.refs.clone(),
        });

        processed.insert(commit.sha.clone());
    }

    rows
}

/// 泳道图分页查询：commits（含 refs 装饰）+ rows（lane 数据）同一次返回
///
/// 增量 log 缓存（spec `plans/git-panel-p2-lane-cache-spec.md`）：只缓存语义色全量
/// map（跨页共享），键 = (repo, branch, HEAD commit sha, refs 指纹)。HEAD 未变 &
/// refs 未变 → 命中缓存，语义计算从 O(可达 commit)×3 条 revwalk 降到 O(页内 commit)。
pub fn get_log_with_lanes(
    path: &Path,
    limit: Option<usize>,
    skip: Option<usize>,
    branch: Option<&str>,
) -> Result<GitLogPage, GitServiceError> {
    let repo = open_repository(path)?;
    let mut revwalk = repo.revwalk()?;

    // 拓扑序（与 get_log 同；跨页重放依赖显式拓扑序）
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL)?;
    push_history_tip(&repo, &mut revwalk, branch)?;

    let limit = limit.unwrap_or(500);
    let skip = skip.unwrap_or(0);
    let branch_name = branch.map(|b| b.trim().to_string()).filter(|b| !b.is_empty()).unwrap_or_default();

    // refs 聚合一次遍历，O(1) 按 sha 查
    let refs_map = collect_commit_refs(&repo);

    let mut commits = Vec::new();
    let mut walk_shas = Vec::new();
    for (idx, oid_result) in revwalk.enumerate() {
        if idx < skip {
            continue;
        }
        if commits.len() >= limit {
            break;
        }
        let oid = oid_result?;
        let commit = repo.find_commit(oid)?;
        let mut model = commit_to_model(&commit);
        model.refs = refs_map.get(&model.sha).cloned().unwrap_or_default();
        walk_shas.push(model.sha.clone());
        commits.push(model);
    }

    let rows = compute_lanes(&commits);

    // 增量 log 缓存：语义色按 (repo, branch, HEAD, refs 指纹) 缓存。页内按 sha 查 map，
    // 避免每次打开都重跑三条 revwalk 集合构造。配置 b"branch_name" 也纳入键（目录隔离）。
    let semantic = {
        // 分支 tip 必须独立解析（walk_shas[0] 在 skip>0（load more）时是中间 commit，非真 tip）
        let tip_sha = resolve_branch_tip(&repo, &branch_name);
        let refs_fp = refs_fingerprint(&repo);

        let cached = tip_sha.as_deref().and_then(|tip| {
            LaneSemanticCache::load(path, &branch_name, tip, &refs_fp)
        });

        if let Some(map) = cached {
            // 命中：O(页内) 查 map；缺失 sha 按 dim 保守处理（理论上不应发生）
            walk_shas
                .iter()
                .map(|sha| GitLaneSemantic {
                    kind: map.get(sha).cloned().unwrap_or_else(|| "dim".to_string()),
                })
                .collect()
        } else {
            // 未命中：计算全量 map（真 tip 出发）+ 原子写缓存
            let map = compute_semantics_full(&repo, tip_sha.as_deref());
            if let (Some(tip), refs_fp) = (tip_sha.as_deref(), &refs_fp) {
                LaneSemanticCache::store(path, &branch_name, tip, refs_fp, &map);
            }
            let semantic: Vec<GitLaneSemantic> = walk_shas
                .iter()
                .map(|sha| GitLaneSemantic {
                    kind: map.get(sha).cloned().unwrap_or_else(|| "dim".to_string()),
                })
                .collect();
            semantic
        }
    };

    Ok(GitLogPage {
        commits,
        rows,
        semantic,
    })
}

/// 独立解析「当前分支真 tip」：refs/heads/<b> > refs/remotes/<b> > revparse > HEAD。
/// 返回 None 表示解析不出（空仓库 / detached / 异常）——此时不做缓存（语义本身也退化）。
fn resolve_branch_tip(repo: &Repository, branch: &str) -> Option<String> {
    if !branch.is_empty() {
        for ref_name in [
            format!("refs/heads/{}", branch),
            format!("refs/remotes/{}", branch),
        ] {
            if let Ok(r) = repo.find_reference(&ref_name) {
                if let Some(tip) = r.target() {
                    // 分支 ref 必指向 commit（peel 防符号 ref 指向 tag）
                    if let Ok(commit) = repo.find_commit(tip) {
                        return Some(commit.id().to_string());
                    }
                }
            }
        }
    }
    // 带参数解析失败 / 无参数 → 回退 HEAD
    if let Ok(head) = repo.head() {
        if let Ok(commit) = head.peel_to_commit() {
            return Some(commit.id().to_string());
        }
    }
    None
}

/// P2 增量：语义色计算（服务端预计算，前端直接消费）
///
/// 输入三条 revwalk 可达集（每 commit O(1) 查集合）：
/// - `main_headset`：`main`（或 `master`）可达的所有 commit sha（主干历史）
/// - `remote_headset`：全部 `refs/remotes/*` 可达的 commit sha 并集（任何远程可达 = 已 push 过）
/// - `branch_headset`：当前分支 tip 可达的 commit sha（当前分支自身历史）
///
/// 判定顺序（先命中即定，spec §2.2）：
/// 1. `in main && !in branch`  → "merged"（已并入主干、当前分支不可达的历史，蓝灰）
/// 2. `in remote && !in branch` → "dim"（他分支/远程可见但当前不可达，灰暗）
/// 3. `in branch && !in remote` → "unpushed"（当前分支内、未 push 到任何远程，红）
/// 4. `in branch && in remote`  → "local"（当前分支内、已同步远程，绿）
/// 5. else                     → "dim"（孤立提交）
///
/// 单分支无远程：全部 in branch && in main && !in remote → 均判 unpushed（红，未 push）✅
/// 单分支已 push：均 local（绿）✅
///
/// 全量版本：从「当前分支真 tip」出发，对**全部可达 commit** 生成 `HashMap<sha, kind>`。
/// 这是增量 log 缓存的基础（跨页共享、与 skip 无关）。`tip_sha` 为 None（空仓库 /
/// 解析不出）时返回空 map——此时没有页内 commit，语义自然为空。
fn compute_semantics_full(
    repo: &Repository,
    tip_sha: Option<&str>,
) -> std::collections::HashMap<String, String> {
    let Some(tip_sha) = tip_sha else {
        return std::collections::HashMap::new();
    };

    // 主干分支名：main 优先，其次 master，都没有则无 merged 判定
    let main_ref = if repo.find_reference("refs/heads/main").is_ok() {
        Some("refs/heads/main")
    } else if repo.find_reference("refs/heads/master").is_ok() {
        Some("refs/heads/master")
    } else {
        None
    };

    let main_headset = main_ref
        .and_then(|r| revwalk_headset(repo, r).ok())
        .unwrap_or_default();
    let remote_headset = revwalk_remote_headset(repo);
    let branch_headset = revwalk_headset_from_tip(repo, tip_sha);

    let mut map = std::collections::HashMap::new();
    // branch_headset 即「当前分支全部可达 commit」——遍历它生成全量 map
    for sha in &branch_headset {
        let in_main = main_headset.contains(sha.as_str());
        let in_remote = remote_headset.contains(sha.as_str());
        let in_branch = true; // 本循环即 branch 可达

        let kind = if in_main && !in_branch {
            "merged"
        } else if in_remote && !in_branch {
            "dim"
        } else if in_branch && !in_remote {
            "unpushed"
        } else if in_branch && in_remote {
            "local"
        } else {
            "dim"
        };
        map.insert(sha.clone(), kind.to_string());
    }
    map
}

/// 从指定 ref 起点收集全部可达 commit sha（revwalk，拓扑序，hide 无）
fn revwalk_headset(repo: &Repository, ref_name: &str) -> Result<std::collections::HashSet<String>, GitServiceError> {
    let mut rw = repo.revwalk()?;
    rw.set_sorting(git2::Sort::TOPOLOGICAL)?;
    rw.push_ref(ref_name)?;
    let mut set = std::collections::HashSet::new();
    for oid in rw {
        set.insert(oid?.to_string());
    }
    Ok(set)
}

/// 从指定 commit sha 起点收集全部可达 commit sha（失败返回空集，不阻塞语义计算）
fn revwalk_headset_from_tip(
    repo: &Repository,
    tip_sha: &str,
) -> std::collections::HashSet<String> {
    let mut rw = match repo.revwalk() {
        Ok(rw) => rw,
        Err(_) => return std::collections::HashSet::new(),
    };
    let _ = rw.set_sorting(git2::Sort::TOPOLOGICAL);
    let oid = match git2::Oid::from_str(tip_sha) {
        Ok(oid) => oid,
        Err(_) => return std::collections::HashSet::new(),
    };
    if rw.push(oid).is_err() {
        return std::collections::HashSet::new();
    }
    rw.flatten().map(|o| o.to_string()).collect()
}

/// 全部远程 refs 可达 commit sha 的并集（`refs/remotes/*`）
fn revwalk_remote_headset(repo: &Repository) -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let Ok(references) = repo.references_glob("refs/remotes/*") else {
        return set;
    };
    for reference in references.flatten() {
        let Ok(obj) = reference.peel(git2::ObjectType::Commit) else {
            continue;
        };
        let mut rw = match repo.revwalk() {
            Ok(rw) => rw,
            Err(_) => continue,
        };
        let _ = rw.set_sorting(git2::Sort::TOPOLOGICAL);
        if rw.push(obj.id()).is_err() {
            continue;
        }
        for oid in rw.flatten() {
            set.insert(oid.to_string());
        }
    }
    set
}
pub fn get_commit_details(
    path: &Path,
    commit_sha: &str,
) -> Result<GitCommitDetails, GitServiceError> {
    let repo = open_repository(path)?;
    let commit = find_commit_by_prefix(&repo, commit_sha)?;
    let commit_tree = commit.tree()?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0)?.tree()?)
    } else {
        None
    };

    let mut diff_opts = DiffOptions::new();
    diff_opts.include_typechange(true);

    let mut diff = repo.diff_tree_to_tree(
        parent_tree.as_ref(),
        Some(&commit_tree),
        Some(&mut diff_opts),
    )?;
    diff.find_similar(None)?;

    let files = convert_diff(&repo, &diff)?;
    let total_additions = files.iter().map(|file| file.additions.unwrap_or(0)).sum();
    let total_deletions = files.iter().map(|file| file.deletions.unwrap_or(0)).sum();

    Ok(GitCommitDetails {
        commit: commit_to_model(&commit),
        files,
        total_additions,
        total_deletions,
    })
}

/// 获取单个文件的提交历史，并返回每次提交中该文件的 diff
pub fn get_file_history(
    path: &Path,
    file_path: &str,
    limit: Option<usize>,
    skip: Option<usize>,
    branch: Option<&str>,
) -> Result<Vec<GitFileHistoryEntry>, GitServiceError> {
    let repo = open_repository(path)?;
    let mut revwalk = repo.revwalk()?;

    revwalk.set_sorting(git2::Sort::TIME)?;
    push_history_tip(&repo, &mut revwalk, branch)?;

    let limit = limit.unwrap_or(50);
    let skip = skip.unwrap_or(0);
    let normalized_file_path = file_path.replace('\\', "/");

    let mut matched_count = 0usize;
    let mut entries = Vec::new();

    for oid_result in revwalk {
        if entries.len() >= limit {
            break;
        }

        let oid = oid_result?;
        let commit = repo.find_commit(oid)?;
        let commit_tree = commit.tree()?;
        let parent_tree = if commit.parent_count() > 0 {
            Some(commit.parent(0)?.tree()?)
        } else {
            None
        };

        let mut diff_opts = DiffOptions::new();
        diff_opts.include_typechange(true);
        diff_opts.pathspec(file_path);

        let mut diff = repo.diff_tree_to_tree(
            parent_tree.as_ref(),
            Some(&commit_tree),
            Some(&mut diff_opts),
        )?;
        diff.find_similar(None)?;

        let mut files = convert_diff(&repo, &diff)?;
        if files.is_empty() {
            continue;
        }

        let matching_index = files
            .iter()
            .position(|file| {
                file.file_path.replace('\\', "/") == normalized_file_path
                    || file.old_file_path
                        .as_ref()
                        .map(|old_path| old_path.replace('\\', "/") == normalized_file_path)
                        .unwrap_or(false)
            });
        let file = matching_index
            .map(|index| files.remove(index))
            .or_else(|| files.into_iter().next());

        let Some(file) = file else {
            continue;
        };

        if matched_count < skip {
            matched_count += 1;
            continue;
        }

        matched_count += 1;
        entries.push(GitFileHistoryEntry {
            commit: commit_to_model(&commit),
            file,
        });
    }

    Ok(entries)
}

fn find_commit_by_prefix<'repo>(
    repo: &'repo Repository,
    commit_sha: &str,
) -> Result<git2::Commit<'repo>, GitServiceError> {
    let trimmed = commit_sha.trim();
    if trimmed.is_empty() {
        return Err(GitServiceError::CommitNotFound(commit_sha.to_string()));
    }

    if let Ok(oid) = Oid::from_str(trimmed) {
        return repo
            .find_commit(oid)
            .map_err(|_| GitServiceError::CommitNotFound(commit_sha.to_string()));
    }

    let object = repo
        .revparse_single(trimmed)
        .or_else(|_| repo.revparse_single(&format!("{}^{{commit}}", trimmed)))
        .map_err(|_| GitServiceError::CommitNotFound(commit_sha.to_string()))?;

    object
        .peel_to_commit()
        .map_err(|_| GitServiceError::CommitNotFound(commit_sha.to_string()))
}

/// 获取文件 Blame 信息
pub fn blame_file(path: &Path, file_path: &str) -> Result<GitBlameResult, GitServiceError> {
    let repo = open_repository(path)?;

    // 获取 HEAD 提交
    let head = repo.head()?;
    let head_commit = head.peel_to_commit()?;
    let head_tree = head_commit.tree()?;

    // 查找文件
    let file_entry = head_tree.get_path(std::path::Path::new(file_path))?;
    let file_oid = file_entry.id();

    // 获取文件内容
    let blob = repo.find_blob(file_oid)?;
    let content = std::str::from_utf8(blob.content())
        .map_err(|_| GitServiceError::CLIError("File is not valid UTF-8".to_string()))?;

    // 执行 Blame
    let blame = repo.blame_file(std::path::Path::new(file_path), None)?;

    let mut lines = Vec::new();
    let mut line_number = 1;

    for line_content in content.lines() {
        // 获取该行的 Blame 信息
        let blame_hunk = blame.get_line(line_number);

        // 先获取 original_line_number
        let original_line_number = blame_hunk
            .as_ref()
            .map(|h| h.final_start_line())
            .unwrap_or(line_number);

        let (commit_sha, short_sha, author, author_email, timestamp, summary) =
            if let Some(hunk) = blame_hunk {
                let oid = hunk.final_commit_id();
                let sha = oid.to_string();
                let short = sha[..8.min(sha.len())].to_string();

                // 获取提交信息
                let commit_info = repo.find_commit(oid).ok();
                let (author_name, author_mail, time, msg) = if let Some(c) = commit_info {
                    (
                        c.author().name().unwrap_or("Unknown").to_string(),
                        c.author().email().unwrap_or("").to_string(),
                        c.time().seconds(),
                        c.summary().map(|s| s.to_string()),
                    )
                } else {
                    ("Unknown".to_string(), "".to_string(), 0, None)
                };

                (sha, short, author_name, author_mail, time, msg)
            } else {
                (
                    "unknown".to_string(),
                    "unknown".to_string(),
                    "Unknown".to_string(),
                    "".to_string(),
                    0,
                    None,
                )
            };

        lines.push(GitBlameLine {
            line_number,
            original_line_number,
            commit_sha,
            short_sha,
            author,
            author_email,
            timestamp,
            summary,
            content: line_content.to_string(),
        });

        line_number += 1;
    }

    Ok(GitBlameResult {
        file_path: file_path.to_string(),
        total_lines: lines.len(),
        lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Signature, Repository, Oid};

    /// 构造"聚合工作区"场景：
    /// - root 本身不是 git 仓库（聚合根）
    /// - root/subA 是 git 仓库且有提交（子仓库）
    fn build_multirepo_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();

        // 根目录放一个普通文件，但不初始化 git —— 模拟聚合工作区
        std::fs::write(root.join("readme.md"), "aggregate root").unwrap();

        // 子仓库 subA
        let sub = root.join("subA");
        std::fs::create_dir_all(&sub).unwrap();
        let repo = Repository::init(&sub).unwrap();

        // 两笔提交
        let sig = Signature::now("t", "t@t").unwrap();
        let commit = |repo: &Repository, content: &str| -> String {
            std::fs::write(sub.join("a.txt"), content).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("a.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let parent = if repo.head().is_ok() {
                let head = repo.head().unwrap();
                if let Some(target) = head.target() {
                    Some(repo.find_commit(target).unwrap())
                } else { None }
            } else { None };
            let parents: Vec<&git2::Commit> = parent.iter().collect();
            repo.commit(Some("refs/heads/main"), &sig, &sig, "msg", &tree, &parents).unwrap().to_string()
        };
        let _ = commit(&repo, "hello\n");
        let _ = commit(&repo, "hello\nsecond\n");

        (tmp, sub)
    }

    #[test]
    fn get_log_on_aggregate_root_fails() {
        let (tmp, _sub) = build_multirepo_fixture();
        let root = tmp.path();

        let result = get_log(root, Some(50), Some(0), None);
        assert!(result.is_err(), "非仓库的聚合根目录上 get_log 必须失败，实际: {:?}", result);
    }

    #[test]
    fn get_log_on_subrepo_returns_commits() {
        let (_tmp, sub) = build_multirepo_fixture();

        let result = get_log(&sub, Some(50), Some(0), None);
        assert!(result.is_ok(), "子仓库 get_log 应成功，实际: {:?}", result);
        let commits = result.unwrap();
        assert_eq!(commits.len(), 2, "子仓库应有 2 笔提交，实际: {:?}", commits);
    }

    // ── P2 泳道图：lane 分配 + refs 装饰 ─────────────────────────────

    /// 构造主线 + 分支 + merge 的临时仓库：
    /// A ← B ← C（master 主线三笔）→ 从 C 分叉 D ← E（feature），E merge 回 master 成 M。
    /// 拓扑（新→旧）：M(merge) → E → D → C → B → A
    ///
    /// 依赖 repo.head() 连续解析父：`Repository::init` 默认 HEAD 符号引用指向 master，
    /// 主线 commit 传 `Some("refs/heads/master")` 时 libgit2 同步更新符号 HEAD。
    /// 分支 D/E/M 用手动 parent 链（feature ref 不影响符号 HEAD，避免歧义）。
    fn build_lane_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo_path = tmp.path().to_path_buf();
        let repo = Repository::init(&repo_path).unwrap();
        let sig = Signature::now("t", "t@t").unwrap();

        // 主线 A→B→C：每次基于当前 HEAD 追加，分支 ref = master（同步符号 HEAD）
        let commit = |repo: &Repository, file: &str, content: &str, branch: &str| -> String {
            std::fs::write(repo_path.join(file), content).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new(file)).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
            let parents: Vec<&git2::Commit> = parent.iter().collect();
            repo.commit(Some(branch), &sig, &sig, content, &tree, &parents)
                .unwrap()
                .to_string()
        };

        let a = commit(&repo, "a.txt", "A", "refs/heads/master");
        let b = commit(&repo, "b.txt", "B", "refs/heads/master");
        let c = commit(&repo, "c.txt", "C", "refs/heads/master");
        let _ = (a, b);

        // 分支 feature：D(父 C) → E(父 D)，均手动 parent，feature ref 不动符号 HEAD
        let c_commit = repo.find_commit(git2::Oid::from_str(&c).unwrap()).unwrap();
        let d_oid = repo
            .commit(
                Some("refs/heads/feature"),
                &sig,
                &sig,
                "D",
                &c_commit.tree().unwrap(),
                &[&c_commit],
            )
            .unwrap();
        let d_commit = repo.find_commit(d_oid).unwrap();
        let e_oid = repo
            .commit(
                Some("refs/heads/feature"),
                &sig,
                &sig,
                "E",
                &c_commit.tree().unwrap(),
                &[&d_commit],
            )
            .unwrap();
        let e_commit = repo.find_commit(e_oid).unwrap();

        // M = merge feature 回 master（双父：C 与 E）
        let _m = repo
            .commit(
                Some("refs/heads/master"),
                &sig,
                &sig,
                "M",
                &c_commit.tree().unwrap(),
                &[&c_commit, &e_commit],
            )
            .unwrap();

        (tmp, repo_path)
    }

    #[test]
    fn get_log_with_lanes_mainline_and_merge() {
        let (_tmp, repo_path) = build_lane_fixture();
        let page = get_log_with_lanes(&repo_path, Some(50), Some(0), None).unwrap();

        // 拓扑序：M → E → D → C → B → A
        let shas: Vec<&str> = page.commits.iter().map(|c| c.message.as_str()).collect();
        assert_eq!(shas, vec!["M", "E", "D", "C", "B", "A"], "拓扑序应为 M,E,D,C,B,A");

        // rows 与 commits 一一对应
        assert_eq!(page.rows.len(), page.commits.len());

        // M 是 merge 节点：有一个 cell 标 merge，且有多于 1 个 parent lane 占位
        let m_row = page.rows.iter().find(|r| r.sha == page.commits[0].sha).unwrap();
        let merge_cells: Vec<_> = m_row.cells.iter().filter(|c| c.node == "merge").collect();
        assert_eq!(merge_cells.len(), 1, "M 应有 1 个 merge 节点 cell");

        // E 应在泳道占位（M 的 merge 第二父）
        // D 之后的 C 应回到主线泳道（edge_up 语义由斜线汇入）
        // 抽查：主线 6 行都在，row 的 sha 与 commit sha 匹配
        for (row, commit) in page.rows.iter().zip(&page.commits) {
            assert_eq!(row.sha, commit.sha);
        }
    }

    #[test]
    fn get_log_with_lanes_refs_decorations() {
        let (_tmp, repo_path) = build_lane_fixture();
        let page = get_log_with_lanes(&repo_path, Some(50), Some(0), None).unwrap();

        // main 分支 tip（C）应有本地 ref 装饰；HEAD 也应在 C（无符号 ref 时 head() 解析失败，
        // 因此只断言本地/feature ref 存在）
        let has_local_main = page.commits.iter().any(|c| {
            c.refs.iter().any(|r| r.name == "main" && r.kind == "local")
        });
        assert!(has_local_main, "main 分支应有 local ref 装饰，实际 refs: {:?}", page.commits.iter().map(|c| &c.refs).collect::<Vec<_>>());

        let has_local_feature = page.commits.iter().any(|c| {
            c.refs.iter().any(|r| r.name == "feature" && r.kind == "local")
        });
        assert!(has_local_feature, "feature 分支应有 local ref 装饰");
    }

    // ── P2 增量：语义着色 ────────────────────────────────────────────

    /// 单分支无远程仓库 → 所有提交判定 unpushed（未 push 红）
    #[test]
    fn semantic_all_unpushed_when_no_remote() {
        let (_tmp, repo_path) = build_lane_fixture();
        let page = get_log_with_lanes(&repo_path, Some(50), Some(0), None).unwrap();

        assert_eq!(page.semantic.len(), page.commits.len(), "semantic 与 commits 一一对应");
        for (i, s) in page.semantic.iter().enumerate() {
            assert_eq!(
                s.kind, "unpushed",
                "无远程仓库的提交 #{} (sha={}) 应为 unpushed，实际: {}",
                i, page.commits[i].sha, s.kind
            );
        }
    }

    /// 构造带远程的仓库：本地分支领先/落后 origin/main，语义色应区分 unpushed/merged/local
    ///
    /// 拓扑：master 主线 A←B←C；从 C 建远程 origin/master 指向 C；
    /// 继续在 master 提交 D←E（本地领先）；创建 refs/remotes/origin/feature 指向 C（他分支）；
    /// HEAD=master 可达 A..E，origin/master=C。预期：
    /// - E, D → unpushed（branch 可达、remote 不可达）
    /// - C, B, A → merged（在 main (=master=C) 可达）？—— C 是 origin/master 指向，且 B/C/A
    ///   可被 main 分支遍历；但 C 同时被 branch 可达。判定 in_main && !in_branch 才是 merged，
    ///   C/B/A 都被 branch(master) 可达 → 走 in_branch && in_remote → local（绿）。
    fn build_remote_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo_path = tmp.path().to_path_buf();
        let repo = Repository::init(&repo_path).unwrap();
        let sig = Signature::now("t", "t@t").unwrap();

        let commit = |repo: &Repository, file: &str, content: &str, branch: &str| -> String {
            std::fs::write(repo_path.join(file), content).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new(file)).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
            let parents: Vec<&git2::Commit> = parent.iter().collect();
            repo.commit(Some(branch), &sig, &sig, content, &tree, &parents)
                .unwrap()
                .to_string()
        };

        let a = commit(&repo, "a.txt", "A", "refs/heads/master");
        let b = commit(&repo, "b.txt", "B", "refs/heads/master");
        let c = commit(&repo, "c.txt", "C", "refs/heads/master");

        // origin/master 指向 C（远程同步基准）
        let c_oid = git2::Oid::from_str(&c).unwrap();
        repo.reference("refs/remotes/origin/master", c_oid, true, "remote master at C")
            .unwrap();
        // 远程他分支 origin/feature 指向 B（remote 可达但 branch 不可达 → dim 候选）
        let b_oid = git2::Oid::from_str(&b).unwrap();
        repo.reference("refs/remotes/origin/feature", b_oid, true, "remote feature at B")
            .unwrap();

        // 本地继续领先：D ← E
        let _d = commit(&repo, "d.txt", "D", "refs/heads/master");
        let _e = commit(&repo, "e.txt", "E", "refs/heads/master");
        let _ = (a, c);

        (tmp, repo_path)
    }

    /// master 主线 + 远程，语义色区分：
    /// - E, D：branch 可达 + remote 不可达 → unpushed
    /// - C, B：branch + remote 均可达（origin/master=C）→ local
    /// - A：branch 可达 + remote 不可达（A 不在 origin/master 可达集）→ unpushed
    ///   （A 在 C 之后，C 可达即 C..A 全可达，A 也应 remote 可达）→ 实际 A 也在 origin/master 可达 → local
    #[test]
    fn semantic_colors_unpushed_local() {
        let (_tmp, repo_path) = build_remote_fixture();
        let page = get_log_with_lanes(&repo_path, Some(50), Some(0), None).unwrap();

        let by_msg: std::collections::HashMap<&str, &str> = page
            .commits
            .iter()
            .zip(&page.semantic)
            .map(|(c, s)| (c.message.as_str(), s.kind.as_str()))
            .collect();

        assert_eq!(by_msg.get("E"), Some(&"unpushed"), "E 未 push");
        assert_eq!(by_msg.get("D"), Some(&"unpushed"), "D 未 push");
        assert_eq!(by_msg.get("C"), Some(&"local"), "C 已推远程 local");
        assert_eq!(by_msg.get("B"), Some(&"local"), "B 已推远程 local");
        assert_eq!(by_msg.get("A"), Some(&"local"), "A 已推远程 local");
    }

    // ── P2 增量：lane 收缩（graph.c 式列释放） ────────────────────────

    /// feature 完全合入主线后，历史 lane 应释放为 none（非 empty ghost 竖线）。
    ///
    /// build_lane_fixture 拓扑：A←B←C←feature(D←E)，M=merge(C,E)。
    /// revwalk 序 M,E,D,C,B,A。E 在 lane1（merge 第二父列）等 D；D 消费 lane1 后等 C；
    /// C 在主线 lane0 消费 → lane1 的 C 等待已被处理但本行尚未释放（C 本行渲染时 processed
    /// 尚无 C）→ C 行 lane1 是 empty；到 B 行前置收缩释放 → B/A 行 lane1 应为 none。
    #[test]
    fn lanes_shrink_after_merge_released() {
        let (_tmp, repo_path) = build_lane_fixture();
        let page = get_log_with_lanes(&repo_path, Some(50), Some(0), None).unwrap();

        let row_by_msg: std::collections::HashMap<&str, &GitLaneRow> = page
            .rows
            .iter()
            .zip(&page.commits)
            .map(|(r, c)| (c.message.as_str(), r))
            .collect();

        // E 之后主线继续，feature 历史列释放：B/A 行的 lane1 应为 none（无 ghost 竖线）
        for msg in ["B", "A"] {
            let row = row_by_msg[msg];
            let lane1 = row.cells.iter().find(|c| c.lane == 1);
            if let Some(cell) = lane1 {
                assert_eq!(
                    cell.node, "none",
                    "{} 行 lane1 应释放为 none（feature 历史列已合入），实际: {}",
                    msg, cell.node
                );
            }
        }

        // M 行的 merge 斜线语义保留：lane1（E 侧父）edge_up 指向 M 的 merge 节点 lane0
        let m_row = row_by_msg["M"];
        let m_lane = m_row
            .cells
            .iter()
            .find(|c| c.node == "merge")
            .map(|c| c.lane)
            .expect("M 行应有 merge 节点");
        let e_side = m_row.cells.iter().find(|c| c.lane == 1 && c.edge_up.is_some());
        assert!(e_side.is_some(), "M 行 lane1 应有 edge_up 汇入");

        // 列数不增长：所有行 lanes 长度 ≤ 3（active 主线 + feature + buffer），不随页累积
        let max_lanes = page.rows.iter().map(|r| r.cells.len()).max().unwrap_or(0);
        assert!(max_lanes <= 3, "列数不应超过 3（active+feature+buffer），实际: {}", max_lanes);
        let _ = m_lane;
    }
}
