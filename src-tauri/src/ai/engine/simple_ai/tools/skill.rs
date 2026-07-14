/*! read_skill 工具（Phase 4c）：按需读取 skill 全文（progressive disclosure）。
 *
 * 与 `simple_ai::skill::build_skill_index_message` 配对：索引用于注入上下文，
 * 本工具用于模型主动加载某个 skill 的完整指令。
 */

use serde_json::{json, Value};

use super::super::skill::SkillEntry;
use super::{truncate_chars, Tool, ToolContext, ToolOutcome};

pub(super) struct ReadSkillTool;

#[async_trait::async_trait]
impl Tool for ReadSkillTool {
    fn name(&self) -> &'static str {
        "read_skill"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "read_skill",
                "description": "Read the full content of a skill by name. Skills are listed in the 'Available skills' section of the conversation. Call this when a task matches a skill's description, to load its detailed instructions before proceeding.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "The skill name (from the Available skills list)" }
                    },
                    "required": ["name"]
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let name = args["name"].as_str().unwrap_or("");
        if name.is_empty() {
            return ToolOutcome::fail("read_skill requires a 'name' parameter".to_string());
        }
        match ctx.skills.get(name) {
            Some(skill) => ToolOutcome::ok(truncate_chars(&skill.full_text, 16_384)),
            None => {
                let available: Vec<&str> = ctx.skills.keys().map(|s| s.as_str()).collect();
                ToolOutcome::fail(format!(
                    "Skill '{}' not found. Available: {}",
                    name,
                    available.join(", ")
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use tokio::sync::watch;

    fn make_ctx<'a>(
        skills: &'a HashMap<String, SkillEntry>,
        cb: &'a Arc<dyn Fn(crate::models::AIEvent) + Send + Sync>,
        started: &'a AtomicBool,
        profile: &'a crate::models::config::ModelProfile,
        mcp_servers: &'a [crate::services::mcp_config_service::ResolvedExternalMcpServer],
    ) -> ToolContext<'a> {
        let abort_rx = Box::leak(Box::new(watch::channel(false).1));
        ToolContext {
            work_dir: ".",
            session_id: "s",
            event_callback: cb,
            plan_id: "s-plan",
            plan_started: started,
            skills,
            profile,
            mcp_servers,
            subagent_depth: 0,
            abort_rx,
        }
    }

    #[tokio::test]
    async fn read_skill_returns_full_text() {
        let mut skills = HashMap::new();
        skills.insert(
            "pdf".to_string(),
            SkillEntry {
                name: "pdf".into(),
                description: "PDF extraction".into(),
                full_text: "# PDF Skill\nExtract text from PDFs".into(),
            },
        );
        let cb: Arc<dyn Fn(crate::models::AIEvent) + Send + Sync> = Arc::new(|_| ());
        let started = AtomicBool::new(false);
        let profile = crate::models::config::ModelProfile::default();
        let mcp_servers: Vec<crate::services::mcp_config_service::ResolvedExternalMcpServer> =
            Vec::new();
        let ctx = make_ctx(&skills, &cb, &started, &profile, &mcp_servers);
        let out = ReadSkillTool.execute(&json!({ "name": "pdf" }), &ctx).await;
        assert!(out.success);
        assert!(out.content.contains("Extract text from PDFs"));
    }

    #[tokio::test]
    async fn read_skill_fails_for_unknown_name() {
        let skills = HashMap::new();
        let cb: Arc<dyn Fn(crate::models::AIEvent) + Send + Sync> = Arc::new(|_| ());
        let started = AtomicBool::new(false);
        let profile = crate::models::config::ModelProfile::default();
        let mcp_servers: Vec<crate::services::mcp_config_service::ResolvedExternalMcpServer> =
            Vec::new();
        let ctx = make_ctx(&skills, &cb, &started, &profile, &mcp_servers);
        let out = ReadSkillTool
            .execute(&json!({ "name": "nope" }), &ctx)
            .await;
        assert!(!out.success);
        assert!(out.content.contains("not found"));
    }

    #[tokio::test]
    async fn read_skill_rejects_empty_name() {
        let skills = HashMap::new();
        let cb: Arc<dyn Fn(crate::models::AIEvent) + Send + Sync> = Arc::new(|_| ());
        let started = AtomicBool::new(false);
        let profile = crate::models::config::ModelProfile::default();
        let mcp_servers: Vec<crate::services::mcp_config_service::ResolvedExternalMcpServer> =
            Vec::new();
        let ctx = make_ctx(&skills, &cb, &started, &profile, &mcp_servers);
        let out = ReadSkillTool.execute(&json!({ "name": "" }), &ctx).await;
        assert!(!out.success);
    }
}
