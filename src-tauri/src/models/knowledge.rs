//! Knowledge base data models
//!
//! Types aligned with .polaris/knowledge/index.v2.json schema.
//! Shared between UnifiedKnowledgeRepository (Tauri IPC) and MCP server.

use serde::{Deserialize, Serialize};

// =============================================================================
// Enums
// =============================================================================

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Complexity {
    #[default]
    Medium,
    Low,
    High,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeFrequency {
    #[default]
    Medium,
    Low,
    High,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Green,
    Yellow,
    #[default]
    Orange,
    Red,
    Black,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Low,
    #[default]
    Medium,
    High,
}

// =============================================================================
// Assertion
// =============================================================================

/// Code anchor pointing to a specific location in the codebase
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssertionAnchor {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

/// Expectation for machine-checkable validation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssertionExpect {
    /// Flexible equals: accepts both string and numeric values in JSON.
    /// Serialized as the original type (string or number).
    #[serde(skip_serializing_if = "Option::is_none", default, deserialize_with = "deserialize_flex_equals")]
    pub equals: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "type")]
    pub expect_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<ExpectRange>,
}

/// Deserialize equals field: accept string ("foo"), number (20), or null
fn deserialize_flex_equals<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let val: Option<serde_json::Value> = Option::deserialize(deserializer)?;
    Ok(val.and_then(|v| match v {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExpectRange {
    pub min: f64,
    pub max: f64,
}

/// A knowledge assertion — a verifiable claim about the codebase
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeAssertion {
    pub id: String,
    pub claim: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub anchor: Option<AssertionAnchor>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub expect: Option<AssertionExpect>,
    #[serde(default)]
    pub confidence: Confidence,
    #[serde(default)]
    pub trap: bool,
    #[serde(default)]
    pub source: String,
}

// =============================================================================
// Trap
// =============================================================================

/// A knowledge trap — a known pitfall or gotcha
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeTrap {
    pub id: String,
    pub description: String,
    #[serde(default)]
    pub severity: Severity,
    #[serde(default)]
    pub source: String,
    /// Related files (optional, used by some traps)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub files: Option<Vec<String>>,
    /// Location hint (optional, e.g. "src/foo.rs:42")
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub location: Option<String>,
    /// Source file (optional, some traps use this instead of location)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub file: Option<String>,
    /// Line number (optional)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub line: Option<u32>,
}

// =============================================================================
// Module Scope
// =============================================================================

/// File scope specification (glob patterns)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModuleScope {
    pub include: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exclude: Option<Vec<String>>,
}

// =============================================================================
// Domain
// =============================================================================

/// A domain grouping for modules
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DomainDefinition {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    pub modules: Vec<String>,
}

// =============================================================================
// Workspace Meta
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMeta {
    #[serde(default)]
    pub root_path: String,
    #[serde(default)]
    pub language: Vec<String>,
    #[serde(default)]
    pub framework: Vec<String>,
}

// =============================================================================
// Module (v2 entry)
// =============================================================================

/// A knowledge module entry in the v2 index
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeModule {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub scope: Option<ModuleScope>,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub dependents: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub document_file: Option<String>,
    #[serde(default)]
    pub complexity: Complexity,
    #[serde(default)]
    pub change_frequency: ChangeFrequency,
    #[serde(default)]
    pub assertions: Vec<KnowledgeAssertion>,
    #[serde(default)]
    pub traps: Vec<KnowledgeTrap>,
}

// =============================================================================
// Module Index (v2)
// =============================================================================

/// Top-level v2 index structure
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeIndex {
    /// $schema field from JSON (ignored on deserialization)
    #[serde(rename = "$schema", skip_serializing)]
    pub schema_ref: Option<String>,
    #[serde(default)]
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub schema_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub generated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub workspace: Option<WorkspaceMeta>,
    #[serde(default)]
    pub domains: Vec<DomainDefinition>,
    #[serde(default)]
    pub modules: Vec<KnowledgeModule>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub global_conventions: Option<Vec<serde_json::Value>>,
}

// =============================================================================
// Module Detail (for get_module response)
// =============================================================================

/// Full module detail including document content
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleDetail {
    #[serde(flatten)]
    pub module: KnowledgeModule,
    /// Markdown document content (loaded from modules/*.md)
    pub document: Option<String>,
}

// =============================================================================
// Command parameter structs
// =============================================================================

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeListModulesParams {
    pub workspace_path: Option<String>,
    /// Optional domain filter
    pub domain: Option<String>,
    /// Optional search query
    pub query: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGetModuleParams {
    pub workspace_path: Option<String>,
    pub id: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCreateModuleParams {
    pub workspace_path: Option<String>,
    pub id: String,
    pub name: String,
    pub domain: Option<String>,
    pub scope: Option<ModuleScope>,
    pub dependencies: Option<Vec<String>>,
    pub complexity: Option<String>,
    pub change_frequency: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeUpdateModuleParams {
    pub workspace_path: Option<String>,
    pub id: String,
    pub name: Option<String>,
    pub domain: Option<String>,
    pub scope: Option<ModuleScope>,
    pub dependencies: Option<Vec<String>>,
    pub complexity: Option<String>,
    pub change_frequency: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDeleteModuleParams {
    pub workspace_path: Option<String>,
    pub id: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeUpdateDocumentParams {
    pub workspace_path: Option<String>,
    pub module_id: String,
    pub content: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCreateAssertionParams {
    pub workspace_path: Option<String>,
    pub module_id: String,
    pub assertion: KnowledgeAssertion,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeUpdateAssertionParams {
    pub workspace_path: Option<String>,
    pub module_id: String,
    pub assertion_id: String,
    pub claim: Option<String>,
    pub anchor: Option<AssertionAnchor>,
    pub expect: Option<AssertionExpect>,
    pub confidence: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDeleteAssertionParams {
    pub workspace_path: Option<String>,
    pub module_id: String,
    pub assertion_id: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCreateTrapParams {
    pub workspace_path: Option<String>,
    pub module_id: String,
    pub trap: KnowledgeTrap,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeUpdateTrapParams {
    pub workspace_path: Option<String>,
    pub module_id: String,
    pub trap_id: String,
    pub description: Option<String>,
    pub severity: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDeleteTrapParams {
    pub workspace_path: Option<String>,
    pub module_id: String,
    pub trap_id: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeListDomainsParams {
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeInitParams {
    pub workspace_path: Option<String>,
}

// =============================================================================
// Drift-prevention sentry tests
// =============================================================================
//
// The Tauri-side knowledge models duplicate part of the `polaris-knowledge-mcp`
// crate's v2 schema. Until Phase 5 of the plugin refactor unifies the two, this
// sentry locks the Tauri-side model to the live `.polaris/knowledge/index.v2.json`
// shape so a unilateral change here cannot silently break IPC deserialization
// in production.
//
// The test is skipped (not failed) when the live file is absent.

#[cfg(test)]
mod live_data_sentry {
    use super::*;
    use std::path::PathBuf;

    fn live_index_path() -> PathBuf {
        // src-tauri/  →  workspace root
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".polaris")
            .join("knowledge")
            .join("index.v2.json")
    }

    #[test]
    fn live_v2_index_deserializes_with_tauri_model() {
        let path = live_index_path();
        if !path.exists() {
            eprintln!(
                "[sentry] live index not found at {}, skipping",
                path.display()
            );
            return;
        }

        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read live index ({}): {e}", path.display()));

        let index: KnowledgeIndex = serde_json::from_str(&raw).unwrap_or_else(|e| {
            panic!(
                "Tauri-side KnowledgeIndex rejected live data at {}: {e}",
                path.display()
            )
        });

        assert_eq!(
            index.schema_version.as_deref(),
            Some("assertion-based"),
            "schemaVersion in live data must be 'assertion-based'"
        );
        assert!(
            !index.modules.is_empty(),
            "live index must contain at least one module"
        );
        assert!(
            !index.domains.is_empty(),
            "live index must contain at least one domain"
        );

        // Each module's enum-valued fields must round-trip cleanly.
        for m in &index.modules {
            // Re-encode and re-decode each module to ensure no field is lost.
            let s = serde_json::to_string(m)
                .unwrap_or_else(|e| panic!("serialize module {}: {e}", m.id));
            let _: KnowledgeModule = serde_json::from_str(&s)
                .unwrap_or_else(|e| panic!("reparse module {}: {e}", m.id));
        }
    }

    #[test]
    fn live_v2_index_roundtrips_through_tauri_model() {
        let path = live_index_path();
        if !path.exists() {
            eprintln!(
                "[sentry] live index not found at {}, skipping",
                path.display()
            );
            return;
        }

        let raw = std::fs::read_to_string(&path).expect("read live index");
        let parsed: KnowledgeIndex =
            serde_json::from_str(&raw).expect("first parse must succeed");
        let reserialized = serde_json::to_string(&parsed).expect("serialize");
        let reparsed: KnowledgeIndex =
            serde_json::from_str(&reserialized).expect("reparse");

        assert_eq!(parsed.modules.len(), reparsed.modules.len());
        assert_eq!(parsed.domains.len(), reparsed.domains.len());
    }
}
