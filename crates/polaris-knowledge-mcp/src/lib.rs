//! Knowledge MCP Server library.
//!
//! Provides MCP server functionality for project knowledge management.

pub mod compiler;
pub mod error;
pub mod extractor;
pub mod handler;
pub mod migrate;
pub mod models;
pub mod protocol;
pub mod seeder;
pub mod server;
pub mod tools;
pub mod validator;

pub use compiler::{compile_context, CompileRequest, ContextPack, Depth, Mode};
pub use error::{KnowledgeError, Result};
pub use extractor::{
    build_symbol_index, extract_all, extract_module, load_structure, ExportLevel, FileStructure,
    StructureReport, SymbolEntry, SymbolKind,
};
pub use migrate::{migrate_index, MigrationReport};
pub use models::{
    Assertion, AnchorSpec, ChangeFrequency, Complexity, Confidence, Domain, ExpectSpec,
    GlobalConvention, KnowledgeIndex, KnowledgeIndexV2, ModuleEntry, ModuleV2, ScopeSpec, Trap,
    TrapSeverity, WorkspaceInfo, V2_SCHEMA_VERSION,
};
pub use seeder::{apply_seed, seed_assertions, ModuleSeedDelta, SeedOptions, SeedReport};
pub use server::{run_server, run_server_with_workspace};
pub use validator::{
    validate_index, validate_index_with_structures, write_health_report, AssertionResult,
    HealthReport, HealthTotals, ValidationStatus,
};
