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
    /// 文件名 stem(= corpus slug,`load_agent`/`options.agent` 的检索键)
    pub slug: String,
    pub name: String,
    pub description: String,
    /// 工具白名单（空 = 不限制）。Phase 4d 暂未启用过滤，仅解析保留。
    pub tools: Vec<String>,
    pub system_prompt: String,
    /// 展示用 emoji（agency-agents corpus frontmatter,可缺省）
    #[allow(dead_code)] // Phase 1 Agent Gallery 消费
    pub emoji: Option<String>,
    /// 展示用颜色（hex 或色名,可缺省）
    #[allow(dead_code)] // Phase 1 Agent Gallery 消费
    pub color: Option<String>,
    /// 所属部门（frontmatter 通常不含,由 catalog 元数据补充）
    #[allow(dead_code)] // Phase 1 Agent Gallery 消费
    pub division: Option<String>,
    /// 角色类型（developer/qa/gate-keeper/orchestrator/governance,由 agent-roles.json 补充）
    #[allow(dead_code)] // Phase 2 nexus_pipeline 消费
    pub role: Option<String>,
}

/// agent 查找目录序列:项目级 `.polaris/agents/` 优先,其次全局
/// `<DataRoot>/agents/corpus/`(agency-agents corpus,P0-3 回退)。
fn agent_dirs(work_dir: &str) -> Vec<std::path::PathBuf> {
    let mut dirs = vec![Path::new(work_dir).join(".polaris").join("agents")];
    dirs.push(
        crate::services::data_root::data_root()
            .root()
            .join("agents")
            .join("corpus"),
    );
    dirs
}

/// 扫描所有 agent 定义（供前端选择器）。项目级同名覆盖全局。
pub(crate) fn discover_agents(work_dir: &str) -> Vec<AgentDefinition> {
    discover_agents_in(&agent_dirs(work_dir))
}

/// 仅扫描项目级 `.polaris/agents/`（自定义专家管理用,不含全局 corpus）。
pub(crate) fn discover_project_agents(work_dir: &str) -> Vec<AgentDefinition> {
    discover_agents_in(&[Path::new(work_dir).join(".polaris").join("agents")])
}

fn discover_agents_in(dirs: &[std::path::PathBuf]) -> Vec<AgentDefinition> {
    let mut agents = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for base in dirs {
        let Ok(entries) = std::fs::read_dir(base) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
                continue;
            };
            // 前面的目录优先(项目级覆盖全局)
            if !seen.insert(stem) {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Some(agent) = parse_agent(&content, &path) {
                agents.push(agent);
            }
        }
    }
    agents
}

/// 加载指定 agent（按文件名，不含 `.md`）。项目级优先,miss 回退全局 corpus。
pub(crate) fn load_agent(work_dir: &str, name: &str) -> Option<AgentDefinition> {
    load_agent_in(&agent_dirs(work_dir), name)
}

fn load_agent_in(dirs: &[std::path::PathBuf], name: &str) -> Option<AgentDefinition> {
    for base in dirs {
        let path = base.join(format!("{}.md", name));
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Some(agent) = parse_agent(&content, &path) {
                return Some(agent);
            }
        }
    }
    None
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
    let mut emoji = None;
    let mut color = None;
    let mut division = None;
    let mut role = None;
    let mut tools: Vec<String> = Vec::new();
    if fm_end > fm_start {
        for line in &lines[fm_start..fm_end] {
            let l = line.trim();
            let unquote = |rest: &str| rest.trim().trim_matches('"').trim_matches('\'').to_string();
            if let Some(rest) = l.strip_prefix("name:") {
                name = Some(unquote(rest));
            } else if let Some(rest) = l.strip_prefix("description:") {
                description = Some(unquote(rest));
            } else if let Some(rest) = l.strip_prefix("emoji:") {
                emoji = Some(unquote(rest)).filter(|s| !s.is_empty());
            } else if let Some(rest) = l.strip_prefix("color:") {
                color = Some(unquote(rest)).filter(|s| !s.is_empty());
            } else if let Some(rest) = l.strip_prefix("division:") {
                division = Some(unquote(rest)).filter(|s| !s.is_empty());
            } else if let Some(rest) = l.strip_prefix("role:") {
                role = Some(unquote(rest)).filter(|s| !s.is_empty());
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
    let slug = path
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();
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
        slug,
        name,
        description,
        tools,
        system_prompt,
        emoji,
        color,
        division,
        role,
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
        let agents = discover_agents_in(&[std::path::PathBuf::from("/nonexistent/xyz")]);
        assert!(agents.is_empty());
    }

    #[test]
    fn parse_agent_extracts_extended_fields() {
        let dir = tempfile::tempdir().unwrap();
        let agents_dir = dir.path().join(".polaris").join("agents");
        fs::create_dir_all(&agents_dir).unwrap();
        fs::write(
            agents_dir.join("xhs.md"),
            "---\nname: 小红书运营专家\ndescription: 种草\nemoji: 📕\ncolor: \"#FF2442\"\n---\n你是小红书运营专家。",
        )
        .unwrap();
        let agent = load_agent_in(&[agents_dir], "xhs").unwrap();
        assert_eq!(agent.name, "小红书运营专家");
        assert_eq!(agent.emoji.as_deref(), Some("📕"));
        assert_eq!(agent.color.as_deref(), Some("#FF2442"));
        assert!(agent.division.is_none());
        assert!(agent.role.is_none());
    }

    #[test]
    fn extended_fields_default_to_none() {
        let dir = tempfile::tempdir().unwrap();
        let agents_dir = dir.path().join(".polaris").join("agents");
        fs::create_dir_all(&agents_dir).unwrap();
        fs::write(agents_dir.join("basic.md"), "---\nname: basic\n---\nbody").unwrap();
        let agent = load_agent_in(&[agents_dir], "basic").unwrap();
        assert!(agent.emoji.is_none() && agent.color.is_none());
    }

    #[test]
    fn project_agents_shadow_global_corpus() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        let global = dir.path().join("global");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&global).unwrap();
        fs::write(project.join("dup.md"), "---\nname: project-dup\n---\np").unwrap();
        fs::write(global.join("dup.md"), "---\nname: global-dup\n---\ng").unwrap();
        fs::write(global.join("only-global.md"), "---\nname: only-global\n---\ng").unwrap();

        let dirs = vec![project, global];
        let agents = discover_agents_in(&dirs);
        assert_eq!(agents.len(), 2);
        assert!(agents.iter().any(|a| a.name == "project-dup"));
        assert!(agents.iter().any(|a| a.name == "only-global"));
        assert!(!agents.iter().any(|a| a.name == "global-dup"));

        // load 同样项目级优先,miss 回退全局
        assert_eq!(load_agent_in(&dirs, "dup").unwrap().name, "project-dup");
        assert_eq!(load_agent_in(&dirs, "only-global").unwrap().name, "only-global");
        assert!(load_agent_in(&dirs, "nope").is_none());
    }
}
