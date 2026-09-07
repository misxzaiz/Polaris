/*! Git 仓库执行器
 *
 * 提供底层仓库操作：打开、初始化、检查等
 */

use git2::Repository;
use std::path::{Path, PathBuf};

use crate::models::git::{GitDiscoveredRepo, GitServiceError};

/// 检查路径是否为 Git 仓库
pub fn is_repository(path: &Path) -> bool {
    Repository::open(path).is_ok()
}

/// 打开仓库
pub fn open_repository(path: &Path) -> Result<Repository, GitServiceError> {
    Repository::open(path).map_err(GitServiceError::from)
}

/// 初始化 Git 仓库
pub fn init_repository(path: &Path, initial_branch: Option<&str>) -> Result<String, GitServiceError> {
    let branch_name = initial_branch.unwrap_or("main");

    let repo = git2::Repository::init_opts(
        path,
        git2::RepositoryInitOptions::new()
            .initial_head(branch_name)
            .mkdir(true),
    )?;

    // 创建初始提交
    let sig = repo.signature()?;
    let tree_id = {
        let tree_builder = repo.treebuilder(None)?;
        tree_builder.write()?
    };
    let tree = repo.find_tree(tree_id)?;

    let oid = repo.commit(
        Some(&format!("refs/heads/{}", branch_name)),
        &sig,
        &sig,
        "Initial commit",
        &tree,
        &[],
    )?;

    Ok(oid.to_string())
}

/// 扫描根目录下所有嵌套 Git 仓库（用于"聚合工作区"场景：工作区本身非 git，下含多个并行子项目）
///
/// - 递归遍历 `max_depth` 层，遇到 `.git` 即记录该目录为仓库，不再继续下钻该子树
/// - 跳过 node_modules / target / dist / .git / .next / build / out 等大目录
/// - 每个仓库读取：目录名、当前分支、是否有未提交变更、是否空仓库
/// - 根目录本身是仓库时，单独返回（不递归扫描其内容）
pub fn discover_repositories(root: &Path, max_depth: usize) -> Result<Vec<GitDiscoveredRepo>, GitServiceError> {
    use std::fs;

    let mut results: Vec<GitDiscoveredRepo> = Vec::new();

    /// 是否为应跳过的目录名（噪声/大产物目录）
    fn is_skip_dir(name: &str) -> bool {
        matches!(
            name,
            "node_modules" | "target" | "dist" | "build" | "out"
            | ".git" | ".next" | ".venv" | "venv" | "__pycache__"
            | ".cache" | "coverage" | ".turbo" | ".idea" | ".vscode"
        )
    }

    /// 递归扫描
    fn walk(
        dir: &Path,
        depth: usize,
        max_depth: usize,
        results: &mut Vec<GitDiscoveredRepo>,
    ) {
        // 命中 .git：该目录是仓库根
        let dot_git = dir.join(".git");
        if dot_git.exists() {
            // 尝试打开仓库读取元信息；失败则跳过（可能是损坏的 .git）
            if let Ok(repo) = Repository::open(dir) {
                let name = dir
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();

                let is_empty = repo.is_empty().unwrap_or(true);

                // 当前分支名
                let branch = repo
                    .head()
                    .ok()
                    .and_then(|h| h.shorthand().map(|s| s.to_string()))
                    .unwrap_or_default();

                // 快速判断是否有变更：构造 StatusOptions 仅查工作树是否有任何条目
                let has_changes = {
                    let mut opts = git2::StatusOptions::new();
                    opts.include_untracked(true).include_ignored(false);
                    repo.statuses(Some(&mut opts))
                        .map(|s| !s.is_empty())
                        .unwrap_or(false)
                };

                // 提取短 SHA（非空仓库时）
                let short_commit = if !is_empty {
                    repo.head()
                        .ok()
                        .and_then(|h| h.target())
                        .map(|oid| {
                            let s = oid.to_string();
                            s.chars().take(8).collect::<String>()
                        })
                        .unwrap_or_default()
                } else {
                    String::new()
                };

                results.push(GitDiscoveredRepo {
                    path: dir.to_string_lossy().to_string(),
                    name,
                    branch,
                    short_commit,
                    is_empty,
                    has_changes,
                });
                // 不再下钻该子树
                return;
            }
        }

        // 超过最大深度则停止
        if depth >= max_depth {
            return;
        }

        // 读取目录继续下钻
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };
            if is_skip_dir(&name) {
                continue;
            }
            walk(&path, depth + 1, max_depth, results);
        }
    }

    // 根目录本身是仓库：直接返回单条，不递归扫描内容（避免子模块被重复发现搅乱主仓库视图）
    if root.join(".git").exists() {
        if let Ok(repo) = Repository::open(root) {
            let name = root
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(root.to_string_lossy().as_ref())
                .to_string();
            let is_empty = repo.is_empty().unwrap_or(true);
            let branch = repo
                .head()
                .ok()
                .and_then(|h| h.shorthand().map(|s| s.to_string()))
                .unwrap_or_default();
            let has_changes = {
                let mut opts = git2::StatusOptions::new();
                opts.include_untracked(true).include_ignored(false);
                repo.statuses(Some(&mut opts))
                    .map(|s| !s.is_empty())
                    .unwrap_or(false)
            };
            let short_commit = if !is_empty {
                repo.head()
                    .ok()
                    .and_then(|h| h.target())
                    .map(|oid| {
                        oid.to_string().chars().take(8).collect::<String>()
                    })
                    .unwrap_or_default()
            } else {
                String::new()
            };
            results.push(GitDiscoveredRepo {
                path: root.to_string_lossy().to_string(),
                name,
                branch,
                short_commit,
                is_empty,
                has_changes,
            });
            return Ok(results);
        }
    }

    // 根目录不是仓库：递归扫描子目录
    walk(root, 0, max_depth, &mut results);

    // 按路径排序，输出稳定
    results.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(results)
}
