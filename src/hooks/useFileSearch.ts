/**
 * 文件搜索 Hook - 带防抖和缓存
 * 支持指定工作区搜索
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { searchFiles } from '@/services/fileSearch';
import type { FileMatch } from '@/services/fileSearch';
import type { Workspace } from '@/types';
import { useWorkspaceStore } from '@/stores';
import { fileSearchCache } from '@/utils/cache';
import { createLogger } from '@/utils/logger';

const log = createLogger('FileSearch');

export function useFileSearch() {
  const [fileMatches, setFileMatches] = useState<FileMatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const { getCurrentWorkspace, workspaces } = useWorkspaceStore();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 清理
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  const searchFilesDebounced = useCallback(
    (query: string, workspaceOrPath?: Workspace | string | null, delay: number = 150) => {
      // 清除之前的定时器和请求
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();

      if (!query.trim()) {
        setFileMatches([]);
        return;
      }

      // 确定搜索路径
      let searchPath: string | null = null;

      if (typeof workspaceOrPath === 'string') {
        searchPath = workspaceOrPath;
      } else if (workspaceOrPath?.path) {
        searchPath = workspaceOrPath.path;
      } else {
        // 使用当前工作区
        const currentWorkspace = getCurrentWorkspace();
        searchPath = currentWorkspace?.path || null;
      }

      if (!searchPath) {
        setIsLoading(false);
        return;
      }

      // 检查缓存（包含路径的缓存键）
      const cacheKey = `${searchPath}:${query}`;
      const cached = fileSearchCache.get(cacheKey);
      if (cached !== null) {
        setFileMatches(cached);
        return;
      }

      setIsLoading(true);

      timeoutRef.current = setTimeout(async () => {
        abortControllerRef.current = new AbortController();

        try {
          const results = await searchFiles(query, searchPath, 10);

          // 更新缓存
          fileSearchCache.set(cacheKey, results);

          // 定期清理过期缓存
          fileSearchCache.cleanup();

          setFileMatches(results);
        } catch (error) {
          if ((error as Error).name !== 'AbortError') {
            log.error('File search failed', error instanceof Error ? error : new Error(String(error)));
          }
        } finally {
          setIsLoading(false);
        }
      }, delay);
    },
    [getCurrentWorkspace]
  );

  const clearResults = useCallback(() => {
    setFileMatches([]);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  return {
    fileMatches,
    isLoading,
    searchFiles: searchFilesDebounced,
    clearResults,
    workspaces,
  };
}
