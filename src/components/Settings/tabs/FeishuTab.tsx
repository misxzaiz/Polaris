/**
 * Feishu (飞书) 集成配置 Tab
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
} from '@/stores';
import type { PlatformInstance } from '@/types';
import {
  ConnectionStateLabels,
  type ConnectionState,
} from '@/types/integration';
import { createLogger } from '@/utils/logger';

const log = createLogger('FeishuTab');

interface FeishuTabProps {
  loading: boolean;
}

/** 生成唯一 ID */
function generateId(): string {
  return `feishu-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/** 创建空实例 */
function createEmptyInstance(): PlatformInstance {
  return {
    id: generateId(),
    name: '新机器人',
    platform: 'feishu',
    config: {
      type: 'feishu',
      enabled: true,
      appId: '',
      clientSecret: '',
      sandbox: false,
      appSecret: '',
      verificationToken: '',
      encryptKey: '',
      displayMode: 'chat',
      autoConnect: false,
      workDir: '',
    },
    createdAt: new Date().toISOString(),
    enabled: true,
  };
}

export function FeishuTab({ loading }: FeishuTabProps) {
  const feishuStatus = useIntegrationStatus('feishu');
  const instances = useIntegrationInstances('feishu');
  const activeInstance = useActiveIntegrationInstance('feishu');
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

  const isConnected = feishuStatus?.connected ?? false;
  const connectionState = feishuStatus?.connectionState ?? 'disconnected';
  const errorMessage = feishuStatus?.error;
  const errorDetail = feishuStatus?.errorDetail;

  const getStateLabel = (state: ConnectionState): string => {
    return ConnectionStateLabels[state] || state;
  };

  const getStateBadgeStyle = (state: ConnectionState): string => {
    switch (state) {
      case 'ready':
        return 'bg-success/20 text-success';
      case 'connecting':
      case 'authenticating':
      case 'reconnecting':
        return 'bg-warning/20 text-warning animate-pulse';
      case 'failed':
        return 'bg-danger/20 text-danger';
      default:
        return 'bg-text-tertiary/20 text-text-tertiary';
    }
  };

  const [editingInstance, setEditingInstance] = useState<PlatformInstance | null>(null);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    loadInstances();
  }, [loadInstances]);

  useEffect(() => {
    if (!initializedRef.current && activeInstance && !editingInstance) {
      initializedRef.current = true;
      setEditingInstance(activeInstance);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- activeInstance/editingInstance compared by id
  }, [activeInstance?.id, editingInstance?.id]);

  const handleSave = async () => {
    if (!editingInstance) return;
    setSaving(true);
    try {
      const existingInstance = instances.find((i) => i.id === editingInstance.id);
      if (!existingInstance) {
        await addInstance(editingInstance);
      } else {
        await updateInstance(editingInstance);
      }
      setHasChanges(false);
    } catch (error) {
      log.error('Failed to save instance:', error instanceof Error ? error : new Error(String(error)));
    } finally {
      setSaving(false);
    }
  };

  const handleAddInstance = () => {
    const newInstance = createEmptyInstance();
    setEditingInstance(newInstance);
    setHasChanges(true);
  };

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

  const handleSwitchInstance = async (instanceId: string) => {
    if (hasChanges) {
      if (!confirm('有未保存的更改，确定要切换吗？')) return;
    }
    try {
      if (isConnected) {
        await stopPlatform('feishu');
      }
      await switchInstance(instanceId);
      setHasChanges(false);
    } catch (error) {
      log.error('Failed to switch instance:', error instanceof Error ? error : new Error(String(error)));
    }
  };

  const handleConnect = async () => {
    if (!editingInstance) return;
    try {
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

      const fConfig = {
        enabled: true,
        instances: [{
          id: editingInstance.id,
          name: editingInstance.name,
          enabled: editingInstance.enabled,
          appId: editingInstance.config.appId,
          appSecret: editingInstance.config.appSecret || '',
          verificationToken: editingInstance.config.verificationToken || '',
          encryptKey: editingInstance.config.encryptKey || '',
          displayMode: editingInstance.config.displayMode,
          autoConnect: editingInstance.config.autoConnect,
          workDir: editingInstance.config.workDir || undefined,
          createdAt: editingInstance.createdAt,
          lastActive: editingInstance.lastActive,
        }],
        activeInstanceId: editingInstance.id,
      };

      // 先初始化并启动平台（创建消息通道），再切换实例
      await startPlatform('feishu', undefined, fConfig);

      if (activeInstance?.id !== editingInstance.id) {
        await switchInstance(editingInstance.id);
      }
    } catch (error) {
      log.error('Failed to connect Feishu Bot:', error instanceof Error ? error : new Error(String(error)));
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await stopPlatform('feishu');
    } catch (error) {
      log.error('Failed to disconnect Feishu Bot:', error instanceof Error ? error : new Error(String(error)));
    }
  };

  const updateEditingConfig = (updates: Partial<PlatformInstance['config']>) => {
    if (!editingInstance) return;
    setEditingInstance({
      ...editingInstance,
      config: { ...editingInstance.config, ...updates },
    });
    setHasChanges(true);
  };

  const updateEditingName = (name: string) => {
    if (!editingInstance) return;
    setEditingInstance({ ...editingInstance, name });
    setHasChanges(true);
  };

  const handleSelectInstance = (instance: PlatformInstance) => {
    if (hasChanges && editingInstance?.id !== instance.id) {
      if (!confirm('有未保存的更改，确定要切换吗？')) return;
    }
    setEditingInstance(instance);
    setHasChanges(false);
  };

  const isEditingActive = activeInstance?.id === editingInstance?.id;

  return (
    <div className="space-y-6">
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-medium text-text-primary">飞书集成</div>
            <div className="text-xs text-text-secondary">通过飞书机器人接收和发送消息</div>
          </div>
        </div>

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
                            className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              activeInstance?.id === instance.id
                                ? getStateBadgeStyle(connectionState)
                                : 'bg-text-tertiary/20 text-text-tertiary'
                            }`}
                          >
                            {activeInstance?.id === instance.id
                              ? getStateLabel(connectionState)
                              : '未激活'}
                          </div>
                          <span className="text-sm text-text-primary">{instance.name}</span>
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
                    {hasChanges && <span className="text-xs text-warning">未保存</span>}
                    {isEditingActive && (
                      <div
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStateBadgeStyle(
                          connectionState
                        )}`}
                      >
                        {getStateLabel(connectionState)}
                      </div>
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
                    placeholder="飞书开放平台应用的 App ID"
                    className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    disabled={loading}
                  />
                </div>

                {/* App Secret */}
                <div>
                  <label className="block text-xs text-text-secondary mb-2">App Secret</label>
                  <input
                    type="password"
                    value={editingInstance.config.appSecret || ''}
                    onChange={(e) => updateEditingConfig({ appSecret: e.target.value })}
                    placeholder="飞书开放平台应用的 App Secret"
                    className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    disabled={loading}
                  />
                </div>

                {/* 默认工作区 */}
                <div>
                  <label className="block text-xs text-text-secondary mb-2">默认工作区</label>
                  <input
                    type="text"
                    value={editingInstance.config.workDir || ''}
                    onChange={(e) => updateEditingConfig({ workDir: e.target.value })}
                    placeholder="新会话自动使用此目录（可选，留空则使用应用默认目录）"
                    className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    disabled={loading}
                  />
                </div>


                {/* 操作按钮 */}
                <div className="flex items-center gap-3 p-3 bg-surface rounded-lg">
                  <div
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStateBadgeStyle(
                      isEditingActive ? connectionState : 'disconnected'
                    )}`}
                  >
                    {getStateLabel(isEditingActive ? connectionState : 'disconnected')}
                  </div>

                  <div className="flex-1" />

                  <button
                    onClick={handleSave}
                    disabled={!hasChanges || saving || loading}
                    className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-primary/10 hover:border-primary text-text-secondary hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {saving ? '保存中...' : '保存'}
                  </button>

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
                        connectionState === 'connecting' ||
                        connectionState === 'authenticating' ||
                        !editingInstance.config.appId ||
                        !editingInstance.config.appSecret
                      }
                      className="px-3 py-1.5 text-xs bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {connectionState === 'connecting' || connectionState === 'authenticating'
                        ? '连接中...'
                        : saving
                          ? '保存中...'
                          : '连接'}
                    </button>
                  )}
                </div>

                {/* 错误信息显示 */}
                {isEditingActive && connectionState === 'failed' && errorMessage && (
                  <div className="p-3 bg-danger/10 border border-danger/20 rounded-lg">
                    <div className="flex items-start gap-2">
                      <svg
                        className="w-4 h-4 text-danger mt-0.5 flex-shrink-0"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <div className="flex-1">
                        <p className="text-sm text-danger font-medium">{errorMessage}</p>
                        {errorDetail && (
                          <pre className="mt-2 text-xs text-text-tertiary whitespace-pre-wrap">
                            {errorDetail}
                          </pre>
                        )}
                      </div>
                    </div>
                  </div>
                )}
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
                    <li>在飞书开放平台创建应用并获取 App ID 和 App Secret</li>
                    <li>启用「机器人」能力，开启 WebSocket 长连接模式</li>
                    <li>填写配置后点击「保存」保存实例</li>
                    <li>点击「连接」会自动保存并连接</li>
                    <li>同一时间只能连接一个飞书机器人实例</li>
                  </ul>
                </div>
              </div>
            </div>
      </div>
    </div>
  );
}
