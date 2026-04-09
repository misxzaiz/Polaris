/**
 * 文件编辑器状态管理
 */

import { create } from 'zustand';
import type { FileEditorStore } from '../types';
import * as tauri from '../services/tauri';
import { emit, listen } from '@tauri-apps/api/event';
import { createLogger } from '../utils/logger';
import type { FsChangeEvent } from '../types/fileExplorer';
import { useEditorBufferStore } from './editorBufferStore';

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

/** 将当前文件状态保存到缓冲区 */
function saveCurrentToBuffer() {
  const { currentFile } = useFileEditorStore.getState();
  if (!currentFile) return;
  useEditorBufferStore.getState().saveBuffer(currentFile.path, {
    name: currentFile.name,
    language: currentFile.language,
    content: currentFile.content,
    originalContent: currentFile.originalContent,
    isModified: currentFile.isModified,
  });
}

export const useFileEditorStore = create<FileEditorStore>((set, get) => ({
  // 初始状态
  isOpen: false,
  currentFile: null,
  status: 'idle',
  error: null,
  isConflicted: false,
  pendingGotoLine: null,

  // 打开文件
  openFile: async (path: string, name: string) => {
    log.debug('打开文件', { path, name });
    const { currentFile } = get();

    // 相同文件不重复加载
    if (currentFile?.path === path) return;

    // 保存当前文件到缓冲区
    saveCurrentToBuffer();

    set({ isOpen: true, status: 'loading', error: null, isConflicted: false });

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

  // 打开文件并跳转到指定行
  openFileAtLine: async (path: string, name: string, lineNumber: number) => {
    const { currentFile } = get();

    if (currentFile?.path === path) {
      // 文件已打开，直接设置跳转行号
      set({ pendingGotoLine: lineNumber });
    } else {
      // 设置跳转行号，然后打开文件
      set({ pendingGotoLine: lineNumber });
      await get().openFile(path, name);
    }
  },

  // 设置待跳转行号
  setPendingGotoLine: (line: number | null) => {
    set({ pendingGotoLine: line });
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

    const updated = {
      ...currentFile,
      content,
      isModified: content !== currentFile.originalContent,
    };

    set({ currentFile: updated });

    // 同步更新缓冲区
    useEditorBufferStore.getState().updateContent(currentFile.path, content);
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
      const saved = {
        ...currentFile,
        originalContent: currentFile.content,
        isModified: false,
      };
      set({
        currentFile: saved,
        status: 'idle',
        error: null,
        isConflicted: false,
      });

      // 同步更新缓冲区
      useEditorBufferStore.getState().saveBuffer(currentFile.path, {
        name: saved.name,
        language: saved.language,
        content: saved.content,
        originalContent: saved.content,
        isModified: false,
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

  // 设置文件冲突状态
  setConflicted: (conflicted: boolean) => {
    set({ isConflicted: conflicted });
  },

  // 从磁盘重新加载文件内容
  reloadFromDisk: async () => {
    const { currentFile } = get();
    if (!currentFile) return;

    try {
      const diskContent = await tauri.getFileContent(currentFile.path) as string;
      set({
        currentFile: {
          ...currentFile,
          content: diskContent,
          originalContent: diskContent,
          isModified: false,
        },
        isConflicted: false,
      });
    } catch (error) {
      log.error('从磁盘重新加载失败', error instanceof Error ? error : new Error(String(error)));
    }
  },

  // 切换到已缓冲的文件（Tab 切换时使用，优先从缓冲区恢复，避免磁盘读取）
  switchToFile: async (path: string, name: string) => {
    const { currentFile } = get();

    // 相同文件不重复切换
    if (currentFile?.path === path) return;

    // 保存当前文件到缓冲区
    saveCurrentToBuffer();

    // 检查缓冲区
    const buffer = useEditorBufferStore.getState().loadBuffer(path);
    if (buffer) {
      log.debug('从缓冲区恢复文件', { path });
      set({
        isOpen: true,
        currentFile: {
          path,
          name: buffer.name,
          content: buffer.content,
          originalContent: buffer.originalContent,
          isModified: buffer.isModified,
          language: buffer.language,
        },
        status: 'idle',
        error: null,
        isConflicted: false,
      });
      return;
    }

    // 缓冲区未命中，回退到正常 openFile（从磁盘读取）
    await get().openFile(path, name);
  },
}));

/**
 * 初始化编辑器文件变更监听器
 * 监听 file-system-change 事件，检测当前打开的文件是否被外部修改
 * @returns cleanup 函数
 */
export function initEditorFileChangeListener(): () => void {
  let disposed = false;
  let unlistenFn: (() => void) | null = null;

  listen<FsChangeEvent>('file-system-change', async (event) => {
    if (disposed) return;
    const store = useFileEditorStore.getState();
    const { currentFile, isConflicted } = store;
    if (!currentFile || isConflicted) return;

    const filePath = currentFile.path.replace(/\\/g, '/');
    const fileDir = filePath.includes('/')
      ? filePath.substring(0, filePath.lastIndexOf('/'))
      : '';

    const affectedDirs = event.payload.affectedDirs;
    const isAffected = affectedDirs.some(dir => {
      const normalizedDir = dir.replace(/\\/g, '/');
      return fileDir === normalizedDir || fileDir.startsWith(normalizedDir + '/');
    });

    if (!isAffected) return;

    // 读取磁盘内容并与 originalContent 比较
    try {
      const diskContent = await tauri.getFileContent(currentFile.path) as string;
      if (diskContent !== currentFile.originalContent) {
        useFileEditorStore.getState().setConflicted(true);
        log.info('文件被外部修改', { path: currentFile.path });
      }
    } catch {
      // 文件可能已被删除，也标记为冲突
      useFileEditorStore.getState().setConflicted(true);
      log.warn('无法读取外部修改的文件', { path: currentFile.path });
    }
  }).then(unlisten => {
    if (disposed) {
      unlisten();
    } else {
      unlistenFn = unlisten;
    }
  });

  return () => {
    disposed = true;
    unlistenFn?.();
  };
}
