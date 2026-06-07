/**
 * 配置状态管理
 */

import { create } from 'zustand';
import i18n from '@/i18n';
import type { Config, ConfigPatch, HealthStatus } from '@/types';
import * as tauri from '@/services/tauri';
import { createLogger } from '@/utils/logger';
import { currentMode } from '@/services/transport';
import { storeTokenMd5, md5Hex } from '@/services/transport/auth';
import { getSelectedEngineHealth, hasAnyEngineAvailable } from '@/utils/engineHealth';
import { normalizeEngineId } from '@/utils/engineDisplay';
import { useThemeStore } from './themeStore';

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
  /** 强制刷新页面（重置所有状态） */
  forceRefresh: () => void;
  /** 更新配置 */
  updateConfig: (config: Config) => Promise<void>;
  /** 按字段合并更新配置 */
  updateConfigPatch: (patch: ConfigPatch) => Promise<Config>;
  /** 设置工作目录 */
  setWorkDir: (path: string | null) => Promise<void>;
  /** 设置 Claude 命令 */
  setClaudeCmd: (cmd: string) => Promise<void>;
  /** 重置 CLI 配置(测试用):将 Claude/Codex 路径重置为默认值并触发重新检测 */
  resetCliConfig: () => Promise<void>;

  /** 刷新健康状态 */
  refreshHealth: () => Promise<void>;
  /** 重新连接并更新路径 */
  retryConnection: (cliPath?: string) => Promise<void>;
  /** Submit token in web mode (MD5-then-store, then retry loadConfig) */
  submitToken: (rawToken: string) => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  healthStatus: null,
  loading: false,
  isConnecting: true,  // 默认为 true，显示连接蒙板
  connectionState: 'connecting',
  error: null,

  loadConfig: async () => {
    const ts = Date.now()
    console.warn('[loadConfig] START', { ts, currentMode })
    set({ loading: true, isConnecting: true, error: null, connectionState: 'connecting' });
    try {
      const [config, health] = await Promise.all([
        tauri.getConfig(),
        tauri.healthCheck(),
      ]);
      console.warn('[loadConfig] FETCHED', {
        hasConfig: !!config,
        defaultEngine: config?.defaultEngine,
        workDir: config?.workDir,
        claudeAvailable: health?.claudeAvailable,
        claudeVersion: health?.claudeVersion,
        codexAvailable: health?.codexAvailable,
        codexVersion: health?.codexVersion,
        configValid: health?.configValid,
        hasProfile: !!config?.modelProfiles?.length,
        activeProfileId: config?.activeModelProfileId,
        mode: currentMode,
        durationMs: Date.now() - ts,
      })

      const engineAvailable = hasAnyEngineAvailable(health, config)
      const connectionState = (currentMode === 'http' || engineAvailable)
        ? 'success'
        : 'failed';
      console.warn('[loadConfig] STATE', {
        connectionState,
        mode: currentMode,
        engineAvailable,
      })

      if (config?.language) {
        i18n.changeLanguage(config.language);
      }
      if (config?.theme) {
        useThemeStore.getState().applyTheme(config.theme);
      }
      set({ config, healthStatus: health, loading: false, isConnecting: false, connectionState });
      console.warn('[loadConfig] DONE', { connectionState, totalDurationMs: Date.now() - ts })

      // 同步 Model Profile 到 modelProfileStore，确保重启后 Profile 仍然生效
      // （modelProfileStore 没有 persist 中间件，依赖此初始化）
      if (config.modelProfiles?.length) {
        console.warn('[loadConfig] syncing modelProfiles', { count: config.modelProfiles.length, activeId: config.activeModelProfileId })
        import('./modelProfileStore').then(({ useModelProfileStore }) => {
          const store = useModelProfileStore.getState();
          store.setProfiles(config.modelProfiles!);
          if (config.activeModelProfileId) {
            store.setActiveProfileId(config.activeModelProfileId);
          }
          console.warn('[loadConfig] modelProfiles synced')
        }).catch((err) => {
          console.warn('[loadConfig] modelProfiles sync FAILED', err)
        })
      } else {
        console.warn('[loadConfig] no modelProfiles to sync')
      }

      // P0 修复：初始化时将全局 activeModelProfileId 同步到 sessionConfigStore
      // 确保未手动设置过状态栏 Profile 的会话能使用设置页的激活配置
      if (config.activeModelProfileId) {
        const activeProfileId = config.activeModelProfileId
        console.warn('[loadConfig] syncing sessionConfigStore', { activeId: activeProfileId })
        import('./sessionConfigStore').then(({ useSessionConfig }) => {
          const sessionState = useSessionConfig.getState()
          if (!sessionState.config.modelProfileId) {
            sessionState.setModelProfileId(activeProfileId)
            console.warn('[loadConfig] sessionConfigStore synced')
          } else {
            console.warn('[loadConfig] sessionConfigStore already set, skip')
          }
        }).catch((err) => {
          console.warn('[loadConfig] sessionConfigStore sync FAILED', err)
        })
      }

      // CLI 可用时，异步获取动态信息（agents, auth status, version）
      if (connectionState === 'success') {
        console.warn('[loadConfig] triggering cliInfoStore.fetchAll')
        import('./cliInfoStore').then(({ useCliInfoStore }) => {
          useCliInfoStore.getState().fetchAll()
          console.warn('[loadConfig] cliInfoStore.fetchAll triggered')
        }).catch((err) => {
          console.warn('[loadConfig] cliInfoStore import FAILED', err)
        })
      } else {
        console.warn('[loadConfig] skipping cliInfoStore', { connectionState })
      }
    } catch (e: unknown) {
      console.warn('[loadConfig] FAILED', {
        message: e instanceof Error ? e.message : String(e),
        isAuthError: isWebAuthError(e),
        durationMs: Date.now() - ts,
      })
      if (isWebAuthError(e)) {
        console.warn('[loadConfig] → needsToken')
        set(setNeedsToken());
        return;
      }
      set({
        error: e instanceof Error ? e.message : i18n.t('errors:loadConfigFailed'),
        loading: false,
        isConnecting: false,
        connectionState: 'failed'
      });
      console.warn('[loadConfig] error state set', { error: e instanceof Error ? e.message : String(e) })
    }
  },

  forceRefresh: () => {
    window.location.reload();
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
      if (savedConfig?.theme) {
        useThemeStore.getState().applyTheme(savedConfig.theme);
      }
      set({ config: savedConfig, loading: false });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : i18n.t('errors:updateConfigFailed'),
        loading: false
      });
    }
  },

  updateConfigPatch: async (patch) => {
    set({ loading: true, error: null });
    try {
      const savedConfig = await tauri.updateConfigPatch(patch);
      if (savedConfig?.language) {
        i18n.changeLanguage(savedConfig.language);
      }
      if (savedConfig?.theme) {
        useThemeStore.getState().applyTheme(savedConfig.theme);
      }
      set({ config: savedConfig, loading: false });
      return savedConfig;
    } catch (e) {
      const message = e instanceof Error ? e.message : i18n.t('errors:updateConfigFailed');
      set({
        error: message,
        loading: false
      });
      throw e instanceof Error ? e : new Error(message);
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

  resetCliConfig: async () => {
    set({ loading: true, error: null });
    try {
      const config = await tauri.resetCliConfig();
      // 重新跑健康检查 + 评估连接状态;若 PATH 中没有 claude/codex,
      // connectionState 会变为 'failed',ConnectingOverlay 会自然显示出来
      const health = await tauri.healthCheck();
      const connectionState = hasAnyEngineAvailable(health, config) ? 'success' : 'failed';
      set({
        config,
        healthStatus: health,
        connectionState,
        isConnecting: connectionState !== 'success',
        loading: false,
        error: null,
      });
    } catch (e) {
      log.error('resetCliConfig failed', e instanceof Error ? e : new Error(String(e)));
      set({
        error: e instanceof Error ? e.message : i18n.t('errors:resetCliConfigFailed'),
        loading: false,
      });
    }
  },

  

  refreshHealth: async () => {
    try {
      const health = await tauri.healthCheck();
      let config = get().config;
      if (!config) {
        config = await tauri.getConfig();
      }
      const connectionState = hasAnyEngineAvailable(health, config) ? 'success' : 'failed';
      set({ healthStatus: health, connectionState });
    } catch (e) {
      log.error('refreshHealth failed', e instanceof Error ? e : new Error(String(e)), { isWebAuth: isWebAuthError(e) });
      if (isWebAuthError(e)) {
        log.info('refreshHealth → needsToken');
        set(setNeedsToken());
        return;
      }
      log.error(i18n.t('errors:refreshHealthFailed'), e instanceof Error ? e : new Error(String(e)));
      set({ connectionState: 'failed' });
    }
  },

  retryConnection: async (cliPath?: string) => {
    set({ loading: true, error: null, connectionState: 'connecting' });
    try {
      let config = get().config || await tauri.getConfig();
      if (cliPath) {
        const engineId = normalizeEngineId(config.defaultEngine);
        if (engineId === 'codex') {
          await tauri.updateConfigPatch({
            codexCode: { ...(config.codexCode || { cliPath: 'codex' }), cliPath },
          });
        } else {
          await tauri.setClaudeCmd(cliPath);
        }
        config = await tauri.getConfig();
        set({ config });
      }

      const health = await tauri.healthCheck();
      const selectedHealth = getSelectedEngineHealth(config, health);
      const connectionState = selectedHealth.available ? 'success' : 'failed';

      if (connectionState === 'failed') {
        set({
          error: i18n.t('errors:cliNotFound', {
            name: selectedHealth.name,
            path: cliPath || selectedHealth.cliPath || i18n.t('errors:notSet'),
          }),
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
      log.error('retryConnection failed', e instanceof Error ? e : new Error(String(e)), { isWebAuth: isWebAuthError(e) });
      if (isWebAuthError(e)) {
        log.info('retryConnection → needsToken');
        set(setNeedsToken());
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
      // Web 模式下，认证成功拿到 config 即视为连接成功（CLI 可用性是服务端的事）
      const connectionState = (currentMode === 'http' || hasAnyEngineAvailable(health, config))
        ? 'success'
        : 'failed';
      if (config?.language) {
        i18n.changeLanguage(config.language);
      }
      if (config?.theme) {
        useThemeStore.getState().applyTheme(config.theme);
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

/** Check if an error is a web-mode auth error (401/403 in HTTP transport) */
function isWebAuthError(e: unknown): boolean {
  return currentMode === 'http' && isAuthError(e);
}

/** Set state to needsToken (auth required in web mode) */
function setNeedsToken(): Partial<ConfigState> {
  return {
    error: null,
    loading: false,
    isConnecting: false,
    connectionState: 'needsToken' as const,
  };
}
