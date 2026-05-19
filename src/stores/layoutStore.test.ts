import { beforeEach, describe, expect, it } from 'vitest';
import { useLayoutStore } from './layoutStore';
import { BUILTIN_PRESETS, DEFAULT_LAYOUT_SNAPSHOT, DEFAULT_PRESET_ID } from '@/config/layoutPresets';
import type { LayoutSnapshot } from '@/types/layout';

function resetStore() {
  useLayoutStore.setState({
    slots: structuredClone(DEFAULT_LAYOUT_SNAPSHOT.slots),
    activityBarPosition: DEFAULT_LAYOUT_SNAPSHOT.activityBarPosition,
    activePresetId: DEFAULT_PRESET_ID,
    customLayouts: [],
    seenModules: [],
  });
}

describe('layoutStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  describe('default state', () => {
    it('initializes with developer preset snapshot', () => {
      const state = useLayoutStore.getState();
      expect(state.activePresetId).toBe('developer');
      expect(state.slots.left.modules).toEqual(['files', 'git']);
      expect(state.slots.left.activeModule).toBe('files');
      expect(state.slots.bottom.activeModule).toBe('terminal');
      expect(state.activityBarPosition).toBe('left');
      expect(state.customLayouts).toEqual([]);
    });
  });

  describe('applyPreset', () => {
    it('switches to focus-writing preset (chat in center, right empty)', () => {
      useLayoutStore.getState().applyPreset('focus-writing');
      const state = useLayoutStore.getState();
      expect(state.activePresetId).toBe('focus-writing');
      expect(state.slots.left.activeModule).toBeNull();
      expect(state.slots.center.modules).toEqual(['chat']);
      expect(state.slots.center.activeModule).toBe('chat');
      expect(state.slots.right.activeModule).toBeNull();
      expect(state.slots.bottom.activeModule).toBeNull();
      expect(state.activityBarPosition).toBe('hidden');
    });

    it('switches to minimal-chat preset (chat in center, right empty)', () => {
      useLayoutStore.getState().applyPreset('minimal-chat');
      const state = useLayoutStore.getState();
      expect(state.activePresetId).toBe('minimal-chat');
      expect(state.slots.center.modules).toEqual(['chat']);
      expect(state.slots.center.activeModule).toBe('chat');
      expect(state.slots.right.activeModule).toBeNull();
      expect(state.activityBarPosition).toBe('hidden');
    });

    it('switches to task-cockpit with center=chat', () => {
      useLayoutStore.getState().applyPreset('task-cockpit');
      const state = useLayoutStore.getState();
      expect(state.slots.center.modules).toEqual(['chat']);
      expect(state.slots.center.activeModule).toBe('chat');
      expect(state.slots.left.modules).toEqual(['todo', 'requirement']);
    });

    it('switches to panorama with all slots populated', () => {
      useLayoutStore.getState().applyPreset('panorama');
      const state = useLayoutStore.getState();
      expect(state.slots.left.modules.length).toBeGreaterThan(0);
      expect(state.slots.right.modules.length).toBeGreaterThan(0);
      expect(state.slots.bottom.modules.length).toBeGreaterThan(0);
    });

    it('ignores unknown preset id', () => {
      const before = useLayoutStore.getState().slots;
      useLayoutStore.getState().applyPreset('non-existent');
      expect(useLayoutStore.getState().slots).toBe(before);
    });

    it('clamps active slot size when preset has size=0 (defensive)', () => {
      // 直接注入一个"恶意"自定义布局: chat 在 right 且 size=0
      // 这种状态历史上会让 SlotPanel 渲染 width:0px 不可见,空白屏幕 bug
      useLayoutStore.setState({
        customLayouts: [
          {
            id: 'malicious',
            name: 'Malicious',
            slots: {
              left: { modules: [], activeModule: null, size: 0 },
              center: { modules: [], activeModule: null, size: 0 },
              right: { modules: ['chat'], activeModule: 'chat', size: 0 },
              bottom: { modules: [], activeModule: null, size: 0 },
            },
            activityBarPosition: 'hidden',
          },
        ],
      });
      useLayoutStore.getState().applyPreset('malicious');
      const state = useLayoutStore.getState();
      // right.size 被 clamp 到水平最小宽度 200, 而非保留为 0
      expect(state.slots.right.size).toBe(200);
      expect(state.slots.right.activeModule).toBe('chat');
      // 折叠槽位的 size=0 不动 (折叠态 SlotPanel 不渲染, 不影响)
      expect(state.slots.left.size).toBe(0);
    });

    it('clones snapshot so mutations on store do not leak into preset', () => {
      useLayoutStore.getState().applyPreset('developer');
      useLayoutStore.getState().addModuleToSlot('todo', 'left');
      // 再次切换不应残留
      useLayoutStore.getState().applyPreset('developer');
      const state = useLayoutStore.getState();
      expect(state.slots.left.modules).toEqual(['files', 'git']);
    });
  });

  describe('activateModule', () => {
    it('sets activeModule when module is bound in some slot', () => {
      useLayoutStore.getState().activateModule('git');
      expect(useLayoutStore.getState().slots.left.activeModule).toBe('git');
    });

    it('marks activePresetId as custom after manual activation', () => {
      useLayoutStore.getState().activateModule('git');
      expect(useLayoutStore.getState().activePresetId).toBe('custom');
    });

    it('no-ops when module is not bound anywhere', () => {
      const before = useLayoutStore.getState().slots;
      useLayoutStore.getState().activateModule('translate');
      expect(useLayoutStore.getState().slots).toEqual(before);
    });

    it('no-ops when module already active', () => {
      useLayoutStore.getState().activateModule('files');
      expect(useLayoutStore.getState().activePresetId).toBe('developer');
    });

    it('expands collapsed slot when activating its module', () => {
      // 先折叠 left 槽位
      useLayoutStore.getState().toggleSlot('left');
      expect(useLayoutStore.getState().slots.left.activeModule).toBeNull();
      // 激活 files 应展开槽位
      useLayoutStore.getState().activateModule('files');
      expect(useLayoutStore.getState().slots.left.activeModule).toBe('files');
    });
  });

  describe('toggleModule', () => {
    it('collapses slot when toggling the currently active module', () => {
      useLayoutStore.getState().toggleModule('chat');
      expect(useLayoutStore.getState().slots.right.activeModule).toBeNull();
    });

    it('activates module (and expands slot) when not active', () => {
      useLayoutStore.getState().toggleModule('chat'); // collapse
      useLayoutStore.getState().toggleModule('chat'); // re-activate
      expect(useLayoutStore.getState().slots.right.activeModule).toBe('chat');
    });

    it('activates a sibling module in the same slot when it is not active', () => {
      // git 在 left 槽位但未 active (files 是 active)
      useLayoutStore.getState().toggleModule('git');
      expect(useLayoutStore.getState().slots.left.activeModule).toBe('git');
    });

    it('no-ops when module is not bound anywhere', () => {
      const before = useLayoutStore.getState().slots;
      useLayoutStore.getState().toggleModule('translate');
      expect(useLayoutStore.getState().slots).toEqual(before);
    });

    it('marks activePresetId as custom', () => {
      useLayoutStore.getState().toggleModule('chat');
      expect(useLayoutStore.getState().activePresetId).toBe('custom');
    });
  });

  describe('isModuleActive / findModuleSlot', () => {
    it('isModuleActive reflects activeModule across slots', () => {
      expect(useLayoutStore.getState().isModuleActive('files')).toBe(true);
      expect(useLayoutStore.getState().isModuleActive('git')).toBe(false);
      expect(useLayoutStore.getState().isModuleActive('terminal')).toBe(true);
    });

    it('findModuleSlot returns slot containing the module', () => {
      expect(useLayoutStore.getState().findModuleSlot('files')).toBe('left');
      expect(useLayoutStore.getState().findModuleSlot('terminal')).toBe('bottom');
      expect(useLayoutStore.getState().findModuleSlot('chat')).toBe('right');
      expect(useLayoutStore.getState().findModuleSlot('translate')).toBeNull();
    });
  });

  describe('toggleSlot', () => {
    it('collapses slot when active', () => {
      useLayoutStore.getState().toggleSlot('left');
      expect(useLayoutStore.getState().slots.left.activeModule).toBeNull();
    });

    it('expands slot using first module when no active', () => {
      useLayoutStore.getState().toggleSlot('left'); // collapse
      useLayoutStore.getState().toggleSlot('left'); // expand
      expect(useLayoutStore.getState().slots.left.activeModule).toBe('files');
    });

    it('stays null when slot has no modules', () => {
      useLayoutStore.getState().applyPreset('focus-writing');
      useLayoutStore.getState().toggleSlot('left');
      expect(useLayoutStore.getState().slots.left.activeModule).toBeNull();
    });
  });

  describe('addModuleToSlot / removeModuleFromSlot', () => {
    it('appends module when no index given', () => {
      useLayoutStore.getState().addModuleToSlot('todo', 'left');
      const state = useLayoutStore.getState();
      expect(state.slots.left.modules).toEqual(['files', 'git', 'todo']);
    });

    it('respects insertion index', () => {
      useLayoutStore.getState().addModuleToSlot('todo', 'left', 1);
      expect(useLayoutStore.getState().slots.left.modules).toEqual(['files', 'todo', 'git']);
    });

    it('clamps out-of-range index', () => {
      useLayoutStore.getState().addModuleToSlot('todo', 'left', 999);
      expect(useLayoutStore.getState().slots.left.modules).toEqual(['files', 'git', 'todo']);
    });

    it('no-ops when module already in slot', () => {
      useLayoutStore.getState().addModuleToSlot('files', 'left');
      expect(useLayoutStore.getState().slots.left.modules).toEqual(['files', 'git']);
    });

    it('promotes next module on remove when active was removed', () => {
      useLayoutStore.getState().removeModuleFromSlot('files', 'left');
      const state = useLayoutStore.getState();
      expect(state.slots.left.modules).toEqual(['git']);
      expect(state.slots.left.activeModule).toBe('git');
    });

    it('clears activeModule when last module removed', () => {
      useLayoutStore.getState().removeModuleFromSlot('files', 'left');
      useLayoutStore.getState().removeModuleFromSlot('git', 'left');
      expect(useLayoutStore.getState().slots.left.activeModule).toBeNull();
    });

    it('keeps other slot active module unchanged', () => {
      useLayoutStore.getState().removeModuleFromSlot('files', 'left');
      expect(useLayoutStore.getState().slots.bottom.activeModule).toBe('terminal');
    });
  });

  describe('moveModule', () => {
    it('moves module between slots', () => {
      useLayoutStore.getState().moveModule('files', 'left', 'bottom');
      const state = useLayoutStore.getState();
      expect(state.slots.left.modules).toEqual(['git']);
      expect(state.slots.left.activeModule).toBe('git');
      expect(state.slots.bottom.modules).toEqual(['terminal', 'problems', 'files']);
    });

    it('reorders within same slot when from===to', () => {
      useLayoutStore.getState().moveModule('git', 'left', 'left', 0);
      expect(useLayoutStore.getState().slots.left.modules).toEqual(['git', 'files']);
    });

    it('marks activePresetId as custom on same-slot reorder', () => {
      useLayoutStore.getState().moveModule('git', 'left', 'left', 0);
      expect(useLayoutStore.getState().activePresetId).toBe('custom');
    });

    it('no-ops when module not in source slot', () => {
      const before = useLayoutStore.getState().slots;
      useLayoutStore.getState().moveModule('files', 'bottom', 'right');
      expect(useLayoutStore.getState().slots).toEqual(before);
    });

    it('no-ops when target slot already contains module', () => {
      useLayoutStore.getState().addModuleToSlot('files', 'bottom');
      const before = useLayoutStore.getState().slots;
      useLayoutStore.getState().moveModule('files', 'left', 'bottom');
      expect(useLayoutStore.getState().slots).toEqual(before);
    });

    it('sets active in target slot when target was empty', () => {
      useLayoutStore.getState().applyPreset('minimal-chat');
      // minimal-chat 把 chat 放到 center, 这里把它移到 left
      useLayoutStore.getState().moveModule('chat', 'center', 'left');
      const state = useLayoutStore.getState();
      expect(state.slots.left.modules).toEqual(['chat']);
      expect(state.slots.left.activeModule).toBe('chat');
      expect(state.slots.center.activeModule).toBeNull();
    });
  });

  describe('reorderModuleInSlot', () => {
    it('reorders within bounds', () => {
      useLayoutStore.getState().applyPreset('panorama');
      useLayoutStore.getState().reorderModuleInSlot('bottom', 0, 2);
      expect(useLayoutStore.getState().slots.bottom.modules).toEqual([
        'problems',
        'scheduler',
        'terminal',
      ]);
    });

    it('no-ops on out-of-range index', () => {
      const before = useLayoutStore.getState().slots.left.modules;
      useLayoutStore.getState().reorderModuleInSlot('left', 0, 99);
      expect(useLayoutStore.getState().slots.left.modules).toEqual(before);
    });

    it('no-ops when slot is empty', () => {
      useLayoutStore.getState().applyPreset('focus-writing');
      const before = useLayoutStore.getState().slots.left.modules;
      useLayoutStore.getState().reorderModuleInSlot('left', 0, 0);
      expect(useLayoutStore.getState().slots.left.modules).toEqual(before);
    });
  });

  describe('setSlotActive', () => {
    it('auto-adds module to bindings when activating module not already bound', () => {
      useLayoutStore.getState().setSlotActive('right', 'translate');
      const state = useLayoutStore.getState();
      expect(state.slots.right.modules).toContain('translate');
      expect(state.slots.right.activeModule).toBe('translate');
    });

    it('collapses slot when passing null', () => {
      useLayoutStore.getState().setSlotActive('left', null);
      expect(useLayoutStore.getState().slots.left.activeModule).toBeNull();
    });

    it('does not mark activePresetId as custom when re-activating the already-active module', () => {
      // 起点是 developer 预设,active 是 files
      expect(useLayoutStore.getState().activePresetId).toBe('developer');
      useLayoutStore.getState().setSlotActive('left', 'files');
      expect(useLayoutStore.getState().activePresetId).toBe('developer');
    });

    it('moves module from another slot when activating in a different slot (no duplicate)', () => {
      // 不变量保护: files 在 left, 若 setSlotActive('bottom', 'files') 应该:
      // 1. 把 files 从 left 移除
      // 2. 加到 bottom
      // 3. left.activeModule 顺位到 git
      useLayoutStore.getState().setSlotActive('bottom', 'files');
      const state = useLayoutStore.getState();
      expect(state.slots.left.modules).toEqual(['git']);
      expect(state.slots.left.activeModule).toBe('git');
      expect(state.slots.bottom.modules).toContain('files');
      expect(state.slots.bottom.activeModule).toBe('files');
      // files 仅出现在一个 slot
      const slotCounts: Record<string, number> = {};
      (['left', 'right', 'center', 'bottom'] as const).forEach((s) => {
        if (state.slots[s].modules.includes('files')) slotCounts[s] = 1;
      });
      expect(Object.keys(slotCounts)).toEqual(['bottom']);
    });

    it('preserves other slots when removing from source', () => {
      useLayoutStore.getState().setSlotActive('right', 'git');
      const state = useLayoutStore.getState();
      expect(state.slots.left.modules).toEqual(['files']);
      expect(state.slots.right.modules).toContain('git');
    });
  });

  describe('setSlotSize', () => {
    it('clamps left/right to horizontal min', () => {
      useLayoutStore.getState().setSlotSize('left', 10);
      expect(useLayoutStore.getState().slots.left.size).toBe(200);
    });

    it('clamps bottom to vertical min', () => {
      useLayoutStore.getState().setSlotSize('bottom', 10);
      expect(useLayoutStore.getState().slots.bottom.size).toBe(120);
    });

    it('clamps to horizontal max', () => {
      useLayoutStore.getState().setSlotSize('right', 9999);
      expect(useLayoutStore.getState().slots.right.size).toBe(1200);
    });

    it('clamps to vertical max for bottom', () => {
      useLayoutStore.getState().setSlotSize('bottom', 9999);
      expect(useLayoutStore.getState().slots.bottom.size).toBe(800);
    });

    it('forces center to 0', () => {
      useLayoutStore.getState().setSlotSize('center', 500);
      expect(useLayoutStore.getState().slots.center.size).toBe(0);
    });
  });

  describe('setActivityBarPosition', () => {
    it('updates position and marks as custom', () => {
      useLayoutStore.getState().setActivityBarPosition('right');
      expect(useLayoutStore.getState().activityBarPosition).toBe('right');
      expect(useLayoutStore.getState().activePresetId).toBe('custom');
    });
  });

  describe('saveAsCustomLayout / deleteCustomLayout / renameCustomLayout', () => {
    it('saves current state as a new custom layout', () => {
      useLayoutStore.getState().applyPreset('panorama');
      const id = useLayoutStore.getState().saveAsCustomLayout('My Workspace');
      const state = useLayoutStore.getState();
      expect(state.customLayouts).toHaveLength(1);
      expect(state.customLayouts[0]).toMatchObject({ id, name: 'My Workspace' });
      expect(state.activePresetId).toBe(id);
    });

    it('rejects empty layout name', () => {
      expect(() => useLayoutStore.getState().saveAsCustomLayout('   ')).toThrow();
    });

    it('applyPreset works with custom layout id', () => {
      useLayoutStore.getState().applyPreset('focus-writing');
      const id = useLayoutStore.getState().saveAsCustomLayout('Reading');
      useLayoutStore.getState().applyPreset('developer');
      useLayoutStore.getState().applyPreset(id);
      const state = useLayoutStore.getState();
      expect(state.activityBarPosition).toBe('hidden');
      expect(state.activePresetId).toBe(id);
    });

    it('deleting the active custom layout falls back to default preset', () => {
      const id = useLayoutStore.getState().saveAsCustomLayout('Temp');
      useLayoutStore.getState().deleteCustomLayout(id);
      const state = useLayoutStore.getState();
      expect(state.customLayouts).toEqual([]);
      expect(state.activePresetId).toBe(DEFAULT_PRESET_ID);
      expect(state.slots.left.modules).toEqual(['files', 'git']);
    });

    it('renameCustomLayout updates name', () => {
      const id = useLayoutStore.getState().saveAsCustomLayout('Old');
      useLayoutStore.getState().renameCustomLayout(id, 'New');
      expect(useLayoutStore.getState().customLayouts[0].name).toBe('New');
    });

    it('renameCustomLayout ignores blank names', () => {
      const id = useLayoutStore.getState().saveAsCustomLayout('Keep');
      useLayoutStore.getState().renameCustomLayout(id, '   ');
      expect(useLayoutStore.getState().customLayouts[0].name).toBe('Keep');
    });

    it('saved custom layout is deep-independent from store state', () => {
      const id = useLayoutStore.getState().saveAsCustomLayout('Snapshot');
      const savedModules = useLayoutStore.getState().customLayouts[0].slots.left.modules;
      // 修改 store 不应污染已保存快照
      useLayoutStore.getState().addModuleToSlot('todo', 'left');
      const afterMutation = useLayoutStore.getState().customLayouts.find((l) => l.id === id);
      expect(afterMutation?.slots.left.modules).toEqual(savedModules);
      expect(afterMutation?.slots.left.modules).not.toContain('todo');
    });
  });

  describe('exportLayout / importLayout', () => {
    it('exports a JSON payload (mode=all) that can be re-imported (roundtrip)', () => {
      useLayoutStore.getState().applyPreset('panorama');
      useLayoutStore.getState().saveAsCustomLayout('Snapshot A');
      // mode='all' 包含 customLayouts, 是备份/迁移场景
      const exported = useLayoutStore.getState().exportLayout('all');

      resetStore();
      useLayoutStore.getState().importLayout(exported);

      const state = useLayoutStore.getState();
      expect(state.slots.bottom.modules).toEqual(['terminal', 'problems', 'scheduler']);
      expect(state.customLayouts).toHaveLength(1);
      expect(state.customLayouts[0].name).toBe('Snapshot A');
    });

    it('exports a JSON payload (mode=snapshot, default) without customLayouts', () => {
      useLayoutStore.getState().applyPreset('panorama');
      useLayoutStore.getState().saveAsCustomLayout('Snapshot B');
      // 默认模式 = 'snapshot', 只导出当前布局,不泄露其他自定义布局
      const exported = useLayoutStore.getState().exportLayout();
      const parsed = JSON.parse(exported);
      expect(parsed.customLayouts).toEqual([]);
      // 当前布局快照仍完整
      expect(parsed.layout.slots.bottom.modules).toEqual([
        'terminal',
        'problems',
        'scheduler',
      ]);
    });

    it('rejects invalid JSON', () => {
      expect(() => useLayoutStore.getState().importLayout('not json')).toThrow();
    });

    it('rejects unsupported version', () => {
      const payload = JSON.stringify({ version: 99, layout: {}, customLayouts: [] });
      expect(() => useLayoutStore.getState().importLayout(payload)).toThrow(
        /Unsupported layout version/
      );
    });

    it('rejects malformed snapshot', () => {
      const payload = JSON.stringify({ version: 1, layout: { slots: {} }, customLayouts: [] });
      expect(() => useLayoutStore.getState().importLayout(payload)).toThrow(
        /Invalid layout snapshot/
      );
    });

    it('drops malformed entries in customLayouts', () => {
      const validSnapshot: LayoutSnapshot = {
        slots: {
          left: { modules: [], activeModule: null, size: 0 },
          center: { modules: [], activeModule: null, size: 0 },
          right: { modules: ['chat'], activeModule: 'chat', size: 0 },
          bottom: { modules: [], activeModule: null, size: 0 },
        },
        activityBarPosition: 'hidden',
      };
      const payload = JSON.stringify({
        version: 1,
        layout: validSnapshot,
        customLayouts: [
          { id: 'ok', name: 'OK', ...validSnapshot },
          { id: 'bad', name: 42 },
          null,
        ],
        activePresetId: 'ok',
      });
      useLayoutStore.getState().importLayout(payload);
      expect(useLayoutStore.getState().customLayouts).toHaveLength(1);
      expect(useLayoutStore.getState().customLayouts[0].id).toBe('ok');
    });

    it('falls back activePresetId to default when it refers to nothing', () => {
      const validSnapshot: LayoutSnapshot = {
        slots: {
          left: { modules: [], activeModule: null, size: 0 },
          center: { modules: [], activeModule: null, size: 0 },
          right: { modules: ['chat'], activeModule: 'chat', size: 0 },
          bottom: { modules: [], activeModule: null, size: 0 },
        },
        activityBarPosition: 'hidden',
      };
      const payload = JSON.stringify({
        version: 1,
        layout: validSnapshot,
        customLayouts: [],
        activePresetId: 'ghost-id-that-does-not-exist',
      });
      useLayoutStore.getState().importLayout(payload);
      expect(useLayoutStore.getState().activePresetId).toBe(DEFAULT_PRESET_ID);
    });

    it('preserves "custom" activePresetId as a known sentinel', () => {
      const validSnapshot: LayoutSnapshot = {
        slots: {
          left: { modules: [], activeModule: null, size: 0 },
          center: { modules: [], activeModule: null, size: 0 },
          right: { modules: ['chat'], activeModule: 'chat', size: 0 },
          bottom: { modules: [], activeModule: null, size: 0 },
        },
        activityBarPosition: 'hidden',
      };
      const payload = JSON.stringify({
        version: 1,
        layout: validSnapshot,
        customLayouts: [],
        activePresetId: 'custom',
      });
      useLayoutStore.getState().importLayout(payload);
      expect(useLayoutStore.getState().activePresetId).toBe('custom');
    });

    it('falls back to default when activePresetId field is missing', () => {
      const validSnapshot: LayoutSnapshot = {
        slots: {
          left: { modules: [], activeModule: null, size: 0 },
          center: { modules: [], activeModule: null, size: 0 },
          right: { modules: ['chat'], activeModule: 'chat', size: 0 },
          bottom: { modules: [], activeModule: null, size: 0 },
        },
        activityBarPosition: 'hidden',
      };
      const payload = JSON.stringify({
        version: 1,
        layout: validSnapshot,
        customLayouts: [],
      });
      useLayoutStore.getState().importLayout(payload);
      expect(useLayoutStore.getState().activePresetId).toBe(DEFAULT_PRESET_ID);
    });

    it('strips extra slot keys not in SlotId whitelist', () => {
      const payload = JSON.stringify({
        version: 1,
        layout: {
          slots: {
            left: { modules: [], activeModule: null, size: 0 },
            center: { modules: [], activeModule: null, size: 0 },
            right: { modules: ['chat'], activeModule: 'chat', size: 0 },
            bottom: { modules: [], activeModule: null, size: 0 },
            floating: { modules: ['evil'], activeModule: 'evil', size: 99 },
          },
          activityBarPosition: 'hidden',
        },
        customLayouts: [],
      });
      useLayoutStore.getState().importLayout(payload);
      const slots = useLayoutStore.getState().slots as unknown as Record<string, unknown>;
      expect(slots.floating).toBeUndefined();
    });
  });

  describe('builtin preset integrity', () => {
    it('all builtin presets have valid 4 slots', () => {
      for (const preset of BUILTIN_PRESETS) {
        expect(preset.slots.left).toBeDefined();
        expect(preset.slots.right).toBeDefined();
        expect(preset.slots.center).toBeDefined();
        expect(preset.slots.bottom).toBeDefined();
      }
    });

    it('all builtin presets are marked builtin=true', () => {
      for (const preset of BUILTIN_PRESETS) {
        expect(preset.builtin).toBe(true);
      }
    });

    it('every active module is in its slot modules list', () => {
      for (const preset of BUILTIN_PRESETS) {
        for (const slotId of ['left', 'right', 'center', 'bottom'] as const) {
          const slot = preset.slots[slotId];
          if (slot.activeModule !== null) {
            expect(slot.modules).toContain(slot.activeModule);
          }
        }
      }
    });
  });

  describe('resetToDefault', () => {
    it('returns to developer preset', () => {
      useLayoutStore.getState().applyPreset('focus-writing');
      useLayoutStore.getState().resetToDefault();
      const state = useLayoutStore.getState();
      expect(state.activePresetId).toBe(DEFAULT_PRESET_ID);
      expect(state.slots.left.modules).toEqual(['files', 'git']);
    });
  });

  describe('applyPluginDefaultSlots', () => {
    it('places a new module into its defaultSlot when not seen before', () => {
      // 起始 developer 预设: bottom 槽 = [terminal, problems], 让一个全新 module 选 right 槽
      // 但 right 已有 [chat]; 改测一个空 slot (用 minimal-chat 让 left 空)
      useLayoutStore.getState().applyPreset('minimal-chat');
      const placed = useLayoutStore
        .getState()
        .applyPluginDefaultSlots([
          { moduleId: 'translate', defaultSlot: 'left', preferredSize: 280 },
        ]);
      expect(placed).toEqual(['translate']);
      const state = useLayoutStore.getState();
      expect(state.slots.left.modules).toEqual(['translate']);
      expect(state.slots.left.activeModule).toBe('translate');
      expect(state.slots.left.size).toBe(280);
      expect(state.seenModules).toContain('translate');
    });

    it('skips placing when module already in some slot', () => {
      // developer 预设 files 在 left
      const placed = useLayoutStore
        .getState()
        .applyPluginDefaultSlots([
          { moduleId: 'files', defaultSlot: 'right' },
        ]);
      expect(placed).toEqual([]);
      // 但仍标记为 seen, 避免后续被反复扫
      expect(useLayoutStore.getState().seenModules).toContain('files');
      // files 仍在 left, 不会被错误地复制到 right
      expect(useLayoutStore.getState().slots.left.modules).toContain('files');
    });

    it('skips placing when module is already seen (idempotent)', () => {
      useLayoutStore.getState().applyPreset('minimal-chat');
      // 第一次 sweep
      useLayoutStore
        .getState()
        .applyPluginDefaultSlots([{ moduleId: 'translate', defaultSlot: 'left' }]);
      // 用户主动移除
      useLayoutStore.getState().removeModuleFromSlot('translate', 'left');
      expect(useLayoutStore.getState().slots.left.modules).not.toContain('translate');
      // 第二次 sweep: 不应再次塞回
      const placed = useLayoutStore
        .getState()
        .applyPluginDefaultSlots([{ moduleId: 'translate', defaultSlot: 'left' }]);
      expect(placed).toEqual([]);
      expect(useLayoutStore.getState().slots.left.modules).not.toContain('translate');
    });

    it('marks module as seen even when defaultSlot is undefined', () => {
      useLayoutStore.getState().applyPluginDefaultSlots([{ moduleId: 'translate' }]);
      expect(useLayoutStore.getState().seenModules).toContain('translate');
    });

    it('refuses to place into center slot', () => {
      const placed = useLayoutStore
        .getState()
        .applyPluginDefaultSlots([
          { moduleId: 'translate', defaultSlot: 'center' },
        ]);
      expect(placed).toEqual([]);
      expect(useLayoutStore.getState().slots.center.modules).not.toContain('translate');
    });

    it('skips placing when target slot already has modules', () => {
      // developer 预设 right=[chat], 给 translate 让 defaultSlot=right
      const placed = useLayoutStore
        .getState()
        .applyPluginDefaultSlots([
          { moduleId: 'translate', defaultSlot: 'right' },
        ]);
      expect(placed).toEqual([]);
      expect(useLayoutStore.getState().slots.right.modules).toEqual(['chat']);
    });

    it('handles multiple new modules in one call', () => {
      // 用 minimal-chat 让 left/bottom 空
      useLayoutStore.getState().applyPreset('minimal-chat');
      const placed = useLayoutStore.getState().applyPluginDefaultSlots([
        { moduleId: 'translate', defaultSlot: 'left' },
        { moduleId: 'todo', defaultSlot: 'left' }, // left 已被 translate 占满 → 跳过
        { moduleId: 'terminal', defaultSlot: 'bottom', preferredSize: 200 },
      ]);
      // 1) translate 安置到 left; 2) todo 因为 left 不再为空被跳过; 3) terminal 安置到 bottom
      expect(placed).toEqual(['translate', 'terminal']);
      const state = useLayoutStore.getState();
      expect(state.slots.left.modules).toEqual(['translate']);
      expect(state.slots.bottom.modules).toEqual(['terminal']);
      expect(state.slots.bottom.size).toBe(200);
      // 三者都被标 seen
      expect(state.seenModules).toEqual(expect.arrayContaining(['translate', 'todo', 'terminal']));
    });

    it('clamps preferredSize to slot min/max', () => {
      useLayoutStore.getState().applyPreset('minimal-chat');
      useLayoutStore.getState().applyPluginDefaultSlots([
        { moduleId: 'translate', defaultSlot: 'left', preferredSize: 50 }, // < min 200
      ]);
      expect(useLayoutStore.getState().slots.left.size).toBe(200);
    });

    it('returns empty when called twice with the same contributions (idempotent)', () => {
      useLayoutStore.getState().applyPreset('minimal-chat');
      const first = useLayoutStore.getState().applyPluginDefaultSlots([
        { moduleId: 'translate', defaultSlot: 'left' },
      ]);
      const second = useLayoutStore.getState().applyPluginDefaultSlots([
        { moduleId: 'translate', defaultSlot: 'left' },
      ]);
      expect(first).toEqual(['translate']);
      expect(second).toEqual([]);
    });
  });

  // ============================================================
  // V2: appearance 外观字段
  // ============================================================
  describe('V2 appearance', () => {
    it('initializes with DEFAULT_APPEARANCE', () => {
      const { appearance } = useLayoutStore.getState();
      expect(appearance.appPadding).toBe(6);
      expect(appearance.slotGap).toBe(4);
      expect(appearance.slotRadius).toBe(10);
      expect(appearance.density).toBe('standard');
      expect(appearance.transitionLevel).toBe('standard');
      expect(appearance.dockMode).toBe('expanded');
    });

    it('partial update via setAppearance', () => {
      useLayoutStore.getState().setAppearance({ appPadding: 8, density: 'compact' });
      const { appearance } = useLayoutStore.getState();
      expect(appearance.appPadding).toBe(8);
      expect(appearance.density).toBe('compact');
      // 未指定字段保留
      expect(appearance.slotGap).toBe(4);
      expect(appearance.transitionLevel).toBe('standard');
    });

    it('clamps numeric fields to legal range', () => {
      useLayoutStore.getState().setAppearance({
        appPadding: 999,
        slotGap: -5,
        slotRadius: 50,
      });
      const { appearance } = useLayoutStore.getState();
      expect(appearance.appPadding).toBe(12); // max
      expect(appearance.slotGap).toBe(0); // min
      expect(appearance.slotRadius).toBe(12); // max
    });

    it('rounds non-integer numeric values', () => {
      useLayoutStore.getState().setAppearance({ appPadding: 7.6 });
      expect(useLayoutStore.getState().appearance.appPadding).toBe(8);
    });

    it('rejects invalid enum values (fallback to default)', () => {
      useLayoutStore.getState().setAppearance({
        density: 'huge' as unknown as 'standard',
      });
      // sanitize fallback: 整体回默认(因为 sanitize 收到 invalid 枚举会保留默认值)
      expect(useLayoutStore.getState().appearance.density).toBe('standard');
    });

    it('resetAppearance restores defaults', () => {
      useLayoutStore.getState().setAppearance({ appPadding: 12, dockMode: 'compact' });
      useLayoutStore.getState().resetAppearance();
      const { appearance } = useLayoutStore.getState();
      expect(appearance.appPadding).toBe(6);
      expect(appearance.dockMode).toBe('expanded');
    });

    it('exportLayout emits version=2 and includes appearance', () => {
      useLayoutStore.getState().setAppearance({ slotGap: 6 });
      const exported = useLayoutStore.getState().exportLayout('all');
      const parsed = JSON.parse(exported);
      expect(parsed.version).toBe(2);
      expect(parsed.appearance).toBeDefined();
      expect(parsed.appearance.slotGap).toBe(6);
    });

    it('importLayout v1 payload fills appearance with defaults (merge mode keeps existing)', () => {
      useLayoutStore.getState().setAppearance({ slotGap: 7 });
      // v1 payload 没有 appearance
      const payload = JSON.stringify({
        version: 1,
        layout: {
          slots: {
            left: { modules: [], activeModule: null, size: 280 },
            right: { modules: [], activeModule: null, size: 400 },
            center: { modules: [], activeModule: null, size: 0 },
            bottom: { modules: [], activeModule: null, size: 0 },
          },
          activityBarPosition: 'left',
        },
        customLayouts: [],
      });
      useLayoutStore.getState().importLayout(payload, 'merge');
      // merge 模式: appearance 不被覆盖
      expect(useLayoutStore.getState().appearance.slotGap).toBe(7);
    });

    it('importLayout v2 replace mode applies imported appearance', () => {
      const payload = JSON.stringify({
        version: 2,
        layout: {
          slots: {
            left: { modules: [], activeModule: null, size: 280 },
            right: { modules: [], activeModule: null, size: 400 },
            center: { modules: [], activeModule: null, size: 0 },
            bottom: { modules: [], activeModule: null, size: 0 },
          },
          activityBarPosition: 'left',
        },
        customLayouts: [],
        appearance: {
          appPadding: 10,
          slotGap: 2,
          slotRadius: 4,
          density: 'spacious',
          transitionLevel: 'lively',
          dockMode: 'compact',
        },
      });
      useLayoutStore.getState().importLayout(payload, 'replace');
      const { appearance } = useLayoutStore.getState();
      expect(appearance.appPadding).toBe(10);
      expect(appearance.slotGap).toBe(2);
      expect(appearance.density).toBe('spacious');
      expect(appearance.dockMode).toBe('compact');
    });

    it('importLayout v1 replace mode resets appearance to defaults', () => {
      useLayoutStore.getState().setAppearance({ appPadding: 12 });
      const payload = JSON.stringify({
        version: 1,
        layout: {
          slots: {
            left: { modules: [], activeModule: null, size: 280 },
            right: { modules: [], activeModule: null, size: 400 },
            center: { modules: [], activeModule: null, size: 0 },
            bottom: { modules: [], activeModule: null, size: 0 },
          },
          activityBarPosition: 'left',
        },
        customLayouts: [],
      });
      useLayoutStore.getState().importLayout(payload, 'replace');
      expect(useLayoutStore.getState().appearance.appPadding).toBe(6); // default
    });
  });

  // ============================================================
  // V2 P4.3: CustomLayout description 字段
  // ============================================================
  describe('V2 CustomLayout description', () => {
    it('saveAsCustomLayout accepts optional description', () => {
      const id = useLayoutStore
        .getState()
        .saveAsCustomLayout('My Layout', '团队评审场景使用');
      const layout = useLayoutStore.getState().customLayouts.find((l) => l.id === id);
      expect(layout?.description).toBe('团队评审场景使用');
    });

    it('saveAsCustomLayout without description does not add the field', () => {
      const id = useLayoutStore.getState().saveAsCustomLayout('No Desc');
      const layout = useLayoutStore.getState().customLayouts.find((l) => l.id === id);
      expect(layout?.description).toBeUndefined();
    });

    it('saveAsCustomLayout trims description whitespace', () => {
      const id = useLayoutStore.getState().saveAsCustomLayout('Trimmed', '  hi  ');
      const layout = useLayoutStore.getState().customLayouts.find((l) => l.id === id);
      expect(layout?.description).toBe('hi');
    });

    it('saveAsCustomLayout treats whitespace-only description as undefined', () => {
      const id = useLayoutStore.getState().saveAsCustomLayout('Whitespace', '   ');
      const layout = useLayoutStore.getState().customLayouts.find((l) => l.id === id);
      expect(layout?.description).toBeUndefined();
    });

    it('updateCustomLayoutDescription updates description', () => {
      const id = useLayoutStore.getState().saveAsCustomLayout('Layout');
      useLayoutStore.getState().updateCustomLayoutDescription(id, '新描述');
      const layout = useLayoutStore.getState().customLayouts.find((l) => l.id === id);
      expect(layout?.description).toBe('新描述');
    });

    it('updateCustomLayoutDescription with empty string removes description', () => {
      const id = useLayoutStore.getState().saveAsCustomLayout('Layout', '初始描述');
      useLayoutStore.getState().updateCustomLayoutDescription(id, '');
      const layout = useLayoutStore.getState().customLayouts.find((l) => l.id === id);
      expect(layout?.description).toBeUndefined();
    });

    it('exportLayout preserves description in payload', () => {
      useLayoutStore.getState().saveAsCustomLayout('With Desc', '描述内容');
      const exported = useLayoutStore.getState().exportLayout('all');
      const parsed = JSON.parse(exported);
      expect(parsed.customLayouts[0].description).toBe('描述内容');
    });

    it('importLayout preserves description on round-trip', () => {
      useLayoutStore.getState().saveAsCustomLayout('Original', '原始描述');
      const exported = useLayoutStore.getState().exportLayout('all');
      resetStore();
      useLayoutStore.getState().importLayout(exported, 'replace');
      const layout = useLayoutStore.getState().customLayouts[0];
      expect(layout.description).toBe('原始描述');
    });

    it('importLayout rejects malformed description (non-string)', () => {
      // 非字符串 description → 整个 customLayout 被 filter 掉
      const payload = JSON.stringify({
        version: 2,
        layout: {
          slots: {
            left: { modules: [], activeModule: null, size: 280 },
            right: { modules: [], activeModule: null, size: 400 },
            center: { modules: [], activeModule: null, size: 0 },
            bottom: { modules: [], activeModule: null, size: 0 },
          },
          activityBarPosition: 'left',
        },
        customLayouts: [
          {
            id: 'bad',
            name: 'Bad',
            description: { evil: true },
            slots: {
              left: { modules: [], activeModule: null, size: 280 },
              right: { modules: [], activeModule: null, size: 400 },
              center: { modules: [], activeModule: null, size: 0 },
              bottom: { modules: [], activeModule: null, size: 0 },
            },
            activityBarPosition: 'left',
          },
        ],
      });
      useLayoutStore.getState().importLayout(payload, 'replace');
      expect(useLayoutStore.getState().customLayouts).toHaveLength(0);
    });
  });
});
