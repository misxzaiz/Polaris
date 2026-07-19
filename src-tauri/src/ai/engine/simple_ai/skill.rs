/*! Skill 系统（Phase 4c）：progressive disclosure
 *
 * 扫描 `work_dir/.polaris/skills/<name>/SKILL.md`，构建索引（name + description）注入
 * 上下文消息；`read_skill` 工具按需读全文。对齐 Claude Code skill 机制。
 *
 * SKILL.md 格式：YAML frontmatter（`name` / `description`）+ body（全文）。
 */

use std::path::Path;

use serde_json::{json, Value};

/// 单个 skill 的内存表示。
#[derive(Debug, Clone)]
pub(crate) struct SkillEntry {
    pub name: String,
    pub description: String,
    pub full_text: String,
}

/// 扫描 skill 目录序列，返回 skill 列表。项目级 `work_dir/.polaris/skills/`
/// 优先，其次全局 `<DataRoot>/skills/`（同名子目录项目级覆盖全局，P1-7）。
///
/// 仅扫一级子目录（每个子目录一个 skill，含 SKILL.md）。目录不存在时返回空。
pub(crate) fn discover_skills(work_dir: &str) -> Vec<SkillEntry> {
    let dirs = vec![
        Path::new(work_dir).join(".polaris").join("skills"),
        crate::services::data_root::data_root().root().join("skills"),
    ];
    discover_skills_in(&dirs)
}

fn discover_skills_in(dirs: &[std::path::PathBuf]) -> Vec<SkillEntry> {
    let mut skills = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for base in dirs {
        let Ok(entries) = std::fs::read_dir(base) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().to_string();
            // 前面的目录优先(项目级覆盖全局)
            if !seen.insert(dir_name) {
                continue;
            }
            let skill_md = entry.path().join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&skill_md) else {
                continue;
            };
            if let Some(skill) = parse_skill(&content, &entry.path()) {
                skills.push(skill);
            }
        }
    }
    skills
}

/// 解析 SKILL.md：YAML frontmatter（name/description）+ body（全文）。
fn parse_skill(content: &str, dir: &Path) -> Option<SkillEntry> {
    let lines: Vec<&str> = content.lines().collect();
    let frontmatter_start = if lines.first().is_some_and(|l| l.trim() == "---") {
        1
    } else {
        0
    };
    let frontmatter_end = if frontmatter_start > 0 {
        lines[frontmatter_start..]
            .iter()
            .position(|l| l.trim() == "---")
            .map_or(lines.len(), |i| frontmatter_start + i)
    } else {
        0
    };

    let mut name = None;
    let mut description = None;
    if frontmatter_end > frontmatter_start {
        for line in &lines[frontmatter_start..frontmatter_end] {
            let l = line.trim();
            if let Some(rest) = l.strip_prefix("name:") {
                name = Some(rest.trim().trim_matches('"').trim_matches('\'').to_string());
            } else if let Some(rest) = l.strip_prefix("description:") {
                description =
                    Some(rest.trim().trim_matches('"').trim_matches('\'').to_string());
            }
        }
    }

    // name 缺省用目录名。
    let name = name.unwrap_or_else(|| {
        dir.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string()
    });
    let description = description.unwrap_or_default();

    // 全文（含 frontmatter，便于 read_skill 返回完整上下文）。
    let full_text = content.to_string();

    Some(SkillEntry {
        name,
        description,
        full_text,
    })
}

/// 构建 skill 索引消息（注入 user 消息）。无 skill 时返回 None。
pub(crate) fn build_skill_index_message(skills: &[SkillEntry]) -> Option<Value> {
    if skills.is_empty() {
        return None;
    }
    let mut lines = Vec::new();
    lines.push("# Available skills".to_string());
    lines.push(
        "Use the `read_skill` tool to read a skill's full content when a task matches its description."
            .to_string(),
    );
    for s in skills {
        lines.push(format!("- name: {}\n  description: {}", s.name, s.description));
    }
    Some(json!({ "role": "user", "content": lines.join("\n") }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parse_skill_extracts_frontmatter_and_body() {
        let dir = tempfile::tempdir().unwrap();
        let skill_dir = dir.path().join("my-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: my-skill\ndescription: A test skill\n---\n# My Skill\nBody text here",
        )
        .unwrap();
        let skills = discover_skills(dir.path().to_str().unwrap());
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "my-skill");
        assert_eq!(skills[0].description, "A test skill");
        assert!(skills[0].full_text.contains("Body text here"));
    }

    #[test]
    fn parse_skill_uses_dir_name_when_frontmatter_missing() {
        let dir = tempfile::tempdir().unwrap();
        let skill_dir = dir.path().join("fallback");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "No frontmatter").unwrap();
        let skills = discover_skills(dir.path().to_str().unwrap());
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "fallback");
    }

    #[test]
    fn build_index_returns_none_when_empty() {
        assert!(build_skill_index_message(&[]).is_none());
    }

    #[test]
    fn build_index_lists_names_and_mentions_read_skill() {
        let skills = vec![
            SkillEntry {
                name: "a".into(),
                description: "desc a".into(),
                full_text: String::new(),
            },
            SkillEntry {
                name: "b".into(),
                description: "desc b".into(),
                full_text: String::new(),
            },
        ];
        let msg = build_skill_index_message(&skills).unwrap();
        let content = msg["content"].as_str().unwrap();
        assert!(content.contains("- name: a"));
        assert!(content.contains("desc b"));
        assert!(content.contains("read_skill"));
    }

    #[test]
    fn discover_skills_ignores_nonexistent_dir() {
        let skills = discover_skills("/nonexistent/path/xyz");
        assert!(skills.is_empty());
    }

    #[test]
    fn discover_skills_skips_dir_without_skill_md() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("no-skill-md")).unwrap();
        // 无 SKILL.md
        let skills = discover_skills(dir.path().to_str().unwrap());
        assert!(skills.is_empty());
    }
}
