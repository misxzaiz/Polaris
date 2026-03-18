/**
 * 文件编辑器状态管理
 */

import { create } from 'zustand';
import type { FileEditorStore } from '../types';
import * as tauri from '../services/tauri';
import { emit } from '@tauri-apps/api/event';
import { createLogger } from '../utils/logger';

const log = createLogger('Editor');

/** 根据文件扩展名获取语言类型 */
function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    'ts': 'typescript',
    'tsx': 'typescript',
    'js': 'javascript',
    'jsx': 'javascript',
    'json': 'json',
    'md': 'markdown',
    'txt': 'text',
    'html': 'html',
    'css': 'css',
    'scss': 'css',
    'less': 'css',
    'xml': 'xml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'py': 'python',
    'rs': 'rust',
    'go': 'go',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'php': 'php',
    'rb': 'ruby',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'fish': 'shell',
    'sql': 'sql',
    'dart': 'dart',
    'swift': 'swift',
    'kt': 'kotlin',
    'scala': 'scala',
  };
  return languageMap[ext || ''] || 'text';
}

function isImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext || '');
}

export const useFileEditorStore = create<FileEditorStore>((set, get) => ({
  // 初始状态
  isOpen: false,
  currentFile: null,
  status: 'idle',
  error: null,

  // 打开文件
  openFile: async (path: string, name: string) => {
    log.debug('打开文件', { path, name });
    set({ isOpen: true, status: 'loading', error: null });

    try {
      if (isImagePath(path)) {
        set({ isOpen: false, status: 'idle', error: null, currentFile: null });
        await emit('file:preview', { path, name, kind: 'image' });
        return;
      }

      const content = await tauri.getFileContent(path) as string;
      log.debug('文件内容长度', { length: content?.length });
      const language = getLanguageFromPath(path);

      set({
        isOpen: true,
        currentFile: {
          path,
          name,
          content,
          originalContent: content,
          isModified: false,
          language,
        },
        status: 'idle',
        error: null,
      });

      // 发送事件通知 Tab 系统创建 Editor Tab
      try {
        await emit('file:opened', { path, name });
      } catch (emitError) {
        log.warn('发送 file:opened 事件失败', { error: String(emitError) });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '读取文件失败';
      log.error('打开文件失败', error instanceof Error ? error : new Error(String(error)));
      set({
        status: 'error',
        error: errorMessage,
      });
      throw error;
    }
  },

  // 关闭文件
  closeFile: async () => {
    const { currentFile } = get();
    if (currentFile?.isModified) {
      // TODO: 显示未保存提示
    }
    set({
      isOpen: false,
      currentFile: null,
      status: 'idle',
      error: null,
    });
    // 发送事件通知外部组件（事件驱动解耦）
    // 替代直接调用 viewStore.setShowEditor(false)
    try {
      await emit('editor:closed', { path: currentFile?.path });
    } catch (e) {
      log.warn('发送 editor:closed 事件失败', { error: String(e) });
    }
  },

  // 更新内容
  setContent: (content: string) => {
    const { currentFile } = get();
    if (!currentFile) return;

    set({
      currentFile: {
        ...currentFile,
        content,
        isModified: content !== currentFile.originalContent,
      },
    });
  },

  // 保存文件
  saveFile: async () => {
    const { currentFile } = get();
    if (!currentFile) return;

    set({ status: 'saving', error: null });

    try {
      // 先写入文件
      await tauri.createFile(currentFile.path, currentFile.content);

      // 更新状态
      set({
        currentFile: {
          ...currentFile,
          originalContent: currentFile.content,
          isModified: false,
        },
        status: 'idle',
        error: null,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '保存文件失败';
      set({
        status: 'error',
        error: errorMessage,
      });
      throw error;
    }
  },

  // 设置错误
  setError: (error: string | null) => {
    set({ error });
  },

  // 切换编辑器开关
  setOpen: (open: boolean) => {
    set({ isOpen: open });
  },
}));
