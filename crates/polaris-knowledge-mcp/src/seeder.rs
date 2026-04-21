//! Auto-seed assertions from extracted structure.
//!
//! Given a [`KnowledgeIndexV2`] and a set of [`StructureReport`]s produced by
//! [`crate::extractor`], propose an initial layer of [`Assertion`]s for every
//! module that currently has zero or few.
//!
//! Strategy
//! --------
//! For each module (unless one is explicitly scoped):
//! 1. Pull the top-K **public** symbols from the structure, ranked by kind
//!    priority (const > class > interface > struct > fn > enum > trait > type).
//! 2. For each pick, emit an anchor-only [`Assertion`] at [`Confidence::Orange`]
//!    (AI-generated, not human-reviewed).
//! 3. When the anchored symbol is a **numeric const**, additionally scan the
//!    source file for its literal value and attach an `expect.equals`. Those
//!    assertions can be immediately auto-validated to 🟢 green.
//!
//! Two execution modes:
//! * **dry-run** — return the proposed additions without touching disk.
//! * **apply**   — merge the proposals into `index.v2.json`, skipping IDs that
//!   already exist (seeder never overwrites hand-authored knowledge).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::error::{KnowledgeError, Result};
use crate::extractor::{ExportLevel, FileStructure, StructureReport, SymbolEntry, SymbolKind};
use crate::models::{
    AnchorSpec, Assertion, Confidence, ExpectSpec, KnowledgeIndexV2, ModuleV2,
};

// ─── Public types ───────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SeedOptions {
    /// Upper bound of new assertions per module.
    pub max_per_module: usize,
    /// Default confidence for generated assertions.
    pub confidence: Confidence,
    /// If true, modules that already have >= `skip_if_has` assertions are
    /// left untouched (prevents noise in hand-curated modules).
    pub skip_if_has: usize,
    /// If true, attempt to attach `expect.equals` to numeric constants.
    pub prefer_numeric_const: bool,
    /// If set, only seed this module id.
    pub only_module: Option<String>,
}

impl Default for SeedOptions {
    fn default() -> Self {
        Self {
            max_per_module: 5,
            confidence: Confidence::Orange,
            skip_if_has: 3,
            prefer_numeric_const: true,
            only_module: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SeedReport {
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    #[serde(rename = "totalAdded")]
    pub total_added: usize,
    #[serde(rename = "modulesTouched")]
    pub modules_touched: usize,
    #[serde(rename = "modulesSkipped")]
    pub modules_skipped: usize,
    pub per_module: Vec<ModuleSeedDelta>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModuleSeedDelta {
    #[serde(rename = "moduleId")]
    pub module_id: String,
    pub added: Vec<Assertion>,
    #[serde(rename = "existingCount")]
    pub existing_count: usize,
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// ─── Entry point ────────────────────────────────────────────────────

/// Dry-run: produce a [`SeedReport`] without mutating the input.
pub fn seed_assertions(
    index: &KnowledgeIndexV2,
    structures: &BTreeMap<String, StructureReport>,
    workspace_root: &Path,
    opts: &SeedOptions,
) -> Result<SeedReport> {
    let mut per_module: Vec<ModuleSeedDelta> = Vec::new();
    let mut total_added = 0usize;
    let mut modules_touched = 0usize;
    let mut modules_skipped = 0usize;

    for module in &index.modules {
        if let Some(only) = &opts.only_module {
            if &module.id != only {
                continue;
            }
        }

        let existing_count = module.assertions.len();
        if existing_count >= opts.skip_if_has && opts.only_module.is_none() {
            per_module.push(ModuleSeedDelta {
                module_id: module.id.clone(),
                added: Vec::new(),
                existing_count,
                skipped: true,
                reason: Some(format!(
                    "module already has {} assertions (>= skip_if_has {})",
                    existing_count, opts.skip_if_has
                )),
            });
            modules_skipped += 1;
            continue;
        }

        let structure = match structures.get(&module.id) {
            Some(s) => s,
            None => {
                per_module.push(ModuleSeedDelta {
                    module_id: module.id.clone(),
                    added: Vec::new(),
                    existing_count,
                    skipped: true,
                    reason: Some("no structure report (run extract_structure first)".into()),
                });
                modules_skipped += 1;
                continue;
            }
        };

        let added = seed_for_module(module, structure, workspace_root, opts);
        total_added += added.len();
        if !added.is_empty() {
            modules_touched += 1;
        }
        per_module.push(ModuleSeedDelta {
            module_id: module.id.clone(),
            added,
            existing_count,
            skipped: false,
            reason: None,
        });
    }

    Ok(SeedReport {
        generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        total_added,
        modules_touched,
        modules_skipped,
        per_module,
    })
}

/// Apply a previously-produced [`SeedReport`] to the index and persist to
/// disk. Returns the number of assertions actually merged (duplicates are
/// filtered).
pub fn apply_seed(
    index: &mut KnowledgeIndexV2,
    report: &SeedReport,
    v2_index_path: &Path,
) -> Result<usize> {
    let mut merged = 0usize;

    for delta in &report.per_module {
        if delta.skipped || delta.added.is_empty() {
            continue;
        }
        let module = match index
            .modules
            .iter_mut()
            .find(|m| m.id == delta.module_id)
        {
            Some(m) => m,
            None => continue,
        };
        let existing_ids: BTreeSet<String> =
            module.assertions.iter().map(|a| a.id.clone()).collect();

        for candidate in &delta.added {
            if existing_ids.contains(&candidate.id) {
                continue;
            }
            module.assertions.push(candidate.clone());
            merged += 1;
        }
    }

    if merged > 0 {
        // Bump generatedAt so downstream caches invalidate.
        index.generated_at = Some(
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        );
        let bytes = serde_json::to_vec_pretty(index)?;
        fs::write(v2_index_path, bytes)
            .map_err(|e| KnowledgeError::Io(format!("write index.v2.json: {}", e)))?;
    }

    Ok(merged)
}

// ─── Per-module seeding ─────────────────────────────────────────────

fn seed_for_module(
    module: &ModuleV2,
    structure: &StructureReport,
    workspace_root: &Path,
    opts: &SeedOptions,
) -> Vec<Assertion> {
    let existing_ids: BTreeSet<String> =
        module.assertions.iter().map(|a| a.id.clone()).collect();

    // Flatten public symbols + sort by kind priority then by file path for
    // determinism.
    let mut candidates: Vec<(SymbolEntry, String)> = Vec::new();
    for file in &structure.files {
        for sym in &file.symbols {
            if sym.export_level != ExportLevel::Public {
                continue;
            }
            candidates.push((sym.clone(), file.path.clone()));
        }
    }
    candidates.sort_by(|a, b| {
        kind_priority(a.0.kind)
            .cmp(&kind_priority(b.0.kind))
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.0.name.cmp(&b.0.name))
    });

    let mut out: Vec<Assertion> = Vec::new();
    let mut used_slugs: BTreeSet<String> = BTreeSet::new();

    for (sym, file_path) in candidates {
        if out.len() >= opts.max_per_module {
            break;
        }
        let slug = slugify(&sym.name);
        if used_slugs.contains(&slug) {
            continue;
        }
        let assertion_id = format!("{}/{}", module.id, slug);
        if existing_ids.contains(&assertion_id) {
            continue;
        }

        let (expect, confidence) = if opts.prefer_numeric_const
            && matches!(sym.kind, SymbolKind::Const)
        {
            // Try to detect a numeric literal bound to the symbol.
            match numeric_literal_for(&sym, &file_path, workspace_root) {
                Some(value) => (
                    Some(ExpectSpec {
                        equals: Some(serde_json::json!(value)),
                        regex: None,
                        range: None,
                    }),
                    // Numeric equals can be immediately validated → orange is fine,
                    // validator will promote to green.
                    opts.confidence,
                ),
                None => (None, opts.confidence),
            }
        } else {
            (None, opts.confidence)
        };

        let claim = format!(
            "{} `{}` 定义于 {}:{}",
            kind_label(sym.kind),
            sym.name,
            file_path,
            sym.line_start
        );

        out.push(Assertion {
            id: assertion_id,
            claim,
            anchor: AnchorSpec {
                file: file_path.clone(),
                symbol: Some(sym.name.clone()),
                line_range: None,
            },
            expect,
            confidence,
            trap: false,
            last_verified: None,
            source: Some("auto:seeder-v1".into()),
        });
        used_slugs.insert(slug);
    }

    out
}

fn kind_priority(k: SymbolKind) -> u8 {
    // Smaller = higher priority.
    match k {
        SymbolKind::Const => 0,
        SymbolKind::Class => 1,
        SymbolKind::Struct => 2,
        SymbolKind::Interface => 3,
        SymbolKind::Function => 4,
        SymbolKind::Enum => 5,
        SymbolKind::Trait => 6,
        SymbolKind::TypeAlias => 7,
        SymbolKind::Module => 8,
        SymbolKind::Impl => 9,
        SymbolKind::Let => 10,
    }
}

fn kind_label(k: SymbolKind) -> &'static str {
    match k {
        SymbolKind::Const => "常量",
        SymbolKind::Let => "变量",
        SymbolKind::Function => "函数",
        SymbolKind::Class => "类",
        SymbolKind::Interface => "接口",
        SymbolKind::TypeAlias => "类型",
        SymbolKind::Enum => "枚举",
        SymbolKind::Struct => "结构体",
        SymbolKind::Trait => "trait",
        SymbolKind::Impl => "impl 块",
        SymbolKind::Module => "模块",
    }
}

/// Convert a symbol name into a slug suitable for assertion ids
/// (lowercase kebab-case, ASCII only, stripped of non-alnum).
fn slugify(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut prev_dash = true;
    for i in 0..chars.len() {
        let c = chars[i];
        if c.is_ascii_uppercase() {
            // Insert dash only at true word boundaries:
            //   - lowercase/digit → uppercase (camelCase: "fooBar")
            //   - uppercase → uppercase+lowercase ("HTMLParser" → "html-parser")
            let prev_lower_or_digit = i > 0
                && (chars[i - 1].is_ascii_lowercase() || chars[i - 1].is_ascii_digit());
            let boundary_inside_acronym = i > 0
                && chars[i - 1].is_ascii_uppercase()
                && i + 1 < chars.len()
                && chars[i + 1].is_ascii_lowercase();
            if (prev_lower_or_digit || boundary_inside_acronym)
                && !prev_dash
                && !out.is_empty()
            {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            prev_dash = false;
        } else if c == '_' || c == '-' {
            if !prev_dash && !out.is_empty() {
                out.push('-');
                prev_dash = true;
            }
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "sym".into()
    } else {
        trimmed
    }
}

/// Scan the file for a `const|pub const|export const SYMBOL = NUMBER` pattern
/// and return the parsed f64 value.
fn numeric_literal_for(sym: &SymbolEntry, file: &str, workspace_root: &Path) -> Option<f64> {
    let abs = workspace_root.join(file);
    let content = fs::read_to_string(&abs).ok()?;
    crate::parsing::extract_numeric_binding(&content, &sym.name)
}

// Silence unused warning when neither public API uses FileStructure directly.
#[allow(dead_code)]
fn _unused(_: &FileStructure) {}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extractor::{ExportLevel, FileStructure, StructureReport, SymbolEntry, SymbolKind};
    use crate::models::{
        ChangeFrequency, Complexity, Domain, ScopeSpec, V2_SCHEMA_VERSION, WorkspaceInfo,
    };
    use std::fs;
    use tempfile::tempdir;

    fn empty_index(module: ModuleV2) -> KnowledgeIndexV2 {
        KnowledgeIndexV2 {
            version: "2.0.0".into(),
            schema_version: V2_SCHEMA_VERSION.into(),
            generated_at: None,
            workspace: WorkspaceInfo {
                root_path: "/ws".into(),
                language: Vec::new(),
                framework: Vec::new(),
            },
            domains: vec![Domain {
                id: module.domain.clone(),
                name: module.domain.clone(),
                description: None,
                modules: vec![module.id.clone()],
            }],
            modules: vec![module],
            global_conventions: Vec::new(),
        }
    }

    fn bare_module(id: &str) -> ModuleV2 {
        ModuleV2 {
            id: id.into(),
            name: id.into(),
            domain: "d".into(),
            scope: ScopeSpec {
                include: vec!["**".into()],
                exclude: Vec::new(),
            },
            dependencies: Vec::new(),
            dependents: Vec::new(),
            document_file: format!("{}.md", id),
            structure_file: None,
            complexity: Complexity::Low,
            change_frequency: ChangeFrequency::Low,
            assertions: Vec::new(),
            traps: Vec::new(),
        }
    }

    fn fake_structure(module_id: &str, syms: Vec<(SymbolKind, &str, &str)>) -> StructureReport {
        let mut by_file: BTreeMap<String, Vec<SymbolEntry>> = BTreeMap::new();
        for (kind, name, file) in syms {
            by_file.entry(file.into()).or_default().push(SymbolEntry {
                name: name.into(),
                kind,
                line_start: 1,
                export_level: ExportLevel::Public,
            });
        }
        let files: Vec<FileStructure> = by_file
            .into_iter()
            .map(|(path, symbols)| FileStructure {
                path,
                language: "typescript".into(),
                line_count: 1,
                symbols,
            })
            .collect();
        let symbol_count: usize = files.iter().map(|f| f.symbols.len()).sum();
        StructureReport {
            module_id: module_id.into(),
            generated_at: "t".into(),
            file_count: files.len(),
            symbol_count,
            files,
        }
    }

    #[test]
    fn seeder_adds_assertions_to_empty_module() {
        let m = bare_module("chat-render");
        let idx = empty_index(m);
        let structure = fake_structure(
            "chat-render",
            vec![
                (SymbolKind::Const, "MAX_SNAPSHOTS", "src/a.ts"),
                (SymbolKind::Class, "MarkdownRenderCache", "src/b.ts"),
                (SymbolKind::Function, "compact", "src/c.ts"),
            ],
        );
        let mut structures = BTreeMap::new();
        structures.insert("chat-render".into(), structure);

        let report = seed_assertions(&idx, &structures, Path::new("/tmp"), &SeedOptions::default())
            .unwrap();
        assert_eq!(report.total_added, 3);
        assert_eq!(report.modules_touched, 1);
        let delta = &report.per_module[0];
        let ids: Vec<&str> = delta.added.iter().map(|a| a.id.as_str()).collect();
        assert!(ids.contains(&"chat-render/max-snapshots"));
        assert!(ids.contains(&"chat-render/markdown-render-cache"));
        assert!(ids.contains(&"chat-render/compact"));
    }

    #[test]
    fn seeder_respects_max_per_module() {
        let m = bare_module("chat-render");
        let idx = empty_index(m);
        let structure = fake_structure(
            "chat-render",
            (0..20)
                .map(|i| (SymbolKind::Function, Box::leak(format!("fn{}", i).into_boxed_str()) as &str, "src/a.ts"))
                .collect(),
        );
        let mut structures = BTreeMap::new();
        structures.insert("chat-render".into(), structure);

        let opts = SeedOptions {
            max_per_module: 3,
            ..Default::default()
        };
        let report = seed_assertions(&idx, &structures, Path::new("/tmp"), &opts).unwrap();
        assert_eq!(report.per_module[0].added.len(), 3);
    }

    #[test]
    fn seeder_skips_modules_with_existing_assertions() {
        let mut m = bare_module("chat-render");
        m.assertions.push(Assertion {
            id: "chat-render/existing".into(),
            claim: "existing".into(),
            anchor: AnchorSpec {
                file: "x.ts".into(),
                symbol: None,
                line_range: None,
            },
            expect: None,
            confidence: Confidence::Yellow,
            trap: false,
            last_verified: None,
            source: None,
        });
        // Add 3 assertions total.
        for i in 0..2 {
            m.assertions.push(Assertion {
                id: format!("chat-render/existing-{}", i),
                claim: "existing".into(),
                anchor: AnchorSpec {
                    file: "x.ts".into(),
                    symbol: None,
                    line_range: None,
                },
                expect: None,
                confidence: Confidence::Yellow,
                trap: false,
                last_verified: None,
                source: None,
            });
        }

        let idx = empty_index(m);
        let structure = fake_structure(
            "chat-render",
            vec![(SymbolKind::Const, "MAX", "src/a.ts")],
        );
        let mut structures = BTreeMap::new();
        structures.insert("chat-render".into(), structure);

        let report = seed_assertions(&idx, &structures, Path::new("/tmp"), &SeedOptions::default())
            .unwrap();
        assert!(report.per_module[0].skipped);
        assert_eq!(report.total_added, 0);
    }

    #[test]
    fn seeder_attaches_numeric_equals() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(
            dir.path().join("src").join("cfg.ts"),
            "export const MAX_SNAPSHOTS = 20;\n",
        )
        .unwrap();

        let m = bare_module("chat-render");
        let idx = empty_index(m);
        let structure = fake_structure(
            "chat-render",
            vec![(SymbolKind::Const, "MAX_SNAPSHOTS", "src/cfg.ts")],
        );
        let mut structures = BTreeMap::new();
        structures.insert("chat-render".into(), structure);

        let report = seed_assertions(&idx, &structures, dir.path(), &SeedOptions::default())
            .unwrap();
        let delta = &report.per_module[0];
        let a = &delta.added[0];
        assert_eq!(a.id, "chat-render/max-snapshots");
        let expect = a.expect.as_ref().expect("numeric const must get expect");
        assert_eq!(expect.equals.as_ref().unwrap(), &serde_json::json!(20.0));
    }

    #[test]
    fn seeder_respects_only_module() {
        let m1 = bare_module("chat-render");
        let mut idx = empty_index(m1);
        idx.modules.push(bare_module("git"));

        let mut structures = BTreeMap::new();
        structures.insert(
            "chat-render".into(),
            fake_structure(
                "chat-render",
                vec![(SymbolKind::Const, "A", "src/a.ts")],
            ),
        );
        structures.insert(
            "git".into(),
            fake_structure("git", vec![(SymbolKind::Const, "B", "src/b.ts")]),
        );

        let opts = SeedOptions {
            only_module: Some("git".into()),
            ..Default::default()
        };
        let report = seed_assertions(&idx, &structures, Path::new("/tmp"), &opts).unwrap();
        assert_eq!(report.per_module.len(), 1);
        assert_eq!(report.per_module[0].module_id, "git");
    }

    #[test]
    fn apply_seed_merges_without_duplicates() {
        let dir = tempdir().unwrap();
        let v2_path = dir.path().join("index.v2.json");

        let m = bare_module("chat-render");
        let mut idx = empty_index(m);
        fs::write(&v2_path, serde_json::to_vec_pretty(&idx).unwrap()).unwrap();

        let structure = fake_structure(
            "chat-render",
            vec![(SymbolKind::Const, "MAX", "src/a.ts")],
        );
        let mut structures = BTreeMap::new();
        structures.insert("chat-render".into(), structure);

        let report =
            seed_assertions(&idx, &structures, Path::new("/tmp"), &SeedOptions::default())
                .unwrap();
        let merged = apply_seed(&mut idx, &report, &v2_path).unwrap();
        assert_eq!(merged, 1);
        assert_eq!(idx.modules[0].assertions.len(), 1);

        // Applying again should be idempotent.
        let merged2 = apply_seed(&mut idx, &report, &v2_path).unwrap();
        assert_eq!(merged2, 0);
        assert_eq!(idx.modules[0].assertions.len(), 1);
    }

    #[test]
    fn slugify_handles_camel_and_snake() {
        assert_eq!(slugify("MAX_SNAPSHOTS"), "max-snapshots");
        assert_eq!(slugify("MarkdownRenderCache"), "markdown-render-cache");
        assert_eq!(slugify("compile_context"), "compile-context");
        assert_eq!(slugify("polaris-knowledge-mcp"), "polaris-knowledge-mcp");
        assert_eq!(slugify(""), "sym");
        assert_eq!(slugify("123"), "123");
        assert_eq!(slugify("!@#"), "sym");
    }
}
