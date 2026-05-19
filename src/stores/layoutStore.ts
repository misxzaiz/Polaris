/**
 * 布局自定义系统状态管理
 *
 * 维护 4 个槽位 (left/right/center/bottom) 的模块绑定 + ActivityBar 位置 +
 * 自定义布局集合。提供 activateModule 等通用 API 替代旧的 setLeftPanelType。
 *
 * @see src/types/layout.ts 类型定义
 * @see src/config/layoutPresets.ts 内置预设
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  ActivityBarPosition,
  CustomLayout,
  LayoutAppearance,
  LayoutExportPayload,
  LayoutSnapshot,
  ModuleId,
  SlotId,
  SlotState,
} from '@/types/layout';
import { APPEARANCE_LIMITS, DEFAULT_APPEARANCE } from '@/types/layout';
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  DEFAULT_PRESET_ID,
  getBuiltinPreset,
} from '@/config/layoutPresets';

const SLOT_IDS: readonly SlotId[] = ['left', 'right', 'center', 'bottom'];
const ACTIVITY_BAR_POSITIONS: readonly ActivityBarPosition[] = ['left', 'right', 'hidden'];

const SLOT_MIN_SIZE_HORIZONTAL = 200;
const SLOT_MIN_SIZE_VERTICAL = 120;
const SLOT_MAX_SIZE_HORIZONTAL = 1200;
const SLOT_MAX_SIZE_VERTICAL = 800;

/** 当用户修改后布局已与任何预设不一致时使用 */
export const CUSTOM_PRESET_ID = 'custom';

interface LayoutState {
  slots: Record<SlotId, SlotState>;
  activityBarPosition: ActivityBarPosition;
  /** 内置预设 id、自定义布局 id,或 'custom' (已与任何预设不一致) */
  activePresetId: string;
  customLayouts: CustomLayout[];
  /**
   * 已"见过"的 module id 列表 (持久化).
   * 用于 applyPluginDefaultSlots: 只在某个 module 第一次出现时,
   * 才依据 contribution.defaultSlot 自动安置到布局中.
   * 后续即使用户主动把 module 从全部 slot 移除, 也不会被再次塞回去.
   */
  seenModules: ModuleId[];
  /**
   * V2: 外观配置 (padding/gap/radius/density/动效/Dock 模式).
   * 与槽位布局正交,独立持久化,不参与 LayoutSnapshot.
   */
  appearance: LayoutAppearance;
}

interface LayoutActions {
  // === 槽位级别 ===
  setSlotActive: (slot: SlotId, moduleId: ModuleId | null) => void;
  /** 折叠/展开槽位; 展开时若 activeModule 为空则用 modules[0] */
  toggleSlot: (slot: SlotId) => void;
  setSlotSize: (slot: SlotId, size: number) => void;

  // === 模块级别 ===
  addModuleToSlot: (moduleId: ModuleId, slot: SlotId, index?: number) => void;
  removeModuleFromSlot: (moduleId: ModuleId, slot: SlotId) => void;
  moveModule: (moduleId: ModuleId, from: SlotId, to: SlotId, index?: number) => void;
  reorderModuleInSlot: (slot: SlotId, fromIndex: number, toIndex: number) => void;

  // === 通用激活 API (供外部代码使用) ===
  /** 找到模块所在 slot,设为 active 且确保 slot 展开 */
  activateModule: (moduleId: ModuleId) => void;
  /**
   * 切换模块可见性: 模块当前激活则折叠所在槽位 (或切到该槽位的下一个模块),
   * 模块当前不激活则激活它 (从而展开槽位)。
   */
  toggleModule: (moduleId: ModuleId) => void;
  isModuleActive: (moduleId: ModuleId) => boolean;
  findModuleSlot: (moduleId: ModuleId) => SlotId | null;

  // === ActivityBar ===
  setActivityBarPosition: (pos: ActivityBarPosition) => void;

  // === 预设 / 自定义布局 ===
  applyPreset: (presetId: string) => void;
  saveAsCustomLayout: (name: string) => string;
  deleteCustomLayout: (id: string) => void;
  renameCustomLayout: (id: string, name: string) => void;
  /**
   * 导出布局为 JSON 字符串.
   * - 'snapshot' (默认): 只导出当前布局 (layout 字段), customLayouts 设为空数组.
   *   适合分享单个布局,不泄露用户其他自定义布局.
   * - 'all': 导出当前布局 + 全部自定义布局,适合备份/迁移.
   */
  exportLayout: (mode?: 'snapshot' | 'all') => string;
  /**
   * 导入布局 JSON.
   * - 'merge' (默认): 当前布局被 imported.layout 替换, customLayouts 按 id 合并 (已存在 id 跳过).
   * - 'replace': 当前布局 + customLayouts 全部用 imported 替换 (旧 customLayouts 丢失, 不可恢复).
   */
  importLayout: (json: string, mode?: 'merge' | 'replace') => void;
  resetToDefault: () => void;

  /**
   * 应用插件 contribution 的 defaultSlot / preferredSize:
   * 仅对 "首次见到" 的 moduleId 生效 (基于 seenModules 集合判断).
   * 用法: 在 App 启动或插件 (un)install 后调用一次,把新插件挂到 manifest 指定的 slot.
   *
   * @param contributions 待评估的 PluginViewContribution 列表 (来自 pluginRegistry).
   * @returns 实际安置过的 moduleId 列表 (便于调用方做日志/toast).
   */
  applyPluginDefaultSlots: (
    contributions: ReadonlyArray<{
      moduleId: ModuleId
      defaultSlot?: SlotId
      preferredSize?: number
    }>
  ) => ModuleId[];

  // === V2: 外观 ===
  /** 部分更新外观字段, 自动 clamp 数值到合法范围 */
  setAppearance: (patch: Partial<LayoutAppearance>) => void;
  /** 重置外观为默认值 */
  resetAppearance: () => void;
}

export type LayoutStore = LayoutState & LayoutActions;

// ============================================================
// 纯函数辅助 (便于测试和复用)
// ============================================================

/**
 * 白名单深拷贝: 仅复制已知的 4 个槽位与 modules 数组,
 * 任何额外的 slot key (如 'floating') 会被自然丢弃。
 */
function cloneSnapshot(snapshot: LayoutSnapshot): LayoutSnapshot {
  return {
    slots: {
      left: { ...snapshot.slots.left, modules: [...snapshot.slots.left.modules] },
      right: { ...snapshot.slots.right, modules: [...snapshot.slots.right.modules] },
      center: { ...snapshot.slots.center, modules: [...snapshot.slots.center.modules] },
      bottom: { ...snapshot.slots.bottom, modules: [...snapshot.slots.bottom.modules] },
    },
    activityBarPosition: snapshot.activityBarPosition,
  };
}

function clampSize(slot: SlotId, size: number): number {
  if (slot === 'center') return 0;
  if (slot === 'bottom') {
    return Math.max(SLOT_MIN_SIZE_VERTICAL, Math.min(SLOT_MAX_SIZE_VERTICAL, size));
  }
  return Math.max(SLOT_MIN_SIZE_HORIZONTAL, Math.min(SLOT_MAX_SIZE_HORIZONTAL, size));
}

/**
 * 仅当槽位有可见内容 (activeModule !== null) 时,把 size 钳制到合法范围.
 * 折叠槽位 (activeModule=null) 保留原 size 作为"恢复时的记忆值",
 * 即使是 0 也无害,因为 SlotPanel 在折叠态不渲染.
 *
 * 这是 applyPreset 的防御层: 避免预设里 size=0 但 activeModule≠null 时
 * 渲染出 width:0px 的不可见 SlotPanel.
 */
function clampActiveSlotSize(slot: Exclude<SlotId, 'center'>, state: SlotState): SlotState {
  if (state.activeModule === null) return state;
  const clamped = clampSize(slot, state.size);
  if (clamped === state.size) return state;
  return { ...state, size: clamped };
}

function generateLayoutId(): string {
  return `layout-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * V2: 把 appearance 字段 clamp 到合法范围.
 * - 数值字段走 APPEARANCE_LIMITS
 * - 枚举字段未通过白名单 → 回退到默认值
 */
function sanitizeAppearance(input: unknown): LayoutAppearance {
  const out: LayoutAppearance = { ...DEFAULT_APPEARANCE };
  if (!input || typeof input !== 'object') return out;
  const v = input as Record<string, unknown>;
  if (typeof v.appPadding === 'number' && Number.isFinite(v.appPadding)) {
    out.appPadding = Math.max(
      APPEARANCE_LIMITS.appPadding.min,
      Math.min(APPEARANCE_LIMITS.appPadding.max, Math.round(v.appPadding))
    );
  }
  if (typeof v.slotGap === 'number' && Number.isFinite(v.slotGap)) {
    out.slotGap = Math.max(
      APPEARANCE_LIMITS.slotGap.min,
      Math.min(APPEARANCE_LIMITS.slotGap.max, Math.round(v.slotGap))
    );
  }
  if (typeof v.slotRadius === 'number' && Number.isFinite(v.slotRadius)) {
    out.slotRadius = Math.max(
      APPEARANCE_LIMITS.slotRadius.min,
      Math.min(APPEARANCE_LIMITS.slotRadius.max, Math.round(v.slotRadius))
    );
  }
  if (v.density === 'compact' || v.density === 'standard' || v.density === 'spacious') {
    out.density = v.density;
  }
  if (
    v.transitionLevel === 'off' ||
    v.transitionLevel === 'minimal' ||
    v.transitionLevel === 'standard' ||
    v.transitionLevel === 'lively'
  ) {
    out.transitionLevel = v.transitionLevel;
  }
  if (v.dockMode === 'expanded' || v.dockMode === 'compact' || v.dockMode === 'floating') {
    out.dockMode = v.dockMode;
  }
  return out;
}

function findSlotContaining(
  slots: Record<SlotId, SlotState>,
  moduleId: ModuleId
): SlotId | null {
  for (const slotId of SLOT_IDS) {
    if (slots[slotId].modules.includes(moduleId)) return slotId;
  }
  return null;
}

function isValidSlotState(value: unknown): value is SlotState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.modules) &&
    v.modules.every((m) => typeof m === 'string') &&
    (v.activeModule === null || typeof v.activeModule === 'string') &&
    typeof v.size === 'number'
  );
}

function isValidSnapshot(value: unknown): value is LayoutSnapshot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!v.slots || typeof v.slots !== 'object') return false;
  const slots = v.slots as Record<string, unknown>;
  for (const id of SLOT_IDS) {
    if (!isValidSlotState(slots[id])) return false;
  }
  return (
    typeof v.activityBarPosition === 'string' &&
    ACTIVITY_BAR_POSITIONS.includes(v.activityBarPosition as ActivityBarPosition)
  );
}

// ============================================================
// Store
// ============================================================

const initial = cloneSnapshot(DEFAULT_LAYOUT_SNAPSHOT);

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set, get) => ({
      slots: initial.slots,
      activityBarPosition: initial.activityBarPosition,
      activePresetId: DEFAULT_PRESET_ID,
      customLayouts: [],
      seenModules: [],
      appearance: { ...DEFAULT_APPEARANCE },

      setSlotActive: (slot, moduleId) =>
        set((state) => {
          const slotState = state.slots[slot]
          // Early return: 已是 active 且模块已存在 → no-op,避免误标 'custom'
          if (
            slotState.activeModule === moduleId &&
            (moduleId === null || slotState.modules.includes(moduleId))
          ) {
            return state
          }
          // 不变量保护: 如果 moduleId 不在该 slot 但在其他 slot,
          // 先从原 slot 移除再加入目标 slot,避免模块同时出现在多个 slot.
          let nextSlots = state.slots
          if (moduleId && !slotState.modules.includes(moduleId)) {
            const currentSlot = findSlotContaining(state.slots, moduleId)
            if (currentSlot && currentSlot !== slot) {
              const fromSlotState = state.slots[currentSlot]
              const fromNext = fromSlotState.modules.filter((m) => m !== moduleId)
              const newFromActive =
                fromSlotState.activeModule === moduleId
                  ? fromNext[0] ?? null
                  : fromSlotState.activeModule
              nextSlots = {
                ...state.slots,
                [currentSlot]: {
                  ...fromSlotState,
                  modules: fromNext,
                  activeModule: newFromActive,
                },
              }
            }
          }
          const targetSlotState = nextSlots[slot]
          const nextModules =
            moduleId && !targetSlotState.modules.includes(moduleId)
              ? [...targetSlotState.modules, moduleId]
              : targetSlotState.modules
          return {
            slots: {
              ...nextSlots,
              [slot]: { ...targetSlotState, modules: nextModules, activeModule: moduleId },
            },
            activePresetId: CUSTOM_PRESET_ID,
          }
        }),

      toggleSlot: (slot) =>
        set((state) => {
          const slotState = state.slots[slot];
          const willCollapse = slotState.activeModule !== null;
          const nextActive = willCollapse ? null : slotState.modules[0] ?? null;
          return {
            slots: {
              ...state.slots,
              [slot]: { ...slotState, activeModule: nextActive },
            },
            activePresetId: CUSTOM_PRESET_ID,
          };
        }),

      setSlotSize: (slot, size) =>
        set((state) => ({
          slots: {
            ...state.slots,
            [slot]: { ...state.slots[slot], size: clampSize(slot, size) },
          },
        })),

      addModuleToSlot: (moduleId, slot, index) =>
        set((state) => {
          const slotState = state.slots[slot];
          if (slotState.modules.includes(moduleId)) return state;
          const next = [...slotState.modules];
          const insertAt = typeof index === 'number' ? Math.max(0, Math.min(index, next.length)) : next.length;
          next.splice(insertAt, 0, moduleId);
          return {
            slots: {
              ...state.slots,
              [slot]: {
                ...slotState,
                modules: next,
                activeModule: slotState.activeModule ?? moduleId,
              },
            },
            activePresetId: CUSTOM_PRESET_ID,
          };
        }),

      removeModuleFromSlot: (moduleId, slot) =>
        set((state) => {
          const slotState = state.slots[slot];
          if (!slotState.modules.includes(moduleId)) return state;
          const nextModules = slotState.modules.filter((m) => m !== moduleId);
          const nextActive =
            slotState.activeModule === moduleId
              ? nextModules[0] ?? null
              : slotState.activeModule;
          return {
            slots: {
              ...state.slots,
              [slot]: { ...slotState, modules: nextModules, activeModule: nextActive },
            },
            activePresetId: CUSTOM_PRESET_ID,
          };
        }),

      moveModule: (moduleId, from, to, index) =>
        set((state) => {
          if (from === to) {
            // 同槽位重排
            const slotState = state.slots[from];
            const fromIndex = slotState.modules.indexOf(moduleId);
            if (fromIndex < 0) return state;
            const next = [...slotState.modules];
            const [item] = next.splice(fromIndex, 1);
            const insertAt = typeof index === 'number' ? Math.max(0, Math.min(index, next.length)) : next.length;
            next.splice(insertAt, 0, item);
            return {
              slots: {
                ...state.slots,
                [from]: { ...slotState, modules: next },
              },
              activePresetId: CUSTOM_PRESET_ID,
            };
          }
          const fromState = state.slots[from];
          const toState = state.slots[to];
          if (!fromState.modules.includes(moduleId)) return state;
          if (toState.modules.includes(moduleId)) return state;
          const fromNext = fromState.modules.filter((m) => m !== moduleId);
          const toNext = [...toState.modules];
          const insertAt = typeof index === 'number' ? Math.max(0, Math.min(index, toNext.length)) : toNext.length;
          toNext.splice(insertAt, 0, moduleId);
          return {
            slots: {
              ...state.slots,
              [from]: {
                ...fromState,
                modules: fromNext,
                activeModule:
                  fromState.activeModule === moduleId ? fromNext[0] ?? null : fromState.activeModule,
              },
              [to]: {
                ...toState,
                modules: toNext,
                activeModule: toState.activeModule ?? moduleId,
              },
            },
            activePresetId: CUSTOM_PRESET_ID,
          };
        }),

      reorderModuleInSlot: (slot, fromIndex, toIndex) =>
        set((state) => {
          const slotState = state.slots[slot];
          if (slotState.modules.length === 0) return state;
          if (
            fromIndex < 0 ||
            fromIndex >= slotState.modules.length ||
            toIndex < 0 ||
            toIndex >= slotState.modules.length ||
            fromIndex === toIndex
          ) {
            return state;
          }
          const next = [...slotState.modules];
          const [item] = next.splice(fromIndex, 1);
          next.splice(toIndex, 0, item);
          return {
            slots: {
              ...state.slots,
              [slot]: { ...slotState, modules: next },
            },
            activePresetId: CUSTOM_PRESET_ID,
          };
        }),

      activateModule: (moduleId) => {
        const state = get()
        const slot = findSlotContaining(state.slots, moduleId)
        if (!slot) return
        const slotState = state.slots[slot]
        // 已是 active 则无操作
        if (slotState.activeModule === moduleId) return
        set({
          slots: {
            ...state.slots,
            [slot]: { ...slotState, activeModule: moduleId },
          },
          activePresetId: CUSTOM_PRESET_ID,
        })
      },

      toggleModule: (moduleId) => {
        const state = get()
        const slot = findSlotContaining(state.slots, moduleId)
        if (!slot) return
        const slotState = state.slots[slot]
        // 当前 active: 折叠槽位 (置 null)
        if (slotState.activeModule === moduleId) {
          set({
            slots: {
              ...state.slots,
              [slot]: { ...slotState, activeModule: null },
            },
            activePresetId: CUSTOM_PRESET_ID,
          })
          return
        }
        // 当前未 active: 激活该模块 (自动展开槽位)
        set({
          slots: {
            ...state.slots,
            [slot]: { ...slotState, activeModule: moduleId },
          },
          activePresetId: CUSTOM_PRESET_ID,
        })
      },

      isModuleActive: (moduleId) => {
        const { slots } = get();
        return SLOT_IDS.some((id) => slots[id].activeModule === moduleId);
      },

      findModuleSlot: (moduleId) => findSlotContaining(get().slots, moduleId),

      setActivityBarPosition: (pos) =>
        set({ activityBarPosition: pos, activePresetId: CUSTOM_PRESET_ID }),

      applyPreset: (presetId) => {
        const builtin = getBuiltinPreset(presetId);
        const custom = builtin ? null : get().customLayouts.find((l) => l.id === presetId);
        const snapshot: LayoutSnapshot | null = builtin
          ? { slots: builtin.slots, activityBarPosition: builtin.activityBarPosition }
          : custom
            ? { slots: custom.slots, activityBarPosition: custom.activityBarPosition }
            : null;
        if (!snapshot) return;
        const cloned = cloneSnapshot(snapshot);
        // 防御性 clamp: 任何"slot 有 active 模块但 size=0/异常"的预设都强制取最小尺寸,
        // 避免 right.size=0 这类 bug 导致 SlotPanel 渲染出 width:0px 不可见容器
        // (历史回归: focus-writing/minimal-chat 曾因此空白). center 不受 size 约束,跳过.
        const clampedSlots: typeof cloned.slots = {
          left: clampActiveSlotSize('left', cloned.slots.left),
          right: clampActiveSlotSize('right', cloned.slots.right),
          center: cloned.slots.center,
          bottom: clampActiveSlotSize('bottom', cloned.slots.bottom),
        };
        set({
          slots: clampedSlots,
          activityBarPosition: cloned.activityBarPosition,
          activePresetId: presetId,
        });
      },

      saveAsCustomLayout: (name) => {
        const trimmed = name.trim();
        if (!trimmed) throw new Error('Layout name must not be empty');
        const id = generateLayoutId();
        const state = get();
        const snapshot = cloneSnapshot({
          slots: state.slots,
          activityBarPosition: state.activityBarPosition,
        });
        const layout: CustomLayout = {
          id,
          name: trimmed,
          slots: snapshot.slots,
          activityBarPosition: snapshot.activityBarPosition,
        };
        set({
          customLayouts: [...state.customLayouts, layout],
          activePresetId: id,
        });
        return id;
      },

      deleteCustomLayout: (id) =>
        set((state) => {
          const next = state.customLayouts.filter((l) => l.id !== id);
          // 删除当前激活的自定义布局 → 切回默认预设
          if (state.activePresetId === id) {
            const fallback = cloneSnapshot(DEFAULT_LAYOUT_SNAPSHOT);
            return {
              customLayouts: next,
              slots: fallback.slots,
              activityBarPosition: fallback.activityBarPosition,
              activePresetId: DEFAULT_PRESET_ID,
            };
          }
          return { customLayouts: next };
        }),

      renameCustomLayout: (id, name) =>
        set((state) => {
          const trimmed = name.trim();
          if (!trimmed) return state;
          return {
            customLayouts: state.customLayouts.map((l) =>
              l.id === id ? { ...l, name: trimmed } : l
            ),
          };
        }),

      exportLayout: (mode = 'snapshot') => {
        const state = get();
        const payload: LayoutExportPayload = {
          version: 2,
          layout: {
            slots: state.slots,
            activityBarPosition: state.activityBarPosition,
          },
          // 'snapshot' 模式: 只导出当前布局, 不泄露其他自定义布局
          // 'all' 模式: 导出当前 + 所有自定义布局 (用于备份/迁移)
          customLayouts: mode === 'all' ? state.customLayouts : [],
          activePresetId: state.activePresetId,
          // V2 新增: 外观配置. v1 导入侧会忽略此字段; v2 导入侧用其覆盖默认值.
          appearance: { ...state.appearance },
        };
        return JSON.stringify(payload, null, 2);
      },

      importLayout: (json, mode = 'merge') => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch (e) {
          throw new Error(`Invalid JSON: ${(e as Error).message}`);
        }
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Invalid layout payload');
        }
        const p = parsed as Record<string, unknown>;
        // 兼容 v1 与 v2: v1 没有 appearance 字段, 由默认值填充
        if (p.version !== 1 && p.version !== 2) {
          throw new Error(`Unsupported layout version: ${String(p.version)}`);
        }
        if (!isValidSnapshot(p.layout)) {
          throw new Error('Invalid layout snapshot');
        }
        const layout = cloneSnapshot(p.layout);
        const isCustomLayout = (item: unknown): item is CustomLayout => {
          if (!item || typeof item !== 'object') return false;
          const v = item as Record<string, unknown>;
          return (
            typeof v.id === 'string' &&
            typeof v.name === 'string' &&
            isValidSnapshot(v)
          );
        };
        const importedCustomLayouts: CustomLayout[] = Array.isArray(p.customLayouts)
          ? (p.customLayouts as unknown[])
              .filter(isCustomLayout)
              .map((l) => ({
                id: l.id,
                name: l.name,
                ...cloneSnapshot(l),
              }))
          : [];

        // 合并/覆盖语义:
        // - 'replace': 用 imported.customLayouts 完全替换 (旧的全丢)
        // - 'merge': 保留现有, 仅加入 id 不冲突的 imported 项 (默认, 安全)
        const existingCustomLayouts = get().customLayouts;
        const finalCustomLayouts: CustomLayout[] = mode === 'replace'
          ? importedCustomLayouts
          : [
              ...existingCustomLayouts,
              ...importedCustomLayouts.filter(
                (imp) => !existingCustomLayouts.some((cur) => cur.id === imp.id)
              ),
            ];

        // 严格校验 activePresetId: 必须指向 builtin 预设、existing custom 或 CUSTOM_PRESET_ID
        const rawPresetId =
          typeof p.activePresetId === 'string' ? p.activePresetId : DEFAULT_PRESET_ID;
        const isKnownPreset =
          rawPresetId === CUSTOM_PRESET_ID ||
          getBuiltinPreset(rawPresetId) !== undefined ||
          finalCustomLayouts.some((l) => l.id === rawPresetId);
        const activePresetId = isKnownPreset ? rawPresetId : DEFAULT_PRESET_ID;

        // V2: 外观配置导入策略
        // - 'replace' 模式: 用 imported.appearance 替换 (v1 → 默认值; v2 → sanitize)
        // - 'merge' 模式: 保留现有 appearance, 不覆盖
        // 这是有意的: 用户从他人布局 merge 时不应被对方的字号/动效偏好覆盖.
        const nextAppearance: LayoutAppearance =
          mode === 'replace'
            ? p.version === 2
              ? sanitizeAppearance(p.appearance)
              : { ...DEFAULT_APPEARANCE }
            : get().appearance;

        set({
          slots: layout.slots,
          activityBarPosition: layout.activityBarPosition,
          customLayouts: finalCustomLayouts,
          activePresetId,
          appearance: nextAppearance,
        });
      },

      resetToDefault: () => {
        const cloned = cloneSnapshot(DEFAULT_LAYOUT_SNAPSHOT);
        set({
          slots: cloned.slots,
          activityBarPosition: cloned.activityBarPosition,
          activePresetId: DEFAULT_PRESET_ID,
        });
      },

      applyPluginDefaultSlots: (contributions) => {
        const state = get();
        const placed: ModuleId[] = [];
        // 增量构建新状态;原数据不可变, 写回时一次性 set
        let nextSlots = state.slots;
        const nextSeen = new Set(state.seenModules);

        for (const c of contributions) {
          if (nextSeen.has(c.moduleId)) continue;
          nextSeen.add(c.moduleId);
          // 没有 defaultSlot 也要标 seen, 避免后续被反复扫描时认作 "新"
          if (!c.defaultSlot) continue;
          // 已在某个 slot 中: 不动 (尊重用户/预设安排), 仅标 seen
          if (findSlotContaining(nextSlots, c.moduleId)) continue;
          // center 不接受默认安置 (避免误踩到主舞台)
          if (c.defaultSlot === 'center') continue;
          // bareRender 模块 (如 chat) 与其他模块互斥, 这里通过简单检查跳过冲突 slot
          // (slot 已有模块 → 不强行插入, 留给用户拖拽决定)
          const targetSlot = nextSlots[c.defaultSlot];
          if (targetSlot.modules.length > 0) {
            // bareRender 由 contribution.bareRender 决定, 但本函数 contract 只接受
            // 必要字段以保持纯净. 简单策略: 目标 slot 已有模块时跳过.
            continue;
          }
          const nextModules = [...targetSlot.modules, c.moduleId];
          const preferredSize =
            typeof c.preferredSize === 'number' && Number.isFinite(c.preferredSize)
              ? clampSize(c.defaultSlot, c.preferredSize)
              : targetSlot.size;
          nextSlots = {
            ...nextSlots,
            [c.defaultSlot]: {
              modules: nextModules,
              activeModule: targetSlot.activeModule ?? c.moduleId,
              size: preferredSize,
            },
          };
          placed.push(c.moduleId);
        }

        if (placed.length === 0 && nextSeen.size === state.seenModules.length) {
          // 没有任何变化 (常见: 启动时所有 contribution 早已 seen)
          return placed;
        }
        set({
          slots: nextSlots,
          seenModules: Array.from(nextSeen),
          // 用户没有动手, 仅是首次安置插件 → 仍标 custom 是不公平的
          // 但若有 placed > 0, 说明布局事实上变了, 此处保留 activePresetId 不强标 custom,
          // 因为下次启动时 placed 一定为 0 (seen 已包含), 保持 activePresetId 稳定即可.
        });
        return placed;
      },

      // === V2: 外观 ===
      setAppearance: (patch) =>
        set((state) => ({
          appearance: sanitizeAppearance({ ...state.appearance, ...patch }),
        })),

      resetAppearance: () => set({ appearance: { ...DEFAULT_APPEARANCE } }),
    }),
    {
      name: 'layout-store',
      version: 2,
      // V1 → V2 迁移: 持久化中无 appearance 字段时填入默认值, 其他字段照旧.
      migrate: (persistedState: unknown, fromVersion: number) => {
        if (!persistedState || typeof persistedState !== 'object') return persistedState;
        const s = persistedState as Record<string, unknown>;
        if (fromVersion < 2) {
          return {
            ...s,
            appearance: { ...DEFAULT_APPEARANCE },
          };
        }
        return s;
      },
      // 只持久化布局相关字段,瞬时态(未来如 isDragging) 不持久化
      partialize: (state) => ({
        slots: state.slots,
        activityBarPosition: state.activityBarPosition,
        activePresetId: state.activePresetId,
        customLayouts: state.customLayouts,
        seenModules: state.seenModules,
        appearance: state.appearance,
      }),
    }
  )
);

// 暴露常量给消费方
export const LAYOUT_SLOT_IDS = SLOT_IDS;
export const LAYOUT_ACTIVITY_BAR_POSITIONS = ACTIVITY_BAR_POSITIONS;
