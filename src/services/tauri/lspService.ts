/**
 * LSP 语言服务器 Tauri IPC 封装
 *
 * 薄封装层，将 Tauri invoke 调用包装为类型安全的 async 函数。
 * 后端命令定义在 src-tauri/src/commands/lsp.rs
 */

import { invoke } from '@tauri-apps/api/core';

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
