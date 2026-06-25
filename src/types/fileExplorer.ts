/**
 * 文件浏览器相关类型定义
 */

export interface FileInfo {
  /** 文件或目录名称 */
  name: string;
  /** 完整路径 */
  path: string;
  /** 是否为目录 */
  is_dir: boolean;
  /** 文件大小（字节） */
  size?: number;
  /** 修改时间 */
  modified?: string;
  /** 文件扩展名 */
  extension?: string;
  /** 子文件列表（目录） */
  children?: FileInfo[];
  /** 文件类型 */
  file_type?: FileType;
}

export enum FileType {
  /** 目录 */
  Directory = 'directory',
  /** 文本文件 */
  Text = 'text',
  /** 代码文件 */
  Code = 'code',
  /** 配置文件 */
  Config = 'config',
  /** 图片文件 */
  Image = 'image',
  /** 二进制文件 */
  Binary = 'binary',
  /** 未知类型 */
  Unknown = 'unknown',
}

/** 剪贴板操作类型 */
export type ClipboardOperation = 'copy' | 'cut';

/** 剪贴板状态 */
export interface FileClipboard {
  /** 操作类型 */
  operation: ClipboardOperation;
  /** 源文件路径 */
  sourcePath: string;
  /** 源文件信息 */
  sourceFile: FileInfo;
  /** 剪贴板来源 */
  source: 'internal' | 'system';
}

export interface FileExplorerState {
  /** 当前路径 */
  current_path: string;
  /** 文件树结构 */
  file_tree: FileInfo[];
  /** 当前选中的文件 */
  selected_file: FileInfo | null;
  /** 展开的文件夹路径集合 */
  expanded_folders: Set<string>;
  /** 搜索查询 */
  search_query: string;
  /** 搜索结果数量（undefined 表示无搜索） */
  search_results_count?: number;
  /** 搜索是否正在进行深度加载 */
  search_is_deep_loading?: boolean;
  /** 搜索结果（扁平化列表） */
  search_results?: FileInfo[];
  /** 是否正在加载 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 文件夹内容缓存 */
  folder_cache: Map<string, FileInfo[]>;
  /** 正在加载的文件夹 */
  loading_folders: Set<string>;
  /** 是否正在刷新 */
  is_refreshing: boolean;
  /** 剪贴板状态 */
  clipboard: FileClipboard | null;
  /** 高亮路径（Reveal in Explorer 临时高亮） */
  highlighted_path: string | null;
}

export interface FileExplorerActions {
  /** 加载目录内容 */
  load_directory: (path: string) => Promise<void>;
  /** 加载文件夹内容（懒加载） */
  load_folder_content: (path: string) => Promise<void>;
  /** 获取缓存的文件夹内容 */
  get_cached_folder_content: (path: string) => FileInfo[] | null;
  /** 精确刷新指定文件夹（保留其他展开状态） */
  refresh_folder: (path: string) => Promise<void>;
  /** 刷新当前目录（清除缓存并重新加载） */
  refresh_directory: () => Promise<void>;
  /** 选择文件 */
  select_file: (file: FileInfo) => void;
  /** 切换文件夹展开状态 */
  toggle_folder: (path: string) => void;
  /** 设置搜索查询 */
  set_search_query: (query: string) => Promise<void>;
  /** 深度搜索（使用 Rust 后端原生递归搜索） */
  deep_search: (query: string, maxResults?: number) => Promise<FileInfo[]>;
  /** 取消搜索 */
  cancel_search: () => void;
  /** 创建文件 */
  create_file: (path: string, content?: string) => Promise<void>;
  /** 创建目录 */
  create_directory: (path: string) => Promise<void>;
  /** 删除文件或目录 */
  delete_file: (path: string) => Promise<void>;
  /** 重命名文件或目录 */
  rename_file: (old_path: string, new_name: string) => Promise<void>;
  /** 获取文件内容 */
  get_file_content: (path: string) => Promise<string>;
  /** 清除错误 */
  clear_error: () => void;
  /** 复制文件到剪贴板 */
  copy_file: (file: FileInfo) => void;
  /** 剪切文件到剪贴板 */
  cut_file: (file: FileInfo) => void;
  /** 粘贴文件到目标目录 */
  paste_file: (targetPath: string) => Promise<void>;
  /** 保存拖入的文件到目标目录 */
  save_dropped_file: (targetPath: string, file: File) => Promise<void>;
  /** 清除剪贴板 */
  clear_clipboard: () => void;
  /** 在文件树中定位并高亮指定路径 */
  revealPath: (targetPath: string) => Promise<void>;
}

export type FileExplorerStore = FileExplorerState & FileExplorerActions;

export interface FsChangeEvent {
  /** 受影响的父目录路径列表（相对路径） */
  affectedDirs: string[];
}