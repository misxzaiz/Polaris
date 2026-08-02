import { memo, useMemo, useCallback } from 'react';
import { FileTreeNode } from './FileTreeNode';
import { SearchResultsList } from './SearchResultsList';
import { useFileExplorerStore } from '@/stores';
import { normalizePath } from '@/utils/path';
import type { FileInfo } from '@/types';

interface FileTreeProps {
  files?: FileInfo[];
  className?: string;
}

export const FileTree = memo<FileTreeProps>(({ files, className = '' }) => {
  const {
    selected_file,
    expanded_folders,
    loading_folders,
    search_query,
    search_results,
    file_tree
  } = useFileExplorerStore();

  const fileTree = files || file_tree;

  // 递归过滤文件树 - 使用 useCallback 缓存
  const filterFiles = useCallback((filesToFilter: FileInfo[], query: string): FileInfo[] => {
    if (!query.trim()) return filesToFilter;

    const lowerQuery = query.toLowerCase();

    return filesToFilter.reduce((acc: FileInfo[], file) => {
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
  }, []);

  // 应用搜索过滤 - 使用 useMemo 缓存结果
  const filteredFiles = useMemo(
    () => (search_query ? filterFiles(fileTree, search_query) : fileTree),
    [fileTree, search_query, filterFiles]
  );

  // 如果有搜索结果，显示搜索结果列表（移到 hooks 之后）
  if (search_query && search_results) {
    return <SearchResultsList results={search_results} />;
  }

  if (filteredFiles.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center py-8 text-text-tertiary ${className}`}>
        <svg className="w-8 h-8 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
        </svg>
        <div className="text-sm">
          {search_query ? '没有找到匹配的文件' : '此目录为空'}
        </div>
      </div>
    );
  }

  return (
    <div className={`py-1 min-w-max ${className}`}>
      {filteredFiles.map((file) => (
        <FileTreeNode
          key={file.path}
          file={file}
          level={0}
          isExpanded={expanded_folders.has(normalizePath(file.path))}
          isSelected={selected_file?.path === file.path}
          expandedFolders={expanded_folders}
          loadingFolders={loading_folders}
        />
      ))}
    </div>
  );
});

FileTree.displayName = 'FileTree';
