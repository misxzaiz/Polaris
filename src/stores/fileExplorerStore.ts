/**
 * 文件浏览器状态管理
 */

import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import type { FileExplorerStore, FileInfo, FsChangeEvent } from '../types';
import * as tauri from '../services/tauri';
import { createLogger } from '../utils/logger';

const log = createLogger('FileExplorer');

// 搜索取消令牌（用于取消正在进行的搜索）
let searchAbortController: AbortController | null = null;

// 辅助函数：获取父目录路径（兼容 Windows 和 Unix 路径分隔符）
function getParentPath(path: string): string | null {
  // 找到最后一个路径分隔符（支持 / 和 \）
  const lastSepIndex = Math.max(
    path.lastIndexOf('/'),
    path.lastIndexOf('\\')
  );

  if (lastSepIndex <= 0) {
    return null;
  }

  return path.substring(0, lastSepIndex);
}

// 辅助函数：更新文件树中的子节点
function updateFolderChildren(tree: FileInfo[], folderPath: string, children: FileInfo[]): FileInfo[] {
  return tree.map(file => {
    if (file.path === folderPath) {
      // 保留 children 数组，即使是空数组也不要变成 undefined
      // 空数组表示文件夹确实为空，undefined 表示尚未加载
      return { ...file, children };
    }

    if (file.children) {
      const updatedChildren = updateFolderChildren(file.children, folderPath, children);
      return {
        ...file,
        children: updatedChildren,
      };
    }

    return file;
  });
}

// 辅助函数：递归过滤文件树
function filterFiles(files: FileInfo[], query: string): FileInfo[] {
  if (!query.trim()) return files;

  const lowerQuery = query.toLowerCase();

  return files.reduce((acc: FileInfo[], file) => {
    const nameMatches = file.name.toLowerCase().includes(lowerQuery);

    if (file.is_dir) {
      // 对于目录，检查名称是否匹配或子文件是否匹配
      const filteredChildren = file.children ? filterFiles(file.children, query) : [];

      if (nameMatches || filteredChildren.length > 0) {
        acc.push({
          ...file,
          children: filteredChildren.length > 0 ? filteredChildren : file.children
        });
      }
    } else if (nameMatches) {
      // 对于文件，只检查名称是否匹配
      acc.push(file);
    }

    return acc;
  }, []);
}

// 辅助函数：递归计数文件数量（排除目录）
function countFiles(files: FileInfo[]): number {
  let count = 0;
  for (const file of files) {
    if (file.is_dir) {
      if (file.children) {
        count += countFiles(file.children);
      }
    } else {
      count++;
    }
  }
  return count;
}

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
    const { folder_cache } = get();

    // 检查缓存
    if (folder_cache.has(folderPath)) {
      return;
    }

    // 检查是否正在加载
    const { loading_folders } = get();
    if (loading_folders.has(folderPath)) {
      return;
    }

    set((state) => ({
      loading_folders: new Set([...state.loading_folders, folderPath])
    }));

    try {
      const children = await tauri.readDirectory(folderPath) as FileInfo[];

      set((state) => {
        // 更新缓存
        const newCache = new Map(state.folder_cache);
        newCache.set(folderPath, children);

        // 更新文件树
        const updatedTree = updateFolderChildren(state.file_tree, folderPath, children);

        // 移除加载状态
        const newLoading = new Set(state.loading_folders);
        newLoading.delete(folderPath);

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
        newLoading.delete(folderPath);

        return {
          loading_folders: newLoading,
          error: error instanceof Error ? error.message : '加载文件夹失败',
        };
      });
    }
  },

  // 获取缓存的文件夹内容
  get_cached_folder_content: (folderPath: string) => {
    return get().folder_cache.get(folderPath) || null;
  },

  // 精确刷新指定文件夹（保留其他展开状态）
  refresh_folder: async (folderPath: string) => {
    try {
      // 读取文件夹最新内容
      const children = await tauri.readDirectory(folderPath) as FileInfo[];

      set((state) => {
        // 更新缓存
        const newCache = new Map(state.folder_cache);
        newCache.set(folderPath, children);

        // 更新文件树中的对应节点
        // 如果 folderPath 是根目录，直接更新 file_tree
        let updatedTree: FileInfo[];
        if (folderPath === state.current_path) {
          // 对于根目录，需要保留已展开子文件夹的 children
          // 使用 updateFolderChildren 递归更新
          updatedTree = children.map(newFile => {
            const existingFile = state.file_tree.find(f => f.path === newFile.path);
            if (existingFile && existingFile.children) {
              // 保留已加载的 children
              return { ...newFile, children: existingFile.children };
            }
            return newFile;
          });
        } else {
          updatedTree = updateFolderChildren(state.file_tree, folderPath, children);
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

      // 构建新的缓存和需要移除的路径
      const newCache = new Map<string, FileInfo[]>();
      const removedPaths = new Set<string>();

      for (const result of folderResults) {
        if (result.children !== null) {
          newCache.set(result.path, result.children);
        } else {
          removedPaths.add(result.path);
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
      if (expanded.has(path)) {
        expanded.delete(path);
      } else {
        expanded.add(path);
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

  // 深度搜索：递归遍历所有目录
  deep_search: async (query: string) => {
    const results: FileInfo[] = [];
    const visited = new Set<string>();
    const lowerQuery = query.toLowerCase().trim();

    if (!lowerQuery) {
      return [];
    }

    // 递归搜索函数
    const searchDir = async (dirPath: string): Promise<void> => {
      // 检查是否被取消
      if (searchAbortController?.signal.aborted) {
        throw new DOMException('搜索已取消', 'AbortError');
      }

      // 防止循环
      if (visited.has(dirPath)) {
        return;
      }
      visited.add(dirPath);

      try {
        const files = await tauri.readDirectory(dirPath) as FileInfo[];

        for (const file of files) {
          // 检查文件名是否匹配
          if (file.name.toLowerCase().includes(lowerQuery)) {
            results.push(file);
          }

          // 如果是目录，递归搜索
          if (file.is_dir) {
            await searchDir(file.path);
          }
        }
      } catch (error) {
        // 忽略无法访问的目录
        console.debug(`搜索目录失败: ${dirPath}`);
      }
    };

    // 从当前工作区根目录开始搜索
    const { current_path } = get();
    if (current_path) {
      await searchDir(current_path);
    }

    return results;
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
        sourceFile: file
      }
    });
  },

  // 剪切文件到剪贴板
  cut_file: (file: FileInfo) => {
    set({
      clipboard: {
        operation: 'cut',
        sourcePath: file.path,
        sourceFile: file
      }
    });
  },

  // 粘贴文件到目标目录
  paste_file: async (targetPath: string) => {
    const { clipboard } = get();
    if (!clipboard) {
      return;
    }

    const { operation, sourcePath, sourceFile } = clipboard;
    const fileName = sourceFile.name;
    const destPath = `${targetPath}/${fileName}`.replace(/\/+/g, '/');

    try {
      if (operation === 'copy') {
        await tauri.copyPath(sourcePath, destPath);
      } else {
        // 移动操作
        await tauri.movePath(sourcePath, destPath);
        // 清除剪贴板（剪切只能粘贴一次）
        set({ clipboard: null });
      }

      // 刷新目标目录
      await get().refresh_folder(targetPath);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '粘贴文件失败' });
    }
  },

  // 清除剪贴板
  clear_clipboard: () => {
    set({ clipboard: null });
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
    const { affectedDirs } = event.payload;
    const store = useFileExplorerStore.getState();
    const { expanded_folders, current_path } = store;

    if (!current_path) return;

    // 找出需要刷新的目录（受影响且已展开的）
    const dirsToRefresh: string[] = [];

    for (const relDir of affectedDirs) {
      // 构建绝对路径
      const absPath = relDir === '.'
        ? current_path
        : `${current_path}/${relDir}`.replace(/\/+/g, '/').replace(/\\/g, '/');

      // 根目录始终刷新
      if (relDir === '.') {
        dirsToRefresh.push(current_path);
        continue;
      }

      // 检查是否已展开
      if (expanded_folders.has(absPath)) {
        dirsToRefresh.push(absPath);
      }

      // 也检查父目录是否已展开（新文件可能在已展开的目录中）
      const parentDir = getParentPath(absPath);
      if (parentDir && expanded_folders.has(parentDir) && !dirsToRefresh.includes(parentDir)) {
        dirsToRefresh.push(parentDir);
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
