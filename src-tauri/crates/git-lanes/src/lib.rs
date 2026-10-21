//! polaris-git-lanes — git 面板泳道图 lane 计算核心（graph.c 四数组语义，std-only mini crate）
//!
//! 目的（master-plan §十一 欠账 ③ / D2）：把 `log.rs::compute_lanes` 的纯算法抽到
//! 独立 crate，使其可以用 `cargo test -p polaris-git-lanes` **真实跑测**（主仓 lib
//! 测试受 Tauri DLL 限制无法运行，AGENTS §九）。log.rs 侧只做 GitCommit → 本 crate
//! 输入类型的映射与 GitLaneRow 装配（refs 装饰仍在主仓）。
//!
//! 算法（graph.c 列状态 + collapse，契约 spec `plans/git-panel-p2-lane-collapse-spec.md`）：
//! - `columns: Vec<Option<Sha>>`：当前行的列状态（每列 = 该列等待的 commit sha）；
//! - 每行流程：
//!   1. **收缩前置**：等待 sha 已在 processed → 释放列（幽灵竖线消除）；
//!   2. **定位 C**：pending 列唯一命中；否则复用空闲列（无则追加，等价四数组
//!      new_columns 的紧凑重建）；
//!   3. **父占位**（graph.c 语义）：第一父占原 column；其余父：
//!      - 父已在**另一列等待** → 复用该列，不重复占列（交错收缩/列泄漏根因）；
//!      - 父已 processed → 一次性占位，渲染后立即释放；
//!      - 否则占「未被本行父占用、且非 C 原列」的空闲/新列。
//!   4. **渲染**：node = commit/merge/empty/none；edgeDown/edgeUp 语义不变。
//!   5. 输出后 `processed.insert(C.sha)`。
//!
//! 列数上界 = 活跃分支数 + 1（泄漏修复的可测不变量）。

use serde::Deserialize;

/// 输入提交（拓扑序，新→旧）。由主仓 GitCommit 映射而来（refs 装饰在主仓侧）。
#[derive(Debug, Clone, Deserialize)]
pub struct LaneCommit {
    /// 完整 sha
    pub sha: String,
    /// 父 sha（第一父在前）
    pub parents: Vec<String>,
}

/// 输出 cell（serde camelCase；主仓装配为 GitLaneCell 加 refs）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneCell {
    pub lane: usize,
    /// commit / merge / empty / none
    pub node: String,
    pub edge_down: Option<usize>,
    pub edge_up: Option<usize>,
}

/// 输出行
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneRow {
    pub sha: String,
    pub cells: Vec<LaneCell>,
}

/// 空闲列查找：取第一个 `w.is_none()` 且 `col != lane` 的列；无则追加新列。
/// （merge 的额外父不允许占用 C 的原列——那是第一父的专属槽位。）
fn find_free_column(columns: &mut Vec<Option<String>>, lane: usize) -> usize {
    for (i, w) in columns.iter().enumerate() {
        if i != lane && w.is_none() {
            return i;
        }
    }
    columns.push(None);
    columns.len() - 1
}

/// 纯算法入口：拓扑序 commits（新→旧）→ 泳道行
pub fn compute_lanes(commits: &[LaneCommit]) -> Vec<LaneRow> {
    use std::collections::HashSet;

    let mut columns: Vec<Option<String>> = Vec::new();
    let mut processed: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(commits.len());

    for commit in commits {
        let is_merge = commit.parents.len() > 1;

        // 1. 收缩前置：等待 sha 已处理 → 释放该列
        for c in columns.iter_mut() {
            if let Some(sha) = c {
                if processed.contains(sha) {
                    *c = None;
                }
            }
        }

        // 2. 定位 C（pending 命中 → 复用空闲 → 追加）
        let lane = columns
            .iter()
            .position(|w| w.as_deref() == Some(commit.sha.as_str()))
            .unwrap_or_else(|| find_free_column(&mut columns, usize::MAX));

        // 3. 消费 C + 父占位（graph.c）
        columns[lane] = None;
        let mut parent_cols: Vec<Option<usize>> = Vec::with_capacity(commit.parents.len());
        for p in commit.parents.iter() {
            let col: usize;
            if parent_cols.is_empty() {
                // 第一父：占 C 的原列
                col = lane;
                parent_cols.push(Some(col));
                if !processed.contains(p) {
                    columns[col] = Some(p.clone());
                }
                continue;
            }
            // 其余父：已在另一列等待 → 复用（去重）
            if let Some(i) = columns.iter().position(|w| w.as_deref() == Some(p.as_str())) {
                parent_cols.push(Some(i));
                continue;
            }
            // 已 processed → 一次性占位（渲染斜线用），final 阶段释放
            if processed.contains(p) {
                let i = find_free_column(&mut columns, lane);
                parent_cols.push(Some(i));
                continue;
            }
            // 占空闲/新列并等待
            let i = find_free_column(&mut columns, lane);
            columns[i] = Some(p.clone());
            parent_cols.push(Some(i));
        }

        // 4. 渲染
        let mut cells = Vec::with_capacity(columns.len());
        for (l, wait) in columns.iter().enumerate() {
            let has_down = wait.is_some();
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
            cells.push(LaneCell {
                lane: l,
                node: node.to_string(),
                edge_down: if has_down { Some(l) } else { None },
                edge_up: None,
            });
        }
        // merge 斜线：其余父列 → merge 节点列
        if is_merge {
            for pc in parent_cols.iter().skip(1).flatten() {
                if let Some(cell) = cells.get_mut(*pc) {
                    cell.edge_up = Some(lane);
                }
            }
        }

        out.push(LaneRow {
            sha: commit.sha.clone(),
            cells,
        });

        processed.insert(commit.sha.clone());
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(sha: &str, parents: &[&str]) -> LaneCommit {
        LaneCommit {
            sha: sha.to_string(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
        }
    }

    fn cell_of(row: &LaneRow, lane: usize) -> LaneCell {
        row.cells[lane].clone()
    }

    #[test]
    fn linear_is_single_lane() {
        // A→B→C 单线（新→旧：C,B,A）
        let rows = compute_lanes(&[c("c", &["b"]), c("b", &["a"]), c("a", &[])]);
        assert_eq!(rows.len(), 3);
        for r in &rows[..2] {
            assert_eq!(r.cells.len(), 1);
            assert_eq!(r.cells[0].node, "commit");
            assert_eq!(r.cells[0].edge_down, Some(0));
        }
        // 最后一行（根 A）无后续 → edge_down = None
        assert_eq!(rows[2].cells[0].edge_down, None);
    }

    #[test]
    fn mainline_and_merge_npc_line() {
        // 主线 A←B(←f2) + M 合并 f2；拓扑（新→旧）：M, B, f1(f2 的等待 sha), A
        let rows = compute_lanes(&[
            c("m", &["b", "f1"]),
            c("b", &["a"]),
            c("f1", &[]),
            c("a", &[]),
        ]);
        // M 行：列 0 = merge 节点（第一父 B 占列 0）；第二父 f1 占列 1，edgeUp → 0
        let m = &rows[0];
        assert_eq!(cell_of(m, 0).node, "merge");
        assert_eq!(cell_of(m, 1).node, "empty"); // f1 等待 → 贯穿线
        assert_eq!(cell_of(m, 1).edge_up, Some(0));
        assert_eq!(cell_of(m, 0).edge_down, Some(0));
        // B 行：列 0 commit，列 1 empty（f1 继续等待）
        let b = &rows[1];
        assert_eq!(cell_of(b, 0).node, "commit");
        assert_eq!(cell_of(b, 1).node, "empty");
        // f1 行：消费列 1；列 0 empty（A 等待）
        let f1 = &rows[2];
        assert_eq!(f1.cells.len(), 2);
        assert_eq!(cell_of(f1, 1).node, "commit");
        assert_eq!(cell_of(f1, 0).node, "empty");
        // f1 消费后 → 根行列 1 无等待（孤儿根占位一次性）
        let a = &rows[3];
        assert_eq!(a.cells.len(), 2);
        assert_eq!(cell_of(a, 0).node, "commit");
        assert_eq!(cell_of(a, 1).node, "none");
    }

    #[test]
    fn interleaved_duplicate_parent_dedup() {
        // graph.c 交错收缩核心：第二个 merge 的重复父还在等待列 → 复用不重复占列
        let rows = compute_lanes(&[
            // m2 parents (m1, f1); m1 parents (m0, f1_new)? 用 f1 等待复用做去重
            c("m2", &["m1", "f1"]),
            c("m1", &["r", "f1"]),
            c("r", &[]),
            c("f1", &[]),
        ]);
        // m2 行：列 0 merge，列 1 f1 等待
        assert_eq!(cell_of(&rows[0], 0).node, "merge");
        assert_eq!(cell_of(&rows[0], 1).edge_up, Some(0));
        // m1 行：f1 已在列 1 等待 → 复用（不新增）；列数不增长（去重可测不变量）
        assert_eq!(rows[1].cells.len(), 2);
        assert_eq!(cell_of(&rows[1], 1).edge_up, Some(0));
    }

    #[test]
    fn columns_do_not_leak_across_interleaved_merges() {
        // 交错 merge 链：列数上界 = 活跃分支数 + 1（spec §三.3）
        let rows = compute_lanes(&[
            c("m5", &["m4", "f5"]),
            c("m4", &["m3", "f4"]),
            c("m3", &["m2", "f3"]),
            c("m2", &["m1", "f2"]),
            c("m1", &["root", "f1"]),
            c("f1", &[]),
            c("f2", &[]),
            c("f3", &[]),
            c("f4", &[]),
            c("f5", &[]),
            c("root", &[]),
        ]);
        let max_cols = rows.iter().map(|r| r.cells.len()).max().unwrap();
        // 活跃等待分支 = f1..f5（5 个）+ 主线 = 6（旧算法此处会随 merge 数无限增长）
        assert!(max_cols <= 6, "交错 merge 列数泄漏：最高 {max_cols}");
        // 根行：全部释放（无幽灵 empty）
        assert!(rows[10].cells.iter().all(|x| x.node != "empty"));
    }

    #[test]
    fn processed_parent_released_immediately() {
        // 第二父已在本页 output（前序行已处理）→ 一次性占位即释放，不留幽灵竖线
        let rows = compute_lanes(&[c("done", &[]), c("m", &["rootdone", "done"]), c("rootdone", &[])]);
        // m 行：第二父 done 已 processed → 列存在但立即释放（渲染 edgeUp 斜线）
        let m = &rows[1];
        assert!(m.cells.iter().any(|x| x.edge_up == Some(0)));
        // 根行：done 列已释放 → none（无幽灵 empty）
        let root = &rows[2];
        assert!(
            root.cells.iter().all(|x| x.node != "empty"),
            "根行不应有幽灵 empty 竖线"
        );
    }
}
