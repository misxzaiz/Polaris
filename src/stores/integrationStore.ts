/**
 * 集成状态管理 Store
 *
 * 管理平台集成的连接状态、消息收发等。
 * 支持多实例管理。
 */

import { create } from 'zustand';
import type {
  Platform,
  IntegrationStatus,
  IntegrationMessage,
  IntegrationSession,
  SendTarget,
  MessageContent,
  QQBotConfig,
  FeishuConfig,
  PlatformInstance,
  InstanceId,
} from '../types';
import {
  startIntegration,
  stopIntegration,
  getIntegrationStatus,
  getAllIntegrationStatus,
  sendIntegrationMessage,
  getIntegrationSessions,
  initIntegration,
  onIntegrationMessage,
  // 实例管理
  addIntegrationInstance,
  removeIntegrationInstance,
  listIntegrationInstances,
  listIntegrationInstancesByPlatform,
  switchIntegrationInstance,
  disconnectIntegrationInstance,
  updateIntegrationInstance,
} from '../services/tauri';

interface IntegrationState {
  // 状态
  platforms: Record<Platform, IntegrationStatus>;
  messages: IntegrationMessage[];
  sessions: IntegrationSession[];
  initialized: boolean;
  loading: boolean;
  error: string | null;
  // 保存配置以便重新初始化
  _qqbotConfig: QQBotConfig | null;
  _feishuConfig: FeishuConfig | null;
  // 存储 unlisten 函数以便清理
  _unlisten: (() => void) | null;
  // 存储初始化 Promise 防止并发初始化
  _initPromise: Promise<void> | null;

  // 实例管理状态
  instances: PlatformInstance[];
  activeInstances: Record<Platform, InstanceId | null>;

  // Actions - 基础
  initialize: (qqbotConfig: QQBotConfig | null, feishuConfig?: FeishuConfig | null) => Promise<void>;
  startPlatform: (platform: Platform, qqbotConfig?: QQBotConfig, feishuConfig?: FeishuConfig) => Promise<void>;
  stopPlatform: (platform: Platform) => Promise<void>;
  sendMessage: (platform: Platform, target: SendTarget, content: MessageContent) => Promise<void>;
  refreshStatus: (platform: Platform) => Promise<void>;
  refreshAllStatus: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  clearMessages: () => void;
  cleanup: () => void;
  _addMessage: (message: IntegrationMessage) => void;
  _updateStatus: (platform: Platform, status: IntegrationStatus) => void;

  // Actions - 实例管理
  loadInstances: () => Promise<void>;
  loadInstancesByPlatform: (platform: Platform) => Promise<void>;
  addInstance: (instance: PlatformInstance) => Promise<InstanceId>;
  updateInstance: (instance: PlatformInstance) => Promise<void>;
  removeInstance: (instanceId: InstanceId) => Promise<void>;
  switchInstance: (instanceId: InstanceId) => Promise<void>;
  disconnectInstance: (platform: Platform) => Promise<void>;
  getActiveInstance: (platform: Platform) => PlatformInstance | null;
  setActiveInstance: (platform: Platform, instanceId: InstanceId | null) => void;
}

export const useIntegrationStore = create<IntegrationState>((set, get) => ({
  // 初始状态
  platforms: {} as Record<Platform, IntegrationStatus>,
  messages: [],
  sessions: [],
  initialized: false,
  loading: false,
  error: null,
  _qqbotConfig: null,
  _feishuConfig: null,
  _unlisten: null,
  _initPromise: null,
  // 实例管理初始状态
  instances: [],
  activeInstances: {} as Record<Platform, InstanceId | null>,

  // 初始化
  initialize: async (qqbotConfig, feishuConfig) => {
    // 保存配置
    set({ _qqbotConfig: qqbotConfig, _feishuConfig: feishuConfig ?? null });

    // 如果已初始化，不需要重复初始化
    if (get().initialized) {
      console.log('[IntegrationStore] Already initialized, skipping');
      return;
    }

    // 如果初始化正在进行中，等待现有初始化完成
    const existingPromise = get()._initPromise;
    if (existingPromise) {
      console.log('[IntegrationStore] Initialization in progress, waiting');
      return existingPromise;
    }

    // 开始初始化
    const initPromise = (async () => {
      set({ loading: true, error: null });

      try {
        // 初始化集成管理器
        await initIntegration(qqbotConfig, feishuConfig ?? null);

        // 监听消息事件
        const unlisten = await onIntegrationMessage((message) => {
          get()._addMessage(message);
        });

        // 获取初始状态
        const statuses = await getAllIntegrationStatus();
        const platforms = Object.entries(statuses).reduce((acc, [key, value]) => {
          acc[key as Platform] = value;
          return acc;
        }, {} as Record<Platform, IntegrationStatus>);

        set({
          platforms,
          initialized: true,
          loading: false,
          _unlisten: unlisten,
          _initPromise: null,
        });

        console.log('[IntegrationStore] Initialized with config:', qqbotConfig ? 'provided' : 'null');
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : '初始化失败',
          loading: false,
          _initPromise: null,
        });
        console.error('[IntegrationStore] Initialize error:', error);
      }
    })();

    set({ _initPromise: initPromise });
    return initPromise;
  },

  // 启动平台
  startPlatform: async (platform, qqbotConfig, feishuConfig) => {
    set({ loading: true, error: null });

    try {
      // 如果提供了新配置，更新并重新初始化
      if (qqbotConfig) {
        set({ _qqbotConfig: qqbotConfig });
      }
      if (feishuConfig) {
        set({ _feishuConfig: feishuConfig });
      }

      const qConfig = qqbotConfig || get()._qqbotConfig;
      const fConfig = feishuConfig || get()._feishuConfig;

      if (!get().initialized) {
        // 首次初始化：注册适配器 + 设置消息监听
        console.log('[IntegrationStore] Not initialized, initializing first...');
        await initIntegration(qConfig, fConfig);
        set({ initialized: true });

        // 监听消息事件
        const unlisten = await onIntegrationMessage((message) => {
          get()._addMessage(message);
        });
        set({ _unlisten: unlisten });
      } else if (qqbotConfig || feishuConfig) {
        // 已初始化但有新配置：重新注册适配器（不重复设置消息监听）
        console.log('[IntegrationStore] Already initialized, re-registering adapters with new config...');
        await initIntegration(qConfig, fConfig);
      }

      await startIntegration(platform);
      await get().refreshStatus(platform);
      set({ loading: false });
      console.log(`[IntegrationStore] Platform ${platform} started`);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '启动失败',
        loading: false,
      });
      console.error(`[IntegrationStore] Start ${platform} error:`, error);
      throw error; // 重新抛出错误以便调用方处理
    }
  },

  // 停止平台
  stopPlatform: async (platform) => {
    set({ loading: true, error: null });

    try {
      await stopIntegration(platform);
      await get().refreshStatus(platform);
      set({ loading: false });
      console.log(`[IntegrationStore] Platform ${platform} stopped`);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '停止失败',
        loading: false,
      });
      console.error(`[IntegrationStore] Stop ${platform} error:`, error);
    }
  },

  // 发送消息
  sendMessage: async (platform, target, content) => {
    try {
      await sendIntegrationMessage(platform, target, content);
      console.log(`[IntegrationStore] Message sent to ${platform}`);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '发送失败',
      });
      console.error(`[IntegrationStore] Send message error:`, error);
      throw error;
    }
  },

  // 刷新状态
  refreshStatus: async (platform) => {
    try {
      const status = await getIntegrationStatus(platform);
      if (status) {
        get()._updateStatus(platform, status);
      }
    } catch (error) {
      console.error(`[IntegrationStore] Refresh ${platform} status error:`, error);
    }
  },

  // 刷新所有状态
  refreshAllStatus: async () => {
    try {
      const statuses = await getAllIntegrationStatus();
      const platforms = Object.entries(statuses).reduce((acc, [key, value]) => {
        acc[key as Platform] = value;
        return acc;
      }, {} as Record<Platform, IntegrationStatus>);
      set({ platforms });
    } catch (error) {
      console.error('[IntegrationStore] Refresh all status error:', error);
    }
  },

  // 刷新会话列表
  refreshSessions: async () => {
    try {
      const sessions = await getIntegrationSessions();
      set({ sessions });
    } catch (error) {
      console.error('[IntegrationStore] Refresh sessions error:', error);
    }
  },

  // 清空消息
  clearMessages: () => {
    set({ messages: [] });
  },

  // 清理资源
  cleanup: () => {
    const { _unlisten } = get();
    if (_unlisten) {
      _unlisten();
      set({ _unlisten: null, initialized: false, _initPromise: null });
      console.log('[IntegrationStore] Cleaned up unlisten');
    }
  },

  // 内部方法：添加消息
  _addMessage: (message) => {
    set((state) => ({
      messages: [...state.messages, message].slice(-500), // 保留最近 500 条
    }));
  },

  // 内部方法：更新状态
  _updateStatus: (platform, status) => {
    set((state) => ({
      platforms: {
        ...state.platforms,
        [platform]: status,
      },
    }));
  },

  // ==================== 实例管理 Actions ====================

  // 加载所有实例
  loadInstances: async () => {
    try {
      const instances = await listIntegrationInstances();
      set({ instances });
      console.log('[IntegrationStore] Loaded instances:', instances.length);
    } catch (error) {
      console.error('[IntegrationStore] Load instances error:', error);
    }
  },

  // 按平台加载实例
  loadInstancesByPlatform: async (platform) => {
    try {
      const instances = await listIntegrationInstancesByPlatform(platform);
      set((state) => ({
        instances: [
          ...state.instances.filter((i) => i.platform !== platform),
          ...instances,
        ],
      }));
      console.log(`[IntegrationStore] Loaded ${platform} instances:`, instances.length);
    } catch (error) {
      console.error(`[IntegrationStore] Load ${platform} instances error:`, error);
    }
  },

  // 添加实例
  addInstance: async (instance) => {
    try {
      const id = await addIntegrationInstance(instance);
      set((state) => ({
        instances: [...state.instances, { ...instance, id }],
      }));
      console.log('[IntegrationStore] Added instance:', id);
      return id;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '添加实例失败' });
      console.error('[IntegrationStore] Add instance error:', error);
      throw error;
    }
  },

  // 更新实例
  updateInstance: async (instance) => {
    try {
      await updateIntegrationInstance(instance);
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instance.id ? instance : i
        ),
      }));
      console.log('[IntegrationStore] Updated instance:', instance.id);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '更新实例失败' });
      console.error('[IntegrationStore] Update instance error:', error);
      throw error;
    }
  },

  // 移除实例
  removeInstance: async (instanceId) => {
    try {
      await removeIntegrationInstance(instanceId);
      set((state) => {
        const newActiveInstances = { ...state.activeInstances };
        // 找到被移除实例的平台，清除其激活状态
        const removedInstance = state.instances.find((i) => i.id === instanceId);
        if (removedInstance) {
          newActiveInstances[removedInstance.platform] = null;
        }
        return {
          instances: state.instances.filter((i) => i.id !== instanceId),
          activeInstances: newActiveInstances,
        };
      });
      console.log('[IntegrationStore] Removed instance:', instanceId);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '移除实例失败' });
      console.error('[IntegrationStore] Remove instance error:', error);
      throw error;
    }
  },

  // 切换实例
  switchInstance: async (instanceId) => {
    set({ loading: true, error: null });
    try {
      await switchIntegrationInstance(instanceId);

      // 更新激活状态
      const instance = get().instances.find((i) => i.id === instanceId);
      if (instance) {
        set((state) => ({
          activeInstances: {
            ...state.activeInstances,
            [instance.platform]: instanceId,
          },
        }));
      }

      // 刷新状态
      if (instance) {
        await get().refreshStatus(instance.platform);
      }

      set({ loading: false });
      console.log('[IntegrationStore] Switched to instance:', instanceId);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '切换实例失败',
        loading: false,
      });
      console.error('[IntegrationStore] Switch instance error:', error);
      throw error;
    }
  },

  // 断开实例
  disconnectInstance: async (platform) => {
    set({ loading: true, error: null });
    try {
      await disconnectIntegrationInstance(platform);
      set((state) => ({
        activeInstances: {
          ...state.activeInstances,
          [platform]: null,
        },
      }));
      await get().refreshStatus(platform);
      set({ loading: false });
      console.log('[IntegrationStore] Disconnected instance:', platform);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '断开实例失败',
        loading: false,
      });
      console.error('[IntegrationStore] Disconnect instance error:', error);
      throw error;
    }
  },

  // 获取激活的实例
  getActiveInstance: (platform) => {
    const { instances, activeInstances } = get();
    const activeId = activeInstances[platform];
    if (!activeId) return null;
    return instances.find((i) => i.id === activeId) || null;
  },

  // 设置激活的实例
  setActiveInstance: (platform, instanceId) => {
    set((state) => ({
      activeInstances: {
        ...state.activeInstances,
        [platform]: instanceId,
      },
    }));
  },
}));

// 选择器
export const useIntegrationStatus = (platform: Platform) =>
  useIntegrationStore((state) => state.platforms[platform]);

export const useIntegrationMessages = () =>
  useIntegrationStore((state) => state.messages);

export const useIntegrationSessions = () =>
  useIntegrationStore((state) => state.sessions);

export const useIntegrationLoading = () =>
  useIntegrationStore((state) => state.loading);

export const useIntegrationError = () =>
  useIntegrationStore((state) => state.error);

// 获取激活实例的 ID（稳定值）
export const useActiveInstanceId = (platform: Platform) =>
  useIntegrationStore((state) => state.activeInstances[platform] ?? null);

// 实例管理选择器 - 使用浅比较避免无限循环
export const useIntegrationInstances = (platform?: Platform) => {
  const allInstances = useIntegrationStore((state) => state.instances);
  // 使用 useMemo 缓存过滤结果
  return platform
    ? allInstances.filter((i) => i.platform === platform)
    : allInstances;
};

// 获取激活实例 - 通过 ID 查找，避免对象引用变化
export const useActiveIntegrationInstance = (platform: Platform) => {
  const activeId = useActiveInstanceId(platform);
  const instances = useIntegrationStore((state) => state.instances);

  // 直接返回找到的实例或 null
  if (!activeId) return null;
  return instances.find((i) => i.id === activeId) ?? null;
};

export const useHasActiveInstance = (platform: Platform) =>
  useIntegrationStore((state) => !!state.activeInstances[platform]);
