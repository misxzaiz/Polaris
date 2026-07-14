/*! 候选排序（S4 实装；当前提供基础打分）
 *
 * 输入：候选 SymbolRow / RefRow + 当前文件上下文（package, imports）
 * 输出：每条候选的 score
 *
 * 思想：基于显式 import / 同包 / 文件名约定 / java.lang 隐式 / generated 排除。
 * 这是"无类型推导但 Java 严格 import 语义足够准"的关键一环。
 */

use super::db::{QueryContextRow, SymbolRow};
use super::model::{ImportEntry, SymbolKind};

/// 当前文件上下文（构造一次，给所有候选打分用）
pub struct RankContext<'a> {
    /// 当前编辑的文件相对路径（workspace 相对，正斜杠）
    pub current_rel_path: &'a str,
    /// 当前 package
    pub package: Option<&'a str>,
    /// 显式 import + static import + wildcard import
    pub imports: &'a [ImportEntry],
}

impl<'a> RankContext<'a> {
    pub fn from_query(current_rel_path: &'a str, ctx: &'a QueryContextRow) -> Self {
        Self {
            current_rel_path,
            package: ctx.package.as_deref(),
            imports: &ctx.imports,
        }
    }

    /// 当前文件 import 该 short_name 时返回对应 FQN
    pub fn explicit_import(&self, short_name: &str) -> Option<&str> {
        self.imports
            .iter()
            .find(|i| !i.is_wildcard && !i.is_static && i.short_name.as_deref() == Some(short_name))
            .map(|i| i.fqn.as_str())
    }

    pub fn has_static_import(&self, short_name: &str) -> bool {
        self.imports
            .iter()
            .any(|i| i.is_static && (i.is_wildcard || i.short_name.as_deref() == Some(short_name)))
    }

    pub fn wildcard_packages(&self) -> impl Iterator<Item = &str> {
        self.imports
            .iter()
            .filter(|i| i.is_wildcard && !i.is_static)
            .map(|i| i.fqn.as_str())
    }
}

/// 给定一组 SymbolRow，按 RankContext 打分 → 返回 (score, row) 降序排列。
pub fn rank_definition(candidates: Vec<SymbolRow>, ctx: &RankContext<'_>) -> Vec<(i32, SymbolRow)> {
    let mut scored: Vec<(i32, SymbolRow)> = candidates
        .into_iter()
        .map(|s| (score_definition(&s, ctx), s))
        .collect();
    // 大分先；同分按文件路径 + 行号稳定
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.rel_path.cmp(&b.1.rel_path))
            .then_with(|| a.1.line.cmp(&b.1.line))
    });
    scored
}

fn score_definition(s: &SymbolRow, ctx: &RankContext<'_>) -> i32 {
    let mut score = 0i32;

    // 1. 当前文件内（最高）
    if s.rel_path == ctx.current_rel_path {
        score += 10000;
    }

    // 2. 显式 import 命中：FQN 完全匹配
    if let Some(imp_fqn) = ctx.explicit_import(&s.name) {
        if s.fqn == imp_fqn {
            score += 8000;
        }
    }

    // 3. static import（精确或 wildcard）
    if ctx.has_static_import(&s.name) {
        // 仅当符号是 static 成员（field/method/enum_constant）时强加分
        if matches!(
            s.kind,
            SymbolKind::Method | SymbolKind::Field | SymbolKind::EnumConstant
        ) {
            score += 6000;
        }
    }

    // 4. wildcard import 命中：包前缀匹配
    if let Some(pkg) = &s.package {
        for wp in ctx.wildcard_packages() {
            if pkg == wp {
                score += 4000;
                break;
            }
        }
    }

    // 5. 同包
    if s.package.as_deref() == ctx.package && s.package.is_some() {
        score += 3000;
    }

    // 6. java.lang.* 隐式
    if s.fqn.starts_with("java.lang.") {
        score += 2000;
    }

    // 7. 文件名 == 类名（Java 公共类的强约定）
    if matches!(
        s.kind,
        SymbolKind::Class
            | SymbolKind::Interface
            | SymbolKind::Enum
            | SymbolKind::Record
            | SymbolKind::Annotation
    ) {
        if let Some(stem) = file_stem(&s.rel_path) {
            if stem == s.name {
                score += 500;
            }
        }
    }

    // 8. 同模块（src/main/java 前缀）
    if same_module(&s.rel_path, ctx.current_rel_path) {
        score += 200;
    }

    // 9. 排除 generated / test（除非当前文件本身就在 test/generated）
    let in_generated = is_generated(&s.rel_path);
    let cur_generated = is_generated(ctx.current_rel_path);
    if in_generated && !cur_generated {
        score -= 1000;
    }

    let in_test = is_test(&s.rel_path);
    let cur_test = is_test(ctx.current_rel_path);
    if in_test && !cur_test {
        score -= 200;
    }

    score
}

fn file_stem(rel: &str) -> Option<&str> {
    let last = rel.rsplit('/').next()?;
    let dot = last.find('.')?;
    Some(&last[..dot])
}

fn module_root_of(rel: &str) -> Option<&str> {
    // 取 src/main/java 之前的部分作为模块根
    if let Some(idx) = rel.find("/src/main/java/") {
        return Some(&rel[..idx]);
    }
    if let Some(idx) = rel.find("/src/test/java/") {
        return Some(&rel[..idx]);
    }
    None
}

fn same_module(a: &str, b: &str) -> bool {
    match (module_root_of(a), module_root_of(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

fn is_generated(rel: &str) -> bool {
    rel.contains("/generated/")
        || rel.contains("/generated-sources/")
        || rel.contains("/generated-test-sources/")
        || rel.contains("/build/generated/")
}

fn is_test(rel: &str) -> bool {
    rel.contains("/src/test/")
        || rel.contains("/test/")
        || rel.contains("Tests/")
        || rel.contains("Test.java")
        || rel.contains("Tests.java")
}
