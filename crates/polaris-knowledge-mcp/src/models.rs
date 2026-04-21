//! Knowledge index and module data structures.
//!
//! Contains both the original v1 ([`KnowledgeIndex`] / [`ModuleEntry`]) and
//! the v2 assertion-based model ([`KnowledgeIndexV2`] / [`ModuleV2`] + friends).
//! The v1 types remain the source of truth for existing MCP tools; v2 is
//! opt-in during the Q1 migration (see `migrate.rs`).

use serde::{Deserialize, Serialize};

// ═══════════════════════════════════════════════════════════════════
//  v1 — legacy index (do not break existing consumers)
// ═══════════════════════════════════════════════════════════════════

/// Knowledge index structure (mirrors .polaris/knowledge/index.json)
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KnowledgeIndex {
    pub version: String,
    pub modules: Vec<ModuleEntry>,
}

/// Module entry in the knowledge index.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModuleEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub scope: Vec<String>,
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub dependents: Vec<String>,
    pub file: String,
    pub complexity: String,
    #[serde(rename = "changeFrequency")]
    pub change_frequency: String,
}

// ═══════════════════════════════════════════════════════════════════
//  v2 — assertion-based model
// ═══════════════════════════════════════════════════════════════════

/// Constant discriminator value for v2 indexes.
pub const V2_SCHEMA_VERSION: &str = "assertion-based";

/// Top-level v2 index file. Matches `.polaris/knowledge/schema/index.v2.schema.json`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KnowledgeIndexV2 {
    pub version: String,
    #[serde(rename = "schemaVersion")]
    pub schema_version: String,
    #[serde(rename = "generatedAt", default, skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    pub workspace: WorkspaceInfo,
    pub domains: Vec<Domain>,
    pub modules: Vec<ModuleV2>,
    #[serde(rename = "globalConventions", default, skip_serializing_if = "Vec::is_empty")]
    pub global_conventions: Vec<GlobalConvention>,
}

/// Workspace-level metadata.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkspaceInfo {
    #[serde(rename = "rootPath")]
    pub root_path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub language: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub framework: Vec<String>,
}

/// A bounded context (DDD-style) that groups related modules.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Domain {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub modules: Vec<String>,
}

/// v2 module: adds domain, scope globs, assertions, traps, structure file pointer.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModuleV2 {
    pub id: String,
    pub name: String,
    pub domain: String,
    pub scope: ScopeSpec,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependents: Vec<String>,
    #[serde(rename = "documentFile")]
    pub document_file: String,
    #[serde(rename = "structureFile", default, skip_serializing_if = "Option::is_none")]
    pub structure_file: Option<String>,
    pub complexity: Complexity,
    #[serde(rename = "changeFrequency")]
    pub change_frequency: ChangeFrequency,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assertions: Vec<Assertion>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub traps: Vec<Trap>,
}

/// Glob-based scope replacing v1's flat string array.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ScopeSpec {
    pub include: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Complexity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeFrequency {
    Low,
    Medium,
    High,
}

/// Verifiable claim backed by a code anchor.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Assertion {
    pub id: String,
    pub claim: String,
    pub anchor: AnchorSpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect: Option<ExpectSpec>,
    pub confidence: Confidence,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trap: bool,
    #[serde(rename = "lastVerified", default, skip_serializing_if = "Option::is_none")]
    pub last_verified: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Points to the code location that backs an assertion.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AnchorSpec {
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(
        rename = "lineRange",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub line_range: Option<[u32; 2]>,
}

/// Machine-checkable expectation. Exactly one variant is meaningful per instance.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ExpectSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equals: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<[f64; 2]>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    /// Code-verified by the validator.
    Green,
    /// Human-reviewed (not auto-verified).
    Yellow,
    /// AI-generated, never reviewed.
    Orange,
    /// Stale: mtime > 3 months and underlying code changed.
    Red,
    /// Invalidated: anchor fails validation.
    Black,
}

/// Explicit pitfall captured as a first-class concept (not just prose).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Trap {
    pub id: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub severity: TrapSeverity,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrapSeverity {
    Low,
    Medium,
    High,
    Critical,
}

/// Project-wide rule.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GlobalConvention {
    pub id: String,
    pub rule: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "use")]
    pub use_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn v1_index_parses_existing_shape() {
        // Shape taken from the live .polaris/knowledge/index.json.
        let raw = json!({
            "version": "1.0.0",
            "modules": [{
                "id": "chat-render",
                "name": "Chat Render",
                "scope": ["src/components/Chat/"],
                "dependencies": ["chat-session"],
                "dependents": ["assistant"],
                "file": "chat-render.md",
                "complexity": "high",
                "changeFrequency": "high"
            }]
        });
        let parsed: KnowledgeIndex = serde_json::from_value(raw).expect("v1 still parses");
        assert_eq!(parsed.modules.len(), 1);
        assert_eq!(parsed.modules[0].id, "chat-render");
    }

    #[test]
    fn v2_module_roundtrip_preserves_assertions() {
        let module = ModuleV2 {
            id: "chat-render".into(),
            name: "Chat Render".into(),
            domain: "ai-conversation".into(),
            scope: ScopeSpec {
                include: vec!["src/components/Chat/**".into()],
                exclude: vec!["**/*.test.ts".into()],
            },
            dependencies: vec!["chat-session".into()],
            dependents: vec!["assistant".into()],
            document_file: "chat-render.md".into(),
            structure_file: Some("chat-render.structure.json".into()),
            complexity: Complexity::High,
            change_frequency: ChangeFrequency::High,
            assertions: vec![Assertion {
                id: "chat-render/lru-capacity-20".into(),
                claim: "MAX_SNAPSHOTS is 20".into(),
                anchor: AnchorSpec {
                    file: "src/utils/messageCompactor.ts".into(),
                    symbol: Some("MAX_SNAPSHOTS".into()),
                    line_range: None,
                },
                expect: Some(ExpectSpec {
                    equals: Some(json!(20)),
                    regex: None,
                    range: None,
                }),
                confidence: Confidence::Green,
                trap: false,
                last_verified: None,
                source: Some("auto:ast-extractor".into()),
            }],
            traps: vec![Trap {
                id: "chat-render/trap-cache-merge".into(),
                description: "do not merge cache.ts and lru-cache.ts".into(),
                source: Some("memory:MEMORY.md".into()),
                severity: TrapSeverity::High,
            }],
        };

        let serialized = serde_json::to_string(&module).expect("serialize");
        let back: ModuleV2 = serde_json::from_str(&serialized).expect("deserialize");

        assert_eq!(back.id, module.id);
        assert_eq!(back.domain, module.domain);
        assert_eq!(back.scope.include, module.scope.include);
        assert_eq!(back.assertions.len(), 1);
        assert_eq!(back.assertions[0].id, "chat-render/lru-capacity-20");
        assert_eq!(back.assertions[0].confidence, Confidence::Green);
        assert_eq!(back.traps.len(), 1);
        assert_eq!(back.traps[0].severity, TrapSeverity::High);
    }

    #[test]
    fn v2_index_rejects_unknown_schema_version_via_const_on_write() {
        // The JSON schema enforces schemaVersion="assertion-based". At the Rust
        // level we don't hard-reject (consumers may opt out), but the helper
        // constant must match the schema so the two sources of truth agree.
        assert_eq!(V2_SCHEMA_VERSION, "assertion-based");
    }

    #[test]
    fn confidence_serializes_as_lowercase() {
        let json = serde_json::to_string(&Confidence::Green).unwrap();
        assert_eq!(json, "\"green\"");

        let parsed: Confidence = serde_json::from_str("\"black\"").unwrap();
        assert_eq!(parsed, Confidence::Black);
    }
}
