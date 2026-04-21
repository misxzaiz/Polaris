//! Context compiler — the North-Star of the v2 knowledge system.
//!
//! Given a natural-language *intent* and a loaded [`KnowledgeIndexV2`],
//! produce a token-budgeted [`ContextPack`] that AI agents can consume
//! directly. The compiler replaces the "dump all docs" approach with a
//! principled four-phase pipeline:
//!
//! 1. **Intent parse** — classify the verb (optimize / extend / debug /
//!    refactor / understand) and extract referenced entities (module ids,
//!    file paths, symbols).
//! 2. **Multi-path recall** — find candidate facts via three parallel
//!    channels: entity-direct, scope-glob, and keyword text match. Graph
//!    expansion follows module dependency edges up to two hops.
//! 3. **Rerank** — score each candidate by a weighted sum of entity hit,
//!    confidence bonus, proximity, and change-frequency signal. Traps get
//!    extra priority when the intent is "modify" or "extend".
//! 4. **Budget fit** — greedy packer respecting a soft token budget
//!    (approximated as 4 chars/token). Each entry carries a citation so the
//!    consumer can ground or follow up.
//!
//! The compiler is intentionally LLM-free: all recall and ranking operate on
//! indexed metadata and cheap substring scans. A richer embedding-based
//! recall lands in Q4 per the North-Star roadmap — this module's public API
//! is designed to survive that swap.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::error::{KnowledgeError, Result};
use crate::models::{Assertion, Confidence, KnowledgeIndexV2, ModuleV2, Trap};

// ─── Public request / response types ────────────────────────────────

/// Input to the compiler.
#[derive(Debug, Clone, Deserialize)]
pub struct CompileRequest {
    /// The user's natural-language ask.
    pub intent: String,
    /// Optional explicit module ids to restrict recall.
    #[serde(default)]
    pub scope: Vec<String>,
    /// Soft token budget. Default 8000. 0 means unlimited.
    #[serde(default = "default_budget")]
    pub budget: usize,
    /// Recall depth hint. "shallow" skips graph expansion.
    #[serde(default)]
    pub depth: Depth,
    /// Intent mode — drives ranking weights.
    #[serde(default)]
    pub mode: Mode,
}

fn default_budget() -> usize {
    8000
}

#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Depth {
    Shallow,
    #[default]
    Deep,
}

#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Read,
    Modify,
    #[default]
    Plan,
}

/// Output of the compiler.
#[derive(Debug, Clone, Serialize)]
pub struct ContextPack {
    pub recognized: RecognizedIntent,
    pub facts: Vec<Fact>,
    pub assertions: Vec<AssertionRef>,
    pub traps: Vec<TrapRef>,
    pub patterns: Vec<Pattern>,
    #[serde(rename = "budgetUsed")]
    pub budget_used: usize,
    #[serde(rename = "budgetTotal")]
    pub budget_total: usize,
    #[serde(rename = "droppedItems")]
    pub dropped_items: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecognizedIntent {
    pub verb: IntentVerb,
    pub entities: Vec<String>,
    pub raw: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IntentVerb {
    Optimize,
    Extend,
    Debug,
    Refactor,
    Understand,
}

#[derive(Debug, Clone, Serialize)]
pub struct Fact {
    #[serde(rename = "type")]
    pub kind: String,
    pub content: String,
    pub citation: Citation,
}

#[derive(Debug, Clone, Serialize)]
pub struct Citation {
    #[serde(rename = "moduleId")]
    pub module_id: String,
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssertionRef {
    pub id: String,
    pub claim: String,
    #[serde(rename = "moduleId")]
    pub module_id: String,
    pub confidence: Confidence,
    pub file: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrapRef {
    pub id: String,
    pub description: String,
    #[serde(rename = "moduleId")]
    pub module_id: String,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Pattern {
    #[serde(rename = "moduleId")]
    pub module_id: String,
    pub description: String,
    pub similarity: f32,
}

// ─── Entry point ────────────────────────────────────────────────────

/// Compile a context pack for the given intent against the loaded v2 index.
pub fn compile_context(request: &CompileRequest, index: &KnowledgeIndexV2) -> Result<ContextPack> {
    if request.intent.trim().is_empty() {
        return Err(KnowledgeError::Validation(
            "compile_context: intent must not be empty".into(),
        ));
    }

    // Phase 1: intent parse.
    let recognized = parse_intent(&request.intent, index);

    // Phase 2: recall.
    let mut scored_modules = recall_modules(index, &recognized, &request.scope, request.depth);
    scored_modules.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    // Phase 3: assemble candidates with intent-mode-aware weights.
    let mode_weights = ModeWeights::for_mode(request.mode);
    let mut candidate_assertions: Vec<(ScoredAssertion, usize)> = Vec::new();
    let mut candidate_traps: Vec<(ScoredTrap, usize)> = Vec::new();
    let mut candidate_facts: Vec<(Fact, usize)> = Vec::new();
    let mut candidate_patterns: Vec<(Pattern, usize)> = Vec::new();

    for scored in &scored_modules {
        let module = scored.module;
        let module_score = scored.score;

        // Facts: module-level summary.
        let fact_content = format!(
            "模块 `{}` (`{}`): {} 复杂度 / {} 变更频率; scope={}; 依赖=[{}]",
            module.name,
            module.id,
            complexity_label(module),
            change_frequency_label(module),
            module.scope.include.first().cloned().unwrap_or_default(),
            module.dependencies.join(", ")
        );
        let cost = approx_tokens(&fact_content);
        candidate_facts.push((
            Fact {
                kind: "module-summary".into(),
                content: fact_content,
                citation: Citation {
                    module_id: module.id.clone(),
                    file: module.document_file.clone(),
                    symbol: None,
                },
            },
            cost,
        ));

        // Assertions.
        for assertion in &module.assertions {
            let score = module_score + confidence_bonus(assertion.confidence);
            let rendered = AssertionRef {
                id: assertion.id.clone(),
                claim: assertion.claim.clone(),
                module_id: module.id.clone(),
                confidence: assertion.confidence,
                file: assertion.anchor.file.clone(),
            };
            let cost = approx_tokens(&rendered.claim);
            candidate_assertions.push((
                ScoredAssertion {
                    score,
                    rendered,
                    expect_description: describe_expect(assertion),
                },
                cost,
            ));
        }

        // Traps — weighted for modify/extend intents.
        for trap in &module.traps {
            let severity_score = severity_to_score(&trap.severity_label());
            let score =
                module_score + severity_score * mode_weights.trap_weight + trap_bonus(assertion_points_to_trap(&module.assertions, trap), mode_weights.trap_weight);
            let rendered = TrapRef {
                id: trap.id.clone(),
                description: trap.description.clone(),
                module_id: module.id.clone(),
                severity: trap.severity_label(),
            };
            let cost = approx_tokens(&rendered.description);
            candidate_traps.push((
                ScoredTrap { score, rendered },
                cost,
            ));
        }
    }

    // Patterns: top 3 other high-score modules sharing a domain with entities.
    if let Some(primary) = scored_modules.first() {
        let primary_domain = &primary.module.domain;
        for scored in scored_modules.iter().skip(1).take(3) {
            if &scored.module.domain == primary_domain {
                let sim = (scored.score / primary.score.max(0.001)).clamp(0.0, 1.0);
                let pattern = Pattern {
                    module_id: scored.module.id.clone(),
                    description: format!(
                        "同一领域 `{}` 的模块，可作参考",
                        primary_domain
                    ),
                    similarity: sim,
                };
                let cost = approx_tokens(&pattern.description);
                candidate_patterns.push((pattern, cost));
            }
        }
    }

    // Phase 4: budget fit.
    candidate_assertions.sort_by(|a, b| {
        b.0.score
            .partial_cmp(&a.0.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidate_traps.sort_by(|a, b| {
        b.0.score
            .partial_cmp(&a.0.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut pack = ContextPack {
        recognized,
        facts: Vec::new(),
        assertions: Vec::new(),
        traps: Vec::new(),
        patterns: Vec::new(),
        budget_used: 0,
        budget_total: request.budget,
        dropped_items: 0,
    };

    let unlimited = request.budget == 0;
    let budget = request.budget;

    // Must-haves first: top fact, top trap for modify/extend, top assertion.
    if !candidate_facts.is_empty() {
        let (fact, cost) = candidate_facts.remove(0);
        spend(&mut pack.facts, fact, cost, &mut pack.budget_used, budget, unlimited);
    }
    if !candidate_traps.is_empty() && matches!(request.mode, Mode::Modify | Mode::Plan) {
        let (scored, cost) = candidate_traps.remove(0);
        spend(&mut pack.traps, scored.rendered, cost, &mut pack.budget_used, budget, unlimited);
    }
    if !candidate_assertions.is_empty() {
        let (scored, cost) = candidate_assertions.remove(0);
        spend(
            &mut pack.assertions,
            scored.rendered,
            cost,
            &mut pack.budget_used,
            budget,
            unlimited,
        );
    }

    // Remaining pool: interleave types, stop when over budget.
    let mut dropped = 0usize;
    while !candidate_facts.is_empty()
        || !candidate_assertions.is_empty()
        || !candidate_traps.is_empty()
        || !candidate_patterns.is_empty()
    {
        if let Some((assertion, cost)) = candidate_assertions.get(0).cloned() {
            if fits(cost, pack.budget_used, budget, unlimited) {
                pack.assertions.push(assertion.rendered.clone());
                pack.budget_used += cost;
                candidate_assertions.remove(0);
            } else {
                dropped += candidate_assertions.len();
                break;
            }
        }
        if let Some((trap, cost)) = candidate_traps.get(0).cloned() {
            if fits(cost, pack.budget_used, budget, unlimited) {
                pack.traps.push(trap.rendered.clone());
                pack.budget_used += cost;
                candidate_traps.remove(0);
            } else {
                dropped += candidate_traps.len();
                break;
            }
        }
        if let Some((fact, cost)) = candidate_facts.get(0).cloned() {
            if fits(cost, pack.budget_used, budget, unlimited) {
                pack.facts.push(fact);
                pack.budget_used += cost;
                candidate_facts.remove(0);
            } else {
                dropped += candidate_facts.len();
                break;
            }
        }
        if let Some((pattern, cost)) = candidate_patterns.get(0).cloned() {
            if fits(cost, pack.budget_used, budget, unlimited) {
                pack.patterns.push(pattern);
                pack.budget_used += cost;
                candidate_patterns.remove(0);
            } else {
                dropped += candidate_patterns.len();
                break;
            }
        }
    }
    pack.dropped_items = dropped;

    Ok(pack)
}

// ─── Intent parsing ─────────────────────────────────────────────────

fn parse_intent(intent: &str, index: &KnowledgeIndexV2) -> RecognizedIntent {
    let lower = intent.to_lowercase();
    let verb = classify_verb(&lower);
    let entities = extract_entities(intent, &lower, index);
    RecognizedIntent {
        verb,
        entities,
        raw: intent.to_string(),
    }
}

fn classify_verb(lower: &str) -> IntentVerb {
    let optimize_markers = ["optimize", "优化", "faster", "memory", "内存", "性能"];
    let extend_markers = ["extend", "add", "support", "扩展", "新增", "加一个", "支持"];
    let debug_markers = ["debug", "bug", "fix", "修复", "排查", "问题"];
    let refactor_markers = ["refactor", "重构", "拆分", "merge", "cleanup"];

    if optimize_markers.iter().any(|k| lower.contains(k)) {
        return IntentVerb::Optimize;
    }
    if extend_markers.iter().any(|k| lower.contains(k)) {
        return IntentVerb::Extend;
    }
    if debug_markers.iter().any(|k| lower.contains(k)) {
        return IntentVerb::Debug;
    }
    if refactor_markers.iter().any(|k| lower.contains(k)) {
        return IntentVerb::Refactor;
    }
    IntentVerb::Understand
}

fn extract_entities(raw: &str, lower_intent: &str, index: &KnowledgeIndexV2) -> Vec<String> {
    let mut hits: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // 1. Direct #module-id references.
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() {
                let b = bytes[j];
                if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
                    j += 1;
                } else {
                    break;
                }
            }
            if j > start {
                let candidate = &raw[start..j];
                if index.modules.iter().any(|m| m.id == candidate)
                    && seen.insert(candidate.to_string())
                {
                    hits.push(candidate.to_string());
                }
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }

    // 2. Raw id / name mentions.
    for m in &index.modules {
        if seen.contains(&m.id) {
            continue;
        }
        if lower_intent.contains(&m.id.to_lowercase()) {
            seen.insert(m.id.clone());
            hits.push(m.id.clone());
            continue;
        }
        if !m.name.is_empty() && lower_intent.contains(&m.name.to_lowercase()) {
            seen.insert(m.id.clone());
            hits.push(m.id.clone());
        }
    }

    hits
}

// ─── Recall ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct ScoredModule<'a> {
    module: &'a ModuleV2,
    score: f32,
}

fn recall_modules<'a>(
    index: &'a KnowledgeIndexV2,
    recognized: &RecognizedIntent,
    scope: &[String],
    depth: Depth,
) -> Vec<ScoredModule<'a>> {
    let mut scored: Vec<ScoredModule<'a>> = Vec::new();
    let explicit_scope: HashSet<String> = scope.iter().cloned().collect();
    let lower_intent = recognized.raw.to_lowercase();

    for module in &index.modules {
        let mut score: f32 = 0.0;

        if !explicit_scope.is_empty() {
            if !explicit_scope.contains(&module.id) {
                continue;
            }
            score += 5.0;
        }

        if recognized.entities.iter().any(|e| e == &module.id) {
            score += 10.0;
        }

        // Keyword signals against scope globs and document file name.
        for glob in &module.scope.include {
            if lower_intent.contains(&glob.trim_end_matches("/**").to_lowercase()) {
                score += 1.0;
            }
        }
        if lower_intent.contains(&module.document_file.to_lowercase()) {
            score += 1.0;
        }

        // Change frequency bonus for modify-ish intents.
        if matches!(recognized.verb, IntentVerb::Optimize | IntentVerb::Refactor) {
            score += change_frequency_to_score(module);
        }

        if score > 0.0 {
            scored.push(ScoredModule { module, score });
        }
    }

    // Graph expansion: if we have seed modules, add immediate deps & dependents.
    if depth == Depth::Deep && !scored.is_empty() {
        let seeds: HashSet<String> = scored.iter().map(|s| s.module.id.clone()).collect();
        let mut expansions: Vec<ScoredModule<'a>> = Vec::new();
        for seed in &scored {
            for dep_id in seed
                .module
                .dependencies
                .iter()
                .chain(seed.module.dependents.iter())
            {
                if seeds.contains(dep_id) {
                    continue;
                }
                if let Some(dep) = index.modules.iter().find(|m| &m.id == dep_id) {
                    expansions.push(ScoredModule {
                        module: dep,
                        score: seed.score * 0.3,
                    });
                }
            }
        }
        scored.extend(expansions);
        // Deduplicate keeping max score.
        scored = dedupe_keep_max(scored);
    }

    // Guarantee we always return at least the explicit scope modules even if
    // they scored 0 (nothing else matched).
    if scored.is_empty() && !explicit_scope.is_empty() {
        for m in &index.modules {
            if explicit_scope.contains(&m.id) {
                scored.push(ScoredModule {
                    module: m,
                    score: 1.0,
                });
            }
        }
    }

    scored
}

fn dedupe_keep_max<'a>(mut scored: Vec<ScoredModule<'a>>) -> Vec<ScoredModule<'a>> {
    scored.sort_by(|a, b| a.module.id.cmp(&b.module.id));
    let mut out: Vec<ScoredModule<'a>> = Vec::new();
    for item in scored {
        if let Some(last) = out.last_mut() {
            if last.module.id == item.module.id {
                if item.score > last.score {
                    last.score = item.score;
                }
                continue;
            }
        }
        out.push(item);
    }
    out
}

// ─── Ranking helpers ────────────────────────────────────────────────

struct ModeWeights {
    trap_weight: f32,
}

impl ModeWeights {
    fn for_mode(mode: Mode) -> Self {
        match mode {
            Mode::Modify => Self { trap_weight: 2.0 },
            Mode::Plan => Self { trap_weight: 1.5 },
            Mode::Read => Self { trap_weight: 0.5 },
        }
    }
}

struct ScoredAssertion {
    score: f32,
    rendered: AssertionRef,
    #[allow(dead_code)]
    expect_description: Option<String>,
}

#[derive(Clone)]
struct ScoredTrap {
    score: f32,
    rendered: TrapRef,
}

// Manual clones for tuple-based candidate vectors.
impl Clone for ScoredAssertion {
    fn clone(&self) -> Self {
        Self {
            score: self.score,
            rendered: self.rendered.clone(),
            expect_description: self.expect_description.clone(),
        }
    }
}

fn confidence_bonus(c: Confidence) -> f32 {
    match c {
        Confidence::Green => 3.0,
        Confidence::Yellow => 2.0,
        Confidence::Orange => 1.0,
        Confidence::Red => -1.0,
        Confidence::Black => -3.0,
    }
}

fn severity_to_score(severity: &str) -> f32 {
    match severity {
        "critical" => 4.0,
        "high" => 3.0,
        "medium" => 2.0,
        "low" => 1.0,
        _ => 0.0,
    }
}

fn trap_bonus(points_to_trap: bool, weight: f32) -> f32 {
    if points_to_trap {
        weight
    } else {
        0.0
    }
}

fn assertion_points_to_trap(assertions: &[Assertion], trap: &Trap) -> bool {
    assertions.iter().any(|a| a.trap && a.id.starts_with(trap.id.split('/').next().unwrap_or("")))
}

fn change_frequency_to_score(module: &ModuleV2) -> f32 {
    match module.change_frequency {
        crate::models::ChangeFrequency::High => 2.0,
        crate::models::ChangeFrequency::Medium => 1.0,
        crate::models::ChangeFrequency::Low => 0.5,
    }
}

fn complexity_label(module: &ModuleV2) -> &'static str {
    match module.complexity {
        crate::models::Complexity::Low => "low",
        crate::models::Complexity::Medium => "medium",
        crate::models::Complexity::High => "high",
    }
}

fn change_frequency_label(module: &ModuleV2) -> &'static str {
    match module.change_frequency {
        crate::models::ChangeFrequency::Low => "low",
        crate::models::ChangeFrequency::Medium => "medium",
        crate::models::ChangeFrequency::High => "high",
    }
}

fn describe_expect(a: &Assertion) -> Option<String> {
    a.expect.as_ref().map(|e| {
        if let Some(v) = &e.equals {
            format!("期望 {} = {}", a.anchor.symbol.as_deref().unwrap_or(""), v)
        } else if let Some(p) = &e.regex {
            format!("期望匹配正则 {}", p)
        } else if let Some([lo, hi]) = e.range {
            format!(
                "期望 {} 在 [{}, {}]",
                a.anchor.symbol.as_deref().unwrap_or(""),
                lo,
                hi
            )
        } else {
            "期望（未指定形式）".to_string()
        }
    })
}

// Extension trait: expose the TrapSeverity enum as a lowercase string without
// introducing a new pub API in models.
trait TrapSeverityExt {
    fn severity_label(&self) -> String;
}

impl TrapSeverityExt for Trap {
    fn severity_label(&self) -> String {
        match self.severity {
            crate::models::TrapSeverity::Low => "low".into(),
            crate::models::TrapSeverity::Medium => "medium".into(),
            crate::models::TrapSeverity::High => "high".into(),
            crate::models::TrapSeverity::Critical => "critical".into(),
        }
    }
}

// ─── Budget fitting ─────────────────────────────────────────────────

fn approx_tokens(s: &str) -> usize {
    // Rough: 4 chars ≈ 1 token for western text; Chinese counts 1 token per
    // ~1.5 characters. Use char count / 3 as a conservative middle-ground to
    // avoid underestimating.
    (s.chars().count() / 3).max(1)
}

fn fits(cost: usize, used: usize, budget: usize, unlimited: bool) -> bool {
    if unlimited {
        return true;
    }
    used + cost <= budget
}

fn spend<T>(
    out: &mut Vec<T>,
    item: T,
    cost: usize,
    used: &mut usize,
    budget: usize,
    unlimited: bool,
) {
    if fits(cost, *used, budget, unlimited) {
        out.push(item);
        *used += cost;
    }
}

// ─── Mode helpers ───────────────────────────────────────────────────

/// Modes that imply eventual writes or plans — used for ranking weights.
impl Mode {
    pub fn is_writeish(self) -> bool {
        matches!(self, Mode::Modify | Mode::Plan)
    }
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        AnchorSpec, Assertion, ChangeFrequency, Complexity, Domain, ExpectSpec, ModuleV2,
        ScopeSpec, Trap, TrapSeverity, V2_SCHEMA_VERSION, WorkspaceInfo,
    };

    fn build_index() -> KnowledgeIndexV2 {
        let chat_render = ModuleV2 {
            id: "chat-render".into(),
            name: "Chat Render".into(),
            domain: "ai-conversation".into(),
            scope: ScopeSpec {
                include: vec!["src/components/Chat/**".into()],
                exclude: Vec::new(),
            },
            dependencies: vec!["chat-session".into(), "ui-framework".into()],
            dependents: vec!["assistant".into()],
            document_file: "chat-render.md".into(),
            structure_file: None,
            complexity: Complexity::High,
            change_frequency: ChangeFrequency::High,
            assertions: vec![
                Assertion {
                    id: "chat-render/max".into(),
                    claim: "MAX_SNAPSHOTS is 20".into(),
                    anchor: AnchorSpec {
                        file: "src/utils/messageCompactor.ts".into(),
                        symbol: Some("MAX_SNAPSHOTS".into()),
                        line_range: None,
                    },
                    expect: Some(ExpectSpec {
                        equals: Some(serde_json::json!(20)),
                        regex: None,
                        range: None,
                    }),
                    confidence: Confidence::Yellow,
                    trap: false,
                    last_verified: None,
                    source: None,
                },
                Assertion {
                    id: "chat-render/debounce".into(),
                    claim: "80% overlap debounce prevents oscillation".into(),
                    anchor: AnchorSpec {
                        file: "src/components/Chat/EnhancedChatMessages.tsx".into(),
                        symbol: Some("onVisibleRangeChange".into()),
                        line_range: None,
                    },
                    expect: None,
                    confidence: Confidence::Green,
                    trap: true,
                    last_verified: None,
                    source: None,
                },
            ],
            traps: vec![Trap {
                id: "chat-render/trap-cache-merge".into(),
                description: "do not merge cache.ts and lru-cache.ts".into(),
                source: None,
                severity: TrapSeverity::High,
            }],
        };
        let chat_session = ModuleV2 {
            id: "chat-session".into(),
            name: "Chat Session".into(),
            domain: "ai-conversation".into(),
            scope: ScopeSpec {
                include: vec!["src/stores/conversationStore/**".into()],
                exclude: Vec::new(),
            },
            dependencies: Vec::new(),
            dependents: vec!["chat-render".into()],
            document_file: "chat-session.md".into(),
            structure_file: None,
            complexity: Complexity::High,
            change_frequency: ChangeFrequency::High,
            assertions: Vec::new(),
            traps: Vec::new(),
        };
        let ui = ModuleV2 {
            id: "ui-framework".into(),
            name: "UI".into(),
            domain: "platform-integration".into(),
            scope: ScopeSpec {
                include: vec!["src/components/Layout/**".into()],
                exclude: Vec::new(),
            },
            dependencies: Vec::new(),
            dependents: vec!["chat-render".into()],
            document_file: "ui-framework.md".into(),
            structure_file: None,
            complexity: Complexity::Medium,
            change_frequency: ChangeFrequency::Low,
            assertions: Vec::new(),
            traps: Vec::new(),
        };
        KnowledgeIndexV2 {
            version: "2.0.0".into(),
            schema_version: V2_SCHEMA_VERSION.into(),
            generated_at: None,
            workspace: WorkspaceInfo {
                root_path: "/ws".into(),
                language: Vec::new(),
                framework: Vec::new(),
            },
            domains: vec![
                Domain {
                    id: "ai-conversation".into(),
                    name: "AI Conv".into(),
                    description: None,
                    modules: vec!["chat-render".into(), "chat-session".into()],
                },
                Domain {
                    id: "platform-integration".into(),
                    name: "Platform".into(),
                    description: None,
                    modules: vec!["ui-framework".into()],
                },
            ],
            modules: vec![chat_render, chat_session, ui],
            global_conventions: Vec::new(),
        }
    }

    #[test]
    fn recognizes_optimize_intent_on_chat_render() {
        let req = CompileRequest {
            intent: "想给 chat-render 再做一轮内存优化".into(),
            scope: Vec::new(),
            budget: 8000,
            depth: Depth::Deep,
            mode: Mode::Plan,
        };
        let index = build_index();
        let pack = compile_context(&req, &index).unwrap();
        assert_eq!(pack.recognized.verb, IntentVerb::Optimize);
        assert!(pack.recognized.entities.contains(&"chat-render".to_string()));
    }

    #[test]
    fn graph_expansion_pulls_in_dependencies() {
        let req = CompileRequest {
            intent: "优化 chat-render".into(),
            scope: Vec::new(),
            budget: 8000,
            depth: Depth::Deep,
            mode: Mode::Plan,
        };
        let index = build_index();
        let pack = compile_context(&req, &index).unwrap();
        // chat-render is seed. chat-session is a direct dep, ui-framework is a
        // direct dep, assistant is a dependent. Expect multiple facts.
        assert!(pack.facts.len() >= 2, "facts: {:?}", pack.facts);
    }

    #[test]
    fn shallow_depth_does_not_expand() {
        let req = CompileRequest {
            intent: "chat-render 细节".into(),
            scope: Vec::new(),
            budget: 8000,
            depth: Depth::Shallow,
            mode: Mode::Read,
        };
        let index = build_index();
        let pack = compile_context(&req, &index).unwrap();
        // Only chat-render seed should be present as a fact.
        assert!(pack
            .facts
            .iter()
            .all(|f| f.citation.module_id == "chat-render"));
    }

    #[test]
    fn explicit_scope_restricts_results() {
        let req = CompileRequest {
            intent: "看下实现".into(),
            scope: vec!["chat-session".into()],
            budget: 8000,
            depth: Depth::Shallow,
            mode: Mode::Read,
        };
        let index = build_index();
        let pack = compile_context(&req, &index).unwrap();
        assert!(pack
            .facts
            .iter()
            .all(|f| f.citation.module_id == "chat-session"));
    }

    #[test]
    fn traps_prioritized_for_modify_mode() {
        let req = CompileRequest {
            intent: "修改 chat-render 的缓存".into(),
            scope: Vec::new(),
            budget: 8000,
            depth: Depth::Deep,
            mode: Mode::Modify,
        };
        let index = build_index();
        let pack = compile_context(&req, &index).unwrap();
        assert!(!pack.traps.is_empty(), "traps must surface for modify mode");
    }

    #[test]
    fn budget_enforced_drops_items() {
        let req = CompileRequest {
            intent: "chat-render 分析".into(),
            scope: Vec::new(),
            budget: 10, // absurdly small — forces drops
            depth: Depth::Deep,
            mode: Mode::Plan,
        };
        let index = build_index();
        let pack = compile_context(&req, &index).unwrap();
        assert!(pack.budget_used <= 10);
        assert!(pack.dropped_items >= 1);
    }

    #[test]
    fn empty_intent_errors() {
        let req = CompileRequest {
            intent: "   ".into(),
            scope: Vec::new(),
            budget: 0,
            depth: Depth::Shallow,
            mode: Mode::Read,
        };
        let index = build_index();
        assert!(compile_context(&req, &index).is_err());
    }

    #[test]
    fn hash_prefix_reference_recognized() {
        let req = CompileRequest {
            intent: "#chat-render 的优化".into(),
            scope: Vec::new(),
            budget: 8000,
            depth: Depth::Shallow,
            mode: Mode::Plan,
        };
        let index = build_index();
        let pack = compile_context(&req, &index).unwrap();
        assert!(pack.recognized.entities.contains(&"chat-render".to_string()));
    }

    #[test]
    fn assertions_carry_confidence_through_pack() {
        let req = CompileRequest {
            intent: "chat-render".into(),
            scope: Vec::new(),
            budget: 8000,
            depth: Depth::Shallow,
            mode: Mode::Plan,
        };
        let index = build_index();
        let pack = compile_context(&req, &index).unwrap();
        assert!(pack
            .assertions
            .iter()
            .any(|a| a.confidence == Confidence::Green));
    }

    #[test]
    fn citations_include_module_and_file() {
        let req = CompileRequest {
            intent: "chat-render".into(),
            scope: Vec::new(),
            budget: 8000,
            depth: Depth::Shallow,
            mode: Mode::Plan,
        };
        let index = build_index();
        let pack = compile_context(&req, &index).unwrap();
        assert!(pack.facts.iter().all(|f| !f.citation.file.is_empty()));
        assert!(pack.facts.iter().all(|f| !f.citation.module_id.is_empty()));
    }

    #[test]
    fn debug_intent_classification() {
        let req = CompileRequest {
            intent: "chat-render 有个 bug 要排查".into(),
            scope: Vec::new(),
            budget: 8000,
            depth: Depth::Shallow,
            mode: Mode::Read,
        };
        let index = build_index();
        let pack = compile_context(&req, &index).unwrap();
        assert_eq!(pack.recognized.verb, IntentVerb::Debug);
    }
}
