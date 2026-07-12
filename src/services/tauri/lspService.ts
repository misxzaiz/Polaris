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
  /** 符号种类（class/interface/method/...）；regex 兜底为 undefined */
  kind?: string;
  /** 完整限定名 */
  fqn?: string;
  /** 引用种类（call/type/new/...）；仅引用查询有 */
  refKind?: string;
  /** 排序得分（调试用） */
  score?: number;
}

/** dirty buffer：编辑器里未保存的修改，跳转/查应用时传给后端覆盖 DB 数据 */
export interface DirtyBuffer {
  /** 文件绝对路径 */
  path: string;
  /** 文件全文 */
  content: string;
  /** 语言 ID */
  language: string;
}

/** 索引引擎状态（对应后端 IndexStatus） */
export interface IndexStatus {
  workspace: string | null;
  /** 'idle' | 'building' | 'ready' | 'error' */
  state: string;
  progressDone: number;
  progressTotal: number;
  files: number;
  symbols: number;
  refs: number;
  error: string | null;
  lastBuiltAt: number | null;
}

/** 索引模式：查找符号的全部引用 */
export async function lspIndexReferences(
  root: string,
  symbol: string,
  extensions: string[],
  currentFile?: string,
  liveOverrides?: DirtyBuffer[],
): Promise<IndexMatch[]> {
  return invoke('lsp_index_references', {
    root,
    symbol,
    extensions,
    currentFile: currentFile ?? null,
    liveOverrides: liveOverrides ?? null,
  });
}

/** 索引模式：查找符号的定义候选 */
export async function lspIndexDefinition(
  root: string,
  symbol: string,
  language: string,
  extensions: string[],
  currentFile?: string,
  liveOverrides?: DirtyBuffer[],
): Promise<IndexMatch[]> {
  return invoke('lsp_index_definition', {
    root,
    symbol,
    language,
    extensions,
    currentFile: currentFile ?? null,
    liveOverrides: liveOverrides ?? null,
  });
}

/** 打开工作区索引（首次会创建 .polaris/index.db） */
export async function lspIndexOpen(root: string): Promise<IndexStatus> {
  return invoke('lsp_index_open', { root });
}

/** 关闭工作区索引（释放 DB 句柄） */
export async function lspIndexClose(root: string): Promise<void> {
  return invoke('lsp_index_close', { root });
}

/** 触发后台全量重建 */
export async function lspIndexRebuild(root: string): Promise<void> {
  return invoke('lsp_index_rebuild', { root });
}

/** 查询当前索引状态 */
export async function lspIndexStatus(root: string): Promise<IndexStatus> {
  return invoke('lsp_index_status', { root });
}

/** 单文件增量更新（保存文件后调用，可选——watcher 通常会自动触发） */
export async function lspIndexUpdateFile(root: string, absPath: string): Promise<void> {
  return invoke('lsp_index_update_file', { root, absPath });
}
