//! Agency Agents corpus 安装/查询服务(P0-1)
//!
//! 产物由 `scripts/gen-agent-catalog.mjs` 离线生成到 `resources/agents/`
//! (corpus/*.md + catalog/divisions/rosters/roles/manifest JSON + LICENSE/NOTICE),
//! 本模块负责把 corpus 安装到 `<DataRoot>/agents/` 全局目录,供
//! `simple_ai::agent::{discover_agents, load_agent}` 的全局回退(P0-3)消费。
//!
//! 纯逻辑设计:所有函数以显式路径为参数,不依赖 tauri,可单测;
//! 资源目录解析在 commands 层完成。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// 安装状态(供前端展示)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusStatus {
    /// 已安装的 corpus 版本(未安装为 None)
    pub installed_version: Option<u32>,
    /// 资源内置的 corpus 版本
    pub bundled_version: u32,
    /// 已安装 agent 数
    pub installed_count: usize,
    /// 内置 agent 数
    pub bundled_count: usize,
    /// 安装目标目录
    pub install_dir: PathBuf,
    /// 上游基线(corpus-manifest sources,供 UI 展示与 stale 判断)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<serde_json::Value>,
}

/// catalog.json 条目(与生成脚本输出对齐)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogEntry {
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub emoji: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub division: String,
}

#[derive(Debug, Deserialize)]
struct CatalogFile {
    agents: Vec<CatalogEntry>,
}

#[derive(Debug, Deserialize)]
struct CorpusManifest {
    #[serde(rename = "corpusVersion")]
    corpus_version: u32,
}

/// 随 corpus 一并安装的元数据/合规文件
const SIDE_FILES: &[&str] = &[
    "catalog.json",
    "divisions.json",
    "rosters.json",
    "roster_manifest.json",
    "agent-roles.json",
    "agent-index.md",
    "corpus-manifest.json",
    "NOTICE.md",
    "LICENSE-agency-agents.txt",
    "LICENSE-agency-agents-zh.txt",
];

/// 随 corpus 一并安装的子目录(整目录复制,先清后装)
const SIDE_DIRS: &[&str] = &["activation", "playbooks"];

fn read_manifest_version(dir: &Path) -> Option<u32> {
    let content = fs::read_to_string(dir.join("corpus-manifest.json")).ok()?;
    serde_json::from_str::<CorpusManifest>(&content)
        .ok()
        .map(|m| m.corpus_version)
}

fn read_manifest_sources(dir: &Path) -> Option<serde_json::Value> {
    let content = fs::read_to_string(dir.join("corpus-manifest.json")).ok()?;
    serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|v| v.get("sources").cloned())
}

fn count_corpus_md(dir: &Path) -> usize {
    fs::read_dir(dir.join("corpus"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
                .count()
        })
        .unwrap_or(0)
}

/// 读取内置 catalog(不要求已安装)
pub fn load_catalog(resources_agents_dir: &Path) -> Result<Vec<CatalogEntry>> {
    let path = resources_agents_dir.join("catalog.json");
    let content = fs::read_to_string(&path)
        .map_err(|e| AppError::ConfigError(format!("读取 catalog 失败: {} ({})", e, path.display())))?;
    let file: CatalogFile = serde_json::from_str(&content)
        .map_err(|e| AppError::ConfigError(format!("catalog.json 解析失败: {}", e)))?;
    Ok(file.agents)
}

/// 读取 divisions 元数据(label/icon/color,原样透传 JSON)
pub fn load_divisions(resources_agents_dir: &Path) -> Result<serde_json::Value> {
    let path = resources_agents_dir.join("divisions.json");
    let content = fs::read_to_string(&path)
        .map_err(|e| AppError::ConfigError(format!("读取 divisions 失败: {} ({})", e, path.display())))?;
    serde_json::from_str(&content)
        .map_err(|e| AppError::ConfigError(format!("divisions.json 解析失败: {}", e)))
}

/// 查询安装状态
pub fn corpus_status(resources_agents_dir: &Path, install_dir: &Path) -> CorpusStatus {
    CorpusStatus {
        installed_version: read_manifest_version(install_dir),
        bundled_version: read_manifest_version(resources_agents_dir).unwrap_or(0),
        installed_count: count_corpus_md(install_dir),
        bundled_count: count_corpus_md(resources_agents_dir),
        install_dir: install_dir.to_path_buf(),
        sources: read_manifest_sources(resources_agents_dir),
    }
}

/// 安装 corpus 到全局目录(幂等:版本一致且计数一致时跳过)
///
/// 布局:`<install_dir>/corpus/<slug>.md` + 侧文件;不平铺到 install_dir 根,
/// 避免与用户手工放置的文件混淆,也便于 uninstall 精确清理。
pub fn install_corpus(resources_agents_dir: &Path, install_dir: &Path) -> Result<CorpusStatus> {
    let bundled_version = read_manifest_version(resources_agents_dir).ok_or_else(|| {
        AppError::ConfigError(format!(
            "内置 corpus 缺 corpus-manifest.json: {}",
            resources_agents_dir.display()
        ))
    })?;

    let up_to_date = read_manifest_version(install_dir) == Some(bundled_version)
        && count_corpus_md(install_dir) == count_corpus_md(resources_agents_dir);
    if !up_to_date {
        let src_corpus = resources_agents_dir.join("corpus");
        let dst_corpus = install_dir.join("corpus");
        // 先清后装,保证 rename/删除的上游 agent 不残留
        if dst_corpus.exists() {
            fs::remove_dir_all(&dst_corpus)?;
        }
        fs::create_dir_all(&dst_corpus)?;
        for entry in fs::read_dir(&src_corpus)?.flatten() {
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) == Some("md") {
                fs::copy(&path, dst_corpus.join(entry.file_name()))?;
            }
        }
        for name in SIDE_FILES {
            let src = resources_agents_dir.join(name);
            if src.exists() {
                fs::copy(&src, install_dir.join(name))?;
            }
        }
        for dir in SIDE_DIRS {
            let src = resources_agents_dir.join(dir);
            let dst = install_dir.join(dir);
            if dst.exists() {
                fs::remove_dir_all(&dst)?;
            }
            if src.exists() {
                fs::create_dir_all(&dst)?;
                for entry in fs::read_dir(&src)?.flatten() {
                    if entry.path().is_file() {
                        fs::copy(entry.path(), dst.join(entry.file_name()))?;
                    }
                }
            }
        }
    }
    Ok(corpus_status(resources_agents_dir, install_dir))
}

/// 卸载(仅清理本模块安装的 corpus/ 与侧文件,不动目录内其他内容)
pub fn uninstall_corpus(install_dir: &Path) -> Result<()> {
    let corpus = install_dir.join("corpus");
    if corpus.exists() {
        fs::remove_dir_all(&corpus)?;
    }
    for dir in SIDE_DIRS {
        let path = install_dir.join(dir);
        if path.exists() {
            fs::remove_dir_all(&path)?;
        }
    }
    for name in SIDE_FILES {
        let path = install_dir.join(name);
        if path.exists() {
            fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// 读取 agent 的 activation prompt 模板(P1-2)。
///
/// 优先 `<install_dir>/activation/<slug>.md`,缺省回退 `_generic.md`;都没有返回 None。
/// 占位符(`[PHASE]`/`[TASK]`/`[ACCEPTANCE CRITERIA]`/`[REFERENCE DOCUMENTS]` 等)
/// 由调用方(orchestrator LLM / nexus_pipeline)填充,本函数原样返回。
pub fn load_activation(install_dir: &Path, slug: &str) -> Option<String> {
    let dir = install_dir.join("activation");
    for candidate in [format!("{slug}.md"), "_generic.md".to_string()] {
        if let Ok(content) = fs::read_to_string(dir.join(&candidate)) {
            return Some(content);
        }
    }
    None
}

/// 读取 corpus 中某 agent 的 definition(用于 claude 引擎的 `--agents <json>` 免落盘注入,
/// 见 `claude-cli-capability-alignment.md` 第 69 行 U2-4)。
///
/// 解析 `<install_dir>/corpus/<slug>.md` 的 frontmatter(`description`)与 body(system prompt),
/// 返回 `(slug, description, system_prompt)`。命中失败返回 None(调用方回退默认 `--agent <slug>` 或忽略)。
///
/// 与 SimpleAI `parse_agent` 同构,但此处只取 claude `--agents` JSON 需要的字段(description + prompt body)。
pub fn load_claude_agent_def(install_dir: &Path, slug: &str) -> Option<(String, String, String)> {
    let path = install_dir.join("corpus").join(format!("{slug}.md"));
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return None,
    };
    let (description, body) = parse_frontmatter_and_body(&content);
    let desc = description.unwrap_or_else(|| slug.to_string());
    let prompt = if body.trim().is_empty() {
        content
    } else {
        body
    };
    Some((slug.to_string(), desc, prompt))
}

/// 从 corpus `.md` 文本解析 frontmatter 中的 `description` 字段与 body(system prompt)。
///
/// 与 `simple_ai/agent.rs::parse_agent` 同构但只取 description + body;不重复 `AgentDefinition` 全字段,
/// 避免把 simple_ai 模块耦合进 agent_corpus。
fn parse_frontmatter_and_body(content: &str) -> (Option<String>, String) {
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
    let mut description: Option<String> = None;
    if fm_end > fm_start {
        for line in &lines[fm_start..fm_end] {
            let l = line.trim();
            if let Some(rest) = l.strip_prefix("description:") {
                let v = rest.trim().trim_matches('"').trim_matches('\'').to_string();
                if !v.is_empty() {
                    description = Some(v);
                }
            }
        }
    }
    let body = if fm_end > 0 && fm_end + 1 < lines.len() {
        lines[fm_end + 1..].join("\n").trim().to_string()
    } else if fm_end == 0 {
        content.trim().to_string()
    } else {
        String::new()
    };
    (description, body)
}

/// 把 agent-index.md 落为全局 skill `nexus-agent-index`(P1-7,L2 语义路由索引)。
///
/// `skills_dir` 为 `<DataRoot>/skills/`;SimpleAI `discover_skills` 已支持全局回退,
/// 会话内可经 `read_skill` 按需加载(不常驻 context)。
pub fn install_index_skill(resources_agents_dir: &Path, skills_dir: &Path) -> Result<()> {
    let index = fs::read_to_string(resources_agents_dir.join("agent-index.md")).map_err(|e| {
        AppError::ConfigError(format!("读取 agent-index.md 失败: {e}"))
    })?;
    let skill_dir = skills_dir.join("nexus-agent-index");
    fs::create_dir_all(&skill_dir)?;
    let skill = format!(
        "---\nname: nexus-agent-index\ndescription: Agency Agents 专家索引(slug — 显示名 — 职责)。为任务选择专家时按需加载,语义匹配后用 slug 派发。\n---\n\n{index}"
    );
    fs::write(skill_dir.join("SKILL.md"), skill)?;
    Ok(())
}

/// 卸载全局 index skill
pub fn uninstall_index_skill(skills_dir: &Path) -> Result<()> {
    let skill_dir = skills_dir.join("nexus-agent-index");
    if skill_dir.exists() {
        fs::remove_dir_all(&skill_dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_bundled(dir: &Path, version: u32, slugs: &[&str]) {
        let corpus = dir.join("corpus");
        fs::create_dir_all(&corpus).unwrap();
        for slug in slugs {
            fs::write(
                corpus.join(format!("{slug}.md")),
                format!("---\nname: {slug}\ndescription: d\n---\nbody of {slug}"),
            )
            .unwrap();
        }
        fs::write(
            dir.join("corpus-manifest.json"),
            format!(r#"{{"corpusVersion":{version}}}"#),
        )
        .unwrap();
        let agents: Vec<String> = slugs
            .iter()
            .map(|s| format!(r#"{{"slug":"{s}","name":"{s}","description":"d"}}"#))
            .collect();
        fs::write(
            dir.join("catalog.json"),
            format!(r#"{{"agents":[{}]}}"#, agents.join(",")),
        )
        .unwrap();
        fs::write(dir.join("NOTICE.md"), "notice").unwrap();
    }

    #[test]
    fn install_copies_corpus_and_side_files() {
        let tmp = tempfile::tempdir().unwrap();
        let res = tmp.path().join("res");
        let inst = tmp.path().join("inst");
        make_bundled(&res, 1, &["a", "b"]);

        let status = install_corpus(&res, &inst).unwrap();
        assert_eq!(status.installed_version, Some(1));
        assert_eq!(status.installed_count, 2);
        assert!(inst.join("corpus").join("a.md").exists());
        assert!(inst.join("NOTICE.md").exists());
        assert!(inst.join("catalog.json").exists());
    }

    #[test]
    fn install_is_idempotent_and_upgrades() {
        let tmp = tempfile::tempdir().unwrap();
        let res = tmp.path().join("res");
        let inst = tmp.path().join("inst");
        make_bundled(&res, 1, &["a"]);
        install_corpus(&res, &inst).unwrap();

        // 同版本重复安装:已装文件不被破坏(幂等)
        fs::write(inst.join("corpus").join("a.md"), "user-should-not-see-this-lost").unwrap();
        // 计数一致+版本一致 → 跳过,不覆盖
        install_corpus(&res, &inst).unwrap();

        // 升级:新版本移除 a 新增 b,旧文件应被清理
        std::fs::remove_file(res.join("corpus").join("a.md")).unwrap();
        make_bundled(&res, 2, &["b"]);
        let status = install_corpus(&res, &inst).unwrap();
        assert_eq!(status.installed_version, Some(2));
        assert!(!inst.join("corpus").join("a.md").exists());
        assert!(inst.join("corpus").join("b.md").exists());
    }

    #[test]
    fn uninstall_removes_only_managed_files() {
        let tmp = tempfile::tempdir().unwrap();
        let res = tmp.path().join("res");
        let inst = tmp.path().join("inst");
        make_bundled(&res, 1, &["a"]);
        install_corpus(&res, &inst).unwrap();
        fs::write(inst.join("user-note.md"), "keep me").unwrap();

        uninstall_corpus(&inst).unwrap();
        assert!(!inst.join("corpus").exists());
        assert!(!inst.join("catalog.json").exists());
        assert!(inst.join("user-note.md").exists());
    }

    #[test]
    fn load_catalog_parses_entries() {
        let tmp = tempfile::tempdir().unwrap();
        make_bundled(tmp.path(), 1, &["x"]);
        let catalog = load_catalog(tmp.path()).unwrap();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].slug, "x");
    }

    #[test]
    fn status_without_install() {
        let tmp = tempfile::tempdir().unwrap();
        let res = tmp.path().join("res");
        make_bundled(&res, 3, &["a"]);
        let status = corpus_status(&res, &tmp.path().join("missing"));
        assert_eq!(status.installed_version, None);
        assert_eq!(status.bundled_version, 3);
        assert_eq!(status.bundled_count, 1);
        assert_eq!(status.installed_count, 0);
    }

    #[test]
    fn activation_installed_and_loaded_with_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let res = tmp.path().join("res");
        let inst = tmp.path().join("inst");
        make_bundled(&res, 1, &["a"]);
        let act = res.join("activation");
        fs::create_dir_all(&act).unwrap();
        fs::write(act.join("a.md"), "## a\n[PHASE] [TASK ID] [ACCEPTANCE CRITERIA] [REFERENCE DOCUMENTS]").unwrap();
        fs::write(act.join("_generic.md"), "## generic\n[AGENT_NAME]").unwrap();

        install_corpus(&res, &inst).unwrap();
        // 专属模板命中,占位符原样保留
        let a = load_activation(&inst, "a").unwrap();
        assert!(a.contains("[PHASE]") && a.contains("[ACCEPTANCE CRITERIA]"));
        // 无专属模板 → 回退 generic
        let other = load_activation(&inst, "no-template").unwrap();
        assert!(other.contains("[AGENT_NAME]"));
        // 卸载后 activation 目录清理
        uninstall_corpus(&inst).unwrap();
        assert!(load_activation(&inst, "a").is_none());
    }

    #[test]
    fn index_skill_install_and_uninstall() {
        let tmp = tempfile::tempdir().unwrap();
        let res = tmp.path().join("res");
        let skills = tmp.path().join("skills");
        fs::create_dir_all(&res).unwrap();
        fs::write(res.join("agent-index.md"), "# Agent Index\n\n- a — A — 干活").unwrap();

        install_index_skill(&res, &skills).unwrap();
        let content =
            fs::read_to_string(skills.join("nexus-agent-index").join("SKILL.md")).unwrap();
        assert!(content.starts_with("---\nname: nexus-agent-index"));
        assert!(content.contains("- a — A — 干活"));

        uninstall_index_skill(&skills).unwrap();
        assert!(!skills.join("nexus-agent-index").exists());
    }
}
