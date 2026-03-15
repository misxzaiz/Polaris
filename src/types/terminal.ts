/**
 * 终端模块类型定义
 */

/** 终端会话信息 */
export interface TerminalSession {
  /** 会话 ID */
  id: string;
  /** 会话名称 */
  name: string;
  /** 工作目录 */
  cwd?: string;
  /** 是否已关闭 */
  closed: boolean;
}

/** 终端输出事件 */
export interface TerminalOutputEvent {
  /** 会话 ID */
  sessionId: string;
  /** 输出数据 (base64 编码) */
  data: string;
}

/** 终端退出事件 */
export interface TerminalExitEvent {
  /** 会话 ID */
  sessionId: string;
  /** 退出码 */
  exitCode?: number;
}

/** 终端尺寸 */
export interface TerminalSize {
  cols: number;
  rows: number;
}
