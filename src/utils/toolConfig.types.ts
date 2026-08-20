/**
 * 工具配置类型定义
 */

import type { ComponentType } from 'react';

/** 工具类别 */
export type ToolCategory =
  | 'read'      // 读取操作
  | 'write'     // 写入操作
  | 'edit'      // 编辑操作
  | 'execute'   // 执行命令
  | 'search'    // 搜索操作
  | 'list'      // 列出内容
  | 'git'       // Git 操作
  | 'delete'    // 删除操作
  | 'manage'    // 任务管理
  | 'analyze'   // 代码分析
  | 'network'   // 网络请求
  | 'agent'     // Agent/Skill/Task 子任务
  | 'other';    // 其他

/** 工具配置 */
export interface ToolConfig {
  /** lucide-react 图标组件 */
  icon: ComponentType<{ className?: string }>;
  /** 工具类别 */
  category: ToolCategory;
  /** 主题色（Tailwind 类） */
  color: string;
  /** 色条颜色（左侧边框） */
  borderColor: string;
  /** 背景色（淡色） */
  bgColor: string;
  /** 中文标签 */
  label: string;
}
