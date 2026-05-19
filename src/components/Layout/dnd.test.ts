/**
 * 布局拖拽工具测试
 *
 * 包含两类测试:
 * 1. 单元测试: 验证 handleLayoutDragEnd 在各种 active/over 组合下调用正确的 store action
 * 2. Property-based (fast-check): 模拟随机拖拽序列, 验证 layoutStore 不变量始终成立
 *    - 每个 ModuleId 最多在一个 slot 中
 *    - 每个 slot.activeModule ∈ slot.modules ∪ {null}
 *    - 槽位绑定列表无重复模块
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fc from 'fast-check'
import {
  handleLayoutDragEnd,
  activityBarDraggableId,
  tabDraggableId,
  slotDroppableId,
  isDragData,
  isDropData,
  type DragData,
  type DropData,
  type LayoutDndStoreActions,
} from './dnd'
import { useLayoutStore } from '@/stores/layoutStore'
import { DEFAULT_LAYOUT_SNAPSHOT, DEFAULT_PRESET_ID } from '@/config/layoutPresets'
import type { ModuleId, SlotId } from '@/types/layout'

const SLOT_IDS: SlotId[] = ['left', 'right', 'center', 'bottom']

function makeMockActions(): LayoutDndStoreActions & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    addModuleToSlot: vi.fn((m, s, i) => calls.push(`add:${m}->${s}@${i ?? '-'}`)),
    moveModule: vi.fn((m, f, t, i) => calls.push(`move:${m}:${f}->${t}@${i ?? '-'}`)),
    reorderModuleInSlot: vi.fn((s, f, t) => calls.push(`reorder:${s}:${f}->${t}`)),
    setSlotActive: vi.fn((s, m) => calls.push(`active:${s}=${m ?? 'null'}`)),
  } as unknown as LayoutDndStoreActions & { calls: string[] }
}

function resetStore() {
  useLayoutStore.setState({
    slots: structuredClone(DEFAULT_LAYOUT_SNAPSHOT.slots),
    activityBarPosition: DEFAULT_LAYOUT_SNAPSHOT.activityBarPosition,
    activePresetId: DEFAULT_PRESET_ID,
    customLayouts: [],
    seenModules: [],
  })
}

// ============================================================
// 类型守卫
// ============================================================
describe('isDragData / isDropData', () => {
  it('accepts well-formed DragData', () => {
    expect(isDragData({ type: 'activity-bar', moduleId: 'files' })).toBe(true)
    expect(isDragData({ type: 'tab', slotId: 'left', moduleId: 'files' })).toBe(true)
  })

  it('rejects malformed DragData', () => {
    expect(isDragData(null)).toBe(false)
    expect(isDragData({ type: 'unknown' })).toBe(false)
    expect(isDragData({ type: 'activity-bar' })).toBe(false)
    expect(isDragData({ type: 'tab', moduleId: 'files' })).toBe(false)
  })

  it('accepts well-formed DropData', () => {
    expect(isDropData({ type: 'slot', slotId: 'left' })).toBe(true)
  })

  it('rejects malformed DropData', () => {
    expect(isDropData(null)).toBe(false)
    expect(isDropData({ type: 'slot' })).toBe(false)
    expect(isDropData({ type: 'wrong', slotId: 'left' })).toBe(false)
  })
})

// ============================================================
// ID 编解码
// ============================================================
describe('id helpers', () => {
  it('encodes draggable / droppable ids', () => {
    expect(activityBarDraggableId('files')).toBe('activity-bar:files')
    expect(tabDraggableId('left', 'git')).toBe('tab:left:git')
    expect(slotDroppableId('bottom')).toBe('slot:bottom')
  })
})

// ============================================================
// handleLayoutDragEnd: 单元测试
// ============================================================
describe('handleLayoutDragEnd', () => {
  it('returns noop when over is null', () => {
    const actions = makeMockActions()
    const result = handleLayoutDragEnd({
      active: { id: 'tab:left:files', data: { type: 'tab', slotId: 'left', moduleId: 'files' } },
      over: null,
      slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
      actions,
    })
    expect(result).toBe('noop')
    expect(actions.calls).toEqual([])
  })

  it('returns noop when active data is malformed', () => {
    const actions = makeMockActions()
    const result = handleLayoutDragEnd({
      active: { id: 'whatever', data: { type: 'unknown' } },
      over: { id: 'slot:left', data: { type: 'slot', slotId: 'left' } },
      slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
      actions,
    })
    expect(result).toBe('noop')
    expect(actions.calls).toEqual([])
  })

  // A) ActivityBar → slot
  describe('A) ActivityBar drag to slot', () => {
    it('adds module to slot when not already there', () => {
      const actions = makeMockActions()
      const result = handleLayoutDragEnd({
        active: { id: 'activity-bar:todo', data: { type: 'activity-bar', moduleId: 'todo' } },
        over: { id: 'slot:left', data: { type: 'slot', slotId: 'left' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
      })
      expect(result).toBe('add')
      expect(actions.addModuleToSlot).toHaveBeenCalledWith('todo', 'left')
      expect(actions.setSlotActive).toHaveBeenCalledWith('left', 'todo')
    })

    it('activates instead of adding when module already in target slot', () => {
      const actions = makeMockActions()
      // developer 默认 left = ['files', 'git'], active = 'files'
      const result = handleLayoutDragEnd({
        active: { id: 'activity-bar:git', data: { type: 'activity-bar', moduleId: 'git' } },
        over: { id: 'slot:left', data: { type: 'slot', slotId: 'left' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
      })
      expect(result).toBe('noop')
      expect(actions.addModuleToSlot).not.toHaveBeenCalled()
      expect(actions.setSlotActive).toHaveBeenCalledWith('left', 'git')
    })

    it('drops onto a tab in target slot -> inserts at that position', () => {
      const actions = makeMockActions()
      // 拖 todo 到 left 槽位的 git tab 上 → 插在 git 位置
      const result = handleLayoutDragEnd({
        active: { id: 'activity-bar:todo', data: { type: 'activity-bar', moduleId: 'todo' } },
        over: { id: 'tab:left:git', data: { type: 'tab', slotId: 'left', moduleId: 'git' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
      })
      expect(result).toBe('add')
      expect(actions.addModuleToSlot).toHaveBeenCalledWith('todo', 'left', 1)
      expect(actions.setSlotActive).toHaveBeenCalledWith('left', 'todo')
    })

    it('moves module from existing slot when dragged to another slot container', () => {
      // 关键不变量测试: files 在 left, 从 ActivityBar 拖到 bottom 应该 move 而非 add
      const actions = makeMockActions()
      const result = handleLayoutDragEnd({
        active: { id: 'activity-bar:files', data: { type: 'activity-bar', moduleId: 'files' } },
        over: { id: 'slot:bottom', data: { type: 'slot', slotId: 'bottom' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
      })
      expect(result).toBe('move')
      expect(actions.moveModule).toHaveBeenCalledWith('files', 'left', 'bottom')
      expect(actions.addModuleToSlot).not.toHaveBeenCalled()
      expect(actions.setSlotActive).toHaveBeenCalledWith('bottom', 'files')
    })

    it('moves module from existing slot when dragged onto a tab in another slot', () => {
      const actions = makeMockActions()
      const result = handleLayoutDragEnd({
        active: { id: 'activity-bar:files', data: { type: 'activity-bar', moduleId: 'files' } },
        over: {
          id: 'tab:bottom:problems',
          data: { type: 'tab', slotId: 'bottom', moduleId: 'problems' },
        },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
      })
      expect(result).toBe('move')
      // problems 在 bottom 索引 1, 所以 insertAt = 1
      expect(actions.moveModule).toHaveBeenCalledWith('files', 'left', 'bottom', 1)
    })
  })

  // C) 同槽位重排
  describe('C) Tab reorder within same slot', () => {
    it('reorders when dropping on another tab in same slot', () => {
      const actions = makeMockActions()
      // 把 git 拖到 files 上 → reorder(left, 1, 0)
      const result = handleLayoutDragEnd({
        active: { id: 'tab:left:git', data: { type: 'tab', slotId: 'left', moduleId: 'git' } },
        over: { id: 'tab:left:files', data: { type: 'tab', slotId: 'left', moduleId: 'files' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
      })
      expect(result).toBe('reorder')
      expect(actions.reorderModuleInSlot).toHaveBeenCalledWith('left', 1, 0)
    })

    it('noop when dropping tab onto itself', () => {
      const actions = makeMockActions()
      const result = handleLayoutDragEnd({
        active: { id: 'tab:left:files', data: { type: 'tab', slotId: 'left', moduleId: 'files' } },
        over: { id: 'tab:left:files', data: { type: 'tab', slotId: 'left', moduleId: 'files' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
      })
      expect(result).toBe('noop')
      expect(actions.reorderModuleInSlot).not.toHaveBeenCalled()
    })
  })

  // B) 跨槽位移动
  describe('B) Tab move across slots', () => {
    it('moves when dropping on a tab in another slot', () => {
      const actions = makeMockActions()
      // 把 left.git 拖到 bottom.terminal 上
      const result = handleLayoutDragEnd({
        active: { id: 'tab:left:git', data: { type: 'tab', slotId: 'left', moduleId: 'git' } },
        over: {
          id: 'tab:bottom:terminal',
          data: { type: 'tab', slotId: 'bottom', moduleId: 'terminal' },
        },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
      })
      expect(result).toBe('move')
      expect(actions.moveModule).toHaveBeenCalledWith('git', 'left', 'bottom', 0)
      expect(actions.setSlotActive).toHaveBeenCalledWith('bottom', 'git')
    })

    it('moves when dropping on slot container (no specific tab)', () => {
      const actions = makeMockActions()
      const result = handleLayoutDragEnd({
        active: { id: 'tab:left:git', data: { type: 'tab', slotId: 'left', moduleId: 'git' } },
        over: { id: 'slot:bottom', data: { type: 'slot', slotId: 'bottom' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
      })
      expect(result).toBe('move')
      expect(actions.moveModule).toHaveBeenCalledWith('git', 'left', 'bottom')
    })

    it('noop when target slot already contains the module', () => {
      const actions = makeMockActions()
      // 已有 files 在 left, 试图从 (假装) right 移过来 (设个 mock slots)
      const slots = {
        left: { modules: ['files'] as ModuleId[] },
        right: { modules: ['files'] as ModuleId[] },
        center: { modules: [] as ModuleId[] },
        bottom: { modules: [] as ModuleId[] },
      }
      const result = handleLayoutDragEnd({
        active: {
          id: 'tab:right:files',
          data: { type: 'tab', slotId: 'right', moduleId: 'files' },
        },
        over: { id: 'slot:left', data: { type: 'slot', slotId: 'left' } },
        slots,
        actions,
      })
      expect(result).toBe('noop')
      expect(actions.moveModule).not.toHaveBeenCalled()
    })

    it('noop when dropping on the same slot container', () => {
      const actions = makeMockActions()
      const result = handleLayoutDragEnd({
        active: { id: 'tab:left:files', data: { type: 'tab', slotId: 'left', moduleId: 'files' } },
        over: { id: 'slot:left', data: { type: 'slot', slotId: 'left' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
      })
      expect(result).toBe('noop')
      expect(actions.moveModule).not.toHaveBeenCalled()
    })
  })

  // D) allowedSlots 硬约束 (F1 D2+B4)
  describe('D) allowedSlots硬约束', () => {
    it('rejects activity-bar drag to disallowed slot container', () => {
      const actions = makeMockActions()
      const result = handleLayoutDragEnd({
        active: { id: 'activity-bar:chat', data: { type: 'activity-bar', moduleId: 'chat' } },
        over: { id: 'slot:bottom', data: { type: 'slot', slotId: 'bottom' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
        // chat 仅允许 right / center
        isSlotAllowed: (m, s) => (m === 'chat' ? s === 'right' || s === 'center' : true),
      })
      expect(result).toBe('rejected')
      expect(actions.addModuleToSlot).not.toHaveBeenCalled()
      expect(actions.moveModule).not.toHaveBeenCalled()
      expect(actions.setSlotActive).not.toHaveBeenCalled()
    })

    it('rejects activity-bar drag to disallowed tab position', () => {
      const actions = makeMockActions()
      const result = handleLayoutDragEnd({
        active: { id: 'activity-bar:chat', data: { type: 'activity-bar', moduleId: 'chat' } },
        over: {
          id: 'tab:bottom:terminal',
          data: { type: 'tab', slotId: 'bottom', moduleId: 'terminal' },
        },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
        isSlotAllowed: (m, s) => (m === 'chat' ? s === 'right' : true),
      })
      expect(result).toBe('rejected')
    })

    it('rejects tab drag (B.2) to disallowed slot via tab target', () => {
      const actions = makeMockActions()
      const result = handleLayoutDragEnd({
        active: { id: 'tab:right:chat', data: { type: 'tab', slotId: 'right', moduleId: 'chat' } },
        over: {
          id: 'tab:bottom:terminal',
          data: { type: 'tab', slotId: 'bottom', moduleId: 'terminal' },
        },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
        isSlotAllowed: (m, s) => (m === 'chat' ? s === 'right' : true),
      })
      expect(result).toBe('rejected')
      expect(actions.moveModule).not.toHaveBeenCalled()
    })

    it('rejects tab drag (B.1) to disallowed slot container', () => {
      const actions = makeMockActions()
      const result = handleLayoutDragEnd({
        active: { id: 'tab:right:chat', data: { type: 'tab', slotId: 'right', moduleId: 'chat' } },
        over: { id: 'slot:bottom', data: { type: 'slot', slotId: 'bottom' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
        isSlotAllowed: (m, s) => (m === 'chat' ? s === 'right' : true),
      })
      expect(result).toBe('rejected')
    })

    it('allows when isSlotAllowed returns true', () => {
      const actions = makeMockActions()
      const result = handleLayoutDragEnd({
        active: { id: 'activity-bar:todo', data: { type: 'activity-bar', moduleId: 'todo' } },
        over: { id: 'slot:left', data: { type: 'slot', slotId: 'left' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
        isSlotAllowed: () => true,
      })
      expect(result).toBe('add')
      expect(actions.addModuleToSlot).toHaveBeenCalledWith('todo', 'left')
    })

    it('falls back to permissive when isSlotAllowed is undefined', () => {
      const actions = makeMockActions()
      const result = handleLayoutDragEnd({
        active: { id: 'activity-bar:todo', data: { type: 'activity-bar', moduleId: 'todo' } },
        over: { id: 'slot:bottom', data: { type: 'slot', slotId: 'bottom' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
        // 不提供 isSlotAllowed
      })
      expect(result).toBe('add')
    })

    it('reorder within same slot is NOT checked against allowedSlots (module already there)', () => {
      const actions = makeMockActions()
      // chat 不允许 left, 但已经在 left (假设的情景), 重排不应该被 reject
      const slots = {
        left: { modules: ['chat', 'todo'] as ModuleId[] },
        right: { modules: [] as ModuleId[] },
        center: { modules: [] as ModuleId[] },
        bottom: { modules: [] as ModuleId[] },
      }
      const result = handleLayoutDragEnd({
        active: { id: 'tab:left:chat', data: { type: 'tab', slotId: 'left', moduleId: 'chat' } },
        over: { id: 'tab:left:todo', data: { type: 'tab', slotId: 'left', moduleId: 'todo' } },
        slots,
        actions,
        isSlotAllowed: (m, s) => (m === 'chat' ? s === 'right' : true),
      })
      expect(result).toBe('reorder')
    })
  })

  // E) bareRender 独占语义 (F2 D1+B3)
  describe('E) bareRender 独占语义', () => {
    // 假定 chat 是 bareRender
    const bareCheck = (m: ModuleId) => m === 'chat'

    it('rejects bareRender module dragging into a slot with other modules', () => {
      const actions = makeMockActions()
      // 拖 chat 到 left (有 files, git)
      const result = handleLayoutDragEnd({
        active: { id: 'activity-bar:chat', data: { type: 'activity-bar', moduleId: 'chat' } },
        over: { id: 'slot:left', data: { type: 'slot', slotId: 'left' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
        isModuleBareRender: bareCheck,
      })
      expect(result).toBe('rejected')
      expect(actions.addModuleToSlot).not.toHaveBeenCalled()
      expect(actions.moveModule).not.toHaveBeenCalled()
    })

    it('rejects ordinary module dragging into a slot with a bareRender module', () => {
      const actions = makeMockActions()
      // 拖 todo 到 right (chat, bareRender)
      const result = handleLayoutDragEnd({
        active: { id: 'activity-bar:todo', data: { type: 'activity-bar', moduleId: 'todo' } },
        over: { id: 'slot:right', data: { type: 'slot', slotId: 'right' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
        isModuleBareRender: bareCheck,
      })
      expect(result).toBe('rejected')
    })

    it('rejects tab drag of ordinary module into a slot with a bareRender module', () => {
      const actions = makeMockActions()
      const result = handleLayoutDragEnd({
        active: { id: 'tab:left:files', data: { type: 'tab', slotId: 'left', moduleId: 'files' } },
        over: { id: 'slot:right', data: { type: 'slot', slotId: 'right' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
        isModuleBareRender: bareCheck,
      })
      expect(result).toBe('rejected')
    })

    it('allows bareRender module entering an empty slot', () => {
      const actions = makeMockActions()
      // chat 当前在 right; 假设拖到 center (空)
      const result = handleLayoutDragEnd({
        active: { id: 'tab:right:chat', data: { type: 'tab', slotId: 'right', moduleId: 'chat' } },
        over: { id: 'slot:center', data: { type: 'slot', slotId: 'center' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
        isModuleBareRender: bareCheck,
      })
      expect(result).toBe('move')
      expect(actions.moveModule).toHaveBeenCalledWith('chat', 'right', 'center')
    })

    it('falls back to permissive when isModuleBareRender is undefined', () => {
      const actions = makeMockActions()
      // translate 在 default snapshot 中未绑定任何 slot, 拖到 left 应该 add
      const result = handleLayoutDragEnd({
        active: { id: 'activity-bar:translate', data: { type: 'activity-bar', moduleId: 'translate' } },
        over: { id: 'slot:left', data: { type: 'slot', slotId: 'left' } },
        slots: DEFAULT_LAYOUT_SNAPSHOT.slots,
        actions,
        // 不提供 isModuleBareRender
      })
      // 不约束 bareRender 时,普通模块加入 (尽管 left 有 files+git)
      expect(result).toBe('add')
    })
  })
})

// ============================================================
// Property-based invariant 检查
// ============================================================
describe('handleLayoutDragEnd invariants (fast-check)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStore()
  })

  // 不变量校验函数
  function assertInvariants(label: string) {
    const state = useLayoutStore.getState()
    // 1) 每个 ModuleId 最多出现在一个 slot 中
    const seen = new Map<string, SlotId>()
    for (const slotId of SLOT_IDS) {
      const slot = state.slots[slotId]
      const set = new Set<string>()
      for (const m of slot.modules) {
        // a) 槽位内无重复
        expect(set.has(m), `${label} | slot=${slotId} duplicate module ${m}`).toBe(false)
        set.add(m)
        // b) 跨槽位唯一
        const other = seen.get(m)
        expect(
          other === undefined,
          `${label} | module ${m} appears in both ${other} and ${slotId}`
        ).toBe(true)
        seen.set(m, slotId)
      }
      // 2) activeModule ∈ modules ∪ {null}
      if (slot.activeModule !== null) {
        expect(
          slot.modules.includes(slot.activeModule),
          `${label} | slot=${slotId} activeModule ${slot.activeModule} not in modules ${JSON.stringify(slot.modules)}`
        ).toBe(true)
      }
    }
  }

  it('random drag sequences never violate invariants', () => {
    const moduleArb = fc.constantFrom<ModuleId>(
      'files',
      'git',
      'todo',
      'requirement',
      'scheduler',
      'longGoal',
      'terminal',
      'problems',
      'translate'
    )
    const slotArb = fc.constantFrom<Exclude<SlotId, 'center'>>('left', 'right', 'bottom')

    // 每个 op 描述一次拖拽
    const opArb = fc.oneof(
      // A) ActivityBar → slot container
      fc.record({
        kind: fc.constant('ab-to-slot' as const),
        module: moduleArb,
        target: slotArb,
      }),
      // A2) ActivityBar → tab (插在某个具体 tab 位置)
      fc.record({
        kind: fc.constant('ab-to-tab' as const),
        module: moduleArb,
        targetSlot: slotArb,
        targetIndex: fc.nat({ max: 3 }),
      }),
      // B) 同/跨 slot tab 拖动 → slot 容器
      fc.record({
        kind: fc.constant('tab-to-slot' as const),
        fromSlot: slotArb,
        fromIndex: fc.nat({ max: 3 }),
        toSlot: slotArb,
      }),
      // C) tab 拖到具体 tab 上
      fc.record({
        kind: fc.constant('tab-to-tab' as const),
        fromSlot: slotArb,
        fromIndex: fc.nat({ max: 3 }),
        toSlot: slotArb,
        toIndex: fc.nat({ max: 3 }),
      })
    )

    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 20 }), (ops) => {
        resetStore()
        const store = useLayoutStore.getState()
        const actions: LayoutDndStoreActions = {
          addModuleToSlot: store.addModuleToSlot,
          moveModule: store.moveModule,
          reorderModuleInSlot: store.reorderModuleInSlot,
          setSlotActive: store.setSlotActive,
        }

        for (const op of ops) {
          const slots = useLayoutStore.getState().slots
          if (op.kind === 'ab-to-slot') {
            handleLayoutDragEnd({
              active: {
                id: activityBarDraggableId(op.module),
                data: { type: 'activity-bar', moduleId: op.module } satisfies DragData,
              },
              over: {
                id: slotDroppableId(op.target),
                data: { type: 'slot', slotId: op.target } satisfies DropData,
              },
              slots,
              actions,
            })
          } else if (op.kind === 'ab-to-tab') {
            const targetModules = slots[op.targetSlot].modules
            if (targetModules.length === 0) continue
            const overModule = targetModules[op.targetIndex % targetModules.length]
            handleLayoutDragEnd({
              active: {
                id: activityBarDraggableId(op.module),
                data: { type: 'activity-bar', moduleId: op.module } satisfies DragData,
              },
              over: {
                id: tabDraggableId(op.targetSlot, overModule),
                data: {
                  type: 'tab',
                  slotId: op.targetSlot,
                  moduleId: overModule,
                } satisfies DragData,
              },
              slots,
              actions,
            })
          } else if (op.kind === 'tab-to-slot') {
            const sourceModules = slots[op.fromSlot].modules
            if (sourceModules.length === 0) continue
            const moduleId = sourceModules[op.fromIndex % sourceModules.length]
            handleLayoutDragEnd({
              active: {
                id: tabDraggableId(op.fromSlot, moduleId),
                data: { type: 'tab', slotId: op.fromSlot, moduleId } satisfies DragData,
              },
              over: {
                id: slotDroppableId(op.toSlot),
                data: { type: 'slot', slotId: op.toSlot } satisfies DropData,
              },
              slots,
              actions,
            })
          } else {
            // tab-to-tab
            const sourceModules = slots[op.fromSlot].modules
            const targetModules = slots[op.toSlot].modules
            if (sourceModules.length === 0 || targetModules.length === 0) continue
            const moduleId = sourceModules[op.fromIndex % sourceModules.length]
            const overModule = targetModules[op.toIndex % targetModules.length]
            handleLayoutDragEnd({
              active: {
                id: tabDraggableId(op.fromSlot, moduleId),
                data: { type: 'tab', slotId: op.fromSlot, moduleId } satisfies DragData,
              },
              over: {
                id: tabDraggableId(op.toSlot, overModule),
                data: {
                  type: 'tab',
                  slotId: op.toSlot,
                  moduleId: overModule,
                } satisfies DragData,
              },
              slots,
              actions,
            })
          }
          assertInvariants(`after op ${JSON.stringify(op)}`)
        }
      }),
      { numRuns: 100 }
    )
  })
})
