/*! Java tree-sitter 提取器
 *
 * 输入：UTF-8 源码
 * 输出：FileIndex（package + imports + symbols + refs）
 *
 * 设计：
 * - panic 隔离：catch_unwind 包整个解析
 * - 一次 walk：递归 root，按 node kind 分发
 * - FQN 累积：维护 ScopeStack（package → outer class → inner class → method）
 * - 行/列：tree-sitter `start_position()` 是 0-based 行 + UTF-8 字节列；
 *   我们存为 1-based 行 + UTF-16 列（与 LSP/CodeMirror 对齐）
 */

use std::path::Path;

use tree_sitter::{Node, Tree, TreeCursor};

use crate::error::{AppError, Result};

use super::super::model::{
    modifiers, FileIndex, ImportEntry, RefEntry, RefKind, Symbol, SymbolKind,
};

// ── 入口 ────────────────────────────────────────────────────

pub fn extract_java(rel_path: &str, abs_path: &Path, source: &str) -> Result<FileIndex> {
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        try_extract(rel_path, abs_path, source)
    }));
    match res {
        Ok(Ok(fi)) => Ok(fi),
        Ok(Err(e)) => {
            tracing::warn!("Java extract failed for {}: {}", rel_path, e);
            Ok(empty_with_error(rel_path, source))
        }
        Err(_) => {
            tracing::error!("Java extract panicked for {}", rel_path);
            Ok(empty_with_error(rel_path, source))
        }
    }
}

fn empty_with_error(rel_path: &str, source: &str) -> FileIndex {
    FileIndex {
        rel_path: rel_path.to_string(),
        language: "java".to_string(),
        mtime_ns: 0,
        size: source.len() as u64,
        content_hash: xxhash_rust::xxh3::xxh3_64(source.as_bytes()),
        package: None,
        symbols: Vec::new(),
        refs: Vec::new(),
        imports: Vec::new(),
        parse_error: true,
    }
}

#[allow(unused_variables)]
fn try_extract(rel_path: &str, _abs_path: &Path, source: &str) -> Result<FileIndex> {
    use tree_sitter::Parser;

    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::language())
        .map_err(|e| AppError::StateError(format!("set_language 失败: {}", e)))?;
    let tree: Tree = parser
        .parse(source, None)
        .ok_or_else(|| AppError::StateError("tree-sitter parse 返回 None".into()))?;

    let mut fi = FileIndex {
        rel_path: rel_path.to_string(),
        language: "java".to_string(),
        mtime_ns: 0,
        size: source.len() as u64,
        content_hash: xxhash_rust::xxh3::xxh3_64(source.as_bytes()),
        package: None,
        symbols: Vec::new(),
        refs: Vec::new(),
        imports: Vec::new(),
        parse_error: false,
    };

    let bytes = source.as_bytes();
    let lines: Vec<&str> = source.split_inclusive('\n').collect();

    // Pass 1: package + imports（编译单元顶层节点）
    let root = tree.root_node();
    extract_package_and_imports(root, bytes, &mut fi);

    // Pass 2: 符号定义（递归累积 scope）
    let scope_root = ScopeStack::new(fi.package.clone());
    let mut cursor = root.walk();
    walk_definitions(root, &mut cursor, bytes, &lines, &scope_root, &mut fi);

    // Pass 3: 引用
    let mut cursor = root.walk();
    walk_references(root, &mut cursor, bytes, &lines, &fi.imports, fi.package.as_deref(), &mut fi.refs);

    // refs 上限
    if fi.refs.len() > 50_000 {
        fi.refs.truncate(50_000);
    }

    Ok(fi)
}

// ── Pass 1: package + imports ───────────────────────────────

fn extract_package_and_imports(root: Node<'_>, src: &[u8], fi: &mut FileIndex) {
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        match child.kind() {
            "package_declaration" => {
                if let Some(scoped) = first_named_of_kinds(
                    child,
                    &["scoped_identifier", "identifier"],
                ) {
                    if let Ok(s) = scoped.utf8_text(src) {
                        fi.package = Some(s.to_string());
                    }
                }
            }
            "import_declaration" => {
                let is_static = has_anonymous_child(child, "static");
                let is_wildcard = has_anonymous_child(child, "asterisk");
                if let Some(ident) = first_named_of_kinds(
                    child,
                    &["scoped_identifier", "identifier"],
                ) {
                    if let Ok(fqn_full) = ident.utf8_text(src) {
                        let (fqn, short) = if is_wildcard {
                            (fqn_full.to_string(), None)
                        } else {
                            // 取最后一段作为 short_name
                            let last = fqn_full
                                .rsplit('.')
                                .next()
                                .map(|s| s.to_string());
                            (fqn_full.to_string(), last)
                        };
                        fi.imports.push(ImportEntry {
                            fqn,
                            short_name: short,
                            is_static,
                            is_wildcard,
                        });
                    }
                }
            }
            _ => {}
        }
    }
}

// ── Pass 2: 定义 walker ─────────────────────────────────────

#[derive(Clone)]
struct ScopeStack {
    /// 累积的 FQN 段（不含 package；package 在 root 层处理）
    pkg: Option<String>,
    parts: Vec<String>,
}

impl ScopeStack {
    fn new(pkg: Option<String>) -> Self {
        Self {
            pkg,
            parts: Vec::new(),
        }
    }

    fn parent_fqn(&self) -> Option<String> {
        if self.parts.is_empty() {
            self.pkg.clone()
        } else {
            let mut s = String::new();
            if let Some(p) = &self.pkg {
                s.push_str(p);
                s.push('.');
            }
            s.push_str(&self.parts.join("."));
            Some(s)
        }
    }

    fn qualify(&self, name: &str) -> String {
        match self.parent_fqn() {
            Some(p) if !p.is_empty() => format!("{}.{}", p, name),
            _ => name.to_string(),
        }
    }

    fn push(&self, name: String) -> Self {
        let mut copy = self.clone();
        copy.parts.push(name);
        copy
    }
}

fn walk_definitions<'a>(
    node: Node<'a>,
    cursor: &mut TreeCursor<'a>,
    src: &[u8],
    lines: &[&str],
    scope: &ScopeStack,
    fi: &mut FileIndex,
) {
    let kind = node.kind();
    let mut next_scope: Option<ScopeStack> = None;

    match kind {
        "class_declaration"
        | "interface_declaration"
        | "enum_declaration"
        | "record_declaration"
        | "annotation_type_declaration" => {
            let sym_kind = match kind {
                "class_declaration" => SymbolKind::Class,
                "interface_declaration" => SymbolKind::Interface,
                "enum_declaration" => SymbolKind::Enum,
                "record_declaration" => SymbolKind::Record,
                "annotation_type_declaration" => SymbolKind::Annotation,
                _ => SymbolKind::Unknown,
            };
            if let Some(name_node) = node.child_by_field_name("name") {
                if let Ok(name) = name_node.utf8_text(src) {
                    let fqn = scope.qualify(name);
                    let mods = extract_modifiers(node, src);
                    fi.symbols.push(Symbol {
                        name: name.to_string(),
                        fqn: fqn.clone(),
                        kind: sym_kind,
                        parent_fqn: scope.parent_fqn(),
                        line: row_to_line(node.start_position().row),
                        column: utf8_col_to_utf16(lines, node.start_position()),
                        end_line: row_to_line(node.end_position().row),
                        end_column: utf8_col_to_utf16(lines, node.end_position()),
                        name_line: row_to_line(name_node.start_position().row),
                        name_column: utf8_col_to_utf16(lines, name_node.start_position()),
                        signature: None,
                        modifiers: mods,
                    });
                    next_scope = Some(scope.push(name.to_string()));
                }
            }
        }
        "method_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                if let Ok(name) = name_node.utf8_text(src) {
                    let mods = extract_modifiers(node, src);
                    let sig = extract_method_signature(node, src);
                    fi.symbols.push(Symbol {
                        name: name.to_string(),
                        fqn: scope.qualify(name),
                        kind: SymbolKind::Method,
                        parent_fqn: scope.parent_fqn(),
                        line: row_to_line(node.start_position().row),
                        column: utf8_col_to_utf16(lines, node.start_position()),
                        end_line: row_to_line(node.end_position().row),
                        end_column: utf8_col_to_utf16(lines, node.end_position()),
                        name_line: row_to_line(name_node.start_position().row),
                        name_column: utf8_col_to_utf16(lines, name_node.start_position()),
                        signature: Some(sig),
                        modifiers: mods,
                    });
                }
            }
            // 不递归方法体内部为定义（局部类不在我们的索引粒度内）
            return;
        }
        "constructor_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                if let Ok(name) = name_node.utf8_text(src) {
                    let mods = extract_modifiers(node, src);
                    let sig = extract_method_signature(node, src);
                    fi.symbols.push(Symbol {
                        name: name.to_string(),
                        fqn: scope.qualify(name),
                        kind: SymbolKind::Constructor,
                        parent_fqn: scope.parent_fqn(),
                        line: row_to_line(node.start_position().row),
                        column: utf8_col_to_utf16(lines, node.start_position()),
                        end_line: row_to_line(node.end_position().row),
                        end_column: utf8_col_to_utf16(lines, node.end_position()),
                        name_line: row_to_line(name_node.start_position().row),
                        name_column: utf8_col_to_utf16(lines, name_node.start_position()),
                        signature: Some(sig),
                        modifiers: mods,
                    });
                }
            }
            return;
        }
        "field_declaration" => {
            // field 可能一行多变量：private int a, b, c;
            let mods = extract_modifiers(node, src);
            let mut c2 = node.walk();
            for declarator in node.named_children(&mut c2) {
                if declarator.kind() != "variable_declarator" {
                    continue;
                }
                if let Some(name_node) = declarator.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(src) {
                        fi.symbols.push(Symbol {
                            name: name.to_string(),
                            fqn: scope.qualify(name),
                            kind: SymbolKind::Field,
                            parent_fqn: scope.parent_fqn(),
                            line: row_to_line(node.start_position().row),
                            column: utf8_col_to_utf16(lines, node.start_position()),
                            end_line: row_to_line(declarator.end_position().row),
                            end_column: utf8_col_to_utf16(lines, declarator.end_position()),
                            name_line: row_to_line(name_node.start_position().row),
                            name_column: utf8_col_to_utf16(lines, name_node.start_position()),
                            signature: None,
                            modifiers: mods,
                        });
                    }
                }
            }
            return;
        }
        "enum_constant" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                if let Ok(name) = name_node.utf8_text(src) {
                    fi.symbols.push(Symbol {
                        name: name.to_string(),
                        fqn: scope.qualify(name),
                        kind: SymbolKind::EnumConstant,
                        parent_fqn: scope.parent_fqn(),
                        line: row_to_line(node.start_position().row),
                        column: utf8_col_to_utf16(lines, node.start_position()),
                        end_line: row_to_line(node.end_position().row),
                        end_column: utf8_col_to_utf16(lines, node.end_position()),
                        name_line: row_to_line(name_node.start_position().row),
                        name_column: utf8_col_to_utf16(lines, name_node.start_position()),
                        signature: None,
                        modifiers: 0,
                    });
                }
            }
            return;
        }
        _ => {}
    }

    let scope_to_use = next_scope.as_ref().unwrap_or(scope);
    for child in node.children(cursor) {
        let mut sub_cursor = child.walk();
        walk_definitions(child, &mut sub_cursor, src, lines, scope_to_use, fi);
    }
}

// ── Pass 3: 引用 walker ─────────────────────────────────────

fn walk_references<'a>(
    node: Node<'a>,
    cursor: &mut TreeCursor<'a>,
    src: &[u8],
    lines: &[&str],
    imports: &[ImportEntry],
    package: Option<&str>,
    refs: &mut Vec<RefEntry>,
) {
    let kind = node.kind();
    match kind {
        "method_invocation" => {
            // foo() / obj.foo() / Foo.foo()
            if let Some(name_node) = node.child_by_field_name("name") {
                if let Ok(name) = name_node.utf8_text(src) {
                    let target_fqn = resolve_method_invocation_target(node, src, imports, package, name);
                    let line_text = preview_of(lines, name_node.start_position().row);
                    refs.push(RefEntry {
                        name: name.to_string(),
                        line: row_to_line(name_node.start_position().row),
                        column: utf8_col_to_utf16(lines, name_node.start_position()),
                        end_column: utf8_col_to_utf16(lines, name_node.end_position()),
                        ref_kind: RefKind::Call,
                        target_fqn,
                        line_text,
                    });
                }
            }
        }
        "object_creation_expression" => {
            // new Foo(...) — 取 type
            if let Some(t) = node.child_by_field_name("type") {
                if let Some((nm_node, nm)) = innermost_type_name(t, src) {
                    let target_fqn = resolve_type_target(&nm, imports, package);
                    let line_text = preview_of(lines, nm_node.start_position().row);
                    refs.push(RefEntry {
                        name: nm,
                        line: row_to_line(nm_node.start_position().row),
                        column: utf8_col_to_utf16(lines, nm_node.start_position()),
                        end_column: utf8_col_to_utf16(lines, nm_node.end_position()),
                        ref_kind: RefKind::New,
                        target_fqn,
                        line_text,
                    });
                }
            }
        }
        "type_identifier" => {
            // 各种类型出现（extends/implements/参数/返回值/字段）
            if let Ok(name) = node.utf8_text(src) {
                let target_fqn = resolve_type_target(name, imports, package);
                let line_text = preview_of(lines, node.start_position().row);
                refs.push(RefEntry {
                    name: name.to_string(),
                    line: row_to_line(node.start_position().row),
                    column: utf8_col_to_utf16(lines, node.start_position()),
                    end_column: utf8_col_to_utf16(lines, node.end_position()),
                    ref_kind: RefKind::Type,
                    target_fqn,
                    line_text,
                });
            }
            // type_identifier 没有更深的有意义子节点，直接 return
            return;
        }
        "field_access" => {
            // obj.field — 仅记 field 名（target 解析交给排序兜底）
            if let Some(name_node) = node.child_by_field_name("field") {
                if let Ok(name) = name_node.utf8_text(src) {
                    let line_text = preview_of(lines, name_node.start_position().row);
                    refs.push(RefEntry {
                        name: name.to_string(),
                        line: row_to_line(name_node.start_position().row),
                        column: utf8_col_to_utf16(lines, name_node.start_position()),
                        end_column: utf8_col_to_utf16(lines, name_node.end_position()),
                        ref_kind: RefKind::FieldRead,
                        target_fqn: None,
                        line_text,
                    });
                }
            }
        }
        _ => {}
    }

    for child in node.children(cursor) {
        let mut sub_cursor = child.walk();
        walk_references(child, &mut sub_cursor, src, lines, imports, package, refs);
    }
}

// ── 解析辅助 ────────────────────────────────────────────────

/// 提取节点上的修饰符位掩码（搜索 modifiers 子节点的文本）
fn extract_modifiers(node: Node<'_>, src: &[u8]) -> u32 {
    let mut mask = 0u32;
    let mut cursor = node.walk();
    for c in node.children(&mut cursor) {
        if c.kind() != "modifiers" {
            continue;
        }
        let mut c2 = c.walk();
        for mc in c.children(&mut c2) {
            // 注解节点不参与位掩码
            if mc.kind() == "annotation" || mc.kind() == "marker_annotation" {
                continue;
            }
            if let Ok(text) = mc.utf8_text(src) {
                match text {
                    "public" => mask |= modifiers::PUBLIC,
                    "private" => mask |= modifiers::PRIVATE,
                    "protected" => mask |= modifiers::PROTECTED,
                    "static" => mask |= modifiers::STATIC,
                    "final" => mask |= modifiers::FINAL,
                    "abstract" => mask |= modifiers::ABSTRACT,
                    "synchronized" => mask |= modifiers::SYNCHRONIZED,
                    "native" => mask |= modifiers::NATIVE,
                    "default" => mask |= modifiers::DEFAULT,
                    "strictfp" => mask |= modifiers::STRICTFP,
                    "sealed" => mask |= modifiers::SEALED,
                    _ => {}
                }
            }
        }
    }
    mask
}

/// 方法签名摘要（参数类型列表）
/// 简化处理：直接取 formal_parameters 的源文本，去掉修饰符/参数名细节代价太高，
/// 而对人类可读性又最有用——这里直接保留括号原样文本，最长截到 200 字符。
fn extract_method_signature(node: Node<'_>, src: &[u8]) -> String {
    if let Some(params) = node.child_by_field_name("parameters") {
        if let Ok(text) = params.utf8_text(src) {
            let trimmed = text.replace('\n', " ").replace('\r', "");
            let collapsed = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
            if collapsed.chars().count() > 200 {
                return collapsed.chars().take(200).collect();
            }
            return collapsed;
        }
    }
    "()".into()
}

/// 找第一个特定 kind 的子节点
fn first_named_of_kinds<'a>(node: Node<'a>, kinds: &[&str]) -> Option<Node<'a>> {
    let mut cursor = node.walk();
    for c in node.named_children(&mut cursor) {
        if kinds.contains(&c.kind()) {
            return Some(c);
        }
    }
    None
}

/// 是否含有某个匿名（关键字）子节点
fn has_anonymous_child(node: Node<'_>, kind: &str) -> bool {
    let mut cursor = node.walk();
    for c in node.children(&mut cursor) {
        if c.kind() == kind {
            return true;
        }
    }
    false
}

/// 在 type 节点里找最内层 type_identifier（处理 generic_type / array_type 嵌套）
fn innermost_type_name<'a>(node: Node<'a>, src: &[u8]) -> Option<(Node<'a>, String)> {
    match node.kind() {
        "type_identifier" => {
            let s = node.utf8_text(src).ok()?;
            Some((node, s.to_string()))
        }
        "generic_type" | "array_type" => {
            // child_by_field_name("element") 或第一个 type_identifier 子
            if let Some(t) = first_named_of_kinds(node, &["type_identifier"]) {
                let s = t.utf8_text(src).ok()?;
                return Some((t, s.to_string()));
            }
            None
        }
        "scoped_type_identifier" => {
            // 例：Outer.Inner — 取最后一段
            let mut last: Option<Node<'_>> = None;
            let mut cursor = node.walk();
            for c in node.named_children(&mut cursor) {
                if c.kind() == "type_identifier" {
                    last = Some(c);
                }
            }
            if let Some(t) = last {
                let s = t.utf8_text(src).ok()?;
                return Some((t, s.to_string()));
            }
            None
        }
        _ => None,
    }
}

/// 从 imports/package 解析类型短名 → FQN（best-effort）
fn resolve_type_target(short: &str, imports: &[ImportEntry], package: Option<&str>) -> Option<String> {
    // 1. 显式 import
    for imp in imports {
        if !imp.is_wildcard
            && !imp.is_static
            && imp.short_name.as_deref() == Some(short)
        {
            return Some(imp.fqn.clone());
        }
    }
    // 2. java.lang.* 隐式
    if is_java_lang_type(short) {
        return Some(format!("java.lang.{}", short));
    }
    // 3. 同包（保守：返回 pkg.Short，可能错——但在排序里仍是更好的提示）
    if let Some(pkg) = package {
        if !pkg.is_empty() {
            return Some(format!("{}.{}", pkg, short));
        }
    }
    None
}

/// `obj.foo()` / `Foo.foo()` / `foo()` 的 best-effort 目标解析
fn resolve_method_invocation_target(
    node: Node<'_>,
    src: &[u8],
    imports: &[ImportEntry],
    package: Option<&str>,
    method_name: &str,
) -> Option<String> {
    if let Some(obj) = node.child_by_field_name("object") {
        // 形如 Foo.bar() 时 obj 是 identifier，名字大写约定为类型
        if obj.kind() == "identifier" {
            if let Ok(text) = obj.utf8_text(src) {
                if starts_uppercase(text) {
                    if let Some(type_fqn) = resolve_type_target(text, imports, package) {
                        return Some(format!("{}.{}", type_fqn, method_name));
                    }
                }
            }
        }
        // 形如 a.b.Foo.bar()
        if obj.kind() == "field_access" {
            // 暂不深入（成本高）
            return None;
        }
    } else {
        // 没有 object → 静态 import 命中？
        for imp in imports {
            if imp.is_static && !imp.is_wildcard && imp.short_name.as_deref() == Some(method_name) {
                return Some(imp.fqn.clone());
            }
        }
    }
    None
}

fn is_java_lang_type(short: &str) -> bool {
    matches!(
        short,
        "Object"
            | "String"
            | "Integer"
            | "Long"
            | "Short"
            | "Byte"
            | "Float"
            | "Double"
            | "Boolean"
            | "Character"
            | "Number"
            | "Math"
            | "System"
            | "Thread"
            | "Runtime"
            | "Exception"
            | "RuntimeException"
            | "Error"
            | "Throwable"
            | "IllegalArgumentException"
            | "IllegalStateException"
            | "NullPointerException"
            | "IndexOutOfBoundsException"
            | "ClassCastException"
            | "NumberFormatException"
            | "UnsupportedOperationException"
            | "Class"
            | "Iterable"
            | "Comparable"
            | "Cloneable"
            | "Enum"
            | "Record"
            | "AutoCloseable"
            | "CharSequence"
            | "StringBuilder"
            | "StringBuffer"
            | "Void"
            | "ProcessBuilder"
            | "Process"
            | "ThreadLocal"
            | "Override"
            | "Deprecated"
            | "SuppressWarnings"
            | "FunctionalInterface"
            | "SafeVarargs"
    )
}

fn starts_uppercase(s: &str) -> bool {
    s.chars().next().map(|c| c.is_ascii_uppercase()).unwrap_or(false)
}

// ── 行/列归一化 ────────────────────────────────────────────

fn row_to_line(row: usize) -> u32 {
    (row + 1) as u32
}

/// tree-sitter 的 column 是字节偏移（UTF-8）；我们要 UTF-16 列。
/// 简单做法：取该行内容前缀，把字节长度换成 UTF-16 单元数。
fn utf8_col_to_utf16(lines: &[&str], pos: tree_sitter::Point) -> u32 {
    let row = pos.row;
    let byte_col = pos.column;
    let Some(line) = lines.get(row) else {
        return byte_col as u32;
    };
    // 截取到 byte_col 字节
    let prefix_bytes = byte_col.min(line.len());
    let prefix = match std::str::from_utf8(&line.as_bytes()[..prefix_bytes]) {
        Ok(s) => s,
        Err(_) => &line[..0], // UTF-8 边界异常，保守返回 0
    };
    prefix.encode_utf16().count() as u32
}

fn preview_of(lines: &[&str], row: usize) -> String {
    let raw = lines.get(row).copied().unwrap_or("");
    let trimmed = raw.trim_end_matches(|c: char| c == '\n' || c == '\r').trim();
    if trimmed.chars().count() > 200 {
        let s: String = trimmed.chars().take(200).collect();
        format!("{}…", s)
    } else {
        trimmed.to_string()
    }
}
