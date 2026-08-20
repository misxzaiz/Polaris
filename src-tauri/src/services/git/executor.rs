/*! Git 仓库执行器
 *
 * 提供底层仓库操作：打开、初始化、检查等
 */

use git2::Repository;
use std::path::Path;

use crate::models::git::GitServiceError;

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
