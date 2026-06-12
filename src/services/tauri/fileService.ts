/**
 * 文件系统相关 Tauri 命令
 * 包含：工作区操作、文件浏览器、内容搜索、文件监听
 */

import { invoke } from '@/services/transport';

// ============================================================================
// 工作区相关命令
// ============================================================================

/** 验证工作区路径 */
export async function validateWorkspacePath(path: string): Promise<boolean> {
  return invoke('validate_workspace_path', { path });
}

/** 获取目录信息 */
export async function getDirectoryInfo(path: string) {
  return invoke('get_directory_info', { path });
}

// ============================================================================
// 文件浏览器相关命令
// ============================================================================

/** 读取目录内容 */
export async function readDirectory(path: string) {
  return invoke('read_directory', { path });
}

/** 获取文件内容 */
export async function getFileContent(path: string): Promise<string> {
  return invoke('get_file_content', { path });
}

/** 读取文件内容（别名） */
export async function readFile(path: string): Promise<string> {
  return invoke('get_file_content', { path });
}

/**
 * 下载文件到本地
 * - Tauri: 通过 base64 二进制接口读取，支持所有文件类型
 * - Web: 浏览器默认下载行为（仅文本文件可靠）
 */
export async function downloadFile(
  filePath: string,
  fileName: string,
): Promise<void> {
  try {
    // 优先使用二进制接口（Tauri 环境）
    const base64Content: string = await invoke('download_file_binary', { path: filePath });
    const binaryString = atob(base64Content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    downloadBlob(blob, fileName);
  } catch {
    // 回退到文本接口（Web 环境或二进制命令不可用时）
    const content = await getFileContent(filePath);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    downloadBlob(blob, fileName);
  }
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 创建文件 */
export async function createFile(path: string, content?: string) {
  return invoke('create_file', { path, content });
}

/** 创建目录 */
export async function createDirectory(path: string) {
  return invoke('create_directory', { path });
}

/** 删除文件或目录 */
export async function deleteFile(path: string) {
  return invoke('delete_file', { path });
}

/** 重命名文件或目录 */
export async function renameFile(oldPath: string, newName: string) {
  return invoke('rename_file', { oldPath, newName });
}

/** 检查路径是否存在 */
export async function pathExists(path: string) {
  return invoke('path_exists', { path });
}

/** 复制文件或目录 */
export async function copyPath(source: string, destination: string) {
  return invoke('copy_path', { source, destination });
}

/** 移动文件或目录 */
export async function movePath(source: string, destination: string) {
  return invoke('move_path', { source, destination });
}

// ============================================================================
// 文件内容搜索命令
// ============================================================================

/** 内容搜索结果 */
export interface ContentMatch {
  /** 文件名 */
  name: string;
  /** 相对路径 */
  relativePath: string;
  /** 完整路径 */
  fullPath: string;
  /** 匹配行号（1-based） */
  lineNumber: number;
  /** 匹配内容 */
  matchedLine: string;
  /** 匹配前的上下文行 */
  contextBefore: string[];
  /** 匹配后的上下文行 */
  contextAfter: string[];
  /** 匹配文本在行中的起始位置 */
  matchStart: number;
  /** 匹配文本在行中的结束位置 */
  matchEnd: number;
}

/**
 * 搜索文件内容
 * @param query 搜索关键词
 * @param workDir 工作目录
 * @param options 搜索选项
 * @param maxResults 最大结果数
 */
export async function searchFileContents(
  query: string,
  workDir: string | null,
  options?: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
  },
  maxResults: number = 100
): Promise<ContentMatch[]> {
  if (!workDir || !query.trim()) {
    return [];
  }

  return invoke<ContentMatch[]>('search_file_contents', {
    workDir,
    query: query.trim(),
    caseSensitive: options?.caseSensitive ?? false,
    wholeWord: options?.wholeWord ?? false,
    maxResults,
  });
}

// ============================================================================
// 文件监听命令
// ============================================================================

/** 启动文件系统监听 */
export async function fsWatchStart(rootPath: string) {
  return invoke('fs_watch_start', { rootPath });
}

/** 停止文件系统监听 */
export async function fsWatchStop() {
  return invoke('fs_watch_stop');
}

/** 获取文件监听状态 */
export async function fsWatchStatus(): Promise<boolean> {
  return invoke('fs_watch_status');
}
