/**
 * IntegrationStore 单元测试
 *
 * 测试集成状态管理的核心功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initIntegration,
  onIntegrationMessage,
  getAllIntegrationStatus,
  getIntegrationStatus,
  startIntegration,
  stopIntegration,
} from '../services/tauri';

// Mock tauri services
vi.mock('../services/tauri', () => ({
  initIntegration: vi.fn(),
  onIntegrationMessage: vi.fn(),
  getAllIntegrationStatus: vi.fn(),
  getIntegrationStatus: vi.fn(),
  startIntegration: vi.fn(),
  stopIntegration: vi.fn(),
  sendIntegrationMessage: vi.fn(),
  getIntegrationSessions: vi.fn(),
  listIntegrationInstances: vi.fn(),
  listIntegrationInstancesByPlatform: vi.fn(),
  addIntegrationInstance: vi.fn(),
  updateIntegrationInstance: vi.fn(),
  removeIntegrationInstance: vi.fn(),
  switchIntegrationInstance: vi.fn(),
  disconnectIntegrationInstance: vi.fn(),
}));

// 导入 mock 函数以供使用
import {
  listIntegrationInstances,
  listIntegrationInstancesByPlatform,
  addIntegrationInstance,
  updateIntegrationInstance,
  removeIntegrationInstance,
  switchIntegrationInstance,
  disconnectIntegrationInstance,
  getIntegrationSessions,
  sendIntegrationMessage,
} from '../services/tauri';

import { useIntegrationStore } from './integrationStore';

describe('integrationStore', () => {
  // 存储每个测试创建的 unlisten mock
  let currentUnlisten: ReturnType<typeof vi.fn> | null = null;

  beforeEach(() => {
    // 重置 store 状态
    useIntegrationStore.setState({
      platforms: {} as Record<string, unknown>,
      messages: [],
      sessions: [],
      initialized: false,
      loading: false,
      error: null,
      _qqbotConfig: null,
      _unlisten: null,
      _initPromise: null,
      instances: [],
      activeInstances: {} as Record<string, string | null>,
    });

    // 设置默认 mock 返回值
    vi.mocked(initIntegration).mockResolvedValue(undefined);
    // 每次 onIntegrationMessage 被调用时，创建新的 mock 函数并存储
    vi.mocked(onIntegrationMessage).mockImplementation(() => {
      currentUnlisten = vi.fn();
      return Promise.resolve(currentUnlisten);
    });
    vi.mocked(getAllIntegrationStatus).mockResolvedValue({
      qqbot: { connected: false },
    });
    vi.mocked(getIntegrationStatus).mockResolvedValue({ connected: true });
    vi.mocked(startIntegration).mockResolvedValue(undefined);
    vi.mocked(stopIntegration).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    currentUnlisten = null;
  });

  describe('initialize', () => {
    it('应成功初始化并设置 initialized 为 true', async () => {
      const { initialize } = useIntegrationStore.getState();

      await initialize(null);

      expect(useIntegrationStore.getState().initialized).toBe(true);
      expect(useIntegrationStore.getState().loading).toBe(false);
      expect(useIntegrationStore.getState().error).toBeNull();
    });

    it('应存储 unlisten 函数到 store 内部', async () => {
      const { initialize } = useIntegrationStore.getState();
      await initialize(null);

      // currentUnlisten 应该被设置
      expect(currentUnlisten).not.toBeNull();
      expect(useIntegrationStore.getState()._unlisten).toBe(currentUnlisten);
    });

    it('重复初始化应跳过', async () => {
      const { initialize } = useIntegrationStore.getState();

      await initialize(null);
      expect(useIntegrationStore.getState().initialized).toBe(true);

      // 重置 mock 计数
      vi.mocked(initIntegration).mockClear();

      await initialize(null);

      // 验证 initIntegration 没有被再次调用
      expect(initIntegration).toHaveBeenCalledTimes(0);
    });
  });

  describe('cleanup', () => {
    it('应调用 unlisten 函数并重置状态', async () => {
      const { initialize } = useIntegrationStore.getState();
      await initialize(null);

      // currentUnlisten 应该被设置
      expect(currentUnlisten).not.toBeNull();
      expect(useIntegrationStore.getState()._unlisten).toBe(currentUnlisten);

      const { cleanup } = useIntegrationStore.getState();
      cleanup();

      expect(currentUnlisten).toHaveBeenCalled();
      expect(useIntegrationStore.getState()._unlisten).toBeNull();
    });

    it('无 unlisten 时 cleanup 应安全处理', () => {
      const { cleanup } = useIntegrationStore.getState();

      // 不应抛出错误
      expect(() => cleanup()).not.toThrow();
      expect(useIntegrationStore.getState()._unlisten).toBeNull();
    });

    it('多次调用 cleanup 应幂等', async () => {
      const { initialize } = useIntegrationStore.getState();
      await initialize(null);

      expect(currentUnlisten).not.toBeNull();

      const { cleanup } = useIntegrationStore.getState();
      cleanup();
      cleanup();
      cleanup();

      // unlisten 只应被调用一次
      expect(currentUnlisten).toHaveBeenCalledTimes(1);
    });
  });

  describe('_unlisten 存储', () => {
    it('不应使用 window 对象存储 unlisten', async () => {
      // 清除可能存在的 window.__integrationUnlisten
      delete (window as unknown as { __integrationUnlisten?: () => void }).__integrationUnlisten;

      const { initialize } = useIntegrationStore.getState();
      await initialize(null);

      // window.__integrationUnlisten 不应被设置
      expect((window as unknown as { __integrationUnlisten?: () => void }).__integrationUnlisten).toBeUndefined();

      // 应存储在 store 内部
      expect(useIntegrationStore.getState()._unlisten).toBeDefined();
    });
  });

  describe('startPlatform', () => {
    it('未初始化时应先初始化', async () => {
      const { startPlatform } = useIntegrationStore.getState();

      await startPlatform('qqbot', { appId: 'test', appSecret: 'test' });

      expect(useIntegrationStore.getState().initialized).toBe(true);
      expect(currentUnlisten).not.toBeNull();
      expect(useIntegrationStore.getState()._unlisten).toBe(currentUnlisten);
    });

    it('已初始化时不应重复设置 unlisten', async () => {
      const { initialize } = useIntegrationStore.getState();
      await initialize(null);

      const firstUnlisten = currentUnlisten;
      expect(firstUnlisten).not.toBeNull();
      expect(useIntegrationStore.getState()._unlisten).toBe(firstUnlisten);

      // 重置 currentUnlisten 以跟踪新的调用
      currentUnlisten = null;

      // 第二次 startPlatform - 已初始化，不应设置新的 unlisten
      const { startPlatform } = useIntegrationStore.getState();
      await startPlatform('qqbot', { appId: 'test', appSecret: 'test' });

      // currentUnlisten 应该还是 null（没有新的调用）
      expect(currentUnlisten).toBeNull();
      // unlisten 应保持为第一个
      expect(useIntegrationStore.getState()._unlisten).toBe(firstUnlisten);
    });
  });

  describe('消息管理', () => {
    it('_addMessage 应添加消息到列表', () => {
      const { _addMessage } = useIntegrationStore.getState();

      _addMessage({
        platform: 'qqbot',
        type: 'text',
        content: 'Hello',
        timestamp: Date.now(),
      });

      expect(useIntegrationStore.getState().messages).toHaveLength(1);
      expect(useIntegrationStore.getState().messages[0].content).toBe('Hello');
    });

    it('消息列表应限制为最近 500 条', () => {
      const { _addMessage } = useIntegrationStore.getState();

      // 添加 501 条消息
      for (let i = 0; i < 501; i++) {
        _addMessage({
          platform: 'qqbot',
          type: 'text',
          content: `Message ${i}`,
          timestamp: Date.now(),
        });
      }

      expect(useIntegrationStore.getState().messages).toHaveLength(500);
      // 最早的消息应被移除
      expect(useIntegrationStore.getState().messages[0].content).toBe('Message 1');
    });

    it('clearMessages 应清空消息列表', () => {
      const { _addMessage, clearMessages } = useIntegrationStore.getState();

      _addMessage({
        platform: 'qqbot',
        type: 'text',
        content: 'Hello',
        timestamp: Date.now(),
      });

      expect(useIntegrationStore.getState().messages).toHaveLength(1);

      clearMessages();

      expect(useIntegrationStore.getState().messages).toHaveLength(0);
    });
  });

  describe('错误处理', () => {
    it('初始化失败应设置错误信息', async () => {
      vi.mocked(initIntegration).mockRejectedValueOnce(new Error('初始化失败'));

      const { initialize } = useIntegrationStore.getState();
      await initialize(null);

      expect(useIntegrationStore.getState().error).toBe('初始化失败');
      expect(useIntegrationStore.getState().initialized).toBe(false);
    });
  });

  describe('StrictMode 场景', () => {
    it('多次初始化后 cleanup 应正确清理', async () => {
      const { initialize } = useIntegrationStore.getState();

      // 模拟 StrictMode 双重挂载：第一次初始化
      await initialize(null);
      expect(useIntegrationStore.getState().initialized).toBe(true);
      expect(currentUnlisten).not.toBeNull();

      const savedUnlisten = currentUnlisten;

      // 第二次初始化应该跳过
      await initialize(null);
      expect(useIntegrationStore.getState().initialized).toBe(true);
      // currentUnlisten 不应变化
      expect(currentUnlisten).toBe(savedUnlisten);

      // cleanup 应只调用一次 unlisten
      const { cleanup } = useIntegrationStore.getState();
      cleanup();
      expect(savedUnlisten).toHaveBeenCalledTimes(1);
      expect(useIntegrationStore.getState()._unlisten).toBeNull();
    });

    it('cleanup 后可重新初始化', async () => {
      const { initialize } = useIntegrationStore.getState();
      await initialize(null);

      const firstUnlisten = currentUnlisten;
      expect(firstUnlisten).not.toBeNull();
      expect(useIntegrationStore.getState()._unlisten).toBe(firstUnlisten);

      // 清理
      const { cleanup } = useIntegrationStore.getState();
      cleanup();
      expect(useIntegrationStore.getState().initialized).toBe(false);
      expect(useIntegrationStore.getState()._unlisten).toBeNull();

      // 重置 currentUnlisten
      currentUnlisten = null;

      // 重新初始化
      await initialize(null);
      expect(useIntegrationStore.getState().initialized).toBe(true);
      expect(currentUnlisten).not.toBeNull();
      expect(currentUnlisten).not.toBe(firstUnlisten);
    });

    it('组件卸载场景应正确清理资源', async () => {
      // 模拟组件挂载时初始化
      const { initialize } = useIntegrationStore.getState();
      await initialize(null);

      expect(currentUnlisten).not.toBeNull();
      expect(useIntegrationStore.getState()._unlisten).toBe(currentUnlisten);

      // 模拟组件卸载时清理
      const { cleanup } = useIntegrationStore.getState();
      cleanup();

      // 验证资源已清理
      expect(currentUnlisten).toHaveBeenCalled();
      expect(useIntegrationStore.getState()._unlisten).toBeNull();
      expect(useIntegrationStore.getState().initialized).toBe(false);
    });
  });

  describe('unlisten 存储安全性', () => {
    it('startPlatform 未初始化时应设置 unlisten', async () => {
      const { startPlatform } = useIntegrationStore.getState();

      await startPlatform('qqbot', { appId: 'test', appSecret: 'test' });

      expect(currentUnlisten).not.toBeNull();
      expect(useIntegrationStore.getState()._unlisten).toBe(currentUnlisten);
    });

    it('startPlatform 已初始化时不应覆盖 unlisten', async () => {
      const { initialize } = useIntegrationStore.getState();
      await initialize(null);

      const firstUnlisten = currentUnlisten;
      expect(firstUnlisten).not.toBeNull();
      expect(useIntegrationStore.getState()._unlisten).toBe(firstUnlisten);

      // 重置 currentUnlisten
      currentUnlisten = null;

      // startPlatform 不应调用 onIntegrationMessage
      const { startPlatform } = useIntegrationStore.getState();
      await startPlatform('qqbot', { appId: 'test', appSecret: 'test' });

      // currentUnlisten 应该还是 null（没有新的调用）
      expect(currentUnlisten).toBeNull();
      expect(useIntegrationStore.getState()._unlisten).toBe(firstUnlisten);
    });
  });

  describe('实例管理', () => {
    const mockInstance = {
      id: 'instance-1',
      name: 'Test QQ Bot',
      platform: 'qqbot' as const,
      config: {
        type: 'qqbot' as const,
        enabled: true,
        appId: 'test-app-id',
        clientSecret: 'test-secret',
        sandbox: false,
        displayMode: 'chat' as const,
        autoConnect: false,
      },
      createdAt: '2026-03-18T00:00:00Z',
      enabled: true,
    };

    describe('loadInstances', () => {
      it('应成功加载实例列表', async () => {
        vi.mocked(listIntegrationInstances).mockResolvedValueOnce([mockInstance]);

        const { loadInstances } = useIntegrationStore.getState();
        await loadInstances();

        expect(useIntegrationStore.getState().instances).toHaveLength(1);
        expect(useIntegrationStore.getState().instances[0].id).toBe('instance-1');
      });

      it('加载失败时应记录错误日志', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(listIntegrationInstances).mockRejectedValueOnce(new Error('加载失败'));

        const { loadInstances } = useIntegrationStore.getState();
        await loadInstances();

        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
      });
    });

    describe('loadInstancesByPlatform', () => {
      it('应按平台加载实例并替换现有平台数据', async () => {
        // 预设一个不同平台的实例
        useIntegrationStore.setState({
          instances: [{ ...mockInstance, id: 'instance-0', platform: 'wechat' }],
        });

        vi.mocked(listIntegrationInstancesByPlatform).mockResolvedValueOnce([mockInstance]);

        const { loadInstancesByPlatform } = useIntegrationStore.getState();
        await loadInstancesByPlatform('qqbot');

        const instances = useIntegrationStore.getState().instances;
        expect(instances).toHaveLength(2);
        expect(instances.find((i) => i.platform === 'qqbot')?.id).toBe('instance-1');
        expect(instances.find((i) => i.platform === 'wechat')?.id).toBe('instance-0');
      });
    });

    describe('addInstance', () => {
      it('应成功添加实例并返回 ID', async () => {
        vi.mocked(addIntegrationInstance).mockResolvedValueOnce('new-instance-id');

        const { addInstance } = useIntegrationStore.getState();
        const newInstance = { ...mockInstance, id: undefined } as unknown as typeof mockInstance;
        const id = await addInstance(newInstance);

        expect(id).toBe('new-instance-id');
        expect(useIntegrationStore.getState().instances).toHaveLength(1);
        expect(useIntegrationStore.getState().instances[0].id).toBe('new-instance-id');
      });

      it('添加失败应设置错误信息', async () => {
        vi.mocked(addIntegrationInstance).mockRejectedValueOnce(new Error('添加失败'));

        const { addInstance } = useIntegrationStore.getState();
        await expect(addInstance(mockInstance)).rejects.toThrow('添加失败');

        expect(useIntegrationStore.getState().error).toBe('添加失败');
      });
    });

    describe('updateInstance', () => {
      it('应成功更新实例', async () => {
        useIntegrationStore.setState({ instances: [mockInstance] });

        vi.mocked(updateIntegrationInstance).mockResolvedValueOnce(undefined);

        const { updateInstance } = useIntegrationStore.getState();
        const updatedInstance = { ...mockInstance, name: 'Updated Name' };
        await updateInstance(updatedInstance);

        expect(useIntegrationStore.getState().instances[0].name).toBe('Updated Name');
      });

      it('更新失败应设置错误信息', async () => {
        useIntegrationStore.setState({ instances: [mockInstance] });

        vi.mocked(updateIntegrationInstance).mockRejectedValueOnce(new Error('更新失败'));

        const { updateInstance } = useIntegrationStore.getState();
        await expect(updateInstance(mockInstance)).rejects.toThrow('更新失败');

        expect(useIntegrationStore.getState().error).toBe('更新失败');
      });
    });

    describe('removeInstance', () => {
      it('应成功移除实例', async () => {
        useIntegrationStore.setState({ instances: [mockInstance] });

        vi.mocked(removeIntegrationInstance).mockResolvedValueOnce(undefined);

        const { removeInstance } = useIntegrationStore.getState();
        await removeInstance('instance-1');

        expect(useIntegrationStore.getState().instances).toHaveLength(0);
      });

      it('移除实例时应清除对应的激活状态', async () => {
        useIntegrationStore.setState({
          instances: [mockInstance],
          activeInstances: { qqbot: 'instance-1' },
        });

        vi.mocked(removeIntegrationInstance).mockResolvedValueOnce(undefined);

        const { removeInstance } = useIntegrationStore.getState();
        await removeInstance('instance-1');

        expect(useIntegrationStore.getState().activeInstances.qqbot).toBeNull();
      });

      it('移除失败应设置错误信息', async () => {
        useIntegrationStore.setState({ instances: [mockInstance] });

        vi.mocked(removeIntegrationInstance).mockRejectedValueOnce(new Error('移除失败'));

        const { removeInstance } = useIntegrationStore.getState();
        await expect(removeInstance('instance-1')).rejects.toThrow('移除失败');

        expect(useIntegrationStore.getState().error).toBe('移除失败');
      });
    });

    describe('switchInstance', () => {
      beforeEach(() => {
        useIntegrationStore.setState({ instances: [mockInstance] });
        vi.mocked(switchIntegrationInstance).mockResolvedValue(undefined);
        vi.mocked(getIntegrationStatus).mockResolvedValue({ connected: true });
      });

      it('应成功切换实例并更新激活状态', async () => {
        const { switchInstance } = useIntegrationStore.getState();
        await switchInstance('instance-1');

        expect(useIntegrationStore.getState().activeInstances.qqbot).toBe('instance-1');
      });

      it('切换实例后应刷新平台状态', async () => {
        const { switchInstance } = useIntegrationStore.getState();
        await switchInstance('instance-1');

        expect(getIntegrationStatus).toHaveBeenCalledWith('qqbot');
      });

      it('切换失败应设置错误信息', async () => {
        vi.mocked(switchIntegrationInstance).mockRejectedValueOnce(new Error('切换失败'));

        const { switchInstance } = useIntegrationStore.getState();
        await expect(switchInstance('instance-1')).rejects.toThrow('切换失败');

        expect(useIntegrationStore.getState().error).toBe('切换失败');
      });
    });

    describe('disconnectInstance', () => {
      beforeEach(() => {
        vi.mocked(disconnectIntegrationInstance).mockResolvedValue(undefined);
        vi.mocked(getIntegrationStatus).mockResolvedValue({ connected: false });
      });

      it('应成功断开实例并清除激活状态', async () => {
        useIntegrationStore.setState({
          activeInstances: { qqbot: 'instance-1' },
        });

        const { disconnectInstance } = useIntegrationStore.getState();
        await disconnectInstance('qqbot');

        expect(useIntegrationStore.getState().activeInstances.qqbot).toBeNull();
      });

      it('断开后应刷新平台状态', async () => {
        const { disconnectInstance } = useIntegrationStore.getState();
        await disconnectInstance('qqbot');

        expect(getIntegrationStatus).toHaveBeenCalledWith('qqbot');
      });
    });

    describe('getActiveInstance', () => {
      it('应返回激活的实例', () => {
        useIntegrationStore.setState({
          instances: [mockInstance],
          activeInstances: { qqbot: 'instance-1' },
        });

        const { getActiveInstance } = useIntegrationStore.getState();
        const activeInstance = getActiveInstance('qqbot');

        expect(activeInstance?.id).toBe('instance-1');
      });

      it('无激活实例时应返回 null', () => {
        useIntegrationStore.setState({
          instances: [mockInstance],
          activeInstances: { qqbot: null },
        });

        const { getActiveInstance } = useIntegrationStore.getState();
        const activeInstance = getActiveInstance('qqbot');

        expect(activeInstance).toBeNull();
      });

      it('激活的实例 ID 不存在于列表中时应返回 null', () => {
        useIntegrationStore.setState({
          instances: [mockInstance],
          activeInstances: { qqbot: 'non-existent-id' },
        });

        const { getActiveInstance } = useIntegrationStore.getState();
        const activeInstance = getActiveInstance('qqbot');

        expect(activeInstance).toBeNull();
      });
    });

    describe('setActiveInstance', () => {
      it('应设置激活的实例', () => {
        const { setActiveInstance } = useIntegrationStore.getState();
        setActiveInstance('qqbot', 'instance-1');

        expect(useIntegrationStore.getState().activeInstances.qqbot).toBe('instance-1');
      });

      it('应能清除激活状态', () => {
        useIntegrationStore.setState({
          activeInstances: { qqbot: 'instance-1' },
        });

        const { setActiveInstance } = useIntegrationStore.getState();
        setActiveInstance('qqbot', null);

        expect(useIntegrationStore.getState().activeInstances.qqbot).toBeNull();
      });
    });
  });

  describe('并发初始化', () => {
    it('并发调用 initialize 应只初始化一次', async () => {
      const { initialize } = useIntegrationStore.getState();

      // 并发调用 initialize
      const promises = [
        initialize(null),
        initialize(null),
        initialize(null),
      ];

      await Promise.all(promises);

      // initIntegration 应只被调用一次
      expect(initIntegration).toHaveBeenCalledTimes(1);
      expect(onIntegrationMessage).toHaveBeenCalledTimes(1);
      expect(useIntegrationStore.getState().initialized).toBe(true);
    });

    it('初始化进行中时后续调用应跳过', async () => {
      // 创建一个延迟 resolve 的 mock
      let resolveInit: () => void;
      const initPromise = new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
      vi.mocked(initIntegration).mockImplementationOnce(() => initPromise);

      const { initialize } = useIntegrationStore.getState();

      // 第一次调用（正在进行中）
      const firstCall = initialize(null);

      // 状态应该是 loading
      expect(useIntegrationStore.getState().loading).toBe(true);

      // 第二次调用（应跳过）
      const secondCall = initialize(null);

      // 完成初始化
      resolveInit!();
      await Promise.all([firstCall, secondCall]);

      // 应只初始化一次
      expect(initIntegration).toHaveBeenCalledTimes(1);
    });
  });

  describe('状态刷新', () => {
    describe('refreshStatus', () => {
      it('应成功刷新单个平台状态', async () => {
        vi.mocked(getIntegrationStatus).mockResolvedValueOnce({ connected: true, status: 'online' });

        const { refreshStatus } = useIntegrationStore.getState();
        await refreshStatus('qqbot');

        expect(getIntegrationStatus).toHaveBeenCalledWith('qqbot');
      });

      it('刷新失败应记录错误日志', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(getIntegrationStatus).mockRejectedValueOnce(new Error('刷新失败'));

        const { refreshStatus } = useIntegrationStore.getState();
        await refreshStatus('qqbot');

        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
      });

      it('状态为 null 时不应更新', async () => {
        vi.mocked(getIntegrationStatus).mockResolvedValueOnce(null as unknown as { connected: boolean });

        // 重置 store 状态以避免被之前的测试污染
        useIntegrationStore.setState({
          platforms: {} as Record<string, unknown>,
          _updateStatus: useIntegrationStore.getState()._updateStatus,
        });
        const originalUpdateStatus = useIntegrationStore.getState()._updateStatus;
        const updateSpy = vi.fn();

        // 临时覆盖 _updateStatus
        useIntegrationStore.setState({ _updateStatus: updateSpy as unknown as typeof originalUpdateStatus });

        const { refreshStatus } = useIntegrationStore.getState();
        await refreshStatus('qqbot');

        expect(updateSpy).not.toHaveBeenCalled();

        // 恢复原始 _updateStatus
        useIntegrationStore.setState({ _updateStatus: originalUpdateStatus });
      });
    });

    describe('refreshAllStatus', () => {
      it('应成功刷新所有平台状态', async () => {
        vi.mocked(getAllIntegrationStatus).mockResolvedValueOnce({
          qqbot: { connected: true },
          wechat: { connected: false },
        });

        const { refreshAllStatus } = useIntegrationStore.getState();
        await refreshAllStatus();

        const platforms = useIntegrationStore.getState().platforms;
        expect(platforms.qqbot).toEqual({ connected: true });
        expect(platforms.wechat).toEqual({ connected: false });
      });

      it('刷新失败应记录错误日志', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(getAllIntegrationStatus).mockRejectedValueOnce(new Error('刷新失败'));

        const { refreshAllStatus } = useIntegrationStore.getState();
        await refreshAllStatus();

        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
      });
    });

    describe('refreshSessions', () => {
      it('应成功刷新会话列表', async () => {
        const mockSessions = [
          { id: 'session-1', platform: 'qqbot', name: 'Test Session' },
        ];
        vi.mocked(getIntegrationSessions).mockResolvedValueOnce(mockSessions);

        const { refreshSessions } = useIntegrationStore.getState();
        await refreshSessions();

        expect(useIntegrationStore.getState().sessions).toEqual(mockSessions);
      });

      it('刷新失败应记录错误日志', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(getIntegrationSessions).mockRejectedValueOnce(new Error('刷新失败'));

        const { refreshSessions } = useIntegrationStore.getState();
        await refreshSessions();

        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
      });
    });
  });

  describe('平台操作', () => {
    describe('stopPlatform', () => {
      beforeEach(() => {
        vi.mocked(stopIntegration).mockResolvedValue(undefined);
        vi.mocked(getIntegrationStatus).mockResolvedValue({ connected: false });
      });

      it('应成功停止平台', async () => {
        const { stopPlatform } = useIntegrationStore.getState();
        await stopPlatform('qqbot');

        expect(stopIntegration).toHaveBeenCalledWith('qqbot');
        expect(getIntegrationStatus).toHaveBeenCalledWith('qqbot');
      });

      it('停止失败应设置错误信息', async () => {
        vi.mocked(stopIntegration).mockRejectedValueOnce(new Error('停止失败'));

        const { stopPlatform } = useIntegrationStore.getState();
        await stopPlatform('qqbot');

        expect(useIntegrationStore.getState().error).toBe('停止失败');
      });
    });
  });

  describe('发送消息', () => {
    it('应成功发送消息', async () => {
      vi.mocked(sendIntegrationMessage).mockResolvedValueOnce(undefined);

      const { sendMessage } = useIntegrationStore.getState();
      await sendMessage('qqbot', { type: 'private', id: 'user-1' }, { type: 'text', content: 'Hello' });

      expect(sendIntegrationMessage).toHaveBeenCalledWith(
        'qqbot',
        { type: 'private', id: 'user-1' },
        { type: 'text', content: 'Hello' }
      );
    });

    it('发送失败应设置错误信息并抛出异常', async () => {
      vi.mocked(sendIntegrationMessage).mockRejectedValueOnce(new Error('发送失败'));

      const { sendMessage } = useIntegrationStore.getState();
      await expect(
        sendMessage('qqbot', { type: 'private', id: 'user-1' }, { type: 'text', content: 'Hello' })
      ).rejects.toThrow('发送失败');

      expect(useIntegrationStore.getState().error).toBe('发送失败');
    });
  });

  describe('_updateStatus', () => {
    it('应更新指定平台的状态', () => {
      useIntegrationStore.setState({
        platforms: { qqbot: { connected: false } },
      });

      const { _updateStatus } = useIntegrationStore.getState();
      _updateStatus('qqbot', { connected: true, status: 'online' });

      expect(useIntegrationStore.getState().platforms.qqbot).toEqual({
        connected: true,
        status: 'online',
      });
    });

    it('添加新平台状态时应扩展 platforms 对象', () => {
      useIntegrationStore.setState({
        platforms: {},
      });

      const { _updateStatus } = useIntegrationStore.getState();
      _updateStatus('wechat', { connected: true });

      expect(useIntegrationStore.getState().platforms.wechat).toEqual({ connected: true });
    });

    it('应保留其他平台的状态不变', () => {
      useIntegrationStore.setState({
        platforms: {
          qqbot: { connected: true },
          wechat: { connected: false },
        },
      });

      const { _updateStatus } = useIntegrationStore.getState();
      _updateStatus('qqbot', { connected: false });

      const platforms = useIntegrationStore.getState().platforms;
      expect(platforms.qqbot).toEqual({ connected: false });
      expect(platforms.wechat).toEqual({ connected: false });
    });
  });
});