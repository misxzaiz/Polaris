/**
 * 布局自定义系统类型定义
 *
 * 设计要点:
 * - Slot(槽位): 物理位置固定的容器,共 4 个(left/right/center/bottom)
 * - Module(模块): 被插件注册的业务单元,可放入不同槽位作为 Tab
 * - SlotState.activeModule === null 表示该槽位整体折叠
 * - Center 槽位是特例: modules 为空时由 tabStore 驱动 CenterStage
 */

/** 槽位 id */
export type SlotId = 'left' | 'right' | 'center' | 'bottom';

/** 模块 id (与 plugin-system PluginViewContribution.moduleId 对齐) */
export type ModuleId =
  | 'chat'
  | 'files'
  | 'git'
  | 'todo'
  | 'requirement'
  | 'scheduler'
  | 'longGoal'
  | 'terminal'
  | 'problems'
  | 'developer'
  | 'integration'
  | 'translate'
  | 'demoPlugin';

/** ActivityBar 位置 */
export type ActivityBarPosition = 'left' | 'right' | 'hidden';

/** 单个槽位的状态 */
export interface SlotState {
  /** 槽位中绑定的模块列表 (Tab 顺序) */
  modules: ModuleId[];
  /** 当前激活的模块; null 表示整个槽位折叠不渲染 */
  activeModule: ModuleId | null;
  /**
   * 槽位尺寸 (左右槽位为宽度像素,bottom 为高度像素;center 始终 0)。
   * 即使 activeModule=null 折叠时,size 也会保留作为"恢复时的记忆值"。
   */
  size: number;
}

/** 完整布局快照 (预设与自定义布局共用) */
export interface LayoutSnapshot {
  slots: Record<SlotId, SlotState>;
  activityBarPosition: ActivityBarPosition;
}

/** 用户自定义布局 */
export interface CustomLayout extends LayoutSnapshot {
  id: string;
  name: string;
}

/** 内置预设 id */
export type BuiltinPresetId =
  | 'focus-writing'
  | 'developer'
  | 'task-cockpit'
  | 'minimal-chat'
  | 'panorama';

/** 预设定义 (内置或自定义) */
export interface LayoutPreset extends LayoutSnapshot {
  id: BuiltinPresetId | string;
  /** i18n key,如 layout:preset.developer.name */
  nameKey?: string;
  /** 自定义布局直接使用的展示名 */
  name?: string;
  /** 描述用的 i18n key */
  descriptionKey?: string;
  /** 图标名 (lucide) */
  icon?: string;
  /** 内置标记;false 表示用户自定义 */
  builtin: boolean;
}

/** 导出/导入用的 JSON 结构 */
export interface LayoutExportPayload {
  version: 1;
  layout: LayoutSnapshot;
  customLayouts: CustomLayout[];
  activePresetId: string;
}
