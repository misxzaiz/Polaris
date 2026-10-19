/*! 泳道图增量 log 缓存
 *
 * 只缓存「语义色全量 map」（跨页共享，spec `plans/git-panel-p2-lane-cache-spec.md`），
 * 不做整页缓存。键 = (repo 绝对路径, branch, HEAD commit sha, refs 指纹)。
 *
 * 生命周期：命中 → 页内 O(page) 查 map；未命中 → 计算全量 map + 原子写。
 * 任何失败静默降级为未命中（warn 日志），缓存是性能增强非正确性依赖。
 */

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use git2::Repository;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::services::data_root::data_root;

/// 目录内最多保留的缓存文件数；超过后按 mtime 删最旧。
const MAX_CACHE_FILES: usize = 50;
/// 清理后保留的最少文件数（避免一次写就触发一次清）。
const PRUNE_TO: usize = 30;

/// 缓存文件正文（含键双保险，读回时再验）
#[derive(Serialize, Deserialize)]
struct SemanticCacheFile {
    key: String,
    map: HashMap<String, String>,
}

/// 语义色 map 缓存（对外入口，base_dir 固定为全局数据根缓存目录）
pub struct LaneSemanticCache;

impl LaneSemanticCache {
    /// 命中则返回全量 map，否则 None（降级：调用方自行计算并 store）
    pub fn load(
        repo_path: &Path,
        branch: &str,
        head_sha: &str,
        refs_fp: &str,
    ) -> Option<HashMap<String, String>> {
        let base = data_root().cache_dir().join("git-lane-semantic");
        crate::services::git::lane_cache::inner::load(&base, repo_path, branch, head_sha, refs_fp)
    }

    /// 写入全量 map（原子写 + 清理超限旧文件）
    pub fn store(
        repo_path: &Path,
        branch: &str,
        head_sha: &str,
        refs_fp: &str,
        map: &HashMap<String, String>,
    ) {
        let base = data_root().cache_dir().join("git-lane-semantic");
        crate::services::git::lane_cache::inner::store(&base, repo_path, branch, head_sha, refs_fp, map);
    }
}

/// 换行分隔路径/分支 → 目录哈希（repo 绝对路径与 branch 含 Windows 非法字符，统一哈希）
fn dir_hash(repo_path: &Path, branch: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    repo_path.to_string_lossy().hash(&mut h);
    branch.hash(&mut h);
    h.finish()
}

/// 文件名 = semantic-<head_sha>-<refs_fp>.json（两者均为 hex，可直接作文件名）
fn file_name(head_sha: &str, refs_fp: &str) -> String {
    format!("semantic-{head_sha}-{refs_fp}.json")
}

/// 正文键 = "<head_sha>:<refs_fp>"，读回时双保险校验
fn file_key(head_sha: &str, refs_fp: &str) -> String {
    format!("{head_sha}:{refs_fp}")
}

/// 内层实现（可注入 base_dir 以便测试隔离）
pub(crate) mod inner {
    use super::*;

    pub fn load(
        base: &Path,
        repo_path: &Path,
        branch: &str,
        head_sha: &str,
        refs_fp: &str,
    ) -> Option<HashMap<String, String>> {
        let dir = base.join(format!("{:016x}", dir_hash(repo_path, branch)));
        let file = dir.join(file_name(head_sha, refs_fp));

        let text = std::fs::read_to_string(&file).ok()?;
        let parsed: SemanticCacheFile = match serde_json::from_str(&text) {
            Ok(f) => f,
            Err(e) => {
                warn!("git-lane-semantic 缓存解析失败: {e}（{file:?}），降级未命中");
                return None;
            }
        };
        // 键双保险：文件内容与当前 (head, refs) 必须一致
        if parsed.key != file_key(head_sha, refs_fp) {
            return None;
        }
        Some(parsed.map)
    }

    pub fn store(
        base: &Path,
        repo_path: &Path,
        branch: &str,
        head_sha: &str,
        refs_fp: &str,
        map: &HashMap<String, String>,
    ) {
        let dir = base.join(format!("{:016x}", dir_hash(repo_path, branch)));
        let file = dir.join(file_name(head_sha, refs_fp));

        if let Err(e) = std::fs::create_dir_all(&dir) {
            warn!("git-lane-semantic 缓存目录创建失败: {e}（{dir:?}），跳过写入");
            return;
        }

        let body = SemanticCacheFile {
            key: file_key(head_sha, refs_fp),
            map: map.clone(),
        };
        let Ok(text) = serde_json::to_string(&body) else {
            warn!("git-lane-semantic 缓存序列化失败，跳过写入");
            return;
        };

        let tmp = dir.join(format!("{}.tmp", file_name(head_sha, refs_fp)));
        if let Err(e) = std::fs::write(&tmp, &text) {
            warn!("git-lane-semantic 缓存临时写入失败: {e}（{tmp:?}），跳过写入");
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, &file) {
            warn!("git-lane-semantic 缓存 rename 失败: {e}（{file:?}），跳过写入");
            let _ = std::fs::remove_file(&tmp);
            return;
        }

        prune(&dir);
    }

    /// 目录内文件数超限 → 按 mtime 删最旧直到 PRUNE_TO
    fn prune(dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            if let Ok(mtime) = meta.modified() {
                files.push((mtime, entry.path()));
            }
        }
        if files.len() <= MAX_CACHE_FILES {
            return;
        }
        // 最旧在前
        files.sort_by_key(|(t, _)| *t);
        let excess = files.len().saturating_sub(PRUNE_TO);
        for (_, path) in files.into_iter().take(excess) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// refs 指纹：全部 refs 的 (full_name, peel→commit sha) 排序拼接后哈希。
/// 任何 fetch / 分支增删 / 新 commit → 目标 sha 变 → 指纹变 → 缓存失效。
/// 用 DefaultHasher（标准库）；同进程内稳定即可，无需跨进程一致。
pub fn refs_fingerprint(repo: &Repository) -> String {
    let mut items: Vec<String> = Vec::new();
    if let Ok(head) = repo.head() {
        if let Some(target) = head.target() {
            items.push(format!("HEAD={target}"));
        }
    }
    if let Ok(references) = repo.references() {
        for reference in references.flatten() {
            let Some(name) = reference.name() else { continue };
            let Ok(obj) = reference.peel(git2::ObjectType::Commit) else {
                continue;
            };
            items.push(format!("{name}={}", obj.id()));
        }
    }
    items.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for item in items {
        item.hash(&mut h);
    }
    format!("{:016x}", h.finish())
}

#[cfg(test)]
mod tests {
    use super::inner;
    use super::*;
    use git2::Repository;

    #[test]
    fn refs_fingerprint_changes_on_new_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        let sig = git2::Signature::now("t", "t@t").unwrap();

        std::fs::write(tmp.path().join("a.txt"), "1").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(Some("refs/heads/main"), &sig, &sig, "c1", &tree, &[])
                .unwrap();
        }
        let fp1 = refs_fingerprint(&repo);

        std::fs::write(tmp.path().join("a.txt"), "2").unwrap();
        let commit2 = {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let parent = repo.find_commit(repo.head().unwrap().peel_to_commit().unwrap().id()).unwrap();
            repo.commit(Some("refs/heads/main"), &sig, &sig, "c2", &tree, &[&parent])
                .unwrap()
        };
        let fp2 = refs_fingerprint(&repo);
        let _ = commit2;

        assert_ne!(fp1, fp2, "新 commit 必须改变 refs 指纹（HEAD/ref 目标 sha 变化）");
    }

    #[test]
    fn load_missing_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("cache");
        let got = inner::load(&base, tmp.path(), "main", "abc", "def");
        assert!(got.is_none(), "缺失缓存应返回 None");
    }

    #[test]
    fn store_then_load_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("cache");
        let mut map = HashMap::new();
        map.insert("sha1".to_string(), "unpushed".to_string());
        map.insert("sha2".to_string(), "local".to_string());

        inner::store(&base, tmp.path(), "feature", "headAAA", "fpBBB", &map);
        let got = inner::load(&base, tmp.path(), "feature", "headAAA", "fpBBB");
        assert_eq!(got, Some(map.clone()), "store→load 往返应一致");

        // 键不匹配 → 降级 None
        let wrong_head = inner::load(&base, tmp.path(), "feature", "headXXX", "fpBBB");
        assert!(wrong_head.is_none(), "head_sha 变化应使缓存失效");
        let wrong_branch = inner::load(&base, tmp.path(), "other", "headAAA", "fpBBB");
        assert!(wrong_branch.is_none(), "branch 变化（目录隔离）应使缓存失效");
    }
}