/*! 上下文管理 Tauri 命令
 * 供 IDE 插件调用的上下文管理接口
 */

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::State;

// ========================================
// 类型定义
// ========================================

/// 上下文来源
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextSource {
    Project,
    Workspace,
    Ide,
    UserSelection,
    SemanticRelated,
    History,
    Diagnostics,
}

/// 上下文类型
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextType {
    File,
    FileStructure,
    Symbol,
    Selection,
    Diagnostics,
    ProjectMeta,
}

/// 优先级 (0-5)
pub type ContextPriority = u8;

/// 代码位置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Location {
    pub path: String,
    pub line_start: u32,
    pub line_end: u32,
    pub column_start: Option<u32>,
    pub column_end: Option<u32>,
}

/// 代码范围
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

/// 符号类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolKind {
    Class,
    Interface,
    Enum,
    Function,
    Method,
    Variable,
    Constant,
    Property,
}

/// 符号信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolInfo {
    pub name: String,
    pub kind: SymbolKind,
    pub location: Location,
    pub documentation: Option<String>,
    pub children: Option<Vec<SymbolInfo>>,
}

/// 诊断条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub path: String,
    pub severity: String, // "error", "warning", "info", "hint"
    pub message: String,
    pub range: Range,
    pub code: Option<String>,
    pub source: Option<String>,
}

/// 上下文条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextEntry {
    pub id: String,
    pub source: ContextSource,
    pub type_: ContextType,
    pub priority: ContextPriority,
    pub content: ContextContent,
    pub workspace_id: Option<String>,
    pub created_at: u64,
    pub expires_at: Option<u64>,
    pub estimated_tokens: u32,
}

/// 上下文内容
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContextContent {
    File(FileContent),
    FileStructure(FileStructureContent),
    Symbol(SymbolContent),
    Selection(SelectionContent),
    Diagnostics(DiagnosticsContent),
    ProjectMeta(ProjectMetaContent),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStructureContent {
    pub path: String,
    pub symbols: Vec<SymbolInfo>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolContent {
    pub name: String,
    pub definition: Location,
    pub kind: SymbolKind,
    pub documentation: Option<String>,
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectionContent {
    pub path: String,
    pub range: Range,
    pub content: String,
    pub context_lines: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticsContent {
    pub path: Option<String>,
    pub items: Vec<Diagnostic>,
    pub summary: Option<DiagnosticSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticSummary {
    pub errors: u32,
    pub warnings: u32,
    pub infos: u32,
    pub hints: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMetaContent {
    pub name: String,
    pub root_dir: String,
    pub project_type: String,
    pub languages: Vec<String>,
    pub frameworks: Vec<String>,
}

/// 上下文查询请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextQueryRequest {
    pub workspace_id: Option<String>,
    pub types: Option<Vec<ContextType>>,
    pub sources: Option<Vec<ContextSource>>,
    pub max_tokens: Option<u32>,
    pub min_priority: Option<u8>,
    pub current_file: Option<String>,
    pub mentioned_files: Option<Vec<String>>,
}

/// 上下文查询结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextQueryResult {
    pub entries: Vec<ContextEntry>,
    pub total_tokens: u32,
    pub summary: ContextSummary,
}

/// 上下文摘要
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSummary {
    pub file_count: usize,
    pub symbol_count: usize,
    pub workspace_ids: Vec<String>,
    pub languages: Vec<String>,
}

/// IDE 上报的当前文件上下文
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdeFileContext {
    pub workspace_id: String,
    pub file_path: String,
    pub content: String,
    pub language: String,
    pub cursor_offset: usize,
    pub selection: Option<Range>,
}

/// IDE 上报的文件结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdeFileStructure {
    pub workspace_id: String,
    pub file_path: String,
    pub symbols: Vec<SymbolInfo>,
}

/// IDE 上报的诊断信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdeDiagnostics {
    pub workspace_id: String,
    pub file_path: String,
    pub diagnostics: Vec<Diagnostic>,
}

// ========================================
// 内存存储
// ========================================

/// 内存中的上下文存储
pub struct ContextMemoryStore {
    entries: HashMap<String, ContextEntry>,
}

impl ContextMemoryStore {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    pub fn upsert(&mut self, entry: ContextEntry) {
        self.entries.insert(entry.id.clone(), entry);
    }

    pub fn get(&self, id: &str) -> Option<&ContextEntry> {
        self.entries.get(id)
    }

    pub fn remove(&mut self, id: &str) -> Option<ContextEntry> {
        self.entries.remove(id)
    }

    pub fn get_all(&self) -> Vec<ContextEntry> {
        self.entries.values().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn query(&self, request: &ContextQueryRequest) -> ContextQueryResult {
        let mut entries: Vec<ContextEntry> = self.entries.values()
            .filter(|entry| {
                // 过滤条件
                if let Some(workspace_id) = &request.workspace_id {
                    if entry.workspace_id.as_ref() != Some(workspace_id) {
                        return false;
                    }
                }

                if let Some(types) = &request.types {
                    if !types.contains(&entry.type_) {
                        return false;
                    }
                }

                if let Some(min_priority) = request.min_priority {
                    if entry.priority < min_priority {
                        return false;
                    }
                }

                true
            })
            .cloned()
            .collect();

        // 按优先级排序
        entries.sort_by(|a, b| b.priority.cmp(&a.priority));

        // 计算 Token 预算
        let max_tokens = request.max_tokens.unwrap_or(8000);
        let mut total_tokens = 0;
        let selected: Vec<ContextEntry> = entries
            .into_iter()
            .take_while(|e| {
                total_tokens += e.estimated_tokens;
                total_tokens <= max_tokens
            })
            .collect();

        // 构建摘要
        let summary = Self::build_summary(&selected);

        ContextQueryResult {
            entries: selected,
            total_tokens,
            summary,
        }
    }

    fn build_summary(entries: &[ContextEntry]) -> ContextSummary {
        use std::collections::HashSet;

        let mut file_count = 0;
        let mut symbol_count = 0;
        let mut workspace_ids = HashSet::new();
        let mut languages = HashSet::new();

        for entry in entries {
            match entry.type_ {
                ContextType::File | ContextType::FileStructure => file_count += 1,
                ContextType::Symbol => symbol_count += 1,
                _ => {}
            }

            if let Some(workspace_id) = &entry.workspace_id {
                workspace_ids.insert(workspace_id.clone());
            }

            // 提取语言
            if let ContextContent::File(f) = &entry.content {
                languages.insert(f.language.clone());
            }
        }

        ContextSummary {
            file_count,
            symbol_count,
            workspace_ids: workspace_ids.into_iter().collect(),
            languages: languages.into_iter().collect(),
        }
    }
}

impl Default for ContextMemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

// ========================================
// Tauri 命令
// ========================================

/// 添加或更新上下文条目
#[tauri::command]
pub async fn context_upsert(
    entry: ContextEntry,
    store: State<'_, Arc<Mutex<ContextMemoryStore>>>,
) -> Result<(), String> {
    let mut guard = store.lock().map_err(|e| e.to_string())?;
    guard.upsert(entry);
    Ok(())
}

/// 批量添加或更新上下文条目
#[tauri::command]
pub async fn context_upsert_many(
    entries: Vec<ContextEntry>,
    store: State<'_, Arc<Mutex<ContextMemoryStore>>>,
) -> Result<(), String> {
    let mut guard = store.lock().map_err(|e| e.to_string())?;
    for entry in entries {
        guard.upsert(entry);
    }
    Ok(())
}

/// 查询上下文
#[tauri::command]
pub async fn context_query(
    request: ContextQueryRequest,
    store: State<'_, Arc<Mutex<ContextMemoryStore>>>,
) -> Result<ContextQueryResult, String> {
    let guard = store.lock().map_err(|e| e.to_string())?;
    Ok(guard.query(&request))
}

/// 获取所有上下文条目
#[tauri::command]
pub async fn context_get_all(
    store: State<'_, Arc<Mutex<ContextMemoryStore>>>,
) -> Result<Vec<ContextEntry>, String> {
    let guard = store.lock().map_err(|e| e.to_string())?;
    Ok(guard.get_all())
}

/// 移除指定的上下文条目
#[tauri::command]
pub async fn context_remove(
    id: String,
    store: State<'_, Arc<Mutex<ContextMemoryStore>>>,
) -> Result<(), String> {
    let mut guard = store.lock().map_err(|e| e.to_string())?;
    guard.remove(&id);
    Ok(())
}

/// 清空所有上下文
#[tauri::command]
pub async fn context_clear(
    store: State<'_, Arc<Mutex<ContextMemoryStore>>>,
) -> Result<(), String> {
    let mut guard = store.lock().map_err(|e| e.to_string())?;
    guard.clear();
    Ok(())
}

/// IDE 插件上报当前文件上下文
#[tauri::command]
pub async fn ide_report_current_file(
    context: IdeFileContext,
    store: State<'_, Arc<Mutex<ContextMemoryStore>>>,
) -> Result<(), String> {
    let mut guard = store.lock().map_err(|e| e.to_string())?;

    // 创建文件上下文条目
    let entry = ContextEntry {
        id: format!("ide:current_file:{}", context.file_path),
        source: ContextSource::Ide,
        type_: ContextType::File,
        priority: 4,
        content: ContextContent::File(FileContent {
            path: context.file_path.clone(),
            content: context.content,
            language: context.language,
        }),
        workspace_id: Some(context.workspace_id),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        expires_at: None,
        estimated_tokens: 500, // 简化估算
    };

    guard.upsert(entry);
    Ok(())
}

/// IDE 插件上报文件结构
#[tauri::command]
pub async fn ide_report_file_structure(
    structure: IdeFileStructure,
    store: State<'_, Arc<Mutex<ContextMemoryStore>>>,
) -> Result<(), String> {
    let mut guard = store.lock().map_err(|e| e.to_string())?;

    let entry = ContextEntry {
        id: format!("ide:structure:{}", structure.file_path),
        source: ContextSource::Ide,
        type_: ContextType::FileStructure,
        priority: 3,
        content: ContextContent::FileStructure(FileStructureContent {
            path: structure.file_path.clone(),
            symbols: structure.symbols,
            summary: None,
        }),
        workspace_id: Some(structure.workspace_id),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        expires_at: None,
        estimated_tokens: 100,
    };

    guard.upsert(entry);
    Ok(())
}

/// IDE 插件上报诊断信息
#[tauri::command]
pub async fn ide_report_diagnostics(
    diagnostics: IdeDiagnostics,
    store: State<'_, Arc<Mutex<ContextMemoryStore>>>,
) -> Result<(), String> {
    let mut guard = store.lock().map_err(|e| e.to_string())?;

    let entry = ContextEntry {
        id: format!("ide:diagnostics:{}", diagnostics.file_path),
        source: ContextSource::Diagnostics,
        type_: ContextType::Diagnostics,
        priority: 2,
        content: ContextContent::Diagnostics(DiagnosticsContent {
            path: Some(diagnostics.file_path.clone()),
            items: diagnostics.diagnostics,
            summary: None,
        }),
        workspace_id: Some(diagnostics.workspace_id),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        expires_at: None,
        estimated_tokens: 50,
    };

    guard.upsert(entry);
    Ok(())
}
