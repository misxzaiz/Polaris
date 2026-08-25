/**
 * 通用执行器服务
 * 封装 Tauri 命令 / HTTP IPC 对执行器的统一访问。
 */

import { invoke } from '@/services/transport';

/** 执行器注册项（来自后端 ExecutorRegistry::list） */
export interface ExecutorInfo {
  /** 执行器类型标识（如 "chat" / "command" / "http" / "plugin:<id>:<executor>"） */
  type: string;
  /** 执行器名称（展示用） */
  name: string;
  /** 执行器描述 */
  description: string;
}

/** 列出已注册的执行器 */
export async function executorList(): Promise<ExecutorInfo[]> {
  const raw = await invoke<Array<[string, string, string]>>('executor_list');
  return (raw || []).map(([type, name, description]) => ({ type, name, description }));
}

/** 判断执行器类型是否为插件自定义 */
export function isPluginExecutor(type: string): boolean {
  return type.startsWith('plugin:');
}