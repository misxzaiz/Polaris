import { memo, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ChevronDown, Folder, Loader2, Copy, FolderOpen } from 'lucide-react';
import { clsx } from 'clsx';
import { FileIcon } from './FileIcon';
import { ContextMenu, isHtmlFile, type ContextMenuItem } from './ContextMenu';
import { useFileExplorerStore, useFileEditorStore } from '../../stores';
import { openInDefaultApp } from '../../services/tauri';
import { openPath } from '@tauri-apps/plugin-opener';
import { InputDialog } from '../Common/InputDialog';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import { IconFile, IconFolder, IconEdit, IconTrash, IconExternalLink, IconOpen } from '../Common/Icons';
import type { FileInfo } from '../../types';
import { getParentPath, joinPath } from '../../utils/path';

function isValidFileName(name: string): boolean {
  if (!name || name.trim().length === 0) {
    return false;
  }

  const trimmed = name.trim();

  const invalidChars = /[<>:"|?*\\]/;
  if (invalidChars.test(trimmed)) {
    return false;
  }

  const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (reservedNames.test(trimmed)) {
    return false;
  }

  // 禁止 . 和 .. 这两个特殊目录名
  if (trimmed === '.' || trimmed === '..') {
    return false;
  }

  // 允许以 . 开头的文件（如 .env, .gitignore）
  if (trimmed.startsWith(' ') || trimmed.endsWith(' ') || trimmed.endsWith('.')) {
    return false;
  }

  return true;
}

interface FileTreeNodeProps {
  file: FileInfo;
  level: number;
  isExpanded: boolean;
  isSelected: boolean;
  expandedFolders: Set<string>;
  loadingFolders: Set<string>;
}

export const FileTreeNode = memo<FileTreeNodeProps>(({
  file,
  level,
  isExpanded,
  isSelected,
  expandedFolders,
  loadingFolders,
}) => {
  const { t } = useTranslation('fileExplorer');
  const {
    load_folder_content,
    get_cached_folder_content,
    toggle_folder,
    select_file,
    create_file,
    create_directory,
    delete_file,
    rename_file,
    copy_file,
    cut_file,
    paste_file,
    clipboard
  } = useFileExplorerStore();
  const { openFile } = useFileEditorStore();

  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
  }>({ visible: false, x: 0, y: 0 });

  const [inputDialog, setInputDialog] = useState<{
    visible: boolean;
    title: string;
    message: string;
    defaultValue: string;
    action: 'create-file' | 'create-folder' | 'rename';
  }>({ visible: false, title: '', message: '', defaultValue: '', action: 'create-file' });

  const [confirmDialog, setConfirmDialog] = useState<{
    visible: boolean;
    message: string;
  }>({ visible: false, message: '' });

  useEffect(() => {
    if (file.is_dir && isExpanded) {
      const cached = get_cached_folder_content(file.path);

      // 只有当缓存不存在且 children 尚未加载时才触发加载
      // 注意：file.children 可能是 undefined（未加载）或数组（已加载）
      // 空数组 [] 表示已加载且为空，不应再次触发加载
      if (!cached && file.children === undefined) {
        load_folder_content(file.path);
      }
    }
  }, [file.is_dir, file.path, isExpanded, file.children, load_folder_content, get_cached_folder_content]);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (file.is_dir) {
      toggle_folder(file.path);

      if (!isExpanded) {
        const cached = get_cached_folder_content(file.path);

        // 只有当缓存不存在且 children 尚未加载时才触发加载
        if (!cached && file.children === undefined) {
          await load_folder_content(file.path);
        }
      }
    } else {
      select_file(file);
      // 直接调用 store 的 openFile
      await openFile(file.path, file.name);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick(e as any);
    }
  };

  const isLoading = file.is_dir && loadingFolders.has(file.path);

  // children 状态:
  // - undefined: 尚未加载
  // - []: 空数组，确实为空
  // - [items]: 有内容
  const hasChildren = file.children !== undefined && file.children.length > 0;
  const isChildrenLoaded = file.children !== undefined;

  const closeContextMenu = useCallback(() => {
    setContextMenu({ visible: false, x: 0, y: 0 });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    select_file(file);

    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
    });
  }, [file, select_file]);

  const getMenuItems = useCallback((): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      {
        id: 'open',
        label: file.is_dir ? t('contextMenu.openFolder') : t('contextMenu.openFile'),
        icon: <IconOpen size={14} />,
        action: async () => {
          if (file.is_dir) {
            toggle_folder(file.path);
          } else {
            await openFile(file.path, file.name);
          }
        },
      },
    ];

    if (file.is_dir) {
      items.push({
        id: 'create-file',
        label: t('contextMenu.newFile'),
        icon: <IconFile size={14} />,
        action: () => {
          setInputDialog({
            visible: true,
            title: t('contextMenu.newFile'),
            message: t('contextMenu.inputFileName'),
            defaultValue: '',
            action: 'create-file',
          });
        },
      });

      items.push({
        id: 'create-folder',
        label: t('contextMenu.newFolder'),
        icon: <IconFolder size={14} />,
        action: () => {
          setInputDialog({
            visible: true,
            title: t('contextMenu.newFolder'),
            message: t('contextMenu.inputFolderName'),
            defaultValue: '',
            action: 'create-folder',
          });
        },
      });
    }

    items.push({ id: 'separator-1', label: '-', icon: undefined, action: () => {} });

    // 复制文件路径
    items.push({
      id: 'copy-path',
      label: t('contextMenu.copyPath'),
      icon: <Copy size={14} />,
      action: async () => {
        await navigator.clipboard.writeText(file.path);
      },
    });

    // 在外部文件管理器打开
    items.push({
      id: 'open-in-explorer',
      label: file.is_dir ? t('contextMenu.openInExplorer') : t('contextMenu.openFolderInExplorer'),
      icon: <FolderOpen size={14} />,
      action: async () => {
        if (file.is_dir) {
          await openPath(file.path);
        } else {
          // 对于文件，打开其所在目录
          const parentPath = getParentPath(file.path);
          if (parentPath) {
            await openPath(parentPath);
          }
        }
      },
    });

    items.push({ id: 'separator-2', label: '-', icon: undefined, action: () => {} });

    // 复制文件
    items.push({
      id: 'copy',
      label: t('contextMenu.copy'),
      icon: <Copy size={14} />,
      action: () => {
        copy_file(file);
      },
    });

    // 剪切文件
    items.push({
      id: 'cut',
      label: t('contextMenu.cut'),
      icon: <IconEdit size={14} />,
      action: () => {
        cut_file(file);
      },
    });

    // 粘贴（仅目录显示）
    if (file.is_dir && clipboard) {
      items.push({
        id: 'paste',
        label: t('contextMenu.paste'),
        icon: <IconFolder size={14} />,
        action: async () => {
          await paste_file(file.path);
        },
      });
    }

    items.push({ id: 'separator-rename', label: '-', icon: undefined, action: () => {} });

    items.push({
      id: 'rename',
      label: t('contextMenu.rename'),
      icon: <IconEdit size={14} />,
      action: () => {
        setInputDialog({
          visible: true,
          title: t('contextMenu.rename'),
          message: t('contextMenu.inputNewName'),
          defaultValue: file.name,
          action: 'rename',
        });
      },
    });

    items.push({
      id: 'delete',
      label: t('contextMenu.delete'),
      icon: <IconTrash size={14} />,
      action: () => {
        const itemType = file.is_dir ? t('contextMenu.newFolder') : t('contextMenu.newFile');
        setConfirmDialog({
          visible: true,
          message: t('confirmDeleteMessage', { type: itemType.toLowerCase(), name: file.name }),
        });
      },
    });

    if (isHtmlFile(file)) {
      items.push({ id: 'separator-3', label: '-', icon: undefined, action: () => {} });
      items.push({
        id: 'open-in-browser',
        label: t('contextMenu.openInBrowser'),
        icon: <IconExternalLink size={14} />,
        action: async () => {
          await openInDefaultApp(file.path);
        },
      });
    }

    return items;
  }, [file, toggle_folder, openFile, t, copy_file, cut_file, paste_file, clipboard]);

  const handleInputDialogConfirm = async (value: string) => {
    if (!value) return;

    if (inputDialog.action === 'create-file') {
      if (isValidFileName(value)) {
        const fullPath = joinPath(file.path, value);
        await create_file(fullPath, '');
        setInputDialog({ ...inputDialog, visible: false });
      }
    } else if (inputDialog.action === 'create-folder') {
      if (isValidFileName(value)) {
        const fullPath = joinPath(file.path, value);
        await create_directory(fullPath);
        setInputDialog({ ...inputDialog, visible: false });
      }
    } else if (inputDialog.action === 'rename') {
      if (value && value !== file.name && isValidFileName(value)) {
        await rename_file(file.path, value);
        setInputDialog({ ...inputDialog, visible: false });
      }
    }
  };

  const handleConfirmDialogConfirm = async () => {
    await delete_file(file.path);
    setConfirmDialog({ ...confirmDialog, visible: false });
  };

  const validateInput = (value: string) => {
    if (!value || value.trim().length === 0) {
      return t('contextMenu.nameEmpty');
    }
    if (!isValidFileName(value)) {
      return t('contextMenu.nameInvalid');
    }
    if (inputDialog.action === 'rename' && value === file.name) {
      return t('contextMenu.nameSame');
    }
    return null;
  };

  return (
    <div>
      <div
        className={clsx(
          'flex items-center px-2 py-1.5 cursor-pointer rounded transition-colors',
          'hover:bg-background-hover',
          isSelected && 'bg-primary/20 border-l-2 border-primary'
        )}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
        aria-label={file.is_dir ? t('ariaLabel.folder', { name: file.name }) : t('ariaLabel.file', { name: file.name })}
      >
        {file.is_dir && (
          <span className="mr-1 flex-shrink-0">
            {isLoading ? (
              <Loader2 className="w-3.5 h-3.5 text-text-muted animate-spin" />
            ) : isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
            )}
          </span>
        )}

        {!file.is_dir && <span className="mr-1 w-3.5 flex-shrink-0" />}

        {file.is_dir ? (
          <Folder className={clsx(
            'mr-2 w-4 h-4 flex-shrink-0',
            isExpanded ? 'text-primary' : 'text-text-muted'
          )} />
        ) : (
          <FileIcon
            file={file}
            className="mr-2 w-4 h-4 flex-shrink-0"
          />
        )}

        <span
          className="text-sm text-text-primary truncate flex-1 min-w-0"
          title={file.name}
        >
          {file.name}
        </span>
      </div>
      
      {file.is_dir && isExpanded && hasChildren && (
        <div className="animate-in slide-in-from-top-1 duration-200">
          {file.children?.map(child => (
            <FileTreeNode
              key={child.path}
              file={child}
              level={level + 1}
              isExpanded={expandedFolders.has(child.path)}
              isSelected={false}
              expandedFolders={expandedFolders}
              loadingFolders={loadingFolders}
            />
          ))}
        </div>
      )}

      {/* 正在加载时显示加载状态 */}
      {file.is_dir && isExpanded && isLoading && (
        <div
          style={{ paddingLeft: `${(level + 1) * 16 + 8}px` }}
          className="text-xs text-text-tertiary py-1 animate-pulse"
        >
          {t('loading')}
        </div>
      )}

      {/* 已加载且确实为空时显示空文件夹提示 */}
      {file.is_dir && isExpanded && !isLoading && isChildrenLoaded && !hasChildren && (
        <div
          style={{ paddingLeft: `${(level + 1) * 16 + 8}px` }}
          className="text-xs text-text-tertiary py-1 italic"
        >
          {t('empty.folder')}
        </div>
      )}

      {/* 右键菜单 */}
      <ContextMenu
        visible={contextMenu.visible}
        x={contextMenu.x}
        y={contextMenu.y}
        items={getMenuItems()}
        onClose={closeContextMenu}
      />

      {/* 输入对话框 */}
      {inputDialog.visible && (
        <InputDialog
          title={inputDialog.title}
          message={inputDialog.message}
          defaultValue={inputDialog.defaultValue}
          onConfirm={handleInputDialogConfirm}
          onCancel={() => setInputDialog({ ...inputDialog, visible: false })}
          validate={validateInput}
        />
      )}

      {/* 确认对话框 */}
      {confirmDialog.visible && (
        <ConfirmDialog
          message={confirmDialog.message}
          onConfirm={handleConfirmDialogConfirm}
          onCancel={() => setConfirmDialog({ ...confirmDialog, visible: false })}
          type="danger"
        />
      )}
    </div>
  );
});

FileTreeNode.displayName = 'FileTreeNode';
