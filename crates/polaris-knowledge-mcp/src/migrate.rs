//! v1 → v2 migration logic.
//!
//! Converts a legacy [`KnowledgeIndex`] (v1) into a [`KnowledgeIndexV2`]
//! (assertion-based) without losing information. The migration is **non-
//! destructive**: the original v1 file stays on disk, and v2 is emitted as a
//! parallel `index.v2.json`.
//!
//! Migration rules
//! ---------------
//! * Flat `scope: [String]` → `ScopeSpec { include, exclude: [] }`.
//! * Unknown complexity / changeFrequency strings are coerced to `Medium`,
//!   with a warning surfaced via the returned [`MigrationReport`].
//! * Modules are distributed into domains using [`default_domain_map`], which
//!   encodes Polaris's current 4-domain topology. Unmapped modules fall into
//!   the synthetic `unclassified` domain so no data is lost.
//! * Assertions/traps are empty on migration — those are produced later by
//!   the extractor + curation pipeline.

use std::collections::BTreeMap;

use crate::error::{KnowledgeError, Result};
use crate::models::{
    ChangeFrequency, Complexity, Domain, KnowledgeIndex, KnowledgeIndexV2, ModuleEntry, ModuleV2,
    ScopeSpec, WorkspaceInfo, V2_SCHEMA_VERSION,
};

/// Report produced alongside a migration, carrying lossy-conversion warnings.
#[derive(Debug, Default, Clone)]
pub struct MigrationReport {
    pub warnings: Vec<String>,
    pub module_count: usize,
    pub domain_count: usize,
    pub unclassified: Vec<String>,
}

/// Default Polaris domain topology. Maps module id → domain id.
///
/// Keep this in sync with `docs/knowledge-domains.md` (future) and with the
/// domains array produced by [`migrate_index`]. Missing entries go to the
/// `unclassified` bucket and must be curated by hand.
pub fn default_domain_map() -> BTreeMap<&'static str, &'static str> {
    let mut map = BTreeMap::new();
    // ai-conversation — everything that produces/shows the AI dialog
    map.insert("ai-engine", "ai-conversation");
    map.insert("chat-session", "ai-conversation");
    map.insert("chat-render", "ai-conversation");
    map.insert("assistant", "ai-conversation");

    // data-management — stateful data surfaces
    map.insert("todo-requirement", "data-management");
    map.insert("scheduler", "data-management");
    map.insert("config-settings", "data-management");

    // developer-tools — IDE-like capabilities
    map.insert("git", "developer-tools");
    map.insert("terminal", "developer-tools");
    map.insert("workspace", "developer-tools");
    map.insert("mcp", "developer-tools");

    // platform-integration — bridges, UI chrome, voice
    map.insert("integration", "platform-integration");
    map.insert("speech-voice", "platform-integration");
    map.insert("ipc-bridge", "platform-integration");
    map.insert("ui-framework", "platform-integration");
    map
}

/// Pretty domain names.
fn default_domain_name(id: &str) -> &'static str {
    match id {
        "ai-conversation" => "AI 对话",
        "data-management" => "数据与持久化",
        "developer-tools" => "开发者工具",
        "platform-integration" => "平台集成",
        "unclassified" => "未分类（需人工分配）",
        _ => "未分类",
    }
}

/// Migrate a v1 index into a v2 index.
///
/// Does NOT touch disk. Callers are responsible for writing the result to
/// `.polaris/knowledge/index.v2.json` (or wherever the v2 file lives).
pub fn migrate_index(v1: &KnowledgeIndex, workspace_root: &str) -> Result<(KnowledgeIndexV2, MigrationReport)> {
    if v1.modules.is_empty() {
        return Err(KnowledgeError::Validation(
            "Cannot migrate empty v1 index".into(),
        ));
    }

    let domain_map = default_domain_map();
    let mut report = MigrationReport {
        module_count: v1.modules.len(),
        ..Default::default()
    };

    // Distribute modules to domains.
    let mut domain_buckets: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut modules_v2 = Vec::with_capacity(v1.modules.len());

    for entry in &v1.modules {
        let domain_id = domain_map
            .get(entry.id.as_str())
            .map(|s| (*s).to_string())
            .unwrap_or_else(|| {
                report.unclassified.push(entry.id.clone());
                "unclassified".to_string()
            });

        domain_buckets
            .entry(domain_id.clone())
            .or_default()
            .push(entry.id.clone());

        modules_v2.push(convert_module(entry, &domain_id, &mut report));
    }

    if !report.unclassified.is_empty() {
        report.warnings.push(format!(
            "{} modules were placed in the `unclassified` domain and need manual assignment: {}",
            report.unclassified.len(),
            report.unclassified.join(", ")
        ));
    }

    // Build domains vector, stable-sorted for reproducible output.
    let mut domains: Vec<Domain> = domain_buckets
        .into_iter()
        .map(|(id, mut modules)| {
            modules.sort();
            Domain {
                name: default_domain_name(&id).to_string(),
                id,
                description: None,
                modules,
            }
        })
        .collect();
    domains.sort_by(|a, b| a.id.cmp(&b.id));
    report.domain_count = domains.len();

    let v2 = KnowledgeIndexV2 {
        version: bump_minor(&v1.version),
        schema_version: V2_SCHEMA_VERSION.to_string(),
        generated_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        workspace: WorkspaceInfo {
            root_path: workspace_root.to_string(),
            language: detect_languages(v1),
            framework: Vec::new(),
        },
        domains,
        modules: modules_v2,
        global_conventions: Vec::new(),
    };

    Ok((v2, report))
}

/// Convert a single v1 module entry into a v2 module, emitting warnings for
/// coerced fields.
fn convert_module(entry: &ModuleEntry, domain_id: &str, report: &mut MigrationReport) -> ModuleV2 {
    let complexity = parse_complexity(&entry.complexity).unwrap_or_else(|| {
        report.warnings.push(format!(
            "module `{}` has unknown complexity `{}`, coerced to medium",
            entry.id, entry.complexity
        ));
        Complexity::Medium
    });
    let change_frequency = parse_change_frequency(&entry.change_frequency).unwrap_or_else(|| {
        report.warnings.push(format!(
            "module `{}` has unknown changeFrequency `{}`, coerced to medium",
            entry.id, entry.change_frequency
        ));
        ChangeFrequency::Medium
    });

    // v1 flat scope → v2 glob. We normalize separators and promote trailing
    // slashes to `**` so directory entries match recursively.
    let include: Vec<String> = entry
        .scope
        .iter()
        .map(|raw| normalize_scope_entry(raw))
        .collect();

    ModuleV2 {
        id: entry.id.clone(),
        name: entry.name.clone(),
        domain: domain_id.to_string(),
        scope: ScopeSpec {
            include,
            exclude: Vec::new(),
        },
        dependencies: entry.dependencies.clone(),
        dependents: entry.dependents.clone(),
        document_file: entry.file.clone(),
        structure_file: None,
        complexity,
        change_frequency,
        assertions: Vec::new(),
        traps: Vec::new(),
    }
}

/// Normalize a v1 scope string.
///
/// * `"src/foo/"` → `"src/foo/**"`
/// * `"src\\foo"` → `"src/foo"`
/// * globs passed through untouched.
fn normalize_scope_entry(raw: &str) -> String {
    let forward = raw.replace('\\', "/");
    if forward.ends_with('/') {
        format!("{}**", forward)
    } else {
        forward
    }
}

fn parse_complexity(raw: &str) -> Option<Complexity> {
    match raw.to_ascii_lowercase().as_str() {
        "low" => Some(Complexity::Low),
        "medium" => Some(Complexity::Medium),
        "high" => Some(Complexity::High),
        _ => None,
    }
}

fn parse_change_frequency(raw: &str) -> Option<ChangeFrequency> {
    match raw.to_ascii_lowercase().as_str() {
        "low" => Some(ChangeFrequency::Low),
        "medium" => Some(ChangeFrequency::Medium),
        "high" => Some(ChangeFrequency::High),
        _ => None,
    }
}

/// Bump the minor version component of a semver string; if it cannot be
/// parsed, we fall back to appending `-v2`.
fn bump_minor(v1_version: &str) -> String {
    let parts: Vec<&str> = v1_version.split('.').collect();
    if parts.len() == 3 {
        if let (Ok(major), Ok(minor), Ok(patch)) = (
            parts[0].parse::<u32>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<u32>(),
        ) {
            return format!("{}.{}.{}", major + 1, minor, patch);
        }
    }
    format!("{}-v2", v1_version)
}

/// Cheap heuristic: inspect v1 scope paths to detect dominant languages.
fn detect_languages(v1: &KnowledgeIndex) -> Vec<String> {
    let mut ts = false;
    let mut rs = false;
    for m in &v1.modules {
        for s in &m.scope {
            if s.contains("src-tauri") || s.contains(".rs") {
                rs = true;
            }
            if s.contains("src/") && !s.contains("src-tauri") {
                ts = true;
            }
        }
    }
    let mut langs = Vec::new();
    if ts {
        langs.push("typescript".into());
    }
    if rs {
        langs.push("rust".into());
    }
    langs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ModuleEntry;

    fn sample_v1(count: usize) -> KnowledgeIndex {
        let ids = [
            "chat-render",
            "chat-session",
            "ai-engine",
            "mcp",
            "some-future-module",
        ];
        let modules = ids
            .iter()
            .take(count)
            .map(|id| ModuleEntry {
                id: (*id).into(),
                name: format!("Module {}", id),
                scope: vec![format!("src/{}/", id), "src-tauri/src/".into()],
                dependencies: Vec::new(),
                dependents: Vec::new(),
                file: format!("{}.md", id),
                complexity: "high".into(),
                change_frequency: "medium".into(),
            })
            .collect();
        KnowledgeIndex {
            version: "1.0.0".into(),
            modules,
        }
    }

    #[test]
    fn migrate_basic_index() {
        let v1 = sample_v1(4);
        let (v2, report) =
            migrate_index(&v1, "/workspace").expect("migration must succeed on non-empty input");

        assert_eq!(v2.schema_version, V2_SCHEMA_VERSION);
        assert_eq!(v2.modules.len(), 4);
        assert_eq!(report.module_count, 4);
        assert!(!v2.domains.is_empty(), "domains must be emitted");
        // chat-render lives in ai-conversation per the default map.
        let chat_render = v2
            .modules
            .iter()
            .find(|m| m.id == "chat-render")
            .expect("chat-render preserved");
        assert_eq!(chat_render.domain, "ai-conversation");
    }

    #[test]
    fn unmapped_modules_land_in_unclassified() {
        let v1 = sample_v1(5); // includes "some-future-module"
        let (v2, report) = migrate_index(&v1, "/workspace").unwrap();
        assert!(report.unclassified.contains(&"some-future-module".to_string()));
        let has_unclassified = v2.domains.iter().any(|d| d.id == "unclassified");
        assert!(has_unclassified, "unclassified domain must exist");
        assert!(!report.warnings.is_empty(), "warnings must surface");
    }

    #[test]
    fn scope_trailing_slash_promotes_to_globstar() {
        assert_eq!(normalize_scope_entry("src/foo/"), "src/foo/**");
        assert_eq!(normalize_scope_entry("src/foo"), "src/foo");
        assert_eq!(normalize_scope_entry("src\\bar\\baz"), "src/bar/baz");
    }

    #[test]
    fn complexity_and_change_frequency_fallback_coerce_to_medium() {
        let mut v1 = sample_v1(1);
        v1.modules[0].complexity = "extreme".into();
        v1.modules[0].change_frequency = "glacial".into();

        let (v2, report) = migrate_index(&v1, "/workspace").unwrap();
        assert_eq!(v2.modules[0].complexity, Complexity::Medium);
        assert_eq!(v2.modules[0].change_frequency, ChangeFrequency::Medium);
        assert_eq!(report.warnings.len(), 2);
    }

    #[test]
    fn empty_index_errors() {
        let empty = KnowledgeIndex {
            version: "1.0.0".into(),
            modules: Vec::new(),
        };
        assert!(migrate_index(&empty, "/workspace").is_err());
    }

    #[test]
    fn version_bump_major() {
        assert_eq!(bump_minor("1.0.0"), "2.0.0");
        assert_eq!(bump_minor("not-semver"), "not-semver-v2");
    }

    #[test]
    fn language_detection_heuristic() {
        let v1 = sample_v1(2);
        let (v2, _) = migrate_index(&v1, "/workspace").unwrap();
        assert!(v2.workspace.language.contains(&"typescript".to_string()));
        assert!(v2.workspace.language.contains(&"rust".to_string()));
    }
}
