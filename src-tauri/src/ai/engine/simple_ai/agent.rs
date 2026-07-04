/*! Agent preset（Phase 4d）
 *
 * 扫描 `work_dir/.polaris/agents/<name>.md`：YAML frontmatter（`name` / `description`
 * / `tools`）+ body（system prompt）。`options.agent` 指定时，body 覆盖默认 persona
 * （用户显式传 `system_prompt` 时仍完全覆盖，决策 §12-3）。
 */

use std::path::Path;

/// 单个 agent 定义。
#[derive(Debug, Clone)]
pub(crate) struct AgentDefinition {
    pub name: String,
    pub description: String,
    /// 工具白名单（空 = 不限制）。Phase 4d 暂未启用过滤，仅解析保留。
    pub tools: Vec<String>,
    pub system_prompt: String,
}

/// 扫描所有 agent 定义（供前端选择器）。
pub(crate) fn discover_agents(work_dir: &str) -> Vec<AgentDefinition> {
    let base = Path::new(work_dir).join(".polaris").join("agents");
    let mut agents = Vec::new();
    let Ok(entries) = std::fs::read_dir(&base) else {
        return agents;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(agent) = parse_agent(&content, &path) {
            agents.push(agent);
        }
    }
    agents
}

/// 加载指定 agent（按文件名，不含 `.md`）。
pub(crate) fn load_agent(work_dir: &str, name: &str) -> Option<AgentDefinition> {
    let path = Path::new(work_dir)
        .join(".polaris")
        .join("agents")
        .join(format!("{}.md", name));
    let content = std::fs::read_to_string(&path).ok()?;
    parse_agent(&content, &path)
}

fn parse_agent(content: &str, path: &Path) -> Option<AgentDefinition> {
    let lines: Vec<&str> = content.lines().collect();
    let fm_start = if lines.first().is_some_and(|l| l.trim() == "---") {
        1
    } else {
        0
    };
    let fm_end = if fm_start > 0 {
        lines[fm_start..]
            .iter()
            .position(|l| l.trim() == "---")
            .map_or(lines.len(), |i| fm_start + i)
    } else {
        0
    };

    let mut name = None;
    let mut description = None;
    let mut tools: Vec<String> = Vec::new();
    if fm_end > fm_start {
        for line in &lines[fm_start..fm_end] {
            let l = line.trim();
            if let Some(rest) = l.strip_prefix("name:") {
                name = Some(rest.trim().trim_matches('"').trim_matches('\'').to_string());
            } else if let Some(rest) = l.strip_prefix("description:") {
                description = Some(rest.trim().trim_matches('"').trim_matches('\'').to_string());
            } else if let Some(rest) = l.strip_prefix("tools:") {
                tools = rest
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        }
    }

    let name = name.unwrap_or_else(|| {
        path.file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string()
    });
    let description = description.unwrap_or_default();

    // body = frontmatter 之后的全部内容（system prompt）。
    let system_prompt = if fm_end > 0 && fm_end + 1 < lines.len() {
        lines[fm_end + 1..].join("\n").trim().to_string()
    } else if fm_end == 0 {
        content.trim().to_string()
    } else {
        String::new()
    };

    Some(AgentDefinition {
        name,
        description,
        tools,
        system_prompt,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parse_agent_extracts_frontmatter_and_body() {
        let dir = tempfile::tempdir().unwrap();
        let agents_dir = dir.path().join(".polaris").join("agents");
        fs::create_dir_all(&agents_dir).unwrap();
        fs::write(
            agents_dir.join("coder.md"),
            "---\nname: coder\ndescription: A coding agent\ntools: bash, read_file, apply_patch\n---\nYou are a focused coding agent.",
        )
        .unwrap();
        let agents = discover_agents(dir.path().to_str().unwrap());
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].name, "coder");
        assert_eq!(agents[0].description, "A coding agent");
        assert_eq!(agents[0].tools, vec!["bash", "read_file", "apply_patch"]);
        assert!(agents[0].system_prompt.contains("focused coding agent"));
    }

    #[test]
    fn load_agent_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let agents_dir = dir.path().join(".polaris").join("agents");
        fs::create_dir_all(&agents_dir).unwrap();
        fs::write(
            agents_dir.join("reviewer.md"),
            "---\nname: reviewer\n---\nYou are a code reviewer.",
        )
        .unwrap();
        let agent = load_agent(dir.path().to_str().unwrap(), "reviewer").unwrap();
        assert_eq!(agent.name, "reviewer");
        assert!(agent.system_prompt.contains("code reviewer"));
    }

    #[test]
    fn load_agent_missing_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_agent(dir.path().to_str().unwrap(), "nope").is_none());
    }

    #[test]
    fn parse_agent_without_frontmatter_uses_body_as_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let agents_dir = dir.path().join(".polaris").join("agents");
        fs::create_dir_all(&agents_dir).unwrap();
        fs::write(agents_dir.join("plain.md"), "You are a plain agent.").unwrap();
        let agents = discover_agents(dir.path().to_str().unwrap());
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].name, "plain");
        assert_eq!(agents[0].system_prompt, "You are a plain agent.");
    }

    #[test]
    fn discover_agents_ignores_nonexistent_dir() {
        let agents = discover_agents("/nonexistent/xyz");
        assert!(agents.is_empty());
    }
}
