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

// ============================================================
// V2: 外观与空间美学
// ============================================================

/** 信息密度档 */
export type LayoutDensity = 'compact' | 'standard' | 'spacious';

/** 动效强度档 */
export type TransitionLevel = 'off' | 'minimal' | 'standard' | 'lively';

/** Dock 显示模式 */
export type DockMode = 'expanded' | 'compact' | 'floating';

/**
 * V2 外观配置 (与槽位布局正交).
 * 这一组字段控制"空间美学" — padding/gap/radius/动效/密度,
 * 不影响 slots 内容,因此不属于 LayoutSnapshot,而是独立持久化字段.
 */
export interface LayoutAppearance {
  /** 应用窗口外 padding (0~12 px, 默认 6) */
  appPadding: number;
  /** 槽位之间 gap (0~8 px, 默认 4) */
  slotGap: number;
  /** 槽位圆角 (0~12 px, 默认 10) */
  slotRadius: number;
  /** 信息密度 */
  density: LayoutDensity;
  /** 动效强度 */
  transitionLevel: TransitionLevel;
  /** Dock 显示模式 */
  dockMode: DockMode;
}

/** V2 外观字段的合法范围常量 */
export const APPEARANCE_LIMITS = {
  appPadding: { min: 0, max: 12 },
  slotGap: { min: 0, max: 8 },
  slotRadius: { min: 0, max: 12 },
} as const;

/** V2 外观字段默认值 */
export const DEFAULT_APPEARANCE: LayoutAppearance = {
  appPadding: 6,
  slotGap: 4,
  slotRadius: 10,
  density: 'standard',
  transitionLevel: 'standard',
  dockMode: 'expanded',
};

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

/**
 * 导出/导入用的 JSON 结构.
 *
 * version 字段约定:
 * - 1: 早期版本, 无 appearance 字段
 * - 2: V2 版本, 增加 appearance (可选向后兼容: 导入 v1 时 appearance 由默认值填充)
 *
 * 导入器必须接受 v1 与 v2; 导出器始终输出当前版本 (v2).
 */
export interface LayoutExportPayload {
  version: 1 | 2;
  layout: LayoutSnapshot;
  customLayouts: CustomLayout[];
  activePresetId: string;
  /** V2 新增: 外观配置 (v1 导入时由默认值填充) */
  appearance?: LayoutAppearance;
}
