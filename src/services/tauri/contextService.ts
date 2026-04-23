/**
 * 上下文管理相关 Tauri 命令
 * 包含：上下文查询、IDE 上报、上下文 CRUD
 */

import { invoke } from '@/services/transport';

// ============================================================================
// 类型定义
// ============================================================================

/** 上下文来源类型 */
export type ContextSource = 'project' | 'workspace' | 'ide' | 'user_selection' | 'semantic_related' | 'history' | 'diagnostics';

/** 上下文类型 */
export type ContextType = 'file' | 'file_structure' | 'symbol' | 'selection' | 'diagnostics' | 'project_meta';

/** 上下文条目 */
export interface ContextEntry {
  id: string;
  source: ContextSource;
  type: ContextType;
  priority: number;
  content: ContextContent;
  workspace_id?: string;
  created_at: number;
  expires_at?: number;
  estimated_tokens: number;
}

/** 上下文内容 */
export type ContextContent =
  | { type: 'file'; path: string; content: string; language: string }
  | { type: 'file_structure'; path: string; symbols: ContextSymbol[]; summary?: string }
  | { type: 'symbol'; name: string; definition: ContextLocation; kind: SymbolKind; documentation?: string; signature?: string }
  | { type: 'selection'; path: string; range: ContextRange; content: string; context_lines?: number }
  | { type: 'diagnostics'; path?: string; items: ContextDiagnostic[]; summary?: ContextDiagnosticSummary }
  | { type: 'project_meta'; name: string; root_dir: string; project_type: string; languages: string[]; frameworks: string[] };

/** 符号类型 */
export type SymbolKind = 'class' | 'interface' | 'enum' | 'function' | 'method' | 'variable' | 'constant' | 'property';

/** 上下文符号 */
export interface ContextSymbol {
  name: string;
  kind: SymbolKind;
  location: ContextLocation;
  documentation?: string;
  children?: ContextSymbol[];
}

/** 上下文位置 */
export interface ContextLocation {
  path: string;
  line_start: number;
  line_end: number;
  column_start?: number;
  column_end?: number;
}

/** 上下文范围 */
export interface ContextRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** 上下文诊断 */
export interface ContextDiagnostic {
  path: string;
  severity: string;
  message: string;
  range: ContextRange;
  code?: string;
  source?: string;
}

/** 诊断摘要 */
export interface ContextDiagnosticSummary {
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
}

/** 上下文查询请求 */
export interface ContextQueryRequest {
  workspace_id?: string;
  types?: ContextType[];
  sources?: ContextSource[];
  max_tokens?: number;
  min_priority?: number;
  current_file?: string;
  mentioned_files?: string[];
}

/** 上下文查询结果 */
export interface ContextQueryResult {
  entries: ContextEntry[];
  total_tokens: number;
  summary: ContextSummary;
}

/** 上下文摘要 */
export interface ContextSummary {
  file_count: number;
  symbol_count: number;
  workspace_ids: string[];
  languages: string[];
}

// ============================================================================
// 命令函数
// ============================================================================

/** 查询上下文 */
export async function queryContext(request: ContextQueryRequest): Promise<ContextQueryResult> {
  return invoke('context_query', { request });
}

/** 添加或更新上下文 */
export async function upsertContext(entry: ContextEntry): Promise<void> {
  return invoke('context_upsert', { entry });
}

/** 批量添加或更新上下文 */
export async function upsertContextMany(entries: ContextEntry[]): Promise<void> {
  return invoke('context_upsert_many', { entries });
}

/** 获取所有上下文 */
export async function getAllContext(): Promise<ContextEntry[]> {
  return invoke('context_get_all');
}

/** 移除上下文 */
export async function removeContext(id: string): Promise<void> {
  return invoke('context_remove', { id });
}

/** 清空上下文 */
export async function clearContext(): Promise<void> {
  return invoke('context_clear');
}

/** IDE 上报当前文件 */
export async function ideReportCurrentFile(context: {
  workspace_id: string;
  file_path: string;
  content: string;
  language: string;
  cursor_offset: number;
}): Promise<void> {
  return invoke('ide_report_current_file', { context });
}

/** IDE 上报文件结构 */
export async function ideReportFileStructure(structure: {
  workspace_id: string;
  file_path: string;
  symbols: ContextSymbol[];
}): Promise<void> {
  return invoke('ide_report_file_structure', { structure });
}

/** IDE 上报诊断信息 */
export async function ideReportDiagnostics(diagnostics: {
  workspace_id: string;
  file_path: string;
  diagnostics: ContextDiagnostic[];
}): Promise<void> {
  return invoke('ide_report_diagnostics', { diagnostics });
}
