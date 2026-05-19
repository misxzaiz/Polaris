/**
 * 布局系统的拖拽 (DnD) 工具模块
 *
 * 设计要点:
 * - 复合 ID 编码: `activity-bar:<moduleId>` / `tab:<slotId>:<moduleId>` / `slot:<slotId>`
 *   这样 @dnd-kit 的 unique-id 需求得到满足,active/over 双方解析方便
 * - active.data / over.data 通过 @dnd-kit 的 data 字段携带强类型 payload
 * - handleDragEnd 抽离为纯函数,便于单元测试 (输入 active/over 描述 + store API)
 *
 * 三种拖拽语义:
 *  A. ActivityBar 图标 → 任意 slot       (新增模块到槽位)
 *  B. Tab → 另一个 slot                  (跨槽位移动)
 *  C. Tab → 同 slot 内的另一个 Tab       (同槽位重排)
 *
 * 不处理:
 *  - 空槽位的 drop (折叠槽位本期不支持 drop;由 ActivityBar 点击激活)
 *  - 内容区的 drop (与 Virtuoso/CodeMirror 冲突,显式禁用)
 */

import type { ModuleId, SlotId } from '@/types/layout';

// ============================================================
// Drag/Drop payload 类型
// ============================================================
export type DragData =
  | { type: 'activity-bar'; moduleId: ModuleId }
  | { type: 'tab'; slotId: SlotId; moduleId: ModuleId };

export type DropData = { type: 'slot'; slotId: SlotId };

// ============================================================
// ID 编解码
// ============================================================
export const activityBarDraggableId = (moduleId: ModuleId): string =>
  `activity-bar:${moduleId}`;

export const tabDraggableId = (slotId: SlotId, moduleId: ModuleId): string =>
  `tab:${slotId}:${moduleId}`;

export const slotDroppableId = (slotId: SlotId): string => `slot:${slotId}`;

// ============================================================
// 类型守卫
// ============================================================
export function isDragData(value: unknown): value is DragData {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.type === 'activity-bar') return typeof v.moduleId === 'string';
  if (v.type === 'tab')
    return typeof v.moduleId === 'string' && typeof v.slotId === 'string';
  return false;
}

export function isDropData(value: unknown): value is DropData {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.type === 'slot' && typeof v.slotId === 'string';
}

// ============================================================
// handleDragEnd: 纯函数, 根据 active/over 决定调用哪个 store action
// ============================================================
export interface LayoutDndStoreActions {
  addModuleToSlot: (moduleId: ModuleId, slot: SlotId, index?: number) => void;
  moveModule: (moduleId: ModuleId, from: SlotId, to: SlotId, index?: number) => void;
  reorderModuleInSlot: (slot: SlotId, fromIndex: number, toIndex: number) => void;
  setSlotActive: (slot: SlotId, moduleId: ModuleId | null) => void;
}

export interface LayoutSlotsSnapshot {
  [key: string]: { modules: ModuleId[] };
}

export interface DragEndArgs {
  /** active.id 与 data,在 @dnd-kit 的 DragEndEvent 中位于 event.active */
  active: { id: string; data: unknown };
  /** over.id 与 data;为 null 表示未落到合法 drop zone */
  over: { id: string; data: unknown } | null;
  /** 拖拽前的 slots 快照,用于查 fromIndex/toIndex */
  slots: LayoutSlotsSnapshot;
  actions: LayoutDndStoreActions;
  /**
   * 可选: 校验模块是否允许进入目标槽位 (基于 PluginViewContribution.allowedSlots)。
   * 未提供时不做约束 (回退到旧行为)。
   * 返回 false 时 handleLayoutDragEnd 跳过所有 action,返回 'rejected'。
   */
  isSlotAllowed?: (moduleId: ModuleId, slot: SlotId) => boolean;
  /**
   * 可选: 查询模块是否为 bareRender (自带容器结构, 独占其所在 slot).
   * 用于强制"bareRender 模块与其他模块互斥共存"的不变量:
   *   - bareRender 模块不能加入到已有其他模块的 slot
   *   - 任何模块不能加入到已有 bareRender 模块的 slot
   * 未提供时不做约束.
   */
  isModuleBareRender?: (moduleId: ModuleId) => boolean;
}

/**
 * 解析拖拽结束事件并触发对应的 store 变更.
 * 返回值用于调用方做反馈 (toast/动效):
 *   - 'add'      : 模块从无到有加入了某个 slot
 *   - 'move'     : 模块从一个 slot 迁到另一个
 *   - 'reorder'  : 同 slot 内 tab 重排
 *   - 'rejected' : 因 allowedSlots 约束被拒绝 (用户可见 toast)
 *   - 'noop'     : 无效拖拽 (over=null, 同位置, 数据格式错等)
 */
export function handleLayoutDragEnd(args: DragEndArgs): 'add' | 'move' | 'reorder' | 'rejected' | 'noop' {
  const { active, over, slots, actions, isSlotAllowed, isModuleBareRender } = args;
  if (!over) return 'noop';
  const dragData = active.data;
  const dropData = over.data;
  if (!isDragData(dragData)) return 'noop';

  // 内部辅助: 检查目标 slot 是否允许该模块,统一处理 rejected
  const checkAllowed = (moduleId: ModuleId, targetSlot: SlotId): boolean => {
    if (!isSlotAllowed) return true;
    return isSlotAllowed(moduleId, targetSlot);
  };

  /**
   * 检查 bareRender 模块的独占语义:
   * - 若 module 是 bareRender,目标 slot 不能有其他模块 (但可以有 module 自己,表示同槽位)
   * - 若 module 不是 bareRender,目标 slot 不能有 bareRender 模块
   * 同槽位 (currentSlot === targetSlot) 时无需检查 (移动到自己原本所在 slot).
   */
  const checkBareRender = (moduleId: ModuleId, targetSlot: SlotId): boolean => {
    if (!isModuleBareRender) return true;
    const targetSlotState = slots[targetSlot];
    if (!targetSlotState) return true;
    const otherModules = targetSlotState.modules.filter((m) => m !== moduleId);
    if (otherModules.length === 0) return true;
    const draggingIsBare = isModuleBareRender(moduleId);
    const targetHasBare = otherModules.some((m) => isModuleBareRender(m));
    if (draggingIsBare) return false; // bareRender 模块拒绝与其他模块共存
    if (targetHasBare) return false; // 普通模块拒绝加入 bareRender 占据的 slot
    return true;
  };

  // === A) ActivityBar → slot / tab ===
  // 语义: 模块当前已在某槽位 → 移动到目标; 未在任何槽位 → 新增到目标
  // 这保证了"每个 moduleId 最多出现在一个 slot 中"不变量
  if (dragData.type === 'activity-bar') {
    const moduleId = dragData.moduleId;
    const currentSlot = findCurrentSlot(slots, moduleId);

    // 落在具体 tab 上
    const overTab = parseTabId(over.id);
    if (overTab) {
      const targetSlot = overTab.slotId;
      const targetSlotState = slots[targetSlot];
      if (!targetSlotState) return 'noop';
      const insertAt = targetSlotState.modules.indexOf(overTab.moduleId);
      const safeIndex = insertAt < 0 ? undefined : insertAt;

      if (currentSlot === targetSlot) {
        // 同槽位内,仅激活 — 不检查 allowedSlots (模块已经在这里了)
        actions.setSlotActive(targetSlot, moduleId);
        return 'noop';
      }
      // 跨槽位: 检查目标 slot 是否允许该模块
      if (!checkAllowed(moduleId, targetSlot)) return 'rejected';
      if (!checkBareRender(moduleId, targetSlot)) return 'rejected';
      if (currentSlot) {
        actions.moveModule(moduleId, currentSlot, targetSlot, safeIndex);
        actions.setSlotActive(targetSlot, moduleId);
        return 'move';
      }
      actions.addModuleToSlot(moduleId, targetSlot, safeIndex);
      actions.setSlotActive(targetSlot, moduleId);
      return 'add';
    }

    // 落在 slot 容器上
    if (!isDropData(dropData)) return 'noop';
    const targetSlot = dropData.slotId;
    const targetSlotState = slots[targetSlot];
    if (!targetSlotState) return 'noop';

    if (currentSlot === targetSlot) {
      actions.setSlotActive(targetSlot, moduleId);
      return 'noop';
    }
    if (!checkAllowed(moduleId, targetSlot)) return 'rejected';
    if (!checkBareRender(moduleId, targetSlot)) return 'rejected';
    if (currentSlot) {
      actions.moveModule(moduleId, currentSlot, targetSlot);
      actions.setSlotActive(targetSlot, moduleId);
      return 'move';
    }
    actions.addModuleToSlot(moduleId, targetSlot);
    actions.setSlotActive(targetSlot, moduleId);
    return 'add';
  }

  // === B / C) Tab 拖动 ===
  if (dragData.type === 'tab') {
    const fromSlot = dragData.slotId;
    const moduleId = dragData.moduleId;
    const fromSlotState = slots[fromSlot];
    if (!fromSlotState) return 'noop';
    const fromIndex = fromSlotState.modules.indexOf(moduleId);
    if (fromIndex < 0) return 'noop';

    // B.2) Tab 落到另一个 Tab 上 (精确插入位置)
    const overTab = parseTabId(over.id);
    if (overTab) {
      const toSlot = overTab.slotId;
      const toSlotState = slots[toSlot];
      if (!toSlotState) return 'noop';

      if (fromSlot === toSlot) {
        // C) 同 slot 重排 — 模块已经在 slot 里,不需要检查 allowedSlots
        if (overTab.moduleId === moduleId) return 'noop';
        const toIndex = toSlotState.modules.indexOf(overTab.moduleId);
        if (toIndex < 0 || toIndex === fromIndex) return 'noop';
        actions.reorderModuleInSlot(fromSlot, fromIndex, toIndex);
        return 'reorder';
      }
      // B) 跨 slot,插到 overTab 之前的位置 — 检查目标 slot 允许性
      if (toSlotState.modules.includes(moduleId)) return 'noop';
      if (!checkAllowed(moduleId, toSlot)) return 'rejected';
      if (!checkBareRender(moduleId, toSlot)) return 'rejected';
      const toIndex = toSlotState.modules.indexOf(overTab.moduleId);
      actions.moveModule(moduleId, fromSlot, toSlot, toIndex < 0 ? undefined : toIndex);
      actions.setSlotActive(toSlot, moduleId);
      return 'move';
    }

    // B.1) Tab 落到 slot 容器 (无具体 tab 目标)
    if (isDropData(dropData)) {
      const toSlot = dropData.slotId;
      if (toSlot === fromSlot) return 'noop'; // 同 slot 容器,无 tab 目标 → 不动
      const toSlotState = slots[toSlot];
      if (!toSlotState || toSlotState.modules.includes(moduleId)) return 'noop';
      if (!checkAllowed(moduleId, toSlot)) return 'rejected';
      if (!checkBareRender(moduleId, toSlot)) return 'rejected';
      actions.moveModule(moduleId, fromSlot, toSlot);
      actions.setSlotActive(toSlot, moduleId);
      return 'move';
    }
  }

  return 'noop';
}

/** 解析 tab:<slotId>:<moduleId> 为 {slotId, moduleId},失败返回 null */
function parseTabId(id: string): { slotId: SlotId; moduleId: ModuleId } | null {
  if (typeof id !== 'string' || !id.startsWith('tab:')) return null;
  const rest = id.slice('tab:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  return {
    slotId: rest.slice(0, sep) as SlotId,
    moduleId: rest.slice(sep + 1) as ModuleId,
  };
}

/** 查找模块当前所在的 slot;不在任何 slot 时返回 null */
function findCurrentSlot(slots: LayoutSlotsSnapshot, moduleId: ModuleId): SlotId | null {
  for (const slotId of ['left', 'right', 'center', 'bottom'] as const) {
    if (slots[slotId]?.modules.includes(moduleId)) return slotId;
  }
  return null;
}
