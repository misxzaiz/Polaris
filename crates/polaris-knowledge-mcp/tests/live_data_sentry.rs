//! Drift-prevention sentry: load the **live** `.polaris/knowledge/index.v2.json`
//! from the repository and verify the crate's v2 model still deserializes it.
//!
//! This is the safety net for Phase 0 of the Knowledge plugin refactor. Two
//! parallel Rust models (this crate vs. `src-tauri/src/models/knowledge.rs`)
//! read the same on-disk index file. Until we unify them in Phase 5, a sentry
//! on each side ensures unilateral changes that break the contract fail in
//! CI rather than at runtime.
//!
//! The test is skipped (not failed) when the live file is absent so the crate
//! remains buildable in isolation from the parent workspace.

use polaris_knowledge_mcp::{KnowledgeIndexV2, V2_SCHEMA_VERSION};
use std::path::PathBuf;

fn live_index_path() -> PathBuf {
    // crates/polaris-knowledge-mcp/  →  workspace root
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(".polaris")
        .join("knowledge")
        .join("index.v2.json")
}

#[test]
fn live_v2_index_deserializes_with_crate_model() {
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

    let index: KnowledgeIndexV2 = serde_json::from_str(&raw).unwrap_or_else(|e| {
        panic!(
            "crate-side KnowledgeIndexV2 rejected live data at {}: {e}",
            path.display()
        )
    });

    // Live contract invariants — fail loudly if production drifts in a way
    // the crate model cannot represent.
    assert_eq!(
        index.schema_version, V2_SCHEMA_VERSION,
        "schemaVersion in live data must match crate constant"
    );
    assert!(
        !index.modules.is_empty(),
        "live index must contain at least one module"
    );
    assert!(
        !index.domains.is_empty(),
        "live index must contain at least one domain"
    );
    // Every module must reference a known domain.
    let known_domains: std::collections::HashSet<&str> =
        index.domains.iter().map(|d| d.id.as_str()).collect();
    for m in &index.modules {
        assert!(
            known_domains.contains(m.domain.as_str()),
            "module `{}` references unknown domain `{}`",
            m.id,
            m.domain
        );
    }
}

#[test]
fn live_v2_index_roundtrips_through_crate_model() {
    let path = live_index_path();
    if !path.exists() {
        eprintln!(
            "[sentry] live index not found at {}, skipping",
            path.display()
        );
        return;
    }

    let raw = std::fs::read_to_string(&path).expect("read live index");
    let parsed: KnowledgeIndexV2 =
        serde_json::from_str(&raw).expect("first parse must succeed");
    let reserialized = serde_json::to_string(&parsed).expect("serialize");
    let reparsed: KnowledgeIndexV2 = serde_json::from_str(&reserialized).expect("reparse");

    assert_eq!(parsed.modules.len(), reparsed.modules.len());
    assert_eq!(parsed.domains.len(), reparsed.domains.len());
}
