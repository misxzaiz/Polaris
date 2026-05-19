/**
 * 内置布局预设
 *
 * 每套预设描述一个完整的布局快照(slots + activityBarPosition)。
 * size 含义:
 * - left/right: 宽度像素
 * - bottom:    高度像素
 * - center:    始终 0(占位,实际由 flex-1 控制)
 */

import type { BuiltinPresetId, LayoutPreset, LayoutSnapshot, SlotState } from '@/types/layout';

const emptySlot = (size = 0): SlotState => ({
  modules: [],
  activeModule: null,
  size,
});

/** 专注写作: Chat 占满主舞台 (center),其余隐藏,ActivityBar 也隐藏。
 *
 *   Chat 必须放在 center 而非 right —— LayoutShell 用 flex-1 撑 center,
 *   而 SlotPanel 的 right 是固定 width=size 的次要槽位,
 *   如果把 chat 放在 right 且 size 又被设为 0,会被渲染为 width:0px 的不可见容器,
 *   导致整个屏幕看起来空白 (回归记忆). 任何"主舞台单模块"语义的预设都应当用 center.
 */
const focusWritingSnapshot: LayoutSnapshot = {
  slots: {
    left: emptySlot(280),
    center: { modules: ['chat'], activeModule: 'chat', size: 0 },
    right: emptySlot(400),
    bottom: emptySlot(),
  },
  activityBarPosition: 'hidden',
};

/** 开发模式: 经典 IDE 三栏 + 底部终端 */
const developerSnapshot: LayoutSnapshot = {
  slots: {
    left: { modules: ['files', 'git'], activeModule: 'files', size: 280 },
    center: emptySlot(),
    right: { modules: ['chat'], activeModule: 'chat', size: 400 },
    bottom: { modules: ['terminal', 'problems'], activeModule: 'terminal', size: 220 },
  },
  activityBarPosition: 'left',
};

/** 任务驾驶舱: 左 Todo+需求,中 Chat,右 调度器+长目标 */
const taskCockpitSnapshot: LayoutSnapshot = {
  slots: {
    left: { modules: ['todo', 'requirement'], activeModule: 'todo', size: 320 },
    center: { modules: ['chat'], activeModule: 'chat', size: 0 },
    right: { modules: ['scheduler', 'longGoal'], activeModule: 'scheduler', size: 360 },
    bottom: emptySlot(),
  },
  activityBarPosition: 'left',
};

/** 极简对话: 类 ChatGPT,Chat 占满主舞台 (center),无 ActivityBar.
 *  见 focus-writing 注释关于 "chat 必须放 center" 的不变量说明. */
const minimalChatSnapshot: LayoutSnapshot = {
  slots: {
    left: emptySlot(280),
    center: { modules: ['chat'], activeModule: 'chat', size: 0 },
    right: emptySlot(400),
    bottom: emptySlot(),
  },
  activityBarPosition: 'hidden',
};

/** 全景模式: 所有面板可见 */
const panoramaSnapshot: LayoutSnapshot = {
  slots: {
    left: { modules: ['files', 'git', 'todo'], activeModule: 'files', size: 280 },
    center: emptySlot(),
    right: { modules: ['chat'], activeModule: 'chat', size: 400 },
    bottom: {
      modules: ['terminal', 'problems', 'scheduler'],
      activeModule: 'terminal',
      size: 200,
    },
  },
  activityBarPosition: 'left',
};

// ============================================================
// V2 新增 4 套预设
// ============================================================

/** 评审模式 (Review): 左=Files+Git, 中=编辑器 (CenterStage), 右=Chat, 底=Problems.
 *  专为代码 review 设计 — Files/Git 看变更, 中央编辑器看代码, AI 帮助分析, Problems 跟踪 lint/编译.
 */
const reviewSnapshot: LayoutSnapshot = {
  slots: {
    left: { modules: ['files', 'git'], activeModule: 'git', size: 300 },
    center: emptySlot(),
    right: { modules: ['chat'], activeModule: 'chat', size: 380 },
    bottom: { modules: ['problems'], activeModule: 'problems', size: 180 },
  },
  activityBarPosition: 'left',
};

/** 演示模式 (Presenting): Chat 占满 center, Dock 隐藏.
 *  适合屏幕共享、录课. 用户可结合 density='spacious' 进一步放大字号
 *  (后续可加联动: 应用此预设时自动设置 density). */
const presentingSnapshot: LayoutSnapshot = {
  slots: {
    left: emptySlot(280),
    center: { modules: ['chat'], activeModule: 'chat', size: 0 },
    right: emptySlot(400),
    bottom: emptySlot(),
  },
  activityBarPosition: 'hidden',
};

/** 多任务并行 (Parallel Work): 左=Todo, 中=Chat, 右=Scheduler+LongGoal.
 *  V2 PRD 设想的"双 Chat 并行"需要 chat 多实例支持, 本期 chat 仍是单实例,
 *  这里把"多任务"的语义落在工作流模块组合上: Todo 管理 + Chat 协作 + 调度 + 长目标.
 */
const parallelChatSnapshot: LayoutSnapshot = {
  slots: {
    left: { modules: ['todo'], activeModule: 'todo', size: 280 },
    center: { modules: ['chat'], activeModule: 'chat', size: 0 },
    right: {
      modules: ['scheduler', 'longGoal'],
      activeModule: 'scheduler',
      size: 360,
    },
    bottom: emptySlot(),
  },
  activityBarPosition: 'left',
};

/** 数据探索 (Data Explorer): 左=Files, 中=编辑器, 右=Chat, 底=Terminal+Problems.
 *  与 review 相似但更偏向"调试/分析" — 强调 Terminal 输出与 AI 协同分析.
 */
const dataExplorerSnapshot: LayoutSnapshot = {
  slots: {
    left: { modules: ['files'], activeModule: 'files', size: 260 },
    center: emptySlot(),
    right: { modules: ['chat'], activeModule: 'chat', size: 380 },
    bottom: {
      modules: ['terminal', 'problems'],
      activeModule: 'terminal',
      size: 220,
    },
  },
  activityBarPosition: 'left',
};

export const BUILTIN_PRESETS: readonly LayoutPreset[] = [
  {
    id: 'focus-writing',
    nameKey: 'layout:preset.focusWriting.name',
    descriptionKey: 'layout:preset.focusWriting.description',
    icon: 'Feather',
    builtin: true,
    ...focusWritingSnapshot,
  },
  {
    id: 'developer',
    nameKey: 'layout:preset.developer.name',
    descriptionKey: 'layout:preset.developer.description',
    icon: 'Code2',
    builtin: true,
    ...developerSnapshot,
  },
  {
    id: 'task-cockpit',
    nameKey: 'layout:preset.taskCockpit.name',
    descriptionKey: 'layout:preset.taskCockpit.description',
    icon: 'ClipboardList',
    builtin: true,
    ...taskCockpitSnapshot,
  },
  {
    id: 'minimal-chat',
    nameKey: 'layout:preset.minimalChat.name',
    descriptionKey: 'layout:preset.minimalChat.description',
    icon: 'MessageSquare',
    builtin: true,
    ...minimalChatSnapshot,
  },
  {
    id: 'panorama',
    nameKey: 'layout:preset.panorama.name',
    descriptionKey: 'layout:preset.panorama.description',
    icon: 'LayoutGrid',
    builtin: true,
    ...panoramaSnapshot,
  },
  // V2 新增 4 套
  {
    id: 'review',
    nameKey: 'layout:preset.review.name',
    descriptionKey: 'layout:preset.review.description',
    icon: 'ScrollText',
    builtin: true,
    ...reviewSnapshot,
  },
  {
    id: 'presenting',
    nameKey: 'layout:preset.presenting.name',
    descriptionKey: 'layout:preset.presenting.description',
    icon: 'Presentation',
    builtin: true,
    ...presentingSnapshot,
  },
  {
    id: 'parallel-chat',
    nameKey: 'layout:preset.parallelChat.name',
    descriptionKey: 'layout:preset.parallelChat.description',
    icon: 'Workflow',
    builtin: true,
    ...parallelChatSnapshot,
  },
  {
    id: 'data-explorer',
    nameKey: 'layout:preset.dataExplorer.name',
    descriptionKey: 'layout:preset.dataExplorer.description',
    icon: 'Microscope',
    builtin: true,
    ...dataExplorerSnapshot,
  },
];

export const DEFAULT_PRESET_ID: BuiltinPresetId = 'developer';

export const DEFAULT_LAYOUT_SNAPSHOT: LayoutSnapshot = developerSnapshot;

export function getBuiltinPreset(id: string): LayoutPreset | undefined {
  return BUILTIN_PRESETS.find((preset) => preset.id === id);
}
