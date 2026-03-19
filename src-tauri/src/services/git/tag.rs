/*! Git 标签操作
 *
 * 提供标签的创建、删除、查询等功能
 */

use std::path::Path;

use crate::models::git::{GitTag, GitServiceError};
use super::executor::open_repository;

/// 获取所有标签
pub fn get_tags(path: &Path) -> Result<Vec<GitTag>, GitServiceError> {
    let repo = open_repository(path)?;

    let mut tags = Vec::new();

    // 获取所有标签
    let tag_names = repo.tag_names(None)?;

    for tag_name_opt in tag_names.iter() {
        if let Some(tag_name) = tag_name_opt {
            // 查找标签引用
            let ref_name = format!("refs/tags/{}", tag_name);
            let reference = match repo.find_reference(&ref_name) {
                Ok(r) => r,
                Err(_) => continue,
            };

            // 获取标签指向的目标
            let target = match reference.target() {
                Some(t) => t,
                None => continue,
            };

            // 检查是否为 annotated 标签或 lightweight 标签
            let (commit_sha, is_annotated, message, tagger, timestamp) =
                if let Ok(tag_obj) = repo.find_tag(target) {
                    // Annotated 标签
                    let commit_oid = tag_obj.target_id();
                    let message = tag_obj.message().map(|s| s.to_string());
                    let tagger = tag_obj
                        .tagger()
                        .and_then(|s| s.name().map(|n| n.to_string()));
                    let timestamp = tag_obj.tagger().and_then(|s| {
                        let time = s.when();
                        Some(time.seconds())
                    });
                    (commit_oid.to_string(), true, message, tagger, timestamp)
                } else {
                    // Lightweight 标签
                    (target.to_string(), false, None, None, None)
                };

            // 生成短 SHA
            let short_sha = if commit_sha.len() >= 8 {
                commit_sha[..8].to_string()
            } else {
                commit_sha.clone()
            };

            tags.push(GitTag {
                name: tag_name.to_string(),
                is_annotated,
                commit_sha,
                short_sha,
                message,
                tagger,
                timestamp,
            });
        }
    }

    // 按时间倒序排序
    tags.sort_by(|a, b| {
        let time_a = a.timestamp.unwrap_or(0);
        let time_b = b.timestamp.unwrap_or(0);
        time_b.cmp(&time_a)
    });

    Ok(tags)
}

/// 创建标签
pub fn create_tag(
    path: &Path,
    name: &str,
    commitish: Option<&str>,
    message: Option<&str>,
) -> Result<GitTag, GitServiceError> {
    let repo = open_repository(path)?;

    // 验证标签名
    let invalid_chars = [' ', '~', '^', ':', '?', '*', '[', '\\'];
    if name.chars().any(|c| invalid_chars.contains(&c)) {
        return Err(GitServiceError::CLIError(format!(
            "Invalid tag name '{}': contains illegal characters",
            name
        )));
    }

    // 检查标签是否已存在
    let tag_ref = format!("refs/tags/{}", name);
    if repo.find_reference(&tag_ref).is_ok() {
        return Err(GitServiceError::CLIError(format!(
            "Tag '{}' already exists",
            name
        )));
    }

    // 获取目标 commit
    let target = if let Some(commitish) = commitish {
        repo.revparse_single(commitish)?.peel_to_commit()?
    } else {
        repo.head()?.peel_to_commit()?
    };
    let target_oid = target.id();

    // 创建标签
    if let Some(msg) = message {
        // 创建 annotated 标签
        let sig = repo.signature()?;
        let tag_id = repo.tag(name, target.as_object(), &sig, msg, false)?;

        // 获取创建的标签信息
        let tag_obj = repo.find_tag(tag_id)?;
        let message = tag_obj.message().map(|s| s.to_string());
        let tagger = tag_obj.tagger().and_then(|s| s.name().map(|n| n.to_string()));
        let timestamp = tag_obj.tagger().map(|s| {
            let time = s.when();
            time.seconds()
        });

        Ok(GitTag {
            name: name.to_string(),
            is_annotated: true,
            commit_sha: target_oid.to_string(),
            short_sha: target_oid.to_string()[..8].to_string(),
            message,
            tagger,
            timestamp,
        })
    } else {
        // 创建 lightweight 标签
        repo.reference(&tag_ref, target_oid, false, "Create lightweight tag")?;

        Ok(GitTag {
            name: name.to_string(),
            is_annotated: false,
            commit_sha: target_oid.to_string(),
            short_sha: target_oid.to_string()[..8].to_string(),
            message: None,
            tagger: None,
            timestamp: None,
        })
    }
}

/// 删除标签
pub fn delete_tag(path: &Path, name: &str) -> Result<(), GitServiceError> {
    let repo = open_repository(path)?;

    // 查找标签引用
    let tag_ref = format!("refs/tags/{}", name);
    let mut reference = repo.find_reference(&tag_ref).map_err(|_| {
        GitServiceError::CLIError(format!("Tag '{}' not found", name))
    })?;

    // 删除标签
    reference.delete()?;

    Ok(())
}
