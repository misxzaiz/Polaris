//! Assertion validator.
//!
//! Runs over a loaded [`KnowledgeIndexV2`] and, for each [`Assertion`], checks
//! that its anchor (file + optional symbol + optional line range) still points
//! at something real. If the anchor carries an [`ExpectSpec`], the expected
//! literal / substring / range is matched against the anchor text.
//!
//! The result is a [`HealthReport`] that can be serialized to
//! `.polaris/knowledge/meta/assertions-health.json` for UI consumption.
//!
//! Design notes
//! ------------
//! * Validator is **read-only** against the workspace — it never writes code.
//! * Symbol existence uses a byte-level word-boundary scan so the check is
//!   language-independent and dependency-free. AST-level matching lands in S2
//!   when the extractor pipeline is available.
//! * A failed anchor degrades confidence: any of {green, yellow, orange} →
//!   red, red → black.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{KnowledgeError, Result};
use crate::models::{Assertion, Confidence, ExpectSpec, KnowledgeIndexV2};

// ─── Reports ────────────────────────────────────────────────────────

/// Aggregate health report for an entire v2 index.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthReport {
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    #[serde(rename = "workspaceRoot")]
    pub workspace_root: String,
    pub totals: HealthTotals,
    /// Per-assertion results, keyed by assertion id.
    pub results: BTreeMap<String, AssertionResult>,
    /// Modules that have zero passing assertions — surfaced for curation.
    #[serde(rename = "weakModules")]
    pub weak_modules: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HealthTotals {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
    #[serde(rename = "byConfidence")]
    pub by_confidence: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssertionResult {
    pub id: String,
    #[serde(rename = "moduleId")]
    pub module_id: String,
    pub status: ValidationStatus,
    #[serde(rename = "effectiveConfidence")]
    pub effective_confidence: Confidence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ValidationStatus {
    /// Anchor + expectation all matched. Confidence becomes green.
    Passed,
    /// Anchor missing or expectation mismatch. Confidence degrades.
    Failed,
    /// Anchor has nothing to machine-check (no symbol, no expect). Confidence
    /// is preserved at its human-provided level.
    Skipped,
}

// ─── Public API ─────────────────────────────────────────────────────

/// Validate every assertion in the index against the files in `workspace_root`.
///
/// File reads are lenient — a missing file degrades the containing assertion
/// but does not abort the whole run.
pub fn validate_index(index: &KnowledgeIndexV2, workspace_root: &Path) -> Result<HealthReport> {
    let mut results: BTreeMap<String, AssertionResult> = BTreeMap::new();
    let mut totals = HealthTotals::default();
    let mut weak_modules: Vec<String> = Vec::new();

    for module in &index.modules {
        let mut module_passed = 0usize;
        let mut module_total = 0usize;

        for assertion in &module.assertions {
            module_total += 1;
            let outcome = validate_assertion(assertion, workspace_root);
            totals.total += 1;
            match outcome.status {
                ValidationStatus::Passed => {
                    totals.passed += 1;
                    module_passed += 1;
                }
                ValidationStatus::Failed => totals.failed += 1,
                ValidationStatus::Skipped => totals.skipped += 1,
            }

            let bucket = match outcome.effective_confidence {
                Confidence::Green => "green",
                Confidence::Yellow => "yellow",
                Confidence::Orange => "orange",
                Confidence::Red => "red",
                Confidence::Black => "black",
            };
            *totals.by_confidence.entry(bucket.to_string()).or_insert(0) += 1;

            results.insert(
                assertion.id.clone(),
                AssertionResult {
                    id: assertion.id.clone(),
                    module_id: module.id.clone(),
                    status: outcome.status,
                    effective_confidence: outcome.effective_confidence,
                    reason: outcome.reason,
                },
            );
        }

        if module_total > 0 && module_passed == 0 {
            weak_modules.push(module.id.clone());
        }
    }

    Ok(HealthReport {
        generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        workspace_root: workspace_root.to_string_lossy().to_string(),
        totals,
        results,
        weak_modules,
    })
}

/// Persist a [`HealthReport`] to `<knowledge_dir>/meta/assertions-health.json`.
pub fn write_health_report(report: &HealthReport, knowledge_dir: &Path) -> Result<PathBuf> {
    let meta_dir = knowledge_dir.join("meta");
    fs::create_dir_all(&meta_dir)
        .map_err(|e| KnowledgeError::Io(format!("meta dir: {}", e)))?;
    let out = meta_dir.join("assertions-health.json");
    let bytes = serde_json::to_vec_pretty(report)?;
    fs::write(&out, bytes).map_err(|e| KnowledgeError::Io(format!("write health: {}", e)))?;
    Ok(out)
}

// ─── Per-assertion logic ────────────────────────────────────────────

/// Outcome of validating a single assertion.
struct Outcome {
    status: ValidationStatus,
    effective_confidence: Confidence,
    reason: Option<String>,
}

fn validate_assertion(assertion: &Assertion, workspace_root: &Path) -> Outcome {
    let original = assertion.confidence;
    let abs_path = workspace_root.join(&assertion.anchor.file);

    // Step 1: file existence.
    if !abs_path.exists() {
        return Outcome {
            status: ValidationStatus::Failed,
            effective_confidence: degrade(original),
            reason: Some(format!("file not found: {}", assertion.anchor.file)),
        };
    }

    let content = match fs::read_to_string(&abs_path) {
        Ok(c) => c,
        Err(e) => {
            return Outcome {
                status: ValidationStatus::Failed,
                effective_confidence: degrade(original),
                reason: Some(format!("read error: {}", e)),
            };
        }
    };

    // Step 2: symbol existence (word-boundary byte scan, language-independent).
    if let Some(symbol) = &assertion.anchor.symbol {
        if !symbol_present(&content, symbol) {
            return Outcome {
                status: ValidationStatus::Failed,
                effective_confidence: degrade(original),
                reason: Some(format!("symbol `{}` not present in file", symbol)),
            };
        }
    }

    // Step 3: line range sanity (1-indexed inclusive).
    if let Some([start, end]) = assertion.anchor.line_range {
        let line_count = content.lines().count() as u32;
        if start == 0 || start > end || end > line_count {
            return Outcome {
                status: ValidationStatus::Failed,
                effective_confidence: degrade(original),
                reason: Some(format!(
                    "line range [{}, {}] invalid for file with {} lines",
                    start, end, line_count
                )),
            };
        }
    }

    // Step 4: expect (optional machine check).
    if let Some(expect) = &assertion.expect {
        match check_expect(expect, &content, assertion.anchor.symbol.as_deref()) {
            ExpectOutcome::Pass => {}
            ExpectOutcome::Fail(reason) => {
                return Outcome {
                    status: ValidationStatus::Failed,
                    effective_confidence: degrade(original),
                    reason: Some(reason),
                };
            }
            ExpectOutcome::NotApplicable => {}
        }
    }

    // Machine-checkable signal required to promote to green.
    let has_machine_signal = assertion.expect.is_some() || assertion.anchor.line_range.is_some();
    if !has_machine_signal {
        return Outcome {
            status: ValidationStatus::Skipped,
            effective_confidence: original,
            reason: Some("anchor exists but no machine-checkable expectation".into()),
        };
    }

    Outcome {
        status: ValidationStatus::Passed,
        effective_confidence: Confidence::Green,
        reason: None,
    }
}

enum ExpectOutcome {
    Pass,
    Fail(String),
    NotApplicable,
}

fn check_expect(expect: &ExpectSpec, content: &str, symbol: Option<&str>) -> ExpectOutcome {
    // equals: must find `<symbol> [: type] = <literal>` binding.
    if let Some(value) = &expect.equals {
        if let Some(sym) = symbol {
            let literal = value_literal(value);
            if contains_binding(content, sym, &literal) {
                return ExpectOutcome::Pass;
            }
            return ExpectOutcome::Fail(format!(
                "expected `{} = {}` not found in file",
                sym, literal
            ));
        }
        return ExpectOutcome::Fail(
            "expect.equals requires anchor.symbol to resolve the binding".into(),
        );
    }

    // regex: simplified to substring match. Upgrades to real regex in S3.
    if let Some(pattern) = &expect.regex {
        if content.contains(pattern.as_str()) {
            return ExpectOutcome::Pass;
        }
        return ExpectOutcome::Fail(format!("pattern `{}` not found (substring)", pattern));
    }

    // range: find numeric binding on the same logical line as the symbol.
    if let Some([lo, hi]) = expect.range {
        if let Some(sym) = symbol {
            if let Some(number) = extract_numeric_binding(content, sym) {
                if number >= lo && number <= hi {
                    return ExpectOutcome::Pass;
                }
                return ExpectOutcome::Fail(format!(
                    "{} = {} is outside range [{}, {}]",
                    sym, number, lo, hi
                ));
            }
            return ExpectOutcome::Fail(format!(
                "no numeric binding found for symbol `{}`",
                sym
            ));
        }
        return ExpectOutcome::Fail("expect.range requires anchor.symbol".into());
    }

    ExpectOutcome::NotApplicable
}

/// Render a JSON value as the literal that would appear in source code.
fn value_literal(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => format!("\"{}\"", s.replace('"', "\\\"")),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

// ─── Byte-level scanners (no regex dependency) ──────────────────────

#[inline]
fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Return true if `symbol` occurs as a word-bounded token in `content`.
fn symbol_present(content: &str, symbol: &str) -> bool {
    find_symbol_positions(content, symbol).next().is_some()
}

/// Iterator over byte offsets where `symbol` appears as a word-bounded token.
fn find_symbol_positions<'a>(
    content: &'a str,
    symbol: &'a str,
) -> impl Iterator<Item = usize> + 'a {
    let bytes = content.as_bytes();
    let sym_bytes = symbol.as_bytes();
    let sym_len = sym_bytes.len();
    let scan_end = bytes.len().saturating_sub(sym_len);

    (0..=scan_end).filter_map(move |i| {
        if sym_len == 0 || i + sym_len > bytes.len() {
            return None;
        }
        if &bytes[i..i + sym_len] != sym_bytes {
            return None;
        }
        let before_ok = i == 0 || !is_ident_byte(bytes[i - 1]);
        let after_idx = i + sym_len;
        let after_ok = after_idx >= bytes.len() || !is_ident_byte(bytes[after_idx]);
        if before_ok && after_ok {
            Some(i)
        } else {
            None
        }
    })
}

/// Look for a `<symbol> [: type] = <literal>` binding anywhere in `content`.
/// Returns true on the first occurrence. Type annotations are optional and
/// may include ASCII identifiers plus `< > , : . _ whitespace`.
fn contains_binding(content: &str, symbol: &str, literal: &str) -> bool {
    for sym_start in find_symbol_positions(content, symbol) {
        let after_sym = sym_start + symbol.len();
        // Find the first `=` ahead, but stop at newlines / semicolons.
        let bytes = content.as_bytes();
        let mut i = after_sym;
        // Consume optional type annotation / whitespace.
        while i < bytes.len() {
            let b = bytes[i];
            if b == b'=' {
                break;
            }
            if b == b'\n' || b == b';' || b == b'{' {
                // Hit end-of-statement before '='.
                break;
            }
            let ok = b.is_ascii_whitespace()
                || b == b':'
                || b == b'.'
                || b == b','
                || b == b'<'
                || b == b'>'
                || b == b'_'
                || b.is_ascii_alphanumeric();
            if !ok {
                break;
            }
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        // Skip `=` and whitespace.
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let tail = &content[i..];
        if tail.starts_with(literal) {
            // For numeric / bool literals, demand a word boundary after.
            let is_stringish = literal.starts_with('"');
            let next_idx = i + literal.len();
            let boundary_ok = is_stringish
                || next_idx >= bytes.len()
                || !is_ident_byte(bytes[next_idx]);
            if boundary_ok {
                return true;
            }
        }
    }
    false
}

/// Extract the first numeric literal that appears immediately after a binding
/// of `symbol`. Returns `None` if no such pattern exists.
fn extract_numeric_binding(content: &str, symbol: &str) -> Option<f64> {
    let bytes = content.as_bytes();
    for sym_start in find_symbol_positions(content, symbol) {
        let mut i = sym_start + symbol.len();
        // Move to '='.
        while i < bytes.len() && bytes[i] != b'=' && bytes[i] != b'\n' && bytes[i] != b';' {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        i += 1;
        // Skip whitespace.
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        // Collect numeric literal.
        if let Some(n) = parse_number_at(&content[i..]) {
            return Some(n);
        }
    }
    None
}

fn parse_number_at(s: &str) -> Option<f64> {
    let bytes = s.as_bytes();
    let mut end = 0usize;
    let mut seen_digit = false;
    let mut seen_dot = false;
    while end < bytes.len() {
        let b = bytes[end];
        if b.is_ascii_digit() {
            seen_digit = true;
            end += 1;
        } else if b == b'.' && !seen_dot {
            seen_dot = true;
            end += 1;
        } else if (b == b'-' || b == b'+') && end == 0 {
            end += 1;
        } else {
            break;
        }
    }
    if !seen_digit {
        return None;
    }
    s[..end].parse::<f64>().ok()
}

// ─── Confidence transitions ─────────────────────────────────────────

fn degrade(c: Confidence) -> Confidence {
    match c {
        Confidence::Green => Confidence::Red,
        Confidence::Yellow => Confidence::Red,
        Confidence::Orange => Confidence::Red,
        Confidence::Red => Confidence::Black,
        Confidence::Black => Confidence::Black,
    }
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        AnchorSpec, Assertion, ChangeFrequency, Complexity, Domain, ModuleV2, ScopeSpec,
        WorkspaceInfo,
    };
    use std::fs;
    use tempfile::tempdir;

    fn index_with(assertion: Assertion) -> KnowledgeIndexV2 {
        let module = ModuleV2 {
            id: "m".into(),
            name: "M".into(),
            domain: "d".into(),
            scope: ScopeSpec {
                include: vec!["**".into()],
                exclude: Vec::new(),
            },
            dependencies: Vec::new(),
            dependents: Vec::new(),
            document_file: "m.md".into(),
            structure_file: None,
            complexity: Complexity::Low,
            change_frequency: ChangeFrequency::Low,
            assertions: vec![assertion],
            traps: Vec::new(),
        };
        KnowledgeIndexV2 {
            version: "2.0.0".into(),
            schema_version: crate::models::V2_SCHEMA_VERSION.into(),
            generated_at: None,
            workspace: WorkspaceInfo {
                root_path: "/ws".into(),
                language: Vec::new(),
                framework: Vec::new(),
            },
            domains: vec![Domain {
                id: "d".into(),
                name: "D".into(),
                description: None,
                modules: vec!["m".into()],
            }],
            modules: vec![module],
            global_conventions: Vec::new(),
        }
    }

    fn basic_assertion(id: &str, file: &str, symbol: Option<&str>, expect: Option<ExpectSpec>) -> Assertion {
        Assertion {
            id: id.into(),
            claim: "claim".into(),
            anchor: AnchorSpec {
                file: file.into(),
                symbol: symbol.map(|s| s.into()),
                line_range: None,
            },
            expect,
            confidence: Confidence::Yellow,
            trap: false,
            last_verified: None,
            source: None,
        }
    }

    // ── symbol_present / find_symbol_positions ──────────────────────

    #[test]
    fn symbol_respects_word_boundaries() {
        let content = "const MAX = 1;\nconst MAX_SIZE = 2;\n";
        assert!(symbol_present(content, "MAX"));
        assert!(symbol_present(content, "MAX_SIZE"));
        // Substring MAX inside MAX_SIZE must not spuriously match nothing;
        // MAX on its own line must match.
        let only_max_size = "const MAX_SIZE = 2;\n";
        assert!(!symbol_present(only_max_size, "MAX"));
    }

    // ── missing file ────────────────────────────────────────────────

    #[test]
    fn missing_file_fails() {
        let dir = tempdir().unwrap();
        let a = basic_assertion("m/missing", "nope.ts", None, None);
        let idx = index_with(a);
        let report = validate_index(&idx, dir.path()).unwrap();
        let r = report.results.get("m/missing").unwrap();
        assert_eq!(r.status, ValidationStatus::Failed);
        assert_eq!(r.effective_confidence, Confidence::Red);
        assert_eq!(report.weak_modules, vec!["m".to_string()]);
    }

    // ── equals / range / symbol ─────────────────────────────────────

    #[test]
    fn equals_binding_passes_to_green() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("cfg.ts");
        fs::write(&file, "export const MAX_SNAPSHOTS = 20;\n").unwrap();
        let a = basic_assertion(
            "m/max",
            "cfg.ts",
            Some("MAX_SNAPSHOTS"),
            Some(ExpectSpec {
                equals: Some(serde_json::json!(20)),
                regex: None,
                range: None,
            }),
        );
        let idx = index_with(a);
        let report = validate_index(&idx, dir.path()).unwrap();
        let r = report.results.get("m/max").unwrap();
        assert_eq!(r.status, ValidationStatus::Passed);
        assert_eq!(r.effective_confidence, Confidence::Green);
    }

    #[test]
    fn equals_binding_with_type_annotation() {
        // Rust-style: `pub const MAX: usize = 20`.
        let dir = tempdir().unwrap();
        let file = dir.path().join("cfg.rs");
        fs::write(&file, "pub const MAX: usize = 20;\n").unwrap();
        let a = basic_assertion(
            "m/max-rs",
            "cfg.rs",
            Some("MAX"),
            Some(ExpectSpec {
                equals: Some(serde_json::json!(20)),
                regex: None,
                range: None,
            }),
        );
        let idx = index_with(a);
        let report = validate_index(&idx, dir.path()).unwrap();
        let r = report.results.get("m/max-rs").unwrap();
        assert_eq!(r.status, ValidationStatus::Passed);
    }

    #[test]
    fn equals_wrong_value_fails() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("cfg.ts");
        fs::write(&file, "export const MAX_SNAPSHOTS = 50;\n").unwrap();
        let a = basic_assertion(
            "m/max-wrong",
            "cfg.ts",
            Some("MAX_SNAPSHOTS"),
            Some(ExpectSpec {
                equals: Some(serde_json::json!(20)),
                regex: None,
                range: None,
            }),
        );
        let idx = index_with(a);
        let report = validate_index(&idx, dir.path()).unwrap();
        let r = report.results.get("m/max-wrong").unwrap();
        assert_eq!(r.status, ValidationStatus::Failed);
        assert_eq!(r.effective_confidence, Confidence::Red);
    }

    #[test]
    fn range_pass() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("cfg.rs");
        fs::write(&file, "pub const CACHE_SIZE: usize = 30;\n").unwrap();
        let a = basic_assertion(
            "m/range-ok",
            "cfg.rs",
            Some("CACHE_SIZE"),
            Some(ExpectSpec {
                equals: None,
                regex: None,
                range: Some([20.0, 40.0]),
            }),
        );
        let idx = index_with(a);
        let report = validate_index(&idx, dir.path()).unwrap();
        let r = report.results.get("m/range-ok").unwrap();
        assert_eq!(r.status, ValidationStatus::Passed);
    }

    #[test]
    fn range_fail() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("cfg.rs");
        fs::write(&file, "pub const CACHE_SIZE = 100;\n").unwrap();
        let a = basic_assertion(
            "m/range-bad",
            "cfg.rs",
            Some("CACHE_SIZE"),
            Some(ExpectSpec {
                equals: None,
                regex: None,
                range: Some([20.0, 40.0]),
            }),
        );
        let idx = index_with(a);
        let report = validate_index(&idx, dir.path()).unwrap();
        let r = report.results.get("m/range-bad").unwrap();
        assert_eq!(r.status, ValidationStatus::Failed);
    }

    #[test]
    fn symbol_missing_fails() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("cfg.ts");
        fs::write(&file, "export const SOMETHING_ELSE = 1;\n").unwrap();
        let a = basic_assertion("m/symbol-missing", "cfg.ts", Some("MAX"), None);
        let idx = index_with(a);
        let report = validate_index(&idx, dir.path()).unwrap();
        let r = report.results.get("m/symbol-missing").unwrap();
        assert_eq!(r.status, ValidationStatus::Failed);
    }

    #[test]
    fn skipped_when_no_machine_signal() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("cfg.ts");
        fs::write(&file, "export const MAX = 1;\n").unwrap();
        let a = basic_assertion("m/skip", "cfg.ts", Some("MAX"), None);
        let idx = index_with(a);
        let report = validate_index(&idx, dir.path()).unwrap();
        let r = report.results.get("m/skip").unwrap();
        assert_eq!(r.status, ValidationStatus::Skipped);
        assert_eq!(r.effective_confidence, Confidence::Yellow);
    }

    // ── line range ──────────────────────────────────────────────────

    #[test]
    fn line_range_invalid_fails() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("cfg.ts");
        fs::write(&file, "line1\nline2\n").unwrap();
        let a = Assertion {
            id: "m/bad-range".into(),
            claim: "out of range".into(),
            anchor: AnchorSpec {
                file: "cfg.ts".into(),
                symbol: None,
                line_range: Some([1, 99]),
            },
            expect: None,
            confidence: Confidence::Yellow,
            trap: false,
            last_verified: None,
            source: None,
        };
        let idx = index_with(a);
        let report = validate_index(&idx, dir.path()).unwrap();
        let r = report.results.get("m/bad-range").unwrap();
        assert_eq!(r.status, ValidationStatus::Failed);
    }

    #[test]
    fn line_range_valid_passes() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("cfg.ts");
        fs::write(&file, "a\nb\nc\nd\n").unwrap();
        let a = Assertion {
            id: "m/good-range".into(),
            claim: "covers lines 1-3".into(),
            anchor: AnchorSpec {
                file: "cfg.ts".into(),
                symbol: None,
                line_range: Some([1, 3]),
            },
            expect: None,
            confidence: Confidence::Yellow,
            trap: false,
            last_verified: None,
            source: None,
        };
        let idx = index_with(a);
        let report = validate_index(&idx, dir.path()).unwrap();
        let r = report.results.get("m/good-range").unwrap();
        assert_eq!(r.status, ValidationStatus::Passed);
    }

    // ── report structure ────────────────────────────────────────────

    #[test]
    fn health_report_totals_match_by_confidence_sum() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("cfg.ts");
        fs::write(&file, "export const MAX = 20;\n").unwrap();
        let a = basic_assertion(
            "m/ok",
            "cfg.ts",
            Some("MAX"),
            Some(ExpectSpec {
                equals: Some(serde_json::json!(20)),
                regex: None,
                range: None,
            }),
        );
        let idx = index_with(a);
        let report = validate_index(&idx, dir.path()).unwrap();
        let sum: usize = report.totals.by_confidence.values().sum();
        assert_eq!(sum, report.totals.total);
    }

    #[test]
    fn health_report_persists_to_disk() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        let knowledge_dir = dir.path().join("knowledge");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&knowledge_dir).unwrap();
        fs::write(ws.join("cfg.ts"), "export const MAX = 20;\n").unwrap();

        let a = basic_assertion(
            "m/ok",
            "cfg.ts",
            Some("MAX"),
            Some(ExpectSpec {
                equals: Some(serde_json::json!(20)),
                regex: None,
                range: None,
            }),
        );
        let idx = index_with(a);
        let report = validate_index(&idx, &ws).unwrap();
        let written = write_health_report(&report, &knowledge_dir).unwrap();
        let meta_file = knowledge_dir.join("meta").join("assertions-health.json");
        assert_eq!(written, meta_file);
        let body = fs::read_to_string(meta_file).unwrap();
        let reparsed: HealthReport = serde_json::from_str(&body).unwrap();
        assert_eq!(reparsed.totals.total, 1);
    }

    #[test]
    fn degrade_progression() {
        assert_eq!(degrade(Confidence::Green), Confidence::Red);
        assert_eq!(degrade(Confidence::Yellow), Confidence::Red);
        assert_eq!(degrade(Confidence::Red), Confidence::Black);
        assert_eq!(degrade(Confidence::Black), Confidence::Black);
    }
}
