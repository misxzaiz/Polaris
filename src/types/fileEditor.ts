/**
 * 文件编辑器相关类型定义
 */

/** 编辑器状态 */
export type EditorStatus = 'idle' | 'loading' | 'saving' | 'error';

/** 打开的文件信息 */
export interface OpenFile {
  /** 文件路径 */
  path: string;
  /** 文件名 */
  name: string;
  /** 编辑器内容 */
  content: string;
  /** 原始内容（用于比较是否修改） */
  originalContent: string;
  /** 是否已修改 */
  isModified: boolean;
  /** 语言类型（用于语法高亮） */
  language: string;
}

/** 文件编辑器状态 */
export interface FileEditorState {
  /** 编辑器是否打开 */
  isOpen: boolean;
  /** 当前打开的文件 */
  currentFile: OpenFile | null;
  /** 编辑器状态 */
  status: EditorStatus;
  /** 错误信息 */
  error: string | null;
  /** 文件是否被外部修改（与磁盘版本冲突） */
  isConflicted: boolean;
  /** 待跳转的行号（编辑器加载后使用） */
  pendingGotoLine: number | null;
}

/** 文件编辑器操作 */
export interface FileEditorActions {
  /** 打开文件（从磁盘或缓冲区） */
  openFile: (path: string, name: string) => Promise<void>;
  /** 打开文件并跳转到指定行 */
  openFileAtLine: (path: string, name: string, lineNumber: number) => Promise<void>;
  /** 关闭文件（发送 editor:closed 事件） */
  closeFile: () => Promise<void>;
  /** 更新内容 */
  setContent: (content: string) => void;
  /** 保存文件 */
  saveFile: () => Promise<void>;
  /** 设置错误 */
  setError: (error: string | null) => void;
  /** 切换编辑器开关 */
  setOpen: (open: boolean) => void;
  /** 设置文件冲突状态 */
  setConflicted: (conflicted: boolean) => void;
  /** 从磁盘重新加载文件内容 */
  reloadFromDisk: () => Promise<void>;
  /** 切换到已缓冲的文件（Tab 切换时使用，优先从缓冲区恢复） */
  switchToFile: (path: string, name: string) => Promise<void>;
  /** 设置待跳转行号 */
  setPendingGotoLine: (line: number | null) => void;
}

/** 文件编辑器 Store */
export type FileEditorStore = FileEditorState & FileEditorActions;
