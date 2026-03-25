import { memo, useState, useCallback, useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useTranslation } from 'react-i18next';
import { FileIcon } from './FileIcon';
import { Folder } from 'lucide-react';
import { ContextMenu, isHtmlFile, type ContextMenuItem } from './ContextMenu';
import { useFileExplorerStore, useFileEditorStore } from '../../stores';
import { openInDefaultApp } from '../../services/tauri';
import type { FileInfo } from '../../types';

interface SearchResultsListProps {
  results: FileInfo[];
}

// 获取相对路径显示
function getRelativePath(fullPath: string, basePath: string): string {
  if (fullPath.startsWith(basePath)) {
    const relative = fullPath.slice(basePath.length);
    return relative.startsWith('/') || relative.startsWith('\\')
      ? relative.slice(1)
      : relative;
  }
  return fullPath;
}

// 获取目录路径（不含文件名）
function getDirectoryPath(relativePath: string): string {
  // 找到最后一个路径分隔符
  const lastSlashIndex = Math.max(
    relativePath.lastIndexOf('/'),
    relativePath.lastIndexOf('\\')
  );

  if (lastSlashIndex >= 0) {
    return relativePath.substring(0, lastSlashIndex + 1);
  }
  return '';
}

// 格式化文件大小
const formatFileSize = (bytes?: number): string => {
  if (!bytes) return '';

  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
};

// 单个文件项组件
interface FileItemProps {
  file: FileInfo;
  currentPath: string;
  onClick: (file: FileInfo) => void;
  onKeyDown: (e: React.KeyboardEvent, file: FileInfo) => void;
  onContextMenu: (e: React.MouseEvent, file: FileInfo) => void;
}

const FileItem = memo<FileItemProps>(({ file, currentPath, onClick, onKeyDown, onContextMenu }) => {
  const { t } = useTranslation('fileExplorer');
  const relativePath = getRelativePath(file.path, currentPath);
  const pathOnly = getDirectoryPath(relativePath);

  return (
    <div
      className="px-2 py-1.5 cursor-pointer rounded transition-colors hover:bg-background-hover group"
      onClick={() => onClick(file)}
      onKeyDown={(e) => onKeyDown(e, file)}
      onContextMenu={(e) => onContextMenu(e, file)}
      role="button"
      tabIndex={0}
      aria-label={`${file.is_dir ? t('ariaLabel.folder', { name: file.name }) : t('ariaLabel.file', { name: file.name })}`}
    >
      <div className="flex items-start gap-2">
        {file.is_dir ? (
          <Folder className="mt-0.5 w-4 h-4 flex-shrink-0 text-warning" />
        ) : (
          <FileIcon
            file={file}
            className="mt-0.5 w-4 h-4 flex-shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          {/* 第一行：文件名 */}
          <div
            className="text-sm text-text-primary truncate"
            title={file.name}
          >
            {file.name}
          </div>
          {/* 第二行：相对路径（小字） */}
          {pathOnly && (
            <div
              className="text-xs text-text-tertiary truncate mt-0.5"
              title={pathOnly}
            >
              {pathOnly}
            </div>
          )}
          {/* 文件大小（仅文件显示，悬停时显示） */}
          {!file.is_dir && file.size && (
            <div className="text-xs text-text-tertiary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
              {formatFileSize(file.size)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

FileItem.displayName = 'FileItem';

// 目录分隔线组件
const DirectorySeparator = memo(() => (
  <div className="px-2 my-1 border-t border-border-subtle" />
));

DirectorySeparator.displayName = 'DirectorySeparator';

export const SearchResultsList = memo<SearchResultsListProps>(({ results }) => {
  const { t } = useTranslation('fileExplorer');
  const { select_file, current_path } = useFileExplorerStore();
  const { openFile } = useFileEditorStore();

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    file: FileInfo | null;
  }>({ visible: false, x: 0, y: 0, file: null });

  const handleClick = async (file: FileInfo) => {
    select_file(file);
    if (!file.is_dir) {
      await openFile(file.path, file.name);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, file: FileInfo) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick(file);
    }
  };

  // 关闭右键菜单
  const closeContextMenu = useCallback(() => {
    setContextMenu({ visible: false, x: 0, y: 0, file: null });
  }, []);

  // 右键菜单处理
  const handleContextMenu = useCallback((e: React.MouseEvent, file: FileInfo) => {
    e.preventDefault();
    e.stopPropagation();

    // 选中当前文件
    select_file(file);

    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      file,
    });
  }, [select_file]);

  // 构建菜单项
  const menuItems = useMemo((): ContextMenuItem[] => {
    const file = contextMenu.file;
    if (!file) return [];

    const items: ContextMenuItem[] = [
      {
        id: 'open',
        label: file.is_dir ? t('searchResults.openFolder') : t('searchResults.openFile'),
        icon: '',
        action: async () => {
          if (!file.is_dir) {
            await openFile(file.path, file.name);
          }
        },
      },
    ];

    // HTML 文件添加"在浏览器中打开"选项
    if (isHtmlFile(file)) {
      items.push({
        id: 'open-in-browser',
        label: t('searchResults.openInBrowser'),
        icon: '',
        action: async () => {
          await openInDefaultApp(file.path);
        },
      });
    }

    return items;
  }, [contextMenu.file, openFile, t]);

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
        <svg className="w-8 h-8 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        <div className="text-sm">{t('searchResults.noMatch')}</div>
      </div>
    );
  }

  // 分组：目录和文件分开显示
  const directories = results.filter(f => f.is_dir);
  const files = results.filter(f => !f.is_dir);

  // 合并所有项，目录在前，文件在后，中间加分隔线
  const allItems: Array<{ type: 'directory' | 'file' | 'separator'; data?: FileInfo }> = [
    ...directories.map(d => ({ type: 'directory' as const, data: d })),
    ...(directories.length > 0 && files.length > 0 ? [{ type: 'separator' as const }] : []),
    ...files.map(f => ({ type: 'file' as const, data: f })),
  ];

  // 结果较少时直接渲染，使用虚拟滚动的阈值
  const VIRTUAL_SCROLL_THRESHOLD = 50;
  const shouldUseVirtualScroll = results.length >= VIRTUAL_SCROLL_THRESHOLD;

  // 非虚拟滚动模式
  if (!shouldUseVirtualScroll) {
    return (
      <div className="py-1 min-w-auto">
        {allItems.map((item, index) => {
          if (item.type === 'separator') {
            return <DirectorySeparator key={`sep-${index}`} />;
          }
          return (
            <FileItem
              key={item.data!.path}
              file={item.data!}
              currentPath={current_path}
              onClick={handleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          );
        })}

        {/* 右键菜单 */}
        <ContextMenu
          visible={contextMenu.visible}
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems}
          onClose={closeContextMenu}
        />
      </div>
    );
  }

  // 虚拟滚动模式
  return (
    <>
      <Virtuoso
        style={{ height: '100%' }}
        data={allItems}
        itemContent={(_index, item) => {
          if (item.type === 'separator') {
            return <DirectorySeparator />;
          }
          return (
            <FileItem
              file={item.data!}
              currentPath={current_path}
              onClick={handleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          );
        }}
        defaultItemHeight={60} // 预估每个项的高度
      />

      {/* 右键菜单 */}
      <ContextMenu
        visible={contextMenu.visible}
        x={contextMenu.x}
        y={contextMenu.y}
        items={menuItems}
        onClose={closeContextMenu}
      />
    </>
  );
});

SearchResultsList.displayName = 'SearchResultsList';
