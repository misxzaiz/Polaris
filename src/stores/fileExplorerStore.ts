/**
 * 文件浏览器状态管理
 */

import { create } from 'zustand';
import { listen } from '@/services/transport';
import type { FileExplorerStore, FileInfo, FsChangeEvent } from '@/types';
import * as tauri from '@/services/tauri';
import { searchFiles } from '@/services/fileSearch';
import type { FileMatch } from '@/services/fileSearch';
import { createLogger } from '@/utils/logger';
import { getParentPath, joinPath, normalizePath } from '@/utils/path';
import { updateFolderChildren, filterFiles, countFiles, removePathFromTree } from './fileExplorerStoreUtils';

const log = createLogger('FileExplorer');

// 搜索取消令牌（用于取消正在进行的搜索）
let searchAbortController: AbortController | null = null;

export const useFileExplorerStore = create<FileExplorerStore>((set, get) => ({
  // 初始状态
  current_path: '',
  file_tree: [],
  selected_file: null,
  expanded_folders: new Set(),
  search_query: '',
  search_results_count: undefined,
  search_is_deep_loading: false,
  search_results: undefined,
  loading: false,
  error: null,
  folder_cache: new Map(), // 文件夹内容缓存
  loading_folders: new Set(), // 正在加载的文件夹
  is_refreshing: false, // 是否正在刷新
  clipboard: null, // 剪贴板状态
  highlighted_path: null as string | null, // 高亮路径（Reveal in Explorer）

  // 加载目录内容
  load_directory: async (path: string) => {
    set({ loading: true, error: null });

    try {
      const files = await tauri.readDirectory(path) as FileInfo[];
      set({
        current_path: path,
        file_tree: files,
        // 切换目录时清空旧数据，避免跨工作区数据污染
        folder_cache: new Map(),
        expanded_folders: new Set(),
        loading_folders: new Set(),
        selected_file: null,
        search_query: '',
        search_results: undefined,
        search_results_count: undefined,
        search_is_deep_loading: false,
        loading: false
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '加载目录失败',
        loading: false
      });
    }
  },

  // 加载文件夹内容（懒加载）
  load_folder_content: async (folderPath: string) => {
    // 规范化路径，确保缓存 key 格式一致
    const normalizedPath = normalizePath(folderPath);

    // 使用原子操作检查并锁定，防止并发重复加载
    // Zustand 的 set 回调是同步执行的，可以保证原子性
    let shouldLoad = false;
    set((state) => {
      // 如果已在缓存或正在加载，跳过
      if (state.folder_cache.has(normalizedPath) || state.loading_folders.has(normalizedPath)) {
        return state; // 不做任何修改
      }
      // 标记为需要加载，并添加到 loading_folders
      shouldLoad = true;
      return {
        loading_folders: new Set([...state.loading_folders, normalizedPath])
      };
    });

    // 如果前面的检查发现不需要加载，直接返回
    if (!shouldLoad) {
      return;
    }

    try {
      const children = await tauri.readDirectory(folderPath) as FileInfo[];

      set((state) => {
        // 更新缓存（使用规范化路径作为 key）
        const newCache = new Map(state.folder_cache);
        newCache.set(normalizedPath, children);

        // 更新文件树（使用规范化路径匹配）
        const updatedTree = updateFolderChildren(state.file_tree, normalizedPath, children);

        // 移除加载状态
        const newLoading = new Set(state.loading_folders);
        newLoading.delete(normalizedPath);

        return {
          folder_cache: newCache,
          file_tree: updatedTree,
          loading_folders: newLoading,
        };
      });
    } catch (error) {
      set((state) => {
        // 移除加载状态
        const newLoading = new Set(state.loading_folders);
        newLoading.delete(normalizedPath);

        return {
          loading_folders: newLoading,
          error: error instanceof Error ? error.message : '加载文件夹失败',
        };
      });
    }
  },

  // 获取缓存的文件夹内容
  get_cached_folder_content: (folderPath: string) => {
    // 规范化路径进行查找
    return get().folder_cache.get(normalizePath(folderPath)) || null;
  },

  // 精确刷新指定文件夹（保留其他展开状态）
  refresh_folder: async (folderPath: string) => {
    // 规范化路径
    const normalizedPath = normalizePath(folderPath);

    try {
      // 读取文件夹最新内容
      const children = await tauri.readDirectory(folderPath) as FileInfo[];

      set((state) => {
        // 更新缓存（使用规范化路径）
        const newCache = new Map(state.folder_cache);
        newCache.set(normalizedPath, children);

        // 更新文件树中的对应节点
        // 使用规范化路径比较，处理 Windows 路径分隔符问题
        let updatedTree: FileInfo[];
        if (normalizedPath === normalizePath(state.current_path)) {
          // 对于根目录，需要保留已展开子文件夹的 children
          // 使用 updateFolderChildren 递归更新
          updatedTree = children.map(newFile => {
            const existingFile = state.file_tree.find(f => normalizePath(f.path) === normalizePath(newFile.path));
            if (existingFile && existingFile.children) {
              // 保留已加载的 children
              return { ...newFile, children: existingFile.children };
            }
            return newFile;
          });
        } else {
          updatedTree = updateFolderChildren(state.file_tree, normalizedPath, children);
        }

        return {
          folder_cache: newCache,
          file_tree: updatedTree,
        };
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '刷新文件夹失败' });
    }
  },

  // 刷新当前目录（清除缓存并重新加载）
  // 优化：先并行加载所有数据，再一次性更新，避免闪烁
  refresh_directory: async () => {
    const { current_path, expanded_folders } = get();

    if (!current_path) {
      return;
    }

    set({ is_refreshing: true, error: null });

    try {
      const expandedPaths = Array.from(expanded_folders);

      // 并行加载：根目录 + 所有展开的文件夹
      const loadPromises: Promise<{ path: string; children: FileInfo[] | null }>[] = expandedPaths.map(
        (folderPath) => tauri.readDirectory(folderPath)
          .then((children) => ({ path: folderPath, children: children as FileInfo[] }))
          .catch(() => ({ path: folderPath, children: null }))
      );

      // 加载根目录
      const rootFiles = await tauri.readDirectory(current_path) as FileInfo[];

      // 并行等待所有文件夹加载完成
      const folderResults = await Promise.all(loadPromises);

      // 构建新的缓存和需要移除的路径（使用规范化路径作为 key）
      const newCache = new Map<string, FileInfo[]>();
      const removedPaths = new Set<string>();

      for (const result of folderResults) {
        if (result.children !== null) {
          // 使用规范化路径作为缓存 key
          newCache.set(normalizePath(result.path), result.children);
        } else {
          removedPaths.add(normalizePath(result.path));
        }
      }

      // 从根目录开始，递归更新所有展开文件夹的 children
      let updatedTree = rootFiles;
      for (const [folderPath, children] of newCache) {
        updatedTree = updateFolderChildren(updatedTree, folderPath, children);
      }

      // 一次性更新所有状态
      set((state) => {
        const nextExpanded = new Set(state.expanded_folders);
        const nextCache = new Map(state.folder_cache);

        // 清空旧缓存，使用新缓存
        nextCache.clear();
        for (const [path, children] of newCache) {
          nextCache.set(path, children);
        }

        // 移除不存在的文件夹
        removedPaths.forEach((path) => {
          nextExpanded.delete(path);
          nextCache.delete(path);
        });

        return {
          current_path,
          file_tree: updatedTree,
          folder_cache: nextCache,
          expanded_folders: nextExpanded,
          is_refreshing: false
        };
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '刷新目录失败',
        is_refreshing: false
      });
    }
  },

  // 选择文件
  select_file: (file: FileInfo) => {
    set({ selected_file: file });
  },

  // 切换文件夹展开状态
  toggle_folder: (path: string) => {
    set((state) => {
      const expanded = new Set(state.expanded_folders);
      // 规范化路径，处理 Windows 路径分隔符问题
      const normalizedPath = normalizePath(path);

      // 检查是否存在（需要用规范化路径比较）
      let found = false;
      for (const p of expanded) {
        if (normalizePath(p) === normalizedPath) {
          expanded.delete(p);
          found = true;
          break;
        }
      }

      if (!found) {
        // 添加时使用规范化路径
        expanded.add(normalizedPath);
      } else {
        // 折叠时清除该文件夹缓存，释放内存
        const newCache = new Map(state.folder_cache);
        newCache.delete(normalizedPath);
        return { expanded_folders: expanded, folder_cache: newCache };
      }

      return { expanded_folders: expanded };
    });
  },

  // 设置搜索查询（两阶段搜索：快速 + 深度）
  set_search_query: async (query: string) => {
    // 取消之前的搜索
    if (searchAbortController) {
      searchAbortController.abort();
    }
    searchAbortController = new AbortController();
    const signal = searchAbortController.signal;

    // 立即更新查询状态
    set({ search_query: query });

    // 清空搜索
    if (!query.trim()) {
      set({
        search_results_count: undefined,
        search_results: undefined,
        search_is_deep_loading: false
      });
      return;
    }

    // 阶段1：快速搜索（基于已加载的文件树，同步）
    const quickFiltered = filterFiles(get().file_tree, query);
    const quickCount = countFiles(quickFiltered);
    set({
      search_results_count: quickCount,
      search_is_deep_loading: true
    });

    // 阶段2：深度搜索（异步，不阻塞 UI）
    try {
      const deepResults = await get().deep_search(query);
      if (!signal.aborted) {
        set({
          search_results: deepResults,
          search_results_count: deepResults.length,
          search_is_deep_loading: false
        });
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        log.error('深度搜索失败', error instanceof Error ? error : new Error(String(error)))
        set({ search_is_deep_loading: false });
      }
    }
  },

  // 深度搜索：使用 Rust 后端原生递归搜索（单次 IPC 调用）
  deep_search: async (query: string, maxResults: number = 50): Promise<FileInfo[]> => {
    const lowerQuery = query.toLowerCase().trim();
    if (!lowerQuery) {
      return [];
    }

    // 检查是否被取消
    if (searchAbortController?.signal.aborted) {
      throw new DOMException('搜索已取消', 'AbortError');
    }

    const { current_path } = get();
    if (!current_path) {
      return [];
    }

    try {
      const matches = await searchFiles(lowerQuery, current_path, maxResults);

      // FileMatch → FileInfo 转换
      return matches.map((m: FileMatch): FileInfo => ({
        name: m.name,
        path: m.fullPath,
        is_dir: m.isDir,
        extension: m.extension,
      }));
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        log.error('深度搜索失败', error instanceof Error ? error : new Error(String(error)));
      }
      return [];
    }
  },

  // 取消搜索
  cancel_search: () => {
    if (searchAbortController) {
      searchAbortController.abort();
      searchAbortController = null;
    }
    set({
      search_is_deep_loading: false,
      search_query: '',
      search_results: undefined,
      search_results_count: undefined
    });
  },

  // 创建文件
  create_file: async (path: string, content?: string) => {
    try {
      await tauri.createFile(path, content);
      // 获取父目录并精确刷新
      const parentPath = getParentPath(path);
      if (parentPath) {
        await get().refresh_folder(parentPath);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '创建文件失败' });
    }
  },

  // 创建目录
  create_directory: async (path: string) => {
    try {
      await tauri.createDirectory(path);
      // 获取父目录并精确刷新
      const parentPath = getParentPath(path);
      if (parentPath) {
        await get().refresh_folder(parentPath);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '创建目录失败' });
    }
  },

  // 删除文件或目录
  delete_file: async (path: string) => {
    try {
      await tauri.deleteFile(path);
      // 获取父目录并精确刷新
      const parentPath = getParentPath(path);
      if (parentPath) {
        await get().refresh_folder(parentPath);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '删除文件失败' });
    }
  },

  // 重命名文件或目录
  rename_file: async (old_path: string, new_name: string) => {
    try {
      await tauri.renameFile(old_path, new_name);
      // 获取父目录并精确刷新
      const parentPath = getParentPath(old_path);
      if (parentPath) {
        await get().refresh_folder(parentPath);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '重命名文件失败' });
    }
  },

  // 获取文件内容
  get_file_content: async (path: string) => {
    try {
      return await tauri.getFileContent(path) as string;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '读取文件内容失败' });
      throw error;
    }
  },

  // 清除错误
  clear_error: () => {
    set({ error: null });
  },

  // 复制文件到剪贴板
  copy_file: (file: FileInfo) => {
    set({
      clipboard: {
        operation: 'copy',
        sourcePath: file.path,
        sourceFile: file,
        source: 'internal',
      }
    });
    tauri.setFileClipboard([file.path], 'copy').catch((error) => {
      log.warn('写入系统文件剪贴板失败', error instanceof Error ? error : new Error(String(error)));
    });
  },

  // 剪切文件到剪贴板
  cut_file: (file: FileInfo) => {
    set({
      clipboard: {
        operation: 'cut',
        sourcePath: file.path,
        sourceFile: file,
        source: 'internal',
      }
    });
    tauri.setFileClipboard([file.path], 'cut').catch((error) => {
      log.warn('写入系统文件剪贴板失败', error instanceof Error ? error : new Error(String(error)));
    });
  },

  // 粘贴文件到目标目录
  paste_file: async (targetPath: string) => {
    const internalClipboard = get().clipboard;
    let operation = internalClipboard?.operation;
    let sourcePath = internalClipboard?.sourcePath;
    let sourceFileName = internalClipboard?.sourceFile.name;
    let clipboardSource = internalClipboard?.source;

    try {
      const systemClipboard = await tauri.getFileClipboard();
      if (systemClipboard?.paths.length) {
        operation = systemClipboard.operation;
        sourcePath = systemClipboard.paths[0];
        sourceFileName = sourcePath.split(/[\\/]/).filter(Boolean).pop() || sourcePath;
        clipboardSource = 'system';
      }
    } catch (error) {
      log.warn('读取系统文件剪贴板失败', error instanceof Error ? error : new Error(String(error)));
    }

    if (!operation || !sourcePath) {
      return;
    }

    const sourceParentPath = getParentPath(sourcePath);

    try {
      if (operation === 'copy') {
        await tauri.copyPathToDirectory(sourcePath, targetPath);
      } else {
        await tauri.movePathToDirectory(sourcePath, targetPath);
        // 清除剪贴板（剪切只能粘贴一次）
        set({ clipboard: null });
      }

      // 刷新目标目录
      await get().refresh_folder(targetPath);

      // 剪切跨目录时同步刷新源目录；如果源目录已不存在，则从现有树中移除旧节点。
      if (operation === 'cut' && sourceParentPath && normalizePath(sourceParentPath) !== normalizePath(targetPath)) {
        try {
          await get().refresh_folder(sourceParentPath);
        } catch {
          set((state) => ({
            file_tree: removePathFromTree(state.file_tree, sourcePath),
          }));
        }
      }

      if (clipboardSource === 'system' && sourceFileName) {
        set({
          clipboard: {
            operation,
            sourcePath,
            sourceFile: {
              name: sourceFileName,
              path: sourcePath,
              is_dir: false,
            },
            source: 'system',
          },
        });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '粘贴文件失败' });
    }
  },

  // 保存拖入的文件到目标目录
  save_dropped_file: async (targetPath: string, file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      await tauri.saveDroppedFileToDirectory(targetPath, file.name, btoa(binary));
      await get().refresh_folder(targetPath);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '拖入文件失败' });
    }
  },

  // 清除剪贴板
  clear_clipboard: () => {
    set({ clipboard: null });
  },

  // 在文件树中定位并高亮指定路径
  revealPath: async (targetPath: string) => {
    const { current_path, expanded_folders } = get();
    const normalized = normalizePath(targetPath);
    const normalizedRoot = normalizePath(current_path);

    // 1. 收集从工作区根到目标文件的所有祖先目录
    const relative = normalized.startsWith(normalizedRoot + '/')
      ? normalized.slice(normalizedRoot.length + 1)
      : '';
    if (!relative) return;

    const parts = relative.split('/');
    const dirsToExpand: string[] = [];
    let accumulated = current_path;
    for (let i = 0; i < parts.length - 1; i++) {
      accumulated = joinPath(accumulated, parts[i]);
      dirsToExpand.push(accumulated);
    }

    // 2. 展开所有祖先目录
    const newExpanded = new Set(expanded_folders);
    for (const dir of dirsToExpand) {
      newExpanded.add(normalizePath(dir));
    }
    set({ expanded_folders: newExpanded });

    // 3. 逐级加载目录内容（需要父级先加载才能加载子级）
    for (const dir of dirsToExpand) {
      await get().load_folder_content(dir);
    }

    // 4. 在树中查找目标文件并选中
    const findFile = (files: FileInfo[]): FileInfo | null => {
      for (const f of files) {
        if (normalizePath(f.path) === normalized) return f;
        if (f.children) {
          const found = findFile(f.children);
          if (found) return found;
        }
      }
      return null;
    };

    const file = findFile(get().file_tree);
    if (file) {
      set({
        selected_file: file,
        highlighted_path: normalized,
      });

      // 2 秒后自动清除高亮
      setTimeout(() => {
        if (get().highlighted_path === normalized) {
          set({ highlighted_path: null });
        }
      }, 2000);
    }
  },
}));

// ============================================================================
// 文件监听器
// ============================================================================

let fsWatcherCleanup: (() => void) | null = null;
let fsWatcherDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 初始化文件监听事件监听器
 * 监听 Rust 后端推送的文件系统变化事件，刷新受影响的已展开目录
 */
export function initFileWatcherListener(): () => void {
  const unlisten = listen<FsChangeEvent>('file-system-change', (event) => {
    const { affectedDirs } = event;
    const store = useFileExplorerStore.getState();
    const { expanded_folders, current_path } = store;

    if (!current_path) return;

    // 规范化 expanded_folders 中的路径，确保比较时格式一致
    // Windows 上 file.path 可能是反斜杠格式，需要统一为正斜杠
    const normalizedExpanded = new Set<string>();
    for (const path of expanded_folders) {
      normalizedExpanded.add(normalizePath(path));
    }

    // 找出需要刷新的目录（受影响且已展开的）
    const dirsToRefresh: string[] = [];

    for (const relDir of affectedDirs) {
      // 构建绝对路径并规范化
      const rawAbsPath = relDir === '.'
        ? current_path
        : joinPath(current_path, relDir);
      const normalizedAbsPath = normalizePath(rawAbsPath);

      // 根目录始终刷新
      if (relDir === '.') {
        dirsToRefresh.push(current_path);
        continue;
      }

      // 检查是否已展开（使用规范化后的路径比较）
      if (normalizedExpanded.has(normalizedAbsPath)) {
        dirsToRefresh.push(rawAbsPath);
      }

      // 也检查父目录是否已展开（新文件可能在已展开的目录中）
      const normalizedParentDir = getParentPath(normalizedAbsPath);
      if (normalizedParentDir && normalizedExpanded.has(normalizedParentDir)) {
        const rawParentPath = getParentPath(rawAbsPath);
        if (rawParentPath && !dirsToRefresh.includes(rawParentPath)) {
          dirsToRefresh.push(rawParentPath);
        }
      }
    }

    if (dirsToRefresh.length === 0) return;

    // 防抖：合并多次快速变化
    if (fsWatcherDebounceTimer) {
      clearTimeout(fsWatcherDebounceTimer);
    }

    fsWatcherDebounceTimer = setTimeout(() => {
      for (const dir of dirsToRefresh) {
        store.refresh_folder(dir);
      }
    }, 100);
  });

  const cleanup = () => {
    unlisten.then((fn) => fn());
    if (fsWatcherDebounceTimer) {
      clearTimeout(fsWatcherDebounceTimer);
      fsWatcherDebounceTimer = null;
    }
  };

  fsWatcherCleanup = cleanup;
  return cleanup;
}

/**
 * 启动文件监听
 */
export async function startFileWatcher(rootPath: string): Promise<void> {
  try {
    await tauri.fsWatchStart(rootPath);
    log.info('文件监听已启动', { rootPath });
  } catch (e) {
    log.error('启动文件监听失败', e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * 停止文件监听
 */
export async function stopFileWatcher(): Promise<void> {
  try {
    await tauri.fsWatchStop();
    if (fsWatcherCleanup) {
      fsWatcherCleanup();
      fsWatcherCleanup = null;
    }
    log.info('文件监听已停止');
  } catch (e) {
    log.error('停止文件监听失败', e instanceof Error ? e : new Error(String(e)));
  }
}
