import type { FileInfo } from '@/types';
import { normalizePath } from '@/utils/path';

/** 更新文件树中的子节点 */
export function updateFolderChildren(tree: FileInfo[], folderPath: string, children: FileInfo[]): FileInfo[] {
  const normalizedFolderPath = normalizePath(folderPath);

  return tree.map(file => {
    if (normalizePath(file.path) === normalizedFolderPath) {
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

/** 递归过滤文件树 */
export function filterFiles(files: FileInfo[], query: string): FileInfo[] {
  if (!query.trim()) return files;

  const lowerQuery = query.toLowerCase();

  return files.reduce((acc: FileInfo[], file) => {
    const nameMatches = file.name.toLowerCase().includes(lowerQuery);

    if (file.is_dir) {
      const filteredChildren = file.children ? filterFiles(file.children, query) : [];

      if (nameMatches || filteredChildren.length > 0) {
        acc.push({
          ...file,
          children: filteredChildren.length > 0 ? filteredChildren : file.children
        });
      }
    } else if (nameMatches) {
      acc.push(file);
    }

    return acc;
  }, []);
}

/** 递归计数文件数量（排除目录） */
export function countFiles(files: FileInfo[]): number {
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
