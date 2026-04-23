//! Unified Knowledge Repository
//!
//! Reads/writes .polaris/knowledge/ directory for Tauri IPC commands.
//! Follows the same pattern as UnifiedTodoRepository.

use crate::error::{AppError, Result};
use crate::models::knowledge::{
    ChangeFrequency, Complexity, Confidence, DomainDefinition, KnowledgeAssertion,
    KnowledgeIndex, KnowledgeModule, KnowledgeTrap, ModuleDetail, ModuleScope, Severity,
};
use chrono::Utc;
use std::path::PathBuf;

const V2_INDEX_FILE: &str = "index.v2.json";
const V1_INDEX_FILE: &str = "index.json";
const MODULES_DIR: &str = "modules";
const META_DIR: &str = "meta";

/// Unified repository for knowledge base CRUD
pub struct UnifiedKnowledgeRepository {
    /// .polaris/knowledge/ directory path
    knowledge_dir: PathBuf,
}

impl UnifiedKnowledgeRepository {
    pub fn new(_config_dir: PathBuf, workspace_path: Option<PathBuf>) -> Self {
        let knowledge_dir = workspace_path
            .unwrap_or_default()
            .join(".polaris")
            .join("knowledge");
        Self { knowledge_dir }
    }

    // =========================================================================
    // Read operations
    // =========================================================================

    /// Check if the knowledge base is initialized
    pub fn is_initialized(&self) -> bool {
        self.knowledge_dir.join(V2_INDEX_FILE).exists()
            || self.knowledge_dir.join(V1_INDEX_FILE).exists()
    }

    /// Read the v2 index, falling back to v1
    pub fn read_index(&self) -> Result<KnowledgeIndex> {
        let v2_path = self.knowledge_dir.join(V2_INDEX_FILE);
        if v2_path.exists() {
            let content = read_file_with_retry(&v2_path)?;
            let index: KnowledgeIndex = serde_json::from_str(&content)?;
            return Ok(index);
        }

        let v1_path = self.knowledge_dir.join(V1_INDEX_FILE);
        if v1_path.exists() {
            let content = read_file_with_retry(&v1_path)?;
            let v1: serde_json::Value = serde_json::from_str(&content)?;
            return Ok(migrate_v1_to_v2(&v1));
        }

        Err(AppError::ValidationError(
            "知识库未初始化".to_string(),
        ))
    }

    /// List all modules
    pub fn list_modules(&self) -> Result<Vec<KnowledgeModule>> {
        let index = self.read_index()?;
        Ok(index.modules)
    }

    /// Get a single module by ID with its document content
    pub fn get_module(&self, id: &str) -> Result<ModuleDetail> {
        let index = self.read_index()?;
        let module = index
            .modules
            .into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| AppError::ValidationError(format!("模块不存在: {}", id)))?;

        let document = self.read_module_document(&module).ok();
        Ok(ModuleDetail { module, document })
    }

    /// List all domains
    pub fn list_domains(&self) -> Result<Vec<DomainDefinition>> {
        let index = self.read_index()?;
        Ok(index.domains)
    }

    /// Read a module's markdown document
    fn read_module_document(&self, module: &KnowledgeModule) -> Result<String> {
        let doc_file = module
            .document_file
            .as_deref()
            .unwrap_or(&module.id);
        let doc_path = self
            .knowledge_dir
            .join(MODULES_DIR)
            .join(format!("{}.md", doc_file));

        if doc_path.exists() {
            read_file_with_retry(&doc_path)
        } else {
            Ok(String::new())
        }
    }

    // =========================================================================
    // Write operations
    // =========================================================================

    /// Initialize an empty knowledge base
    pub fn init_knowledge(&self) -> Result<KnowledgeIndex> {
        std::fs::create_dir_all(self.knowledge_dir.join(MODULES_DIR))?;
        std::fs::create_dir_all(self.knowledge_dir.join(META_DIR))?;

        let index = KnowledgeIndex {
            version: "2.0.0".to_string(),
            schema_version: Some("assertion-based".to_string()),
            generated_at: Some(now_iso()),
            workspace: None,
            domains: Vec::new(),
            modules: Vec::new(),
            global_conventions: None,
        };

        self.write_index(&index)?;
        Ok(index)
    }

    /// Create a new module
    pub fn create_module(
        &self,
        id: String,
        name: String,
        domain: Option<String>,
        scope: Option<ModuleScope>,
        dependencies: Option<Vec<String>>,
        complexity: Option<Complexity>,
        change_frequency: Option<ChangeFrequency>,
    ) -> Result<KnowledgeModule> {
        let id = id.trim().to_string();
        let name = name.trim().to_string();

        if id.is_empty() || name.is_empty() {
            return Err(AppError::ValidationError(
                "模块 ID 和名称不能为空".to_string(),
            ));
        }

        // Validate kebab-case ID
        if !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c == '-' || c.is_ascii_digit())
        {
            return Err(AppError::ValidationError(
                "模块 ID 只能包含小写字母、数字和连字符".to_string(),
            ));
        }

        let mut index = self.read_index()?;

        // Check duplicate
        if index.modules.iter().any(|m| m.id == id) {
            return Err(AppError::ValidationError(format!(
                "模块已存在: {}",
                id
            )));
        }

        let doc_file = id.clone();
        let module = KnowledgeModule {
            id: id.clone(),
            name,
            domain,
            scope,
            dependencies: dependencies.unwrap_or_default(),
            dependents: Vec::new(),
            document_file: Some(doc_file),
            complexity: complexity.unwrap_or_default(),
            change_frequency: change_frequency.unwrap_or_default(),
            assertions: Vec::new(),
            traps: Vec::new(),
        };

        // Create empty .md file
        let doc_path = self
            .knowledge_dir
            .join(MODULES_DIR)
            .join(format!("{}.md", id));
        if !doc_path.exists() {
            std::fs::write(&doc_path, format!("---\nmodule: {}\n---\n\n", id))?;
        }

        index.modules.push(module.clone());
        self.write_index(&index)?;
        Ok(module)
    }

    /// Update module metadata
    pub fn update_module(
        &self,
        id: &str,
        name: Option<String>,
        domain: Option<String>,
        scope: Option<ModuleScope>,
        dependencies: Option<Vec<String>>,
        complexity: Option<Complexity>,
        change_frequency: Option<ChangeFrequency>,
    ) -> Result<KnowledgeModule> {
        let mut index = self.read_index()?;
        let module = index
            .modules
            .iter_mut()
            .find(|m| m.id == id)
            .ok_or_else(|| AppError::ValidationError(format!("模块不存在: {}", id)))?;

        if let Some(name) = name {
            let trimmed = name.trim().to_string();
            if !trimmed.is_empty() {
                module.name = trimmed;
            }
        }
        if let Some(domain) = domain {
            module.domain = if domain.is_empty() {
                None
            } else {
                Some(domain)
            };
        }
        if let Some(scope) = scope {
            module.scope = Some(scope);
        }
        if let Some(deps) = dependencies {
            module.dependencies = deps;
        }
        if let Some(complexity) = complexity {
            module.complexity = complexity;
        }
        if let Some(change_frequency) = change_frequency {
            module.change_frequency = change_frequency;
        }

        let result = module.clone();
        self.write_index(&index)?;
        Ok(result)
    }

    /// Delete a module
    pub fn delete_module(&self, id: &str) -> Result<()> {
        let mut index = self.read_index()?;
        let module_idx = index
            .modules
            .iter()
            .position(|m| m.id == id)
            .ok_or_else(|| AppError::ValidationError(format!("模块不存在: {}", id)))?;

        let removed = index.modules.remove(module_idx);

        // Remove module from domain lists
        for domain in &mut index.domains {
            domain.modules.retain(|m| m != id);
        }

        // Remove module from dependents of other modules
        for module in &mut index.modules {
            module.dependencies.retain(|d| d != id);
            module.dependents.retain(|d| d != id);
        }

        // Delete .md file
        if let Some(doc_file) = &removed.document_file {
            let doc_path = self
                .knowledge_dir
                .join(MODULES_DIR)
                .join(format!("{}.md", doc_file));
            let _ = std::fs::remove_file(doc_path);
        }

        // Also try removing by ID name
        let doc_path_by_id = self
            .knowledge_dir
            .join(MODULES_DIR)
            .join(format!("{}.md", id));
        let _ = std::fs::remove_file(doc_path_by_id);

        self.write_index(&index)?;
        Ok(())
    }

    /// Update module document (markdown content)
    pub fn update_module_document(&self, module_id: &str, content: String) -> Result<()> {
        let index = self.read_index()?;
        let module = index
            .modules
            .into_iter()
            .find(|m| m.id == module_id)
            .ok_or_else(|| AppError::ValidationError(format!("模块不存在: {}", module_id)))?;

        let doc_file = module
            .document_file
            .as_deref()
            .unwrap_or(module_id);
        let doc_path = self
            .knowledge_dir
            .join(MODULES_DIR)
            .join(format!("{}.md", doc_file));

        std::fs::write(&doc_path, content)?;
        Ok(())
    }

    // =========================================================================
    // Assertion CRUD
    // =========================================================================

    /// Create an assertion for a module
    pub fn create_assertion(&self, module_id: &str, assertion: KnowledgeAssertion) -> Result<KnowledgeAssertion> {
        let mut index = self.read_index()?;
        let module = index
            .modules
            .iter_mut()
            .find(|m| m.id == module_id)
            .ok_or_else(|| AppError::ValidationError(format!("模块不存在: {}", module_id)))?;

        // Check duplicate assertion ID
        if module.assertions.iter().any(|a| a.id == assertion.id) {
            return Err(AppError::ValidationError(format!(
                "断言已存在: {}",
                assertion.id
            )));
        }

        module.assertions.push(assertion.clone());
        self.write_index(&index)?;
        Ok(assertion)
    }

    /// Update an assertion
    pub fn update_assertion(
        &self,
        module_id: &str,
        assertion_id: &str,
        claim: Option<String>,
        anchor: Option<crate::models::knowledge::AssertionAnchor>,
        expect: Option<crate::models::knowledge::AssertionExpect>,
        confidence: Option<Confidence>,
    ) -> Result<KnowledgeAssertion> {
        let mut index = self.read_index()?;
        let module = index
            .modules
            .iter_mut()
            .find(|m| m.id == module_id)
            .ok_or_else(|| AppError::ValidationError(format!("模块不存在: {}", module_id)))?;

        let assertion = module
            .assertions
            .iter_mut()
            .find(|a| a.id == assertion_id)
            .ok_or_else(|| {
                AppError::ValidationError(format!("断言不存在: {}", assertion_id))
            })?;

        if let Some(claim) = claim {
            assertion.claim = claim;
        }
        if let Some(anchor) = anchor {
            assertion.anchor = Some(anchor);
        }
        if let Some(expect) = expect {
            assertion.expect = Some(expect);
        }
        if let Some(confidence) = confidence {
            assertion.confidence = confidence;
        }

        let result = assertion.clone();
        self.write_index(&index)?;
        Ok(result)
    }

    /// Delete an assertion
    pub fn delete_assertion(&self, module_id: &str, assertion_id: &str) -> Result<()> {
        let mut index = self.read_index()?;
        let module = index
            .modules
            .iter_mut()
            .find(|m| m.id == module_id)
            .ok_or_else(|| AppError::ValidationError(format!("模块不存在: {}", module_id)))?;

        let idx = module
            .assertions
            .iter()
            .position(|a| a.id == assertion_id)
            .ok_or_else(|| {
                AppError::ValidationError(format!("断言不存在: {}", assertion_id))
            })?;

        module.assertions.remove(idx);
        self.write_index(&index)?;
        Ok(())
    }

    // =========================================================================
    // Trap CRUD
    // =========================================================================

    /// Create a trap for a module
    pub fn create_trap(&self, module_id: &str, trap: KnowledgeTrap) -> Result<KnowledgeTrap> {
        let mut index = self.read_index()?;
        let module = index
            .modules
            .iter_mut()
            .find(|m| m.id == module_id)
            .ok_or_else(|| AppError::ValidationError(format!("模块不存在: {}", module_id)))?;

        if module.traps.iter().any(|t| t.id == trap.id) {
            return Err(AppError::ValidationError(format!(
                "陷阱已存在: {}",
                trap.id
            )));
        }

        module.traps.push(trap.clone());
        self.write_index(&index)?;
        Ok(trap)
    }

    /// Update a trap
    pub fn update_trap(
        &self,
        module_id: &str,
        trap_id: &str,
        description: Option<String>,
        severity: Option<Severity>,
    ) -> Result<KnowledgeTrap> {
        let mut index = self.read_index()?;
        let module = index
            .modules
            .iter_mut()
            .find(|m| m.id == module_id)
            .ok_or_else(|| AppError::ValidationError(format!("模块不存在: {}", module_id)))?;

        let trap = module
            .traps
            .iter_mut()
            .find(|t| t.id == trap_id)
            .ok_or_else(|| {
                AppError::ValidationError(format!("陷阱不存在: {}", trap_id))
            })?;

        if let Some(description) = description {
            trap.description = description;
        }
        if let Some(severity) = severity {
            trap.severity = severity;
        }

        let result = trap.clone();
        self.write_index(&index)?;
        Ok(result)
    }

    /// Delete a trap
    pub fn delete_trap(&self, module_id: &str, trap_id: &str) -> Result<()> {
        let mut index = self.read_index()?;
        let module = index
            .modules
            .iter_mut()
            .find(|m| m.id == module_id)
            .ok_or_else(|| AppError::ValidationError(format!("模块不存在: {}", module_id)))?;

        let idx = module
            .traps
            .iter()
            .position(|t| t.id == trap_id)
            .ok_or_else(|| {
                AppError::ValidationError(format!("陷阱不存在: {}", trap_id))
            })?;

        module.traps.remove(idx);
        self.write_index(&index)?;
        Ok(())
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    fn write_index(&self, index: &KnowledgeIndex) -> Result<()> {
        let v2_path = self.knowledge_dir.join(V2_INDEX_FILE);

        if let Some(parent) = v2_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(index)?;
        // Atomic write: write to temp file, then rename
        let tmp_path = v2_path.with_extension("tmp");
        std::fs::write(&tmp_path, format!("{}\n", content))?;
        std::fs::rename(&tmp_path, &v2_path)?;
        Ok(())
    }
}

// =============================================================================
// Helper functions
// =============================================================================

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Read file with Windows retry logic (handles antivirus locks)
fn read_file_with_retry(path: &PathBuf) -> Result<String> {
    let mut attempts = 0;
    loop {
        match std::fs::read_to_string(path) {
            Ok(content) => return Ok(content),
            Err(e) => {
                attempts += 1;
                if attempts >= 3 || e.kind() != std::io::ErrorKind::PermissionDenied {
                    return Err(AppError::IoError(e));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

/// Convert v1 index to v2 structure
fn migrate_v1_to_v2(v1: &serde_json::Value) -> KnowledgeIndex {
    let modules = v1
        .get("modules")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    Some(KnowledgeModule {
                        id: item.get("id")?.as_str()?.to_string(),
                        name: item.get("name")?.as_str()?.to_string(),
                        domain: item
                            .get("domain")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        scope: None,
                        dependencies: item
                            .get("dependencies")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default(),
                        dependents: Vec::new(),
                        document_file: item
                            .get("file")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        complexity: Complexity::default(),
                        change_frequency: ChangeFrequency::default(),
                        assertions: Vec::new(),
                        traps: Vec::new(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    KnowledgeIndex {
        version: "2.0.0".to_string(),
        schema_version: Some("assertion-based".to_string()),
        generated_at: Some(now_iso()),
        workspace: None,
        domains: Vec::new(),
        modules,
        global_conventions: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("polaris-knowledge-{}-{}", name, uuid::Uuid::new_v4()))
    }

    #[test]
    fn creates_and_lists_modules() {
        let ws = temp_workspace("create");
        std::fs::create_dir_all(&ws).unwrap();

        let repo = UnifiedKnowledgeRepository::new(PathBuf::new(), Some(ws.clone()));

        // Init
        repo.init_knowledge().unwrap();
        assert!(repo.is_initialized());

        // Create module
        let module = repo
            .create_module(
                "test-module".to_string(),
                "测试模块".to_string(),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(module.id, "test-module");
        assert_eq!(module.name, "测试模块");

        // List
        let modules = repo.list_modules().unwrap();
        assert_eq!(modules.len(), 1);

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn updates_and_deletes_module() {
        let ws = temp_workspace("update");
        std::fs::create_dir_all(&ws).unwrap();

        let repo = UnifiedKnowledgeRepository::new(PathBuf::new(), Some(ws.clone()));
        repo.init_knowledge().unwrap();

        repo.create_module(
            "my-module".to_string(),
            "原始名称".to_string(),
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        // Update
        let updated = repo
            .update_module(
                "my-module",
                Some("新名称".to_string()),
                Some("ai-conversation".to_string()),
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(updated.name, "新名称");
        assert_eq!(updated.domain, Some("ai-conversation".to_string()));

        // Delete
        repo.delete_module("my-module").unwrap();
        let modules = repo.list_modules().unwrap();
        assert!(modules.is_empty());

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn assertion_and_trap_crud() {
        let ws = temp_workspace("assertions");
        std::fs::create_dir_all(&ws).unwrap();

        let repo = UnifiedKnowledgeRepository::new(PathBuf::new(), Some(ws.clone()));
        repo.init_knowledge().unwrap();

        repo.create_module(
            "mod-a".to_string(),
            "模块A".to_string(),
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        // Create assertion
        let assertion = KnowledgeAssertion {
            id: "mod-a/assert-1".to_string(),
            claim: "Test claim".to_string(),
            anchor: None,
            expect: None,
            confidence: Confidence::Green,
            trap: false,
            source: "test".to_string(),
        };
        repo.create_assertion("mod-a", assertion).unwrap();

        // Create trap
        let trap = KnowledgeTrap {
            id: "mod-a/trap-1".to_string(),
            description: "Test trap".to_string(),
            severity: Severity::High,
            source: "test".to_string(),
        };
        repo.create_trap("mod-a", trap).unwrap();

        // Verify
        let detail = repo.get_module("mod-a").unwrap();
        assert_eq!(detail.module.assertions.len(), 1);
        assert_eq!(detail.module.traps.len(), 1);

        // Delete assertion
        repo.delete_assertion("mod-a", "mod-a/assert-1").unwrap();
        let detail = repo.get_module("mod-a").unwrap();
        assert!(detail.module.assertions.is_empty());

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_duplicate_and_invalid_ids() {
        let ws = temp_workspace("validation");
        std::fs::create_dir_all(&ws).unwrap();

        let repo = UnifiedKnowledgeRepository::new(PathBuf::new(), Some(ws.clone()));
        repo.init_knowledge().unwrap();

        repo.create_module(
            "existing".to_string(),
            "已存在".to_string(),
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        // Duplicate ID
        let result = repo.create_module(
            "existing".to_string(),
            "重复".to_string(),
            None,
            None,
            None,
            None,
            None,
        );
        assert!(result.is_err());

        // Invalid ID (uppercase)
        let result = repo.create_module(
            "Bad-ID".to_string(),
            "错误ID".to_string(),
            None,
            None,
            None,
            None,
            None,
        );
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn updates_module_document() {
        let ws = temp_workspace("document");
        std::fs::create_dir_all(&ws).unwrap();

        let repo = UnifiedKnowledgeRepository::new(PathBuf::new(), Some(ws.clone()));
        repo.init_knowledge().unwrap();

        repo.create_module(
            "doc-mod".to_string(),
            "文档模块".to_string(),
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let content = "# Test\n\nHello world\n";
        repo.update_module_document("doc-mod", content.to_string())
            .unwrap();

        let detail = repo.get_module("doc-mod").unwrap();
        assert_eq!(detail.document, Some(content.to_string()));

        let _ = std::fs::remove_dir_all(&ws);
    }
}
