/*! 索引引擎数据模型
 *
 * 共用类型集中在此：
 * - 内部数据类型（Symbol/RefEntry/ImportEntry/FileIndex）
 * - 持久化层与查询层的桥
 * - 序列化到前端的 IndexMatch（兼容旧 regex_fallback 的形态）
 */

use serde::{Deserialize, Serialize};

// ── 符号种类（位编码 → DB） ──────────────────────────────────

/// 符号种类。使用紧凑整数编码，便于 SQLite 索引。
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SymbolKind {
    Class = 1,
    Interface = 2,
    Enum = 3,
    Record = 4,
    Annotation = 5,
    Method = 6,
    Constructor = 7,
    Field = 8,
    EnumConstant = 9,
    TypeParam = 10,
    Package = 11,
    /// 未识别（兜底，不应出现在生产路径）
    Unknown = 0,
}

impl SymbolKind {
    pub fn from_i64(v: i64) -> Self {
        match v {
            1 => Self::Class,
            2 => Self::Interface,
            3 => Self::Enum,
            4 => Self::Record,
            5 => Self::Annotation,
            6 => Self::Method,
            7 => Self::Constructor,
            8 => Self::Field,
            9 => Self::EnumConstant,
            10 => Self::TypeParam,
            11 => Self::Package,
            _ => Self::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Class => "class",
            Self::Interface => "interface",
            Self::Enum => "enum",
            Self::Record => "record",
            Self::Annotation => "annotation",
            Self::Method => "method",
            Self::Constructor => "constructor",
            Self::Field => "field",
            Self::EnumConstant => "enum_constant",
            Self::TypeParam => "type_param",
            Self::Package => "package",
            Self::Unknown => "unknown",
        }
    }
}

// ── 引用种类 ────────────────────────────────────────────────

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RefKind {
    /// `foo()`、`obj.foo()`
    Call = 1,
    /// 类型出现：`extends/implements/参数/返回值/字段类型`
    Type = 2,
    /// 字段读
    FieldRead = 3,
    /// 字段写
    FieldWrite = 4,
    /// `new Foo(...)`
    New = 5,
    /// `import x.y.Z`
    Import = 6,
    /// `throws X`
    Throws = 7,
    Unknown = 0,
}

impl RefKind {
    pub fn from_i64(v: i64) -> Self {
        match v {
            1 => Self::Call,
            2 => Self::Type,
            3 => Self::FieldRead,
            4 => Self::FieldWrite,
            5 => Self::New,
            6 => Self::Import,
            7 => Self::Throws,
            _ => Self::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Call => "call",
            Self::Type => "type",
            Self::FieldRead => "field_read",
            Self::FieldWrite => "field_write",
            Self::New => "new",
            Self::Import => "import",
            Self::Throws => "throws",
            Self::Unknown => "unknown",
        }
    }
}

// ── 修饰符（Java 位掩码） ───────────────────────────────────

pub mod modifiers {
    pub const PUBLIC: u32 = 1 << 0;
    pub const PRIVATE: u32 = 1 << 1;
    pub const PROTECTED: u32 = 1 << 2;
    pub const STATIC: u32 = 1 << 3;
    pub const FINAL: u32 = 1 << 4;
    pub const ABSTRACT: u32 = 1 << 5;
    pub const SYNCHRONIZED: u32 = 1 << 6;
    pub const NATIVE: u32 = 1 << 7;
    pub const DEFAULT: u32 = 1 << 8;
    pub const STRICTFP: u32 = 1 << 9;
    pub const SEALED: u32 = 1 << 10;
}

// ── 提取器输出（in-memory） ─────────────────────────────────

#[derive(Debug, Clone)]
pub struct Symbol {
    pub name: String,
    pub fqn: String,
    pub kind: SymbolKind,
    pub parent_fqn: Option<String>,
    /// 整体声明范围（从修饰符首字到结尾），1-based 行
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    /// 标识符自身位置（光标落点）
    pub name_line: u32,
    pub name_column: u32,
    /// 方法签名摘要（参数类型列表）；非方法/构造时为 None
    pub signature: Option<String>,
    pub modifiers: u32,
}

#[derive(Debug, Clone)]
pub struct RefEntry {
    pub name: String,
    pub line: u32,
    pub column: u32,
    pub end_column: u32,
    pub ref_kind: RefKind,
    /// best-effort 解析得到的目标 FQN
    pub target_fqn: Option<String>,
    /// 该行去除首尾空白后的预览（截断到 200 字符）
    pub line_text: String,
}

#[derive(Debug, Clone)]
pub struct ImportEntry {
    /// 完整 FQN（wildcard 时不含 `.*`）
    pub fqn: String,
    /// 类名 / 静态成员名；wildcard 时为 None
    pub short_name: Option<String>,
    pub is_static: bool,
    pub is_wildcard: bool,
}

#[derive(Debug, Clone, Default)]
pub struct FileIndex {
    /// workspace 相对路径（统一正斜杠）
    pub rel_path: String,
    /// 语言 ID（"java" / "kotlin" / ...）
    pub language: String,
    pub mtime_ns: i64,
    pub size: u64,
    pub content_hash: u64,
    /// 包声明 FQN（未声明时为 None）
    pub package: Option<String>,
    pub symbols: Vec<Symbol>,
    pub refs: Vec<RefEntry>,
    pub imports: Vec<ImportEntry>,
    /// 解析状态：true = tree-sitter 失败已回退
    pub parse_error: bool,
}

// ── 序列化到前端的 DTO ──────────────────────────────────────

/// 单条匹配结果（与旧 `regex_fallback::IndexMatch` 字段兼容，
/// 多出几个新字段——前端按需读取，不读不影响）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMatch {
    pub path: String,
    pub line: u32,
    pub column: u32,
    /// 该行去除首尾空白后的预览
    pub preview: String,
    /// 符号种类（仅当来源是 symbols 表时有意义；regex 兜底为 None）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    /// 完整限定名
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fqn: Option<String>,
    /// 引用种类（来自 refs 表）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_kind: Option<&'static str>,
    /// 排序得分，便于前端调试
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<i32>,
}

impl IndexMatch {
    /// 兼容旧 regex_fallback 形态（无种类/fqn/score）
    pub fn legacy(path: String, line: u32, column: u32, preview: String) -> Self {
        Self {
            path,
            line,
            column,
            preview,
            kind: None,
            fqn: None,
            ref_kind: None,
            score: None,
        }
    }
}

/// dirty buffer（前端传入的未保存修改）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyBuffer {
    /// 绝对路径
    pub path: String,
    /// 文件全文
    pub content: String,
    /// 语言 ID（"java"/"kotlin"/...）
    pub language: String,
}

// ── 索引状态（推送给前端） ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    /// 工作区根（绝对路径）
    pub workspace: Option<String>,
    /// "idle" / "building" / "ready" / "error"
    pub state: String,
    /// 进度：已处理 / 总数（building 状态有效）
    pub progress_done: u32,
    pub progress_total: u32,
    /// 文件总数
    pub files: u32,
    /// 符号总数
    pub symbols: u32,
    /// 引用总数
    pub refs: u32,
    /// 错误信息（state == "error" 时）
    pub error: Option<String>,
    /// 上次完成时间（ms epoch）
    pub last_built_at: Option<i64>,
}
