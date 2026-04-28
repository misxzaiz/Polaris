/**
 * 配置状态管理
 */

import { create } from 'zustand';
import i18n from '../i18n';
import type { Config, HealthStatus } from '../types';
import * as tauri from '../services/tauri';
import { createLogger } from '../utils/logger';
import { currentMode } from '../services/transport';
import { storeTokenMd5, md5Hex } from '../services/transport/auth';

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
  connectionState: 'connecting' | 'success' | 'failed' | 'needsToken';
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
  /** Submit token in web mode (MD5-then-store, then retry loadConfig) */
  submitToken: (rawToken: string) => Promise<void>;
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
    } catch (e: unknown) {
      // In web mode, detect 401 auth error → show token input instead of CLI error
      if (currentMode === 'http' && isAuthError(e)) {
        set({
          error: null,
          loading: false,
          isConnecting: false,
          connectionState: 'needsToken',
        });
        return;
      }
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
    } catch (e: unknown) {
      // In web mode, detect 401 auth error → show token input
      if (currentMode === 'http' && isAuthError(e)) {
        set({
          error: null,
          loading: false,
          connectionState: 'needsToken',
        });
        return;
      }
      set({
        error: e instanceof Error ? e.message : i18n.t('errors:connectionFailed'),
        loading: false,
        connectionState: 'failed'
      });
    }
  },

  submitToken: async (rawToken: string) => {
    const tokenMd5 = await md5Hex(rawToken);
    storeTokenMd5(tokenMd5);
    // Re-attempt connection with the new token
    set({ connectionState: 'connecting', error: null, loading: true });
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
    } catch (e: unknown) {
      // Token still wrong → stay in needsToken state
      if (isAuthError(e)) {
        storeTokenMd5('');
        set({ connectionState: 'needsToken', error: null, loading: false, isConnecting: false });
        return;
      }
      set({
        error: e instanceof Error ? e.message : i18n.t('errors:loadConfigFailed'),
        loading: false,
        isConnecting: false,
        connectionState: 'failed'
      });
    }
  },
}));

/** Check if an error is an auth error (401/403) thrown by the HTTP transport */
function isAuthError(e: unknown): boolean {
  if (e instanceof Error) {
    return (e as unknown as { isAuthError?: boolean }).isAuthError === true;
  }
  return false;
}
