/**
 * Spring Boot 调试代理协议（与 src-tauri/resources/debug-agent/PolarisDebugAgent.java 对应）。
 *
 * 后端 `spring-boot-debug:event` 事件每条 payload 为一行 JSON 字符串，
 * 由 parseDebugEvent 解析为强类型事件；命令经 DebugCmd 构造为行字符串
 * 通过 `spring_boot_debug_send` 下发。
 */

export interface DebugFrame {
  index: number;
  /** 全限定类名 */
  class: string;
  method: string;
  /** 源文件名（如 OrderController.java），可能为空 */
  source: string;
  line: number;
  /** 是否框架/JDK 帧（用于折叠噪声栈帧） */
  framework: boolean;
}

export interface DebugVariable {
  name: string;
  type: string;
  value: string;
  /** 对象/数组可展开 */
  hasChildren: boolean;
  /** 展开用的对象引用 id（基本类型为 0）；仅在暂停期间有效 */
  objectId: number;
}

export type DebugEvent =
  | { event: 'ready' }
  | { event: 'breakpoint'; id: string; verified: boolean; line: number; message: string | null }
  | { event: 'stopped'; reason: 'breakpoint' | 'step'; thread: string; frames: DebugFrame[]; variables: DebugVariable[] }
  | { event: 'continued' }
  | { event: 'children'; objectId: number; variables: DebugVariable[] }
  | { event: 'terminated' }
  | { event: 'error'; message: string }
  | { event: 'log'; message: string };

/** 解析一行 agent JSON 事件；非法行返回 null。 */
export function parseDebugEvent(line: string): DebugEvent | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v.event === 'string' ? (v as DebugEvent) : null;
  } catch {
    return null;
  }
}

/** 行命令构造器（与代理 dispatch 一一对应）。 */
export const DebugCmd = {
  setBreakpoint: (id: string, fqcn: string, line: number) => `setBreakpoint ${id} ${fqcn} ${line}`,
  removeBreakpoint: (id: string) => `removeBreakpoint ${id}`,
  continue: () => 'continue',
  stepOver: () => 'stepOver',
  stepInto: () => 'stepInto',
  stepOut: () => 'stepOut',
  getChildren: (objectId: number) => `getChildren ${objectId}`,
  disconnect: () => 'disconnect',
} as const;

/**
 * 由文件路径 + 源码推导 Java 全限定类名。
 * 取源码内 `package x.y;` 声明 + 文件名（去 .java）；无 package 则仅文件名。
 */
export function deriveClassName(filePath: string, content: string): string {
  const pkg = content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
  const fileName = (filePath.split(/[\\/]/).pop() ?? '').replace(/\.java$/, '');
  return pkg ? `${pkg}.${fileName}` : fileName;
}
