/**
 * IntegrationPanel - 统一机器人集成管理面板
 *
 * 通过顶部 Tab 切换 QQ Bot / 飞书 / 钉钉 平台，
 * 共享实例列表管理、连接控制和配置编辑逻辑。
 * 是机器人管理的唯一入口（设置页不再包含机器人配置）。
 */

import { useState, useEffect, useCallback } from 'react'
import {
  useIntegrationStore,
  useIntegrationStatus,
  useIntegrationInstances,
  useActiveIntegrationInstance,
  useWorkspaceStore,
} from '@/stores'
import type { Platform, PlatformInstance, QQBotConfig, FeishuConfig, DingTalkConfig } from '@/types'
import {
  ConnectionStateLabels,
  type ConnectionState,
} from '@/types/integration'
import { createLogger } from '@/utils/logger'

const log = createLogger('IntegrationPanel')

type PlatformTab = 'qqbot' | 'feishu' | 'dingtalk'

// ────────────────────────────── 平台字段配置表 ──────────────────────────────

interface PlatformField {
  key: string;
  label: string;
  type: 'text' | 'password';
  placeholder: string;
  hint?: string;
}

interface PlatformExtraField extends PlatformField {
  /** 仅在指定平台显示 */
  platform: PlatformTab;
}

const PLATFORM_BASE_FIELDS: Record<PlatformTab, PlatformField[]> = {
  qqbot: [
    { key: 'appId', label: 'App ID', type: 'text', placeholder: 'QQ 开放平台应用的 App ID' },
    { key: 'clientSecret', label: 'Client Secret', type: 'password', placeholder: 'QQ 开放平台应用的 Client Secret' },
  ],
  feishu: [
    { key: 'appId', label: 'App ID', type: 'text', placeholder: '飞书开放平台应用的 App ID' },
    { key: 'appSecret', label: 'App Secret', type: 'password', placeholder: '飞书开放平台应用的 App Secret' },
  ],
  dingtalk: [
    { key: 'appId', label: 'App Key', type: 'text', placeholder: '钉钉开放平台应用的 App Key' },
    { key: 'appSecret', label: 'App Secret', type: 'password', placeholder: '钉钉开放平台应用的 App Secret' },
  ],
}

/** 平台特有字段（仅部分平台需要） */
const PLATFORM_EXTRA_FIELDS: PlatformExtraField[] = [
  { platform: 'qqbot', key: 'sandbox', label: '沙箱环境', type: 'text', placeholder: '' },
  { platform: 'feishu', key: 'verificationToken', label: '验证 Token', type: 'text', placeholder: '事件验证 Token（可选）' },
  { platform: 'feishu', key: 'encryptKey', label: '加密 Key', type: 'text', placeholder: '事件加密 Key（可选）' },
  { platform: 'dingtalk', key: 'webhookUrl', label: 'Webhook URL', type: 'text', placeholder: '群机器人 Webhook 地址 (https://oapi.dingtalk.com/robot/send?access_token=...)' },
]

/** 平台名称 */
const PLATFORM_LABELS: Record<PlatformTab, string> = {
  qqbot: 'QQ Bot',
  feishu: '飞书',
  dingtalk: '钉钉',
}

/** 平台头像颜色 */
const PLATFORM_AVATAR_CLASS: Record<PlatformTab, string> = {
  qqbot: 'bg-[rgba(18,183,105,0.15)] text-[#12b76a]',
  feishu: 'bg-[rgba(51,126,255,0.15)] text-[#337eff]',
  dingtalk: 'bg-[rgba(42,110,255,0.15)] text-[#2a6eff]',
}

/** 平台头像字母 */
const PLATFORM_AVATAR_LETTER: Record<PlatformTab, string> = {
  qqbot: 'Q',
  feishu: 'F',
  dingtalk: 'D',
}

/** 平台使用说明 */
const PLATFORM_TIPS: Record<PlatformTab, string[]> = {
  qqbot: [
    '在 QQ 开放平台创建应用并获取 App ID 和 Client Secret',
    '开启沙箱环境用于测试，生产环境需审核',
    '填写配置后点击「保存」，再点击「连接」',
    '同一时间只能连接一个 QQ Bot 实例',
  ],
  feishu: [
    '在飞书开放平台创建应用并获取 App ID 和 App Secret',
    '启用「机器人」能力，开启 WebSocket 长连接模式',
    '验证 Token 和加密 Key 可选，用于事件订阅验证',
    '同一时间只能连接一个飞书机器人实例',
  ],
  dingtalk: [
    '在钉钉开放平台创建企业内部应用并获取 App Key 和 App Secret',
    '启用「机器人」能力，开启 Stream 模式（WebSocket 长连接）',
    '在群中添加机器人，获取 Webhook URL 用于回复消息',
    '同一时间只能连接一个钉钉机器人实例',
  ],
}

// ────────────────────────────── 辅助函数 ──────────────────────────────

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

/** 获取连接状态指示点样式 */
function getStateDotStyle(state: ConnectionState): string {
  switch (state) {
    case 'ready': return 'bg-success'
    case 'connecting':
    case 'authenticating':
    case 'reconnecting': return 'bg-warning'
    case 'failed': return 'bg-danger'
    default: return 'bg-text-tertiary'
  }
}

/** 检查实例是否有必要的最小配置 */
function hasRequiredConfig(platform: PlatformTab, inst: PlatformInstance): boolean {
  if (platform === 'qqbot') return !!(inst.config.appId && inst.config.clientSecret)
  if (platform === 'feishu') return !!(inst.config.appId && inst.config.appSecret)
  return !!(inst.config.appId && inst.config.appSecret)
}

/** 生成唯一 ID */
function generateId(platform: PlatformTab): string {
  return `${platform}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

/** 创建空实例 */
function createEmptyInstance(platform: PlatformTab): PlatformInstance {
  return {
    id: generateId(platform),
    name: '新机器人',
    platform: platform as Platform,
    config: {
      type: platform,
      enabled: true,
      appId: '',
      clientSecret: '',
      sandbox: platform === 'qqbot',
      appSecret: '',
      verificationToken: '',
      encryptKey: '',
      webhookUrl: '',
      displayMode: 'chat',
      autoConnect: false,
      workDir: '',
    },
    createdAt: new Date().toISOString(),
    enabled: true,
  }
}

/** 构建平台配置传给 startPlatform */
function buildPlatformConfig(inst: PlatformInstance, platform: PlatformTab) {
  if (platform === 'qqbot') {
    return {
      enabled: true,
      instances: [{
        id: inst.id, name: inst.name, enabled: inst.enabled,
        appId: inst.config.appId, clientSecret: inst.config.clientSecret,
        sandbox: inst.config.sandbox ?? false,
        displayMode: inst.config.displayMode,
        autoConnect: inst.config.autoConnect,
        workDir: inst.config.workDir || undefined,
        createdAt: inst.createdAt, lastActive: inst.lastActive,
      }],
      activeInstanceId: inst.id,
    }
  }
  if (platform === 'feishu') {
    return {
      enabled: true,
      instances: [{
        id: inst.id, name: inst.name, enabled: inst.enabled,
        appId: inst.config.appId, appSecret: inst.config.appSecret || '',
        verificationToken: inst.config.verificationToken || '',
        encryptKey: inst.config.encryptKey || '',
        displayMode: inst.config.displayMode,
        autoConnect: inst.config.autoConnect,
        workDir: inst.config.workDir || undefined,
        createdAt: inst.createdAt, lastActive: inst.lastActive,
      }],
      activeInstanceId: inst.id,
    }
  }
  // dingtalk (DingTalkInstanceConfig 使用 appKey 而非 appId)
  return {
    enabled: true,
    instances: [{
      id: inst.id, name: inst.name, enabled: inst.enabled,
      appKey: inst.config.appId, appSecret: inst.config.appSecret || '',
      webhookUrl: inst.config.webhookUrl || '',
      displayMode: inst.config.displayMode,
      autoConnect: inst.config.autoConnect,
      workDir: inst.config.workDir || undefined,
      createdAt: inst.createdAt, lastActive: inst.lastActive,
    }],
    activeInstanceId: inst.id,
  }
}

// ────────────────────────────── 组件 ──────────────────────────────

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
    loading: integrationLoading,
  } = useIntegrationStore()

  const isConnected = status?.connected ?? false
  const connectionState = status?.connectionState ?? 'disconnected'
  const errorMessage = status?.error
  const errorDetail = status?.errorDetail

  const [editingInstance, setEditingInstance] = useState<PlatformInstance | null>(null)
  const [hasChanges, setHasChanges] = useState(false)
  const [saving, setSaving] = useState(false)
  const [configExpanded, setConfigExpanded] = useState(true)
  const [tipsExpanded, setTipsExpanded] = useState(false)
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
    setConfigExpanded(true)
    setTipsExpanded(false)
  }, [platform])

  // ──── 操作处理 ────

  const handleAddInstance = () => {
    const newInstance = createEmptyInstance(platform)
    setEditingInstance(newInstance)
    setHasChanges(true)
    setConfigExpanded(true)
  }

  const handleSave = useCallback(async () => {
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
  }, [editingInstance, instances, addInstance, updateInstance])

  const handleConnect = useCallback(async () => {
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

      const config = buildPlatformConfig(editingInstance, platform)
      if (platform === 'qqbot') {
        await startPlatform('qqbot', config as QQBotConfig)
      } else if (platform === 'feishu') {
        await startPlatform('feishu', undefined, config as FeishuConfig)
      } else {
        await startPlatform('dingtalk', undefined, undefined, config as unknown as DingTalkConfig)
      }
    } catch (err) {
      log.error('连接失败', err instanceof Error ? err : new Error(String(err)))
    } finally {
      setSaving(false)
    }
  }, [editingInstance, hasChanges, instances, activeInstance, platform, addInstance, updateInstance, switchInstance, startPlatform])

  const handleDisconnect = useCallback(async () => {
    try { await stopPlatform(platform as Platform) } catch { /* ignore */ }
  }, [platform, stopPlatform])

  const handleQuickConnect = useCallback(async (inst: PlatformInstance) => {
    try {
      if (activeInstance?.id !== inst.id) {
        await switchInstance(inst.id)
      }
      const config = buildPlatformConfig(inst, platform)
      if (platform === 'qqbot') {
        await startPlatform('qqbot', config as QQBotConfig)
      } else if (platform === 'feishu') {
        await startPlatform('feishu', undefined, config as FeishuConfig)
      } else {
        await startPlatform('dingtalk', undefined, undefined, config as unknown as DingTalkConfig)
      }
    } catch (err) {
      log.error('快速连接失败', err instanceof Error ? err : new Error(String(err)))
    }
  }, [activeInstance, platform, switchInstance, startPlatform])

  const handleSwitchInstance = useCallback(async (id: string) => {
    if (isConnected) await stopPlatform(platform as Platform)
    await switchInstance(id)
    setHasChanges(false)
  }, [isConnected, platform, stopPlatform, switchInstance])

  const handleSelectInstance = (inst: PlatformInstance) => {
    if (hasChanges && editingInstance?.id !== inst.id) {
      if (!confirm('有未保存的更改，确定要切换吗？')) return
    }
    setEditingInstance(inst)
    setHasChanges(false)
    setConfigExpanded(true)
  }

  const handleRemoveInstance = (e: React.MouseEvent, instId: string) => {
    e.stopPropagation()
    if (!confirm('确定删除此实例？')) return
    removeInstance(instId)
    if (editingInstance?.id === instId) {
      setEditingInstance(null)
      setHasChanges(false)
    }
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
  const canConnect = editingInstance ? hasRequiredConfig(platform, editingInstance) : false
  const baseFields = PLATFORM_BASE_FIELDS[platform]
  const extraFields = PLATFORM_EXTRA_FIELDS.filter(f => f.platform === platform)
  const tips = PLATFORM_TIPS[platform]

  // 计算各平台实例数量
  const qqCount = useIntegrationInstances('qqbot').length
  const feishuCount = useIntegrationInstances('feishu').length
  const dingtalkCount = useIntegrationInstances('dingtalk').length

  // 从 store 中读取所有平台状态（用于底部状态栏统计）
  const platforms = useIntegrationStore((s) => s.platforms)

  // 计算在线平台数
  const connectedPlatforms = (['qqbot', 'feishu', 'dingtalk'] as Platform[]).filter(
    (p) => platforms[p]?.connected ?? false
  )

  // 底部状态栏
  const bottomStatus = (() => {
    if (isConnected) {
      return { text: `${PLATFORM_LABELS[platform]} 已就绪`, dotClass: getStateDotStyle(connectionState) }
    }
    if (connectedPlatforms.length > 0) {
      return { text: `${connectedPlatforms.length} 个平台在线`, dotClass: 'bg-success' }
    }
    return { text: '全部离线', dotClass: 'bg-text-tertiary' }
  })()

  /** 全部断开 */
  const handleDisconnectAll = async () => {
    for (const p of ['qqbot', 'feishu', 'dingtalk'] as Platform[]) {
      try { await stopPlatform(p) } catch { /* ignore */ }
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* 面板头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface">
        <h3 className="text-xs font-semibold text-text-primary">机器人管理</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => loadInstances()}
            className="w-5 h-5 flex items-center justify-center rounded text-text-tertiary hover:text-text-secondary hover:bg-background-hover text-[11px]"
            title="刷新"
          >
            ↻
          </button>
        </div>
      </div>

      {/* 平台切换 Tab */}
      <div className="flex border-b border-border bg-surface/50">
        {(['qqbot', 'feishu', 'dingtalk'] as PlatformTab[]).map((p) => {
          const count = p === 'qqbot' ? qqCount : p === 'feishu' ? feishuCount : dingtalkCount
          return (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className={`flex-1 py-2 text-[11px] font-medium text-center transition-colors relative ${
                platform === p
                  ? 'text-primary border-b-2 border-primary bg-primary/[0.03]'
                  : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {PLATFORM_LABELS[p]}
              {count > 0 && (
                <span className={`ml-1 text-[10px] px-1.5 rounded-full ${
                  platform === p
                    ? 'bg-primary/15 text-primary'
                    : 'bg-background-hover text-text-tertiary'
                }`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* 面板内容 */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5 scrollbar-thin">
        {/* ── 实例列表 ── */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">实例</span>
            <button
              onClick={handleAddInstance}
              className="text-[10px] text-primary hover:text-primary/80 transition-colors"
            >
              + 新实例
            </button>
          </div>

          {instances.length === 0 ? (
            <div className="py-6 text-center">
              <div className="text-lg mb-1 opacity-30">🤖</div>
              <div className="text-[11px] text-text-tertiary">暂无实例，点击上方添加</div>
            </div>
          ) : (
            instances.map((inst) => {
              const isActive = activeInstance?.id === inst.id
              const hasConfig = hasRequiredConfig(platform, inst)
              return (
                <div
                  key={inst.id}
                  onClick={() => handleSelectInstance(inst)}
                  className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg border cursor-pointer transition-colors mb-1 ${
                    editingInstance?.id === inst.id
                      ? 'border-primary bg-primary/[0.04]'
                      : 'border-transparent hover:border-border hover:bg-surface'
                  }`}
                >
                  {/* 头像 */}
                  <div className={`w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold flex-shrink-0 ${PLATFORM_AVATAR_CLASS[platform]}`}>
                    {PLATFORM_AVATAR_LETTER[platform]}
                  </div>

                  {/* 信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-text-primary truncate">{inst.name}</span>
                      {isActive && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${getStateBadgeStyle(connectionState)}`}>
                          {ConnectionStateLabels[connectionState]}
                        </span>
                      )}
                      {!isActive && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-text-tertiary/15 text-text-tertiary font-medium">
                          未激活
                        </span>
                      )}
                    </div>
                    <div className="text-[9px] text-text-tertiary mt-0.5 truncate">
                      {inst.config.appId ? `${platform === 'qqbot' ? 'App ID' : platform === 'feishu' ? 'App ID' : 'App Key'}: ${inst.config.appId.slice(0, 8)}...` : '未配置'}
                      {inst.config.workDir && ` · 📂 ${inst.config.workDir.split(/[\\/]/).pop()}`}
                      {platform === 'qqbot' && inst.config.sandbox && ' · 沙箱'}
                    </div>
                  </div>

                  {/* 操作 */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {isActive && isConnected ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDisconnect() }}
                        className="text-[9px] px-1.5 py-0.5 border border-danger/30 rounded text-danger hover:bg-danger/10 transition-colors"
                      >
                        断开
                      </button>
                    ) : hasConfig ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleQuickConnect(inst) }}
                        className="text-[9px] px-1.5 py-0.5 bg-primary text-white rounded hover:bg-primary/90 transition-colors"
                      >
                        连接
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleSwitchInstance(inst.id) }}
                        className="text-[9px] px-1.5 py-0.5 text-text-tertiary hover:text-primary transition-colors"
                      >
                        切换
                      </button>
                    )}
                    {!isActive && (
                      <button
                        onClick={(e) => handleRemoveInstance(e, inst.id)}
                        className="text-[9px] px-1.5 py-0.5 text-text-tertiary hover:text-danger transition-colors"
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* ── 配置编辑 ── */}
        {editingInstance && (
          <div className="border border-border rounded-lg overflow-hidden bg-surface">
            {/* 折叠头 */}
            <div
              onClick={() => setConfigExpanded(!configExpanded)}
              className="flex items-center justify-between px-2.5 py-2 cursor-pointer hover:bg-background-hover transition-colors select-none"
            >
              <div className="flex items-center gap-1.5">
                <span className={`text-[9px] text-text-tertiary transition-transform ${configExpanded ? 'rotate-90' : ''}`}>▶</span>
                <span className="text-[10px] font-medium text-text-secondary">配置 — {editingInstance.name}</span>
              </div>
              <div className="flex items-center gap-1.5">
                {hasChanges && <span className="text-[9px] text-warning bg-warning/10 px-1.5 py-0.5 rounded">未保存</span>}
                {isEditingActive && (
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${getStateBadgeStyle(connectionState)}`}>
                    {ConnectionStateLabels[connectionState]}
                  </span>
                )}
              </div>
            </div>

            {/* 折叠内容 */}
            {configExpanded && (
              <div className="px-2.5 pb-3 space-y-2.5 border-t border-border">
                {/* 实例名称 */}
                <div className="pt-2.5">
                  <label className="block text-[10px] text-text-tertiary mb-1">名称</label>
                  <input
                    type="text"
                    value={editingInstance.name}
                    onChange={(e) => updateName(e.target.value)}
                    className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs text-text-primary focus:outline-none focus:border-primary transition-colors"
                  />
                </div>

                {/* 基础字段 */}
                {baseFields.map((field) => (
                  <div key={field.key}>
                    <label className="block text-[10px] text-text-tertiary mb-1">{field.label}</label>
                    <input
                      type={field.type}
                      value={(editingInstance.config as unknown as Record<string, string>)[field.key] || ''}
                      onChange={(e) => updateConfig({ [field.key]: e.target.value })}
                      placeholder={field.placeholder}
                      className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs text-text-primary focus:outline-none focus:border-primary transition-colors"
                    />
                    {field.hint && <p className="mt-0.5 text-[9px] text-text-tertiary">{field.hint}</p>}
                  </div>
                ))}

                {/* 平台特有字段 */}
                {extraFields.map((field) => {
                  if (field.key === 'sandbox') {
                    // 沙箱开关（QQ Bot 特有）
                    return (
                      <div key={field.key}>
                        <label className="block text-[10px] text-text-tertiary mb-1">沙箱环境</label>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => updateConfig({ sandbox: !editingInstance.config.sandbox })}
                            className={`w-8 h-4 rounded-full relative transition-colors ${
                              editingInstance.config.sandbox ? 'bg-primary' : 'bg-background-hover border border-border'
                            }`}
                          >
                            <div className={`w-3 h-3 rounded-full bg-white absolute top-0.5 transition-all ${
                              editingInstance.config.sandbox ? 'left-4' : 'left-0.5'
                            }`} />
                          </button>
                          <span className="text-[10px] text-text-tertiary">
                            {editingInstance.config.sandbox ? '开启（用于测试）' : '关闭（生产环境）'}
                          </span>
                        </div>
                      </div>
                    )
                  }
                  return (
                    <div key={field.key}>
                      <label className="block text-[10px] text-text-tertiary mb-1">{field.label}</label>
                      <input
                        type={field.type}
                        value={(editingInstance.config as unknown as Record<string, string>)[field.key] || ''}
                        onChange={(e) => updateConfig({ [field.key]: e.target.value })}
                        placeholder={field.placeholder}
                        className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs text-text-primary focus:outline-none focus:border-primary transition-colors"
                      />
                      {field.hint && <p className="mt-0.5 text-[9px] text-text-tertiary">{field.hint}</p>}
                    </div>
                  )
                })}

                {/* 工作目录 */}
                <div>
                  <label className="block text-[10px] text-text-tertiary mb-1">默认工作区</label>
                  {workspaces.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {workspaces.slice(0, 6).map((ws) => (
                        <button
                          key={ws.id}
                          type="button"
                          onClick={() => updateConfig({ workDir: ws.path === editingInstance.config.workDir ? '' : ws.path })}
                          className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
                            editingInstance.config.workDir === ws.path
                              ? 'bg-primary/15 text-primary'
                              : 'bg-background-hover text-text-tertiary hover:bg-background-active'
                          }`}
                        >
                          {ws.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <input
                    type="text"
                    value={editingInstance.config.workDir || ''}
                    onChange={(e) => updateConfig({ workDir: e.target.value })}
                    placeholder="留空则使用应用默认目录"
                    className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs text-text-primary focus:outline-none focus:border-primary transition-colors"
                  />
                  <p className="mt-0.5 text-[9px] text-text-tertiary">新会话自动使用此目录（可选）</p>
                </div>

                {/* 操作按钮 */}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={handleSave}
                    disabled={!hasChanges || saving}
                    className="flex-1 py-1.5 text-[10px] border border-border rounded text-text-secondary hover:border-primary hover:text-primary disabled:opacity-40 transition-colors"
                  >
                    {saving ? '保存中...' : '保存'}
                  </button>
                  {isEditingActive && isConnected ? (
                    <button
                      onClick={handleDisconnect}
                      className="flex-1 py-1.5 text-[10px] border border-danger/30 rounded text-danger hover:bg-danger/10 transition-colors"
                    >
                      断开
                    </button>
                  ) : (
                    <button
                      onClick={handleConnect}
                      disabled={saving || !canConnect || integrationLoading}
                      className="flex-1 py-1.5 text-[10px] bg-primary text-white rounded hover:bg-primary/90 disabled:opacity-40 transition-colors"
                    >
                      {saving ? '...' : integrationLoading ? '连接中...' : '连接'}
                    </button>
                  )}
                </div>

                {/* 错误信息 */}
                {isEditingActive && connectionState === 'failed' && errorMessage && (
                  <div className="p-2 bg-danger/10 border border-danger/20 rounded">
                    <p className="text-[10px] text-danger font-medium">{errorMessage}</p>
                    {errorDetail && (
                      <pre className="mt-1 text-[9px] text-text-tertiary whitespace-pre-wrap">{errorDetail}</pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── 使用说明 ── */}
        <div className="border border-border rounded-lg overflow-hidden bg-surface">
          <div
            onClick={() => setTipsExpanded(!tipsExpanded)}
            className="flex items-center gap-1.5 px-2.5 py-2 cursor-pointer hover:bg-background-hover transition-colors select-none"
          >
            <span className={`text-[9px] text-text-tertiary transition-transform ${tipsExpanded ? 'rotate-90' : ''}`}>▶</span>
            <span className="text-[10px] font-medium text-text-secondary">使用说明</span>
          </div>
          {tipsExpanded && (
            <div className="px-2.5 pb-2.5 border-t border-border">
              <ul className="pt-2 space-y-1">
                {tips.map((tip, i) => (
                  <li key={i} className="text-[9px] text-text-tertiary flex items-start gap-1.5">
                    <span className="text-primary mt-0.5">•</span>
                    {tip}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* 底部状态栏 */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-border bg-surface">
        <span className={`w-2 h-2 rounded-full ${bottomStatus.dotClass}`} />
        <span className="text-[10px] text-text-tertiary">{bottomStatus.text}</span>
        <div className="flex-1" />
        <button
          onClick={handleDisconnectAll}
          className="text-[9px] px-2 py-1 border border-border rounded text-text-tertiary hover:text-danger hover:border-danger/30 transition-colors"
        >
          全部断开
        </button>
      </div>
    </div>
  )
}