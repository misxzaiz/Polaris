/*! Git Ignore 操作
 *
 * 提供 .gitignore 文件的读取、写入和管理功能
 */

use std::path::Path;

use crate::models::git::{GitIgnoreResult, GitIgnoreTemplate, GitServiceError};

/// 获取 .gitignore 文件内容
pub fn get_gitignore(path: &Path) -> Result<GitIgnoreResult, GitServiceError> {
    let gitignore_path = path.join(".gitignore");

    if gitignore_path.exists() {
        let content = std::fs::read_to_string(&gitignore_path)?;
        Ok(GitIgnoreResult {
            exists: true,
            content,
            path: ".gitignore".to_string(),
        })
    } else {
        Ok(GitIgnoreResult {
            exists: false,
            content: String::new(),
            path: ".gitignore".to_string(),
        })
    }
}

/// 保存 .gitignore 文件内容
pub fn save_gitignore(path: &Path, content: &str) -> Result<(), GitServiceError> {
    let gitignore_path = path.join(".gitignore");
    std::fs::write(&gitignore_path, content)?;
    Ok(())
}

/// 添加忽略规则到 .gitignore
pub fn add_to_gitignore(path: &Path, rules: &[String]) -> Result<(), GitServiceError> {
    let gitignore_path = path.join(".gitignore");

    // 读取现有内容
    let existing_content = if gitignore_path.exists() {
        std::fs::read_to_string(&gitignore_path)?
    } else {
        String::new()
    };

    // 过滤已存在的规则
    let existing_lines: Vec<&str> = existing_content.lines().collect();
    let new_rules: Vec<&String> = rules
        .iter()
        .filter(|rule| !existing_lines.contains(&rule.as_str()))
        .collect();

    if new_rules.is_empty() {
        return Ok(());
    }

    // 构建新内容
    let mut new_content = existing_content;
    if !new_content.is_empty() && !new_content.ends_with('\n') {
        new_content.push('\n');
    }

    for rule in new_rules {
        new_content.push_str(rule);
        new_content.push('\n');
    }

    std::fs::write(&gitignore_path, new_content)?;
    Ok(())
}

/// 获取常用忽略规则模板
pub fn get_gitignore_templates() -> Vec<GitIgnoreTemplate> {
    vec![
        GitIgnoreTemplate {
            name: "Node.js".to_string(),
            description: "Node.js 项目常用忽略规则".to_string(),
            rules: vec![
                "node_modules/".to_string(),
                "dist/".to_string(),
                "build/".to_string(),
                ".cache/".to_string(),
                "*.log".to_string(),
                ".env".to_string(),
                ".env.local".to_string(),
                ".env.*.local".to_string(),
            ],
        },
        GitIgnoreTemplate {
            name: "Rust".to_string(),
            description: "Rust 项目常用忽略规则".to_string(),
            rules: vec![
                "/target/".to_string(),
                "**/*.rs.bk".to_string(),
                "*.pdb".to_string(),
                "Cargo.lock".to_string(),
            ],
        },
        GitIgnoreTemplate {
            name: "Python".to_string(),
            description: "Python 项目常用忽略规则".to_string(),
            rules: vec![
                "__pycache__/".to_string(),
                "*.py[cod]".to_string(),
                "*$py.class".to_string(),
                ".Python".to_string(),
                "venv/".to_string(),
                ".venv/".to_string(),
                "*.egg-info/".to_string(),
                ".pytest_cache/".to_string(),
            ],
        },
        GitIgnoreTemplate {
            name: "macOS".to_string(),
            description: "macOS 系统文件".to_string(),
            rules: vec![
                ".DS_Store".to_string(),
                ".AppleDouble".to_string(),
                ".LSOverride".to_string(),
                "._*".to_string(),
            ],
        },
        GitIgnoreTemplate {
            name: "Windows".to_string(),
            description: "Windows 系统文件".to_string(),
            rules: vec![
                "Thumbs.db".to_string(),
                "ehthumbs.db".to_string(),
                "Desktop.ini".to_string(),
                "$RECYCLE.BIN/".to_string(),
            ],
        },
        GitIgnoreTemplate {
            name: "IDE".to_string(),
            description: "IDE 配置文件".to_string(),
            rules: vec![
                ".idea/".to_string(),
                ".vscode/".to_string(),
                "*.swp".to_string(),
                "*.swo".to_string(),
                "*~".to_string(),
            ],
        },
    ]
}
