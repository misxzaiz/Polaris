/**
 * IntegrationPanel - 统一机器人集成管理面板
 *
 * 通过顶部 Tab 切换 QQ Bot / 飞书平台，
 * 共享实例列表管理、连接控制和轻量配置编辑逻辑。
 */

import { useState, useEffect } from 'react'
import {
  useIntegrationStore,
  useIntegrationStatus,
  useIntegrationInstances,
  useActiveIntegrationInstance,
  useWorkspaceStore,
} from '@/stores'
import type { Platform, PlatformInstance } from '@/types'
import {
  ConnectionStateLabels,
  type ConnectionState,
} from '@/types/integration'
import { createLogger } from '@/utils/logger'

const log = createLogger('IntegrationPanel')

type PlatformTab = 'qqbot' | 'feishu'

/** QQ Bot 平台的配置字段 */
const QQ_FIELDS = [
  { key: 'appId', label: 'App ID', type: 'text', placeholder: 'QQ 开放平台应用 App ID' },
  { key: 'clientSecret', label: 'Client Secret', type: 'password', placeholder: 'Client Secret' },
] as const

/** 飞书平台的配置字段 */
const FEISHU_FIELDS = [
  { key: 'appId', label: 'App ID', type: 'text', placeholder: '飞书开放平台应用 App ID' },
  { key: 'appSecret', label: 'App Secret', type: 'password', placeholder: 'App Secret' },
] as const

/** 通用配置字段（两个平台共享） */
const COMMON_FIELDS = [
  { key: 'workDir', label: '默认工作区', type: 'text', placeholder: '新会话自动使用此目录（可选）' },
] as const

/** 获取平台对应的配置字段 */
function getPlatformFields(platform: PlatformTab) {
  return platform === 'qqbot' ? QQ_FIELDS : FEISHU_FIELDS
}

/** 获取连接状态的徽章样式 */
function getStateBadgeStyle(state: ConnectionState): string {
  switch (state) {
    case 'ready':
      return 'bg-success/20 text-success'
    case 'connecting':
    case 'authenticating':
    case 'reconnecting':
      return 'bg-warning/20 text-warning animate-pulse'
    case 'failed':
      return 'bg-danger/20 text-danger'
    default:
      return 'bg-text-tertiary/20 text-text-tertiary'
  }
}

export function IntegrationPanel() {
  const [platform, setPlatform] = useState<PlatformTab>('qqbot')

  const status = useIntegrationStatus(platform)
  const instances = useIntegrationInstances(platform)
  const activeInstance = useActiveIntegrationInstance(platform)
  const {
    startPlatform,
    stopPlatform,
    loadInstances,
    addInstance,
    updateInstance,
    removeInstance,
    switchInstance,
  } = useIntegrationStore()

  const isConnected = status?.connected ?? false
  const connectionState = status?.connectionState ?? 'disconnected'
  const errorMessage = status?.error

  const [editingInstance, setEditingInstance] = useState<PlatformInstance | null>(null)
  const [hasChanges, setHasChanges] = useState(false)
  const [saving, setSaving] = useState(false)
  const { workspaces } = useWorkspaceStore()

  useEffect(() => { loadInstances() }, [loadInstances])

  // 同步激活实例到编辑状态
  useEffect(() => {
    if (activeInstance && !editingInstance) {
      setEditingInstance(activeInstance)
    }
  }, [activeInstance, editingInstance])

  // 切换平台时重置编辑状态
  useEffect(() => {
    setEditingInstance(null)
    setHasChanges(false)
  }, [platform])

  const handleAddInstance = () => {
    const newInstance: PlatformInstance = {
      id: `${platform}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: '新机器人',
      platform: platform as Platform,
      config: {
        type: platform,
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
    }
    setEditingInstance(newInstance)
    setHasChanges(true)
  }

  const handleSave = async () => {
    if (!editingInstance) return
    setSaving(true)
    try {
      const existing = instances.find((i) => i.id === editingInstance.id)
      if (!existing) {
        await addInstance(editingInstance)
      } else {
        await updateInstance(editingInstance)
      }
      setHasChanges(false)
    } catch (err) {
      log.error('保存失败', err instanceof Error ? err : new Error(String(err)))
    } finally {
      setSaving(false)
    }
  }

  const handleConnect = async () => {
    if (!editingInstance) return
    try {
      if (hasChanges) {
        setSaving(true)
        const existing = instances.find((i) => i.id === editingInstance.id)
        if (!existing) await addInstance(editingInstance)
        else await updateInstance(editingInstance)
        setHasChanges(false)
        setSaving(false)
      }

      if (activeInstance?.id !== editingInstance.id) {
        await switchInstance(editingInstance.id)
      }

      if (platform === 'qqbot') {
        await startPlatform('qqbot', {
          enabled: true,
          instances: [{
            id: editingInstance.id,
            name: editingInstance.name,
            enabled: editingInstance.enabled,
            appId: editingInstance.config.appId,
            clientSecret: editingInstance.config.clientSecret,
            sandbox: editingInstance.config.sandbox ?? false,
            displayMode: editingInstance.config.displayMode,
            autoConnect: editingInstance.config.autoConnect,
            workDir: editingInstance.config.workDir || undefined,
            createdAt: editingInstance.createdAt,
            lastActive: editingInstance.lastActive,
          }],
          activeInstanceId: editingInstance.id,
        })
      } else {
        await startPlatform('feishu', undefined, {
          enabled: true,
          instances: [{
            id: editingInstance.id,
            name: editingInstance.name,
            enabled: editingInstance.enabled,
            appId: editingInstance.config.appId,
            appSecret: editingInstance.config.appSecret || '',
            verificationToken: '',
            encryptKey: '',
            displayMode: editingInstance.config.displayMode,
            autoConnect: editingInstance.config.autoConnect,
            workDir: editingInstance.config.workDir || undefined,
            createdAt: editingInstance.createdAt,
            lastActive: editingInstance.lastActive,
          }],
          activeInstanceId: editingInstance.id,
        })
      }
    } catch (err) {
      log.error('连接失败', err instanceof Error ? err : new Error(String(err)))
    } finally {
      setSaving(false)
    }
  }

  const handleDisconnect = async () => {
    try { await stopPlatform(platform as Platform) } catch { /* ignore */ }
  }

  /** 从实例卡片直接连接（用实例已有配置，不需要进入编辑区） */
  const handleQuickConnect = async (inst: PlatformInstance) => {
    try {
      if (activeInstance?.id !== inst.id) {
        await switchInstance(inst.id)
      }
      if (platform === 'qqbot') {
        await startPlatform('qqbot', {
          enabled: true,
          instances: [{
            id: inst.id, name: inst.name, enabled: inst.enabled,
            appId: inst.config.appId, clientSecret: inst.config.clientSecret,
            sandbox: inst.config.sandbox ?? false, displayMode: inst.config.displayMode,
            autoConnect: inst.config.autoConnect, workDir: inst.config.workDir || undefined,
            createdAt: inst.createdAt, lastActive: inst.lastActive,
          }],
          activeInstanceId: inst.id,
        })
      } else {
        await startPlatform('feishu', undefined, {
          enabled: true,
          instances: [{
            id: inst.id, name: inst.name, enabled: inst.enabled,
            appId: inst.config.appId, appSecret: inst.config.appSecret || '',
            verificationToken: '', encryptKey: '',
            displayMode: inst.config.displayMode, autoConnect: inst.config.autoConnect,
            workDir: inst.config.workDir || undefined,
            createdAt: inst.createdAt, lastActive: inst.lastActive,
          }],
          activeInstanceId: inst.id,
        })
      }
    } catch (err) {
      log.error('快速连接失败', err instanceof Error ? err : new Error(String(err)))
    }
  }

  const handleSwitchInstance = async (id: string) => {
    if (isConnected) await stopPlatform(platform as Platform)
    await switchInstance(id)
    setHasChanges(false)
  }

  const handleSelectInstance = (inst: PlatformInstance) => {
    if (hasChanges && editingInstance?.id !== inst.id) {
      if (!confirm('有未保存的更改，确定要切换吗？')) return
    }
    setEditingInstance(inst)
    setHasChanges(false)
  }

  const updateConfig = (updates: Partial<PlatformInstance['config']>) => {
    if (!editingInstance) return
    setEditingInstance({ ...editingInstance, config: { ...editingInstance.config, ...updates } })
    setHasChanges(true)
  }

  const updateName = (name: string) => {
    if (!editingInstance) return
    setEditingInstance({ ...editingInstance, name })
    setHasChanges(true)
  }

  const isEditingActive = activeInstance?.id === editingInstance?.id
  const platformFields = getPlatformFields(platform)
  const canConnect = editingInstance
    ? (platform === 'qqbot'
        ? !!(editingInstance.config.appId && editingInstance.config.clientSecret)
        : !!(editingInstance.config.appId && editingInstance.config.appSecret))
    : false

  return (
    <div className="flex flex-col h-full">
      {/* 平台切换 Tab */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setPlatform('qqbot')}
          className={`flex-1 py-2.5 text-xs font-medium text-center transition-colors ${
            platform === 'qqbot'
              ? 'text-primary border-b-2 border-primary'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          QQ Bot
        </button>
        <button
          onClick={() => setPlatform('feishu')}
          className={`flex-1 py-2.5 text-xs font-medium text-center transition-colors ${
            platform === 'feishu'
              ? 'text-primary border-b-2 border-primary'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          飞书
        </button>
      </div>

      {/* 面板内容 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* 实例列表 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wider">实例</span>
            <button onClick={handleAddInstance} className="text-[11px] text-primary hover:underline">+ 添加</button>
          </div>

          {instances.length === 0 ? (
            <div className="py-4 text-center text-xs text-text-tertiary">暂无实例</div>
          ) : (
            instances.map((inst) => {
              const isActive = activeInstance?.id === inst.id
              const hasConfig = platform === 'qqbot'
                ? !!(inst.config.appId && inst.config.clientSecret)
                : !!(inst.config.appId && inst.config.appSecret)
              return (
              <div
                key={inst.id}
                onClick={() => handleSelectInstance(inst)}
                className={`p-2.5 rounded-lg border cursor-pointer transition-colors mb-1.5 ${
                  editingInstance?.id === inst.id
                    ? 'border-primary bg-primary/5'
                    : 'border-transparent hover:border-border hover:bg-surface'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-text-primary truncate mr-2">{inst.name}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isActive ? (
                      <>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${getStateBadgeStyle(connectionState)}`}>
                          {ConnectionStateLabels[connectionState]}
                        </span>
                        {isConnected && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDisconnect() }}
                            className="text-[10px] px-1.5 py-0.5 border border-danger/30 rounded text-danger hover:bg-danger/10"
                          >断开</button>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-text-tertiary/15 text-text-tertiary font-medium">未激活</span>
                        {hasConfig && !isConnected && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleQuickConnect(inst) }}
                            className="text-[10px] px-1.5 py-0.5 bg-primary text-white rounded hover:bg-primary/90"
                          >连接</button>
                        )}
                        {!hasConfig && !isConnected && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleSwitchInstance(inst.id) }}
                            className="text-[10px] text-text-tertiary hover:text-primary"
                          >切换</button>
                        )}
                      </>
                    )}
                    {!isActive && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (confirm('确定删除？')) removeInstance(inst.id)
                        }}
                        className="text-[10px] text-text-tertiary hover:text-danger"
                      >删除</button>
                    )}
                  </div>
                </div>
                <div className="text-[10px] text-text-tertiary mt-0.5">
                  {inst.config.appId ? `App ID: ${inst.config.appId.slice(0, 8)}...` : '未配置'}
                  {inst.config.workDir && ` | 📂 ${inst.config.workDir.split(/[\\/]/).pop()}`}
                </div>
              </div>
              )
            })
          )}
        </div>

        {/* 快速配置 */}
        {editingInstance && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wider">快速配置</span>
              {hasChanges && <span className="text-[10px] text-warning">未保存</span>}
            </div>
            <div className="bg-surface rounded-lg p-3 space-y-2.5">
              {/* 实例名称 */}
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">名称</label>
                <input
                  type="text"
                  value={editingInstance.name}
                  onChange={(e) => updateName(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-background border border-border rounded-md text-xs text-text-primary focus:outline-none focus:border-primary"
                />
              </div>

              {/* 平台特有字段 */}
              {platformFields.map((field) => (
                <div key={field.key}>
                  <label className="block text-[11px] text-text-tertiary mb-1">{field.label}</label>
                  <input
                    type={field.type}
                    value={(editingInstance.config as unknown as Record<string, string>)[field.key] || ''}
                    onChange={(e) => updateConfig({ [field.key]: e.target.value })}
                    placeholder={field.placeholder}
                    className="w-full px-2.5 py-1.5 bg-background border border-border rounded-md text-xs text-text-primary focus:outline-none focus:border-primary"
                  />
                </div>
              ))}

              {/* 通用字段 */}
              {COMMON_FIELDS.map((field) => (
                <div key={field.key}>
                  <label className="block text-[11px] text-text-tertiary mb-1">{field.label}</label>
                  {field.key === 'workDir' && workspaces.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {workspaces.map((ws) => (
                        <button
                          key={ws.id}
                          type="button"
                          onClick={() => updateConfig({ workDir: ws.path })}
                          className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                            (editingInstance.config as unknown as Record<string, string>).workDir === ws.path
                              ? 'bg-primary text-white'
                              : 'bg-background-hover text-text-secondary hover:bg-background-active'
                          }`}
                        >
                          {ws.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <input
                    type={field.type}
                    value={(editingInstance.config as unknown as Record<string, string>)[field.key] || ''}
                    onChange={(e) => updateConfig({ [field.key]: e.target.value })}
                    placeholder={field.placeholder}
                    className="w-full px-2.5 py-1.5 bg-background border border-border rounded-md text-xs text-text-primary focus:outline-none focus:border-primary"
                  />
                </div>
              ))}

              {/* 操作按钮 */}
              <div className="flex gap-2 pt-2 border-t border-border">
                <button
                  onClick={handleSave}
                  disabled={!hasChanges || saving}
                  className="flex-1 py-1.5 text-[11px] border border-border rounded-md text-text-secondary hover:border-primary hover:text-primary disabled:opacity-40 transition-colors"
                >
                  {saving ? '保存中...' : '保存'}
                </button>
                {isEditingActive && isConnected ? (
                  <button
                    onClick={handleDisconnect}
                    className="flex-1 py-1.5 text-[11px] border border-danger/30 rounded-md text-danger hover:bg-danger/10 transition-colors"
                  >
                    断开
                  </button>
                ) : (
                  <button
                    onClick={handleConnect}
                    disabled={saving || !canConnect}
                    className="flex-1 py-1.5 text-[11px] bg-primary text-white rounded-md hover:bg-primary/90 disabled:opacity-40 transition-colors"
                  >
                    {saving ? '...' : '连接'}
                  </button>
                )}
              </div>

              {/* 错误信息 */}
              {isEditingActive && connectionState === 'failed' && errorMessage && (
                <div className="text-[10px] text-danger bg-danger/10 p-2 rounded-md">{errorMessage}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
