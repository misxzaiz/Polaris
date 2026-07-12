/**
 * 路径处理工具函数
 * 兼容 Windows 和 Unix 路径分隔符
 */

export type Platform = 'windows' | 'mac' | 'linux';

/** 当前操作系统平台 */
export const platform: Platform = (() => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'mac';
  return 'linux';
})();

/** 是否为 Windows 平台 */
export const isWindows = platform === 'windows';
/** 是否为 macOS 平台 */
export const isMac = platform === 'mac';

/** 当前平台的修饰键名称 (Ctrl / Cmd) */
export const modKey = isMac ? 'Cmd' : 'Ctrl';

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

/**
 * 判断路径是否已经是绝对路径。
 * 支持 Windows 盘符、UNC 路径和 Unix 根路径。
 */
export function isAbsolutePath(path: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
}

/**
 * 从路径中获取文件名。
 * 同时支持 Windows 和 Unix 分隔符。
 */
export function getFileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').pop() || path;
}

/**
 * 将 Git 返回的仓库相对路径解析成工作区内的绝对路径。
 * 如果 filePath 已经是绝对路径，原样返回。
 */
export function resolveWorkspacePath(workspacePath: string | null | undefined, filePath: string): string {
  if (!workspacePath || isAbsolutePath(filePath)) return filePath;

  const separator = workspacePath.includes('\\') ? '\\' : '/';
  const basePath = workspacePath.replace(/[\\/]+$/, '');
  const relativePath = filePath.replace(/^[\\/]+/, '').replace(/[\\/]/g, separator);
  return `${basePath}${separator}${relativePath}`;
}

/**
 * 校验文件名合法性
 * Windows 上应用 Windows 文件名限制（保留名、非法字符、尾部点号/空格）；
 * Unix 上仅禁止 / 和空字节，以及 . 和 .. 两个特殊目录名。
 */
export function isValidFileName(name: string): boolean {
  if (!name || name.trim().length === 0) {
    return false;
  }
  const trimmed = name.trim();

  // 所有平台通用规则：禁止 . 和 ..
  if (trimmed === '.' || trimmed === '..') {
    return false;
  }

  // 所有平台通用规则：禁止前后空格
  if (trimmed.startsWith(' ') || trimmed.endsWith(' ')) {
    return false;
  }

  if (isWindows) {
    // Windows 保留设备名
    const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reservedNames.test(trimmed)) {
      return false;
    }
    // Windows 非法字符
    const invalidChars = /[<>:"|?*\\]/;
    if (invalidChars.test(trimmed)) {
      return false;
    }
    // Windows 禁止以点号结尾
    if (trimmed.endsWith('.')) {
      return false;
    }
  } else {
    // Unix: 仅禁止 / 和空字符（空字符在字符串中不可能出现）
    if (trimmed.includes('/')) {
      return false;
    }
  }

  return true;
}
