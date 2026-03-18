/**
 * QQ Bot 集成配置 Tab
 *
 * 支持多实例管理：
 * - 实例列表（添加、删除、切换）
 * - 当前实例配置编辑
 * - 连接控制
 */

import { useState, useEffect, useRef } from 'react';
import {
  useIntegrationStore,
  useIntegrationStatus,
  useIntegrationInstances,
  useActiveIntegrationInstance,
} from '../../../stores';
import type { Config, IntegrationDisplayMode, PlatformInstance } from '../../../types';
import { createLogger } from '../../../utils/logger';

const log = createLogger('QQBotTab');

interface QQBotTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

/** 生成唯一 ID */
function generateId(): string {
  return `qqbot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/** 创建空实例 */
function createEmptyInstance(): PlatformInstance {
  return {
    id: generateId(),
    name: '新机器人',
    platform: 'qqbot',
    config: {
      type: 'qqbot',
      enabled: true,
      appId: '',
      clientSecret: '',
      sandbox: true,
      displayMode: 'chat',
      autoConnect: false,
    },
    createdAt: new Date().toISOString(),
    enabled: true,
  };
}

export function QQBotTab({ config, onConfigChange, loading }: QQBotTabProps) {
  const qqbotStatus = useIntegrationStatus('qqbot');
  const instances = useIntegrationInstances('qqbot');
  const activeInstance = useActiveIntegrationInstance('qqbot');
  const {
    startPlatform,
    stopPlatform,
    loading: integrationLoading,
    loadInstances,
    addInstance,
    updateInstance,
    removeInstance,
    switchInstance,
  } = useIntegrationStore();

  const isConnected = qqbotStatus?.connected ?? false;

  // 本地编辑状态
  const [editingInstance, setEditingInstance] = useState<PlatformInstance | null>(null);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // 用于跟踪是否已初始化编辑实例
  const initializedRef = useRef(false);

  // 加载实例列表（只执行一次）
  useEffect(() => {
    loadInstances();
  }, [loadInstances]);

  // 同步编辑状态 - 当有激活实例但未初始化编辑状态时
  useEffect(() => {
    // 只在首次且有激活实例时设置
    if (!initializedRef.current && activeInstance && !editingInstance) {
      initializedRef.current = true;
      setEditingInstance(activeInstance);
    }
  }, [activeInstance?.id, editingInstance?.id]); // 只比较 ID，避免对象引用变化

  // 启用/禁用 QQ Bot 集成
  const handleEnabledChange = (enabled: boolean) => {
    onConfigChange({
      ...config,
      qqbot: { ...config.qqbot, enabled }
    });
  };

  // 保存实例配置
  const handleSave = async () => {
    if (!editingInstance) return;
    setSaving(true);
    try {
      // 检查是否是新实例（还未保存到后端）
      const existingInstance = instances.find((i) => i.id === editingInstance.id);
      if (!existingInstance) {
        // 新实例：添加
        await addInstance(editingInstance);
      } else {
        // 已有实例：更新
        await updateInstance(editingInstance);
      }
      setHasChanges(false);
    } catch (error) {
      console.error('Failed to save instance:', error);
    } finally {
      setSaving(false);
    }
  };

  // 添加新实例
  const handleAddInstance = () => {
    const newInstance = createEmptyInstance();
    setEditingInstance(newInstance);
    setHasChanges(true);
  };

  // 删除实例
  const handleRemoveInstance = async (instanceId: string) => {
    if (!confirm('确定要删除此实例吗？')) return;
    try {
      await removeInstance(instanceId);
      if (editingInstance?.id === instanceId) {
        setEditingInstance(null);
        setHasChanges(false);
      }
    } catch (error) {
      log.error('删除实例失败', error instanceof Error ? error : new Error(String(error)));
    }
  };

  // 切换到实例
  const handleSwitchInstance = async (instanceId: string) => {
    // 如果有未保存的更改，提示
    if (hasChanges) {
      if (!confirm('有未保存的更改，确定要切换吗？')) return;
    }
    try {
      // 如果有连接，先断开
      if (isConnected) {
        await stopPlatform('qqbot');
      }
      await switchInstance(instanceId);
      setHasChanges(false);
    } catch (error) {
      console.error('Failed to switch instance:', error);
    }
  };

  // 连接
  const handleConnect = async () => {
    if (!editingInstance) return;
    try {
      // 先保存配置
      if (hasChanges) {
        setSaving(true);
        const existingInstance = instances.find((i) => i.id === editingInstance.id);
        if (!existingInstance) {
          await addInstance(editingInstance);
        } else {
          await updateInstance(editingInstance);
        }
        setHasChanges(false);
        setSaving(false);
      }

      // 如果当前实例不是激活的，先切换
      if (activeInstance?.id !== editingInstance.id) {
        await switchInstance(editingInstance.id);
      }
      // 将配置转换为 QQBotConfig 格式
      const qqbotConfig = {
        enabled: editingInstance.config.enabled,
        appId: editingInstance.config.appId,
        clientSecret: editingInstance.config.clientSecret,
        sandbox: editingInstance.config.sandbox,
        displayMode: editingInstance.config.displayMode,
        autoConnect: editingInstance.config.autoConnect,
      };
      await startPlatform('qqbot', qqbotConfig);
    } catch (error) {
      console.error('Failed to connect QQ Bot:', error);
    } finally {
      setSaving(false);
    }
  };

  // 断开
  const handleDisconnect = async () => {
    try {
      await stopPlatform('qqbot');
    } catch (error) {
      console.error('Failed to disconnect QQ Bot:', error);
    }
  };

  // 更新编辑中的实例配置
  const updateEditingConfig = (updates: Partial<PlatformInstance['config']>) => {
    if (!editingInstance) return;
    setEditingInstance({
      ...editingInstance,
      config: { ...editingInstance.config, ...updates },
    });
    setHasChanges(true);
  };

  // 更新编辑中的实例名称
  const updateEditingName = (name: string) => {
    if (!editingInstance) return;
    setEditingInstance({ ...editingInstance, name });
    setHasChanges(true);
  };

  // 选择实例进行编辑
  const handleSelectInstance = (instance: PlatformInstance) => {
    if (hasChanges && editingInstance?.id !== instance.id) {
      if (!confirm('有未保存的更改，确定要切换吗？')) return;
    }
    setEditingInstance(instance);
    setHasChanges(false);
  };

  // 当前编辑的实例是否是激活的
  const isEditingActive = activeInstance?.id === editingInstance?.id;

  return (
    <div className="space-y-6">
      {/* 总开关 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-medium text-text-primary">启用 QQ Bot 集成</div>
            <div className="text-xs text-text-secondary">通过 QQ 机器人接收和发送消息</div>
          </div>
          <button
            type="button"
            onClick={() => handleEnabledChange(!config.qqbot?.enabled)}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              config.qqbot?.enabled ? 'bg-primary' : 'bg-border'
            }`}
          >
            <span
              className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${
                config.qqbot?.enabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {config.qqbot?.enabled && (
          <>
            {/* 实例列表 */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-text-secondary">机器人实例</label>
                <button
                  onClick={handleAddInstance}
                  className="text-xs text-primary hover:underline"
                >
                  + 添加实例
                </button>
              </div>

              {instances.length === 0 ? (
                <div className="p-3 bg-background rounded-lg text-center">
                  <p className="text-xs text-text-tertiary">暂无实例，点击上方添加</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {instances.map((instance) => (
                    <div
                      key={instance.id}
                      className={`p-3 bg-background rounded-lg border cursor-pointer transition-colors ${
                        editingInstance?.id === instance.id
                          ? 'border-primary bg-primary/5'
                          : 'border-transparent hover:border-border'
                      }`}
                      onClick={() => handleSelectInstance(instance)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div
                            className={`w-2 h-2 rounded-full ${
                              activeInstance?.id === instance.id && isConnected
                                ? 'bg-success'
                                : 'bg-text-tertiary'
                            }`}
                          />
                          <span className="text-sm text-text-primary">{instance.name}</span>
                          {activeInstance?.id === instance.id && (
                            <span className="text-xs text-primary">当前</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {activeInstance?.id !== instance.id && !isConnected && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSwitchInstance(instance.id);
                              }}
                              className="text-xs text-text-secondary hover:text-primary"
                            >
                              切换
                            </button>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveInstance(instance.id);
                            }}
                            className="text-xs text-text-tertiary hover:text-danger"
                          >
                            删除
                          </button>
                        </div>
                      </div>
                      <div className="text-xs text-text-tertiary mt-1">
                        {instance.config.appId
                          ? `App ID: ${instance.config.appId.slice(0, 8)}...`
                          : '未配置'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 实例配置编辑 */}
            {editingInstance && (
              <div className="p-3 bg-background rounded-lg space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">实例配置</span>
                  <div className="flex items-center gap-2">
                    {hasChanges && (
                      <span className="text-xs text-warning">未保存</span>
                    )}
                    {isEditingActive && isConnected && (
                      <span className="text-xs text-success">已连接</span>
                    )}
                  </div>
                </div>

                {/* 实例名称 */}
                <div>
                  <label className="block text-xs text-text-secondary mb-2">实例名称</label>
                  <input
                    type="text"
                    value={editingInstance.name}
                    onChange={(e) => updateEditingName(e.target.value)}
                    placeholder="例如：生产机器人"
                    className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    disabled={loading}
                  />
                </div>

                {/* App ID */}
                <div>
                  <label className="block text-xs text-text-secondary mb-2">App ID</label>
                  <input
                    type="text"
                    value={editingInstance.config.appId}
                    onChange={(e) => updateEditingConfig({ appId: e.target.value })}
                    placeholder="QQ 开放平台应用的 App ID"
                    className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    disabled={loading}
                  />
                </div>

                {/* Client Secret */}
                <div>
                  <label className="block text-xs text-text-secondary mb-2">Client Secret</label>
                  <input
                    type="password"
                    value={editingInstance.config.clientSecret}
                    onChange={(e) => updateEditingConfig({ clientSecret: e.target.value })}
                    placeholder="QQ 开放平台应用的 Client Secret"
                    className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    disabled={loading}
                  />
                </div>

                {/* 复选框选项 */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editingInstance.config.sandbox}
                        onChange={(e) => updateEditingConfig({ sandbox: e.target.checked })}
                        className="w-4 h-4"
                      />
                      沙箱环境
                    </label>
                  </div>
                  <div>
                    <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editingInstance.config.autoConnect}
                        onChange={(e) => updateEditingConfig({ autoConnect: e.target.checked })}
                        className="w-4 h-4"
                      />
                      自动连接
                    </label>
                  </div>
                </div>

                {/* 显示模式 */}
                <div>
                  <label className="block text-xs text-text-secondary mb-2">显示模式</label>
                  <select
                    value={editingInstance.config.displayMode}
                    onChange={(e) =>
                      updateEditingConfig({ displayMode: e.target.value as IntegrationDisplayMode })
                    }
                    className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    disabled={loading}
                  >
                    <option value="chat">聊天模式</option>
                    <option value="separate">分离模式</option>
                    <option value="both">两者都有</option>
                  </select>
                </div>

                {/* 操作按钮 */}
                <div className="flex items-center gap-3 p-3 bg-surface rounded-lg">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      isEditingActive && isConnected ? 'bg-success' : 'bg-text-tertiary'
                    }`}
                  />
                  <span className="text-sm text-text-secondary">
                    {isEditingActive && isConnected ? '已连接' : '未连接'}
                  </span>
                  <div className="flex-1" />

                  {/* 保存按钮 */}
                  <button
                    onClick={handleSave}
                    disabled={!hasChanges || saving || loading}
                    className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-primary/10 hover:border-primary text-text-secondary hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {saving ? '保存中...' : '保存'}
                  </button>

                  {/* 连接/断开按钮 */}
                  {isEditingActive && isConnected ? (
                    <button
                      onClick={handleDisconnect}
                      disabled={integrationLoading}
                      className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-danger/10 hover:border-danger text-text-secondary hover:text-danger transition-colors"
                    >
                      断开
                    </button>
                  ) : (
                    <button
                      onClick={handleConnect}
                      disabled={
                        integrationLoading ||
                        saving ||
                        !editingInstance.config.appId ||
                        !editingInstance.config.clientSecret
                      }
                      className="px-3 py-1.5 text-xs bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {saving ? '保存中...' : '连接'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* 配置说明 */}
            <div className="mt-4 p-3 bg-primary/5 border border-primary/20 rounded-lg">
              <div className="flex items-start gap-2">
                <svg
                  className="w-4 h-4 text-primary mt-0.5 flex-shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                    clipRule="evenodd"
                  />
                </svg>
                <div className="flex-1">
                  <p className="text-xs text-text-primary">
                    <span className="font-medium">使用说明：</span>
                  </p>
                  <ul className="text-xs text-text-tertiary mt-1 space-y-1 list-disc list-inside">
                    <li>填写配置后点击「保存」保存实例</li>
                    <li>点击「连接」会自动保存并连接</li>
                    <li>同一时间只能连接一个 QQ Bot 实例</li>
                    <li>沙箱环境用于测试，生产环境需审核</li>
                  </ul>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
