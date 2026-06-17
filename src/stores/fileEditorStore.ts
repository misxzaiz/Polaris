/**
 * 文件编辑器状态管理
 *
 * 合并了 editorBufferStore — 缓冲区作为编辑器内部实现，
 * 对外暴露 buffer 操作方法供 tabStore / Editor 组件使用。
 */

import { create } from 'zustand';
import type { FileEditorStore, BufferEntry } from '@/types';
import * as tauri from '@/services/tauri';
import { emit, listen } from '@/services/transport';
import { createLogger } from '@/utils/logger';
import type { FsChangeEvent } from '@/types/fileExplorer';

const log = createLogger('Editor');

const MAX_BUFFERS = 10;

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

const BINARY_EXTENSIONS = new Set([
  'msi', 'exe', 'dmg', 'deb', 'rpm', 'pkg', 'appimage', 'app',
  'zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'zst',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'flac', 'wav', 'ogg',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'so', 'dll', 'dylib', 'bin', 'dat',
  'iso', 'img', 'vdi',
]);

function isBinaryFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return BINARY_EXTENSIONS.has(ext || '');
}

export const useFileEditorStore = create<FileEditorStore>((set, get) => ({
  // ========== 初始状态 ==========
  isOpen: false,
  currentFile: null,
  status: 'idle',
  error: null,
  isConflicted: false,
  pendingGotoLine: null,
  pendingGotoColumn: null,

  // ── 缓冲区初始状态 ──
  buffers: new Map(),
  bufferAccessOrder: [],
  maxBuffers: MAX_BUFFERS,

  // ========== 文件操作 ==========

  openFile: async (path: string, name: string) => {
    log.debug('打开文件', { path, name });
    const { currentFile } = get();
    const notifyFileOpened = async () => {
      try {
        await emit('file:opened', { path, name });
      } catch (emitError) {
        log.warn('发送 file:opened 事件失败', { error: String(emitError) });
      }
    };

    // 相同文件不重复加载
    if (currentFile?.path === path) {
      await notifyFileOpened();
      return;
    }

    // 保存当前文件到缓冲区
    get()._saveCurrentToBuffer();

    set({ isOpen: true, status: 'loading', error: null, isConflicted: false });

    try {
      if (isImagePath(path)) {
        set({ isOpen: false, status: 'idle', error: null, currentFile: null });
        await emit('file:preview', { path, name, kind: 'image' });
        return;
      }

      if (isBinaryFile(path)) {
        log.debug('跳过二进制文件', { path });
        set({
          isOpen: true,
          status: 'error',
          error: `不支持编辑二进制文件: ${name}`,
          currentFile: {
            path,
            name,
            content: '',
            originalContent: '',
            isModified: false,
            language: 'text',
          },
        });
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
      await notifyFileOpened();
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

  openFileAtLine: async (path: string, name: string, lineNumber: number) => {
    await get().openFileAtPosition(path, name, lineNumber);
  },

  openFileAtPosition: async (
    path: string,
    name: string,
    lineNumber: number,
    column?: number,
  ) => {
    const { currentFile } = get();

    set({ pendingGotoLine: lineNumber, pendingGotoColumn: column ?? null });
    if (currentFile?.path !== path) {
      await get().openFile(path, name);
    }
  },

  setPendingGotoLine: (line: number | null) => {
    // line=null 同时清掉 column，避免上一次跳转的残留列号影响下一次
    if (line === null) {
      set({ pendingGotoLine: null, pendingGotoColumn: null });
    } else {
      set({ pendingGotoLine: line });
    }
  },

  closeFile: async () => {
    const { currentFile } = get();
    if (currentFile?.isModified) {
      // 未保存确认由 UI 层（EditorHeader.tsx）的 showCloseConfirm 对话框处理
    }
    set({
      isOpen: false,
      currentFile: null,
      status: 'idle',
      error: null,
    });
    try {
      await emit('editor:closed', { path: currentFile?.path });
    } catch (e) {
      log.warn('发送 editor:closed 事件失败', { error: String(e) });
    }
  },

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
    get().updateBufferContent(currentFile.path, content);
  },

  saveFile: async () => {
    const { currentFile } = get();
    if (!currentFile) return;

    set({ status: 'saving', error: null });

    try {
      await tauri.createFile(currentFile.path, currentFile.content);

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
      get().saveBuffer(currentFile.path, {
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

  setError: (error: string | null) => {
    set({ error });
  },

  setOpen: (open: boolean) => {
    set({ isOpen: open });
  },

  setConflicted: (conflicted: boolean) => {
    set({ isConflicted: conflicted });
  },

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
      // 同步刷新缓冲区，避免切走再切回时 switchToFile 又命中旧 buffer
      get().saveBuffer(currentFile.path, {
        name: currentFile.name,
        language: currentFile.language,
        content: diskContent,
        originalContent: diskContent,
        isModified: false,
      });
    } catch (error) {
      log.error('从磁盘重新加载失败', error instanceof Error ? error : new Error(String(error)));
    }
  },

  refreshCurrentFile: async () => {
    const { currentFile } = get();
    if (!currentFile) return;

    try {
      const diskContent = await tauri.getFileContent(currentFile.path) as string;

      // 本地有未保存改动且与磁盘不一致：标记冲突，让用户在 EditorHeader
      // 决定「重新加载」还是「保留当前」，避免静默丢失改动。
      if (currentFile.isModified && diskContent !== currentFile.content) {
        set({ isConflicted: true });
        log.info('刷新检测到外部修改，存在未保存改动', { path: currentFile.path });
        return;
      }

      // 无改动 或 内容已一致：直接覆盖
      set({
        currentFile: {
          ...currentFile,
          content: diskContent,
          originalContent: diskContent,
          isModified: false,
        },
        isConflicted: false,
        status: 'idle',
        error: null,
      });
      get().saveBuffer(currentFile.path, {
        name: currentFile.name,
        language: currentFile.language,
        content: diskContent,
        originalContent: diskContent,
        isModified: false,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '刷新文件失败';
      log.error('刷新当前文件失败', error instanceof Error ? error : new Error(String(error)));
      set({ status: 'error', error: errorMessage });
    }
  },

  switchToFile: async (path: string, name: string) => {
    const { currentFile } = get();

    if (currentFile?.path === path) return;

    // 保存当前文件到缓冲区
    get()._saveCurrentToBuffer();

    // 检查缓冲区
    const buffer = get().loadBuffer(path);
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

      // 后台校验磁盘版本：根因修复——避免 Tab 切回时显示旧内容
      // - 本地无改动且磁盘已变 → 静默用磁盘内容刷新
      // - 本地有改动且与磁盘冲突 → 标记 isConflicted，由 EditorHeader 提示用户
      void (async () => {
        try {
          const diskContent = await tauri.getFileContent(path) as string;
          const stateNow = get();
          // 用户已切走，丢弃本次结果
          if (stateNow.currentFile?.path !== path) return;

          if (!stateNow.currentFile.isModified) {
            if (diskContent !== stateNow.currentFile.originalContent) {
              set({
                currentFile: {
                  ...stateNow.currentFile,
                  content: diskContent,
                  originalContent: diskContent,
                  isModified: false,
                },
                isConflicted: false,
              });
              get().saveBuffer(path, {
                name: stateNow.currentFile.name,
                language: stateNow.currentFile.language,
                content: diskContent,
                originalContent: diskContent,
                isModified: false,
              });
              log.debug('switchToFile 静默同步磁盘最新内容', { path });
            }
          } else if (diskContent !== stateNow.currentFile.originalContent) {
            useFileEditorStore.getState().setConflicted(true);
            log.info('switchToFile 检测到外部修改，存在未保存改动', { path });
          }
        } catch (e) {
          log.warn('switchToFile 后台校验磁盘失败', { path, error: String(e) });
        }
      })();

      return;
    }

    // 缓冲区未命中，回退到正常 openFile
    await get().openFile(path, name);
  },

  // ========== 缓冲区操作（从 editorBufferStore 合并） ==========

  saveBuffer: (filePath: string, entry: BufferEntry) => {
    set((state) => {
      const buffers = new Map(state.buffers);
      const bufferAccessOrder = state.bufferAccessOrder.filter(p => p !== filePath);

      // LRU 淘汰
      while (buffers.size >= state.maxBuffers && !buffers.has(filePath)) {
        const oldest = bufferAccessOrder.shift();
        if (oldest) {
          buffers.delete(oldest);
          log.debug('LRU 淘汰缓冲区', { path: oldest });
        }
      }

      buffers.set(filePath, entry);
      bufferAccessOrder.push(filePath);

      return { buffers, bufferAccessOrder };
    });
  },

  loadBuffer: (filePath: string) => {
    const { buffers, bufferAccessOrder } = get();
    const entry = buffers.get(filePath);
    if (!entry) return null;

    // 更新访问顺序
    const newOrder = bufferAccessOrder.filter(p => p !== filePath);
    newOrder.push(filePath);
    set({ bufferAccessOrder: newOrder });

    return entry;
  },

  hasBuffer: (filePath: string) => {
    return get().buffers.has(filePath);
  },

  removeBuffer: (filePath: string) => {
    set((state) => {
      const buffers = new Map(state.buffers);
      buffers.delete(filePath);
      const bufferAccessOrder = state.bufferAccessOrder.filter(p => p !== filePath);
      return { buffers, bufferAccessOrder };
    });
  },

  updateBufferContent: (filePath: string, content: string) => {
    set((state) => {
      const buffers = new Map(state.buffers);
      const entry = buffers.get(filePath);
      if (entry) {
        buffers.set(filePath, {
          ...entry,
          content,
          isModified: content !== entry.originalContent,
        });
      }
      return { buffers };
    });
  },

  saveBufferEditorState: (filePath: string, editorState: BufferEntry['editorState']) => {
    set((state) => {
      const buffers = new Map(state.buffers);
      const entry = buffers.get(filePath);
      if (entry) {
        buffers.set(filePath, { ...entry, editorState });
      }
      return { buffers };
    });
  },

  clearAllBuffers: () => {
    set({ buffers: new Map(), bufferAccessOrder: [] });
  },

  // ── 内部辅助 ──

  /** 将当前文件状态保存到缓冲区（内部方法） */
  _saveCurrentToBuffer: () => {
    const { currentFile } = get();
    if (!currentFile) return;
    get().saveBuffer(currentFile.path, {
      name: currentFile.name,
      language: currentFile.language,
      content: currentFile.content,
      originalContent: currentFile.originalContent,
      isModified: currentFile.isModified,
    });
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

    const affectedDirs = event.affectedDirs;
    const isAffected = affectedDirs.some(dir => {
      const normalizedDir = dir.replace(/\\/g, '/');
      return fileDir === normalizedDir || fileDir.startsWith(normalizedDir + '/');
    });

    if (!isAffected) return;

    try {
      const diskContent = await tauri.getFileContent(currentFile.path) as string;
      if (diskContent !== currentFile.originalContent) {
        useFileEditorStore.getState().setConflicted(true);
        log.info('文件被外部修改', { path: currentFile.path });
      }
    } catch {
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
