/**
 * 路径处理工具函数
 * 兼容 Windows 和 Unix 路径分隔符
 */

/**
 * 获取父目录路径
 * 支持正斜杠 (/) 和反斜杠 (\) 作为路径分隔符
 * @param path 文件或目录的完整路径
 * @returns 父目录路径，如果没有父目录则返回 null
 */
export function getParentPath(path: string): string | null {
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

/**
 * 连接路径片段
 * 自动处理路径分隔符，确保生成正确的路径
 * @param basePath 基础路径
 * @param name 要追加的文件名或目录名
 * @returns 连接后的路径
 */
export function joinPath(basePath: string, name: string): string {
  // 移除基础路径末尾的路径分隔符
  const cleanBase = basePath.replace(/[/\\]+$/, '');
  return `${cleanBase}/${name}`;
}

/**
 * 规范化路径
 * 将所有反斜杠转换为正斜杠，并移除多余的分隔符
 * @param path 原始路径
 * @returns 规范化后的路径
 */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')  // 反斜杠转正斜杠
    .replace(/\/+/g, '/'); // 移除多余的正斜杠
}
