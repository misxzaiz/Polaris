/**
 * LSP 语言服务器 Tauri IPC 封装
 *
 * 薄封装层，将 Tauri invoke 调用包装为类型安全的 async 函数。
 * 后端命令定义在 src-tauri/src/commands/lsp.rs
 */

import { invoke } from '@/services/transport';

import type { LspServerConfig } from '@/stores/lspStore';

// ── 进程管理 ──────────────────────────────────────

/** 启动语言服务器进程 */
export async function lspStart(id: string, command: string, args: string[]): Promise<void> {
  return invoke('lsp_start', { id, command, args });
}

/** 发送 JSON-RPC 消息到语言服务器 */
export async function lspSend(id: string, data: string): Promise<void> {
  return invoke('lsp_send', { id, data });
}

/** 停止语言服务器进程 */
export async function lspStop(id: string): Promise<void> {
  return invoke('lsp_stop', { id });
}

/** 列出所有活跃的 LSP 会话 */
export async function lspListSessions(): Promise<string[]> {
  return invoke('lsp_list_sessions');
}

// ── 配置管理 ──────────────────────────────────────

/** 读取所有 LSP 服务器配置 */
export async function lspConfigList(): Promise<LspServerConfig[]> {
  return invoke('lsp_config_list');
}

/** 添加或更新 LSP 服务器配置 */
export async function lspConfigUpsert(entry: LspServerConfig): Promise<void> {
  return invoke('lsp_config_upsert', { entry });
}

/** 删除 LSP 服务器配置 */
export async function lspConfigRemove(id: string): Promise<void> {
  return invoke('lsp_config_remove', { id });
}

/** 切换 LSP 服务器启用/禁用 */
export async function lspConfigToggle(id: string, enabled: boolean): Promise<void> {
  return invoke('lsp_config_toggle', { id, enabled });
}

// ── 命令校验 ──────────────────────────────────────

/** 命令存在性校验结果 */
export interface LspCommandCheck {
  /** 是否在 PATH 中找到 */
  found: boolean;
  /** 解析到的完整路径（找到时） */
  resolvedPath: string | null;
}

/** 校验语言服务器可执行文件是否存在 */
export async function lspCheckCommand(command: string): Promise<LspCommandCheck> {
  return invoke('lsp_check_command', { command });
}

// ── 轻量索引模式（无常驻进程）─────────────────────

/** 索引模式匹配结果（对应后端 lsp_index::IndexMatch） */
export interface IndexMatch {
  /** 文件绝对路径 */
  path: string;
  /** 行号（1-based） */
  line: number;
  /** 列号（0-based） */
  column: number;
  /** 该行预览文本 */
  preview: string;
}

/** 索引模式：查找符号的全部引用 */
export async function lspIndexReferences(
  root: string,
  symbol: string,
  extensions: string[],
): Promise<IndexMatch[]> {
  return invoke('lsp_index_references', { root, symbol, extensions });
}

/** 索引模式：查找符号的定义候选 */
export async function lspIndexDefinition(
  root: string,
  symbol: string,
  language: string,
  extensions: string[],
): Promise<IndexMatch[]> {
  return invoke('lsp_index_definition', { root, symbol, language, extensions });
}
