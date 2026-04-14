/**
 * Auto-Mode 状态管理
 *
 * 管理自动模式配置的状态，包括自定义规则编辑
 */

import { create } from 'zustand';
import type {
  AutoModeConfig,
  AutoModeDefaults,
  AutoModeCustomRules,
  ClaudeSettings,
  EditMode,
  RuleType,
} from '../types/autoMode';
import * as autoModeService from '../services/autoModeService';
import * as claudeSettingsService from '../services/claudeSettingsService';
import { createLogger } from '../utils/logger';

const log = createLogger('AutoModeStore');

interface AutoModeState {
  // CLI 输出
  config: AutoModeConfig | null;
  defaults: AutoModeDefaults | null;

  // 用户自定义规则
  customRules: AutoModeCustomRules;
  settings: ClaudeSettings | null;
  settingsPath: string | null;

  // UI 状态
  loading: boolean;
  saving: boolean;
  error: string | null;
  searchQuery: string;
  editMode: EditMode;

  // Actions - 数据获取
  fetchConfig: () => Promise<void>;
  fetchDefaults: () => Promise<void>;
  fetchSettings: () => Promise<void>;
  refreshAll: () => Promise<void>;

  // Actions - 规则编辑
  addCustomRule: (type: RuleType, rule: string) => Promise<void>;
  removeCustomRule: (type: RuleType, index: number) => Promise<void>;
  updateCustomRules: (rules: AutoModeCustomRules) => Promise<void>;

  // Actions - 高级编辑
  updateSettings: (settings: ClaudeSettings) => Promise<void>;

  // Actions - UI 状态
  setSearchQuery: (query: string) => void;
  setEditMode: (mode: EditMode) => void;
  clearError: () => void;
}

export const useAutoModeStore = create<AutoModeState>((set, get) => ({
  config: null,
  defaults: null,
  customRules: { allow: [], softDeny: [] },
  settings: null,
  settingsPath: null,
  loading: false,
  saving: false,
  error: null,
  searchQuery: '',
  editMode: 'list',

  fetchConfig: async () => {
    try {
      set({ loading: true, error: null });
      const config = await autoModeService.getAutoModeConfig();
      set({ config, loading: false });
    } catch (err) {
      log.error('获取配置失败', err instanceof Error ? err : new Error(String(err)));
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  fetchDefaults: async () => {
    try {
      set({ loading: true, error: null });
      const defaults = await autoModeService.getAutoModeDefaults();
      set({ defaults, loading: false });
    } catch (err) {
      log.error('获取默认配置失败', err instanceof Error ? err : new Error(String(err)));
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  fetchSettings: async () => {
    try {
      set({ loading: true, error: null });
      const [settings, settingsPath] = await Promise.all([
        claudeSettingsService.readClaudeSettings(),
        claudeSettingsService.getClaudeSettingsPath(),
      ]);
      const customRules = claudeSettingsService.extractCustomRules(settings);
      set({ settings, settingsPath, customRules, loading: false });
    } catch (err) {
      log.error('读取 settings 失败', err instanceof Error ? err : new Error(String(err)));
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  refreshAll: async () => {
    const { fetchConfig, fetchDefaults, fetchSettings } = get();
    set({ loading: true });
    await Promise.all([fetchConfig(), fetchDefaults(), fetchSettings()]);
    set({ loading: false });
  },

  addCustomRule: async (type: RuleType, rule: string) => {
    const { customRules } = get();
    const key = type === 'allow' ? 'allow' : 'softDeny';
    const newRules = { ...customRules, [key]: [...customRules[key], rule] };
    await get().updateCustomRules(newRules);
  },

  removeCustomRule: async (type: RuleType, index: number) => {
    const { customRules } = get();
    const key = type === 'allow' ? 'allow' : 'softDeny';
    const list = [...customRules[key]];
    list.splice(index, 1);
    await get().updateCustomRules({ ...customRules, [key]: list });
  },

  updateCustomRules: async (rules: AutoModeCustomRules) => {
    const { settings } = get();
    try {
      set({ saving: true });
      const newSettings = claudeSettingsService.updateCustomRules(settings || {}, rules);
      await claudeSettingsService.writeClaudeSettings(newSettings);
      set({ customRules: rules, settings: newSettings, saving: false });
      // 刷新 CLI 配置
      await get().fetchConfig();
    } catch (err) {
      log.error('保存规则失败', err instanceof Error ? err : new Error(String(err)));
      set({ error: err instanceof Error ? err.message : String(err), saving: false });
    }
  },

  updateSettings: async (newSettings: ClaudeSettings) => {
    try {
      set({ saving: true });
      await claudeSettingsService.writeClaudeSettings(newSettings);
      const customRules = claudeSettingsService.extractCustomRules(newSettings);
      set({ settings: newSettings, customRules, saving: false });
      // 刷新 CLI 配置
      await get().fetchConfig();
    } catch (err) {
      log.error('保存 settings 失败', err instanceof Error ? err : new Error(String(err)));
      set({ error: err instanceof Error ? err.message : String(err), saving: false });
    }
  },

  setSearchQuery: (query: string) => set({ searchQuery: query }),
  setEditMode: (mode: EditMode) => set({ editMode: mode }),
  clearError: () => set({ error: null }),
}));
