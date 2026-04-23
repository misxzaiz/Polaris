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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equals: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "type")]
    pub expect_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<ExpectRange>,
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
