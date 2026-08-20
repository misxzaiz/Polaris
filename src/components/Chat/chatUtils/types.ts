/**
 * 聊天组件局部类型定义
 */

import type { ThinkingBlock, ToolCallBlock } from '@/types';

/** 可折叠块分组（支持 thinking + tool_call 混合） */
export interface CollapsibleBlockGroup {
  /** 在 blocks 数组中的起始索引 */
  startIndex: number;
  /** 在 blocks 数组中的结束索引（包含） */
  endIndex: number;
  /** 连续的可折叠块 */
  blocks: (ThinkingBlock | ToolCallBlock)[];
  /** 每个块在原始 blocks 数组中的真实索引 */
  indices: number[];
}

/** 思考步骤提取结果 */
export interface ThinkingStep {
  text: string;
  index: number;
}

/** TodoWrite 相关类型定义 */
export interface TodoItemType {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface TodoInputData {
  todos: TodoItemType[];
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}
