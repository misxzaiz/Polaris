/**
 * 配置状态管理
 */

import { create } from 'zustand';
import i18n from '../i18n';
import type { Config, HealthStatus } from '../types';
import * as tauri from '../services/tauri';
import { createLogger } from '../utils/logger';

const log = createLogger('ConfigStore');

interface ConfigState {
  /** 当前配置 */
  config: Config | null;
  /** 健康状态 */
  healthStatus: HealthStatus | null;
  /** 加载中 */
  loading: boolean;
  /** 连接中（首次启动） */
  isConnecting: boolean;
  /** 连接状态 */
  connectionState: 'connecting' | 'success' | 'failed';
  /** 错误 */
  error: string | null;

  /** 加载配置 */
  loadConfig: () => Promise<void>;
  /** 更新配置 */
  updateConfig: (config: Config) => Promise<void>;
  /** 设置工作目录 */
  setWorkDir: (path: string | null) => Promise<void>;
  /** 设置 Claude 命令 */
  setClaudeCmd: (cmd: string) => Promise<void>;
  
  /** 刷新健康状态 */
  refreshHealth: () => Promise<void>;
  /** 重新连接并更新路径 */
  retryConnection: (claudeCmd?: string) => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set) => ({
  config: null,
  healthStatus: null,
  loading: false,
  isConnecting: true,  // 默认为 true，显示连接蒙板
  connectionState: 'connecting',
  error: null,

  loadConfig: async () => {
    set({ loading: true, isConnecting: true, error: null, connectionState: 'connecting' });
    try {
      const [config, health] = await Promise.all([
        tauri.getConfig(),
        tauri.healthCheck(),
      ]);
      const connectionState = health.claudeAvailable ? 'success' : 'failed';
      if (config?.language) {
        i18n.changeLanguage(config.language);
      }
      set({ config, healthStatus: health, loading: false, isConnecting: false, connectionState });

      // CLI 可用时，异步获取动态信息（agents, auth status, version）
      if (connectionState === 'success') {
        import('./cliInfoStore').then(({ useCliInfoStore }) => {
          useCliInfoStore.getState().fetchAll()
        }).catch(() => {})
      }
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : i18n.t('errors:loadConfigFailed'),
        loading: false,
        isConnecting: false,
        connectionState: 'failed'
      });
    }
  },

  updateConfig: async (config) => {
    set({ loading: true, error: null });
    try {
      await tauri.updateConfig(config);
      // 关键：保存后重新从后端加载，确保同步
      const savedConfig = await tauri.getConfig();
      if (savedConfig?.language) {
        i18n.changeLanguage(savedConfig.language);
      }
      set({ config: savedConfig, loading: false });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : i18n.t('errors:updateConfigFailed'),
        loading: false
      });
    }
  },

  setWorkDir: async (path) => {
    set({ loading: true, error: null });
    try {
      await tauri.setWorkDir(path);
      const config = await tauri.getConfig();
      set({ config, loading: false });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : i18n.t('errors:setWorkDirFailed'),
        loading: false
      });
    }
  },

  setClaudeCmd: async (cmd) => {
    set({ loading: true, error: null });
    try {
      await tauri.setClaudeCmd(cmd);
      const config = await tauri.getConfig();
      set({ config, loading: false });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : i18n.t('errors:setClaudeCmdFailed'),
        loading: false
      });
    }
  },

  

  refreshHealth: async () => {
    try {
      const health = await tauri.healthCheck();
      const connectionState = health.claudeAvailable ? 'success' : 'failed';
      set({ healthStatus: health, connectionState });
    } catch (e) {
      log.error(i18n.t('errors:refreshHealthFailed'), e instanceof Error ? e : new Error(String(e)));
      set({ connectionState: 'failed' });
    }
  },

  retryConnection: async (claudeCmd?: string) => {
    set({ loading: true, error: null, connectionState: 'connecting' });
    try {
      if (claudeCmd) {
        await tauri.setClaudeCmd(claudeCmd);
        const config = await tauri.getConfig();
        set({ config });
      }
      
      const health = await tauri.healthCheck();
      const connectionState = health.claudeAvailable ? 'success' : 'failed';
      
      if (connectionState === 'failed') {
        set({
          error: i18n.t('errors:claudeNotFound', { path: claudeCmd || i18n.t('errors:notSet') }),
          loading: false,
          connectionState: 'failed'
        });
      } else {
        set({
          healthStatus: health,
          loading: false,
          connectionState: 'success',
          error: null
        });
      }
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : i18n.t('errors:connectionFailed'),
        loading: false,
        connectionState: 'failed'
      });
    }
  },
}));
