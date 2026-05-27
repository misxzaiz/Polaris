/**
 * SessionConfigSelector - 会话配置选择器
 *
 * 用于选择 Agent/Model/Effort/PermissionMode
 * 位于 ChatStatusBar 中，影响下一次发送消息的行为
 *
 * Agent/Model 列表优先从 cliInfoStore 动态获取，降级使用 PRESET_AGENTS/PRESET_MODELS
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Bot, Cpu, Zap, Shield } from 'lucide-react'
import { clsx } from 'clsx'
import {
  PRESET_AGENTS,
  PRESET_MODELS,
  EFFORT_OPTIONS,
  PERMISSION_MODE_OPTIONS,
  type SessionRuntimeConfig,
  type EffortLevel,
  type PermissionMode,
} from '@/types/sessionConfig'
import { useCliInfoStore } from '@/stores/cliInfoStore'
import { useModelProfileStore } from '@/stores/modelProfileStore'

interface SessionConfigSelectorProps {
  /** 当前配置 */
  config: SessionRuntimeConfig
  /** 配置变更回调 */
  onChange: (config: SessionRuntimeConfig) => void
  /** 是否禁用 */
  disabled?: boolean
  /** 只渲染指定类型的选择器，不传则渲染全部 */
  visibleTypes?: SelectorType[]
}

type SelectorType = 'agent' | 'model' | 'effort' | 'permission' | 'profile'

/**
 * 会话配置选择器组件
 */
export function SessionConfigSelector({
  config,
  onChange,
  disabled = false,
  visibleTypes,
}: SessionConfigSelectorProps) {
  const { t } = useTranslation('chat')
  const [openDropdown, setOpenDropdown] = useState<SelectorType | null>(null)
  const [customInput, setCustomInput] = useState<{ type: SelectorType; value: string } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenDropdown(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // 动态 Agent 列表：优先 CLI 获取，降级 PRESET
  const dynamicAgents = useCliInfoStore(s => s.agents)
  const agentList = useMemo(() => {
    const emptyOption = { id: '', name: '不设置', description: '不传 Agent 参数，使用 CLI 默认模式' }
    if (dynamicAgents.length > 0) {
      return [
        emptyOption,
        ...dynamicAgents.map(a => ({
          id: a.id,
          name: a.name,
          description: `${a.source === 'plugin' ? '插件' : '内置'}${a.defaultModel ? ` · ${a.defaultModel}` : ''}`,
        }))
      ]
    }
    return PRESET_AGENTS
  }, [dynamicAgents])

  // 模型 Profile 列表
  const profiles = useModelProfileStore(s => s.profiles)

  // 合并后的模型列表：官方模型 + Profile
  const modelList = useMemo(() => {
    const officialModels = PRESET_MODELS
    const profileModels = profiles.map(p => ({
      id: `profile:${p.id}`,
      name: `🔄 ${p.name}`,
      description: p.description || `${p.model} @ ${new URL(p.baseUrl).hostname}`,
    }))
    return [...officialModels, ...profileModels]
  }, [profiles])

  // 获取当前选择的显示名称
  const getAgentLabel = useCallback((agentId?: string) => {
    if (!agentId) return t('sessionConfig.noAgent', '不设置')
    const agent = agentList.find(a => a.id === agentId)
    return agent?.name || agentId
  }, [t, agentList])

  const getModelLabel = useCallback((modelId?: string) => {
    if (!modelId) return t('sessionConfig.noModel', '不设置')
    // Profile 模型
    if (modelId.startsWith('profile:')) {
      const profileId = modelId.slice('profile:'.length)
      const profile = profiles.find(p => p.id === profileId)
      return profile ? `🔄 ${profile.name}` : modelId
    }
    // 官方模型
    const model = PRESET_MODELS.find(m => m.id === modelId)
    return model?.name || modelId
  }, [t, profiles])

  const getEffortLabel = useCallback((effort?: EffortLevel | '') => {
    if (!effort) return t('sessionConfig.noEffort', '不设置')
    const opt = EFFORT_OPTIONS.find(o => o.value === effort)
    return opt?.label || effort
  }, [t])

  const getPermissionLabel = useCallback((mode?: PermissionMode | '') => {
    if (!mode) return t('sessionConfig.noPermission', '不设置')
    const opt = PERMISSION_MODE_OPTIONS.find(o => o.value === mode)
    return opt?.label || mode
  }, [t])

  // 通用选择处理
  const handleSelect = useCallback((type: SelectorType, value: string) => {
    // 处理字段名映射
    const configKey = type === 'permission' ? 'permissionMode' : type === 'profile' ? 'modelProfileId' : type
    onChange({
      ...config,
      [configKey]: value,
    })
    setOpenDropdown(null)
  }, [config, onChange])

  // 处理自定义输入确认
  const handleCustomInputConfirm = useCallback((type: SelectorType) => {
    if (!customInput || customInput.type !== type) return
    const value = customInput.value.trim()
    if (value) {
      handleSelect(type, value)
    }
    setCustomInput(null)
  }, [customInput, handleSelect])

  // 打开自定义输入模式
  const openCustomInput = useCallback((type: SelectorType) => {
    setCustomInput({ type, value: '' })
    setOpenDropdown(null)
    // 延迟聚焦输入框
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  // 渲染下拉选项
  const renderDropdown = (type: SelectorType) => {
    if (openDropdown !== type) return null

    const items: Array<{ value: string; label: string; description?: string }> = []

    switch (type) {
      case 'agent':
        items.push(...agentList.map(a => ({
          value: a.id,
          label: a.name,
          description: a.description,
        })))
        break
      case 'model':
        items.push(...modelList.map(m => ({
          value: m.id,
          label: m.name,
          description: m.description,
        })))
        break
      case 'effort':
        items.push(...EFFORT_OPTIONS.map(o => ({
          value: o.value,
          label: o.label,
          description: o.description,
        })))
        break
      case 'permission':
        items.push(...PERMISSION_MODE_OPTIONS.map(o => ({
          value: o.value,
          label: o.label,
          description: o.description,
        })))
        break
      case 'profile':
        // 官方 API（空 = 不使用 Profile）
        items.push({
          value: '',
          label: t('sessionConfig.officialApi', '官方 API'),
          description: t('sessionConfig.officialApiDesc', '使用 Anthropic 官方端点'),
        })
        // Profile 列表
        items.push(...profiles.map(p => ({
          value: p.id,
          label: `🔄 ${p.name}`,
          description: p.description || `${p.model} @ ${p.baseUrl}`,
        })))
        break
    }

    const getCurrentValue = (): string | undefined => {
      switch (type) {
        case 'agent': return config.agent
        case 'model': return config.model
        case 'effort': return config.effort
        case 'permission': return config.permissionMode
        case 'profile': return config.modelProfileId
        default: return undefined
      }
    }

    const currentValue = getCurrentValue()

    return (
      <div className={clsx(
        'absolute bottom-full left-0 mb-1',
        'bg-background-elevated border border-border rounded-lg shadow-lg',
        'min-w-[180px] max-h-[240px] overflow-y-auto',
        'z-50 animate-in fade-in slide-in-from-bottom-1 duration-150'
      )}>
        {items.map((item) => (
          <button
            key={item.value}
            onClick={() => handleSelect(type, item.value)}
            className={clsx(
              'w-full px-3 py-2 text-left text-xs',
              'hover:bg-background-hover transition-colors',
              'flex flex-col gap-0.5',
              currentValue === item.value && 'bg-primary/10 text-primary'
            )}
          >
            <span className="font-medium">{item.label}</span>
            {item.description && (
              <span className="text-text-tertiary text-[10px]">{item.description}</span>
            )}
          </button>
        ))}
        {/* 分隔线 */}
        <div className="border-t border-border my-1" />
        {/* 自定义输入选项 */}
        <button
          onClick={() => openCustomInput(type)}
          className={clsx(
            'w-full px-3 py-2 text-left text-xs',
            'hover:bg-background-hover transition-colors',
            'text-text-tertiary italic'
          )}
        >
          ✏️ 自定义...
        </button>
      </div>
    )
  }

  // 渲染单个选择器按钮
  const renderSelector = (
    type: SelectorType,
    icon: React.ReactNode,
    label: string,
    currentValue: string | undefined
  ) => (
    <div className="relative">
      <button
        onClick={() => !disabled && setOpenDropdown(openDropdown === type ? null : type)}
        disabled={disabled}
        className={clsx(
          'flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors',
          disabled
            ? 'text-text-muted cursor-not-allowed'
            : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover',
          openDropdown === type && 'bg-primary/10 text-primary'
        )}
        title={t(`sessionConfig.${type}Tooltip`, `选择${label}`)}
      >
        {icon}
        <span className="max-w-[60px] truncate">{currentValue}</span>
        <ChevronDown size={12} className="opacity-50" />
      </button>
      {renderDropdown(type)}
    </div>
  )

  // 选择器元数据映射
  const selectorMeta: Record<SelectorType, { icon: React.ReactNode; label: string; getValue: () => string }> = {
    agent: {
      icon: <Bot size={12} />,
      label: t('sessionConfig.agent', 'Agent'),
      getValue: () => getAgentLabel(config.agent),
    },
    model: {
      icon: <Cpu size={12} />,
      label: t('sessionConfig.model', '模型'),
      getValue: () => getModelLabel(config.model),
    },
    effort: {
      icon: <Zap size={12} />,
      label: t('sessionConfig.effort', '努力'),
      getValue: () => getEffortLabel(config.effort),
    },
    permission: {
      icon: <Shield size={12} />,
      label: t('sessionConfig.permission', '权限'),
      getValue: () => getPermissionLabel(config.permissionMode),
    },
    profile: {
      icon: <Cpu size={12} />,
      label: t('sessionConfig.profile', '端点'),
      getValue: () => {
        if (!config.modelProfileId) return t('sessionConfig.noProfile', '官方')
        const profile = profiles.find(p => p.id === config.modelProfileId)
        return profile ? `🔄 ${profile.name}` : t('sessionConfig.noProfile', '官方')
      },
    },
  }

  const ALL_TYPES: SelectorType[] = ['agent', 'model', 'effort', 'permission', 'profile']
  const typesToShow = visibleTypes ?? ALL_TYPES

  return (
    <div ref={containerRef} className="flex items-center gap-1">
      {typesToShow.map(type => {
        const { icon, label, getValue } = selectorMeta[type]
        return <React.Fragment key={type}>{renderSelector(type, icon, label, getValue())}</React.Fragment>
      })}
      {/* 自定义输入浮层 */}
      {customInput && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-background-elevated border border-border rounded-lg p-4 min-w-[280px] shadow-xl">
            <div className="text-xs text-text-secondary mb-2">
              输入自定义 {selectorMeta[customInput.type].label} 值：
            </div>
            <input
              ref={inputRef}
              type="text"
              value={customInput.value}
              onChange={(e) => setCustomInput({ ...customInput, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCustomInputConfirm(customInput.type)
                if (e.key === 'Escape') setCustomInput(null)
              }}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
              placeholder={`输入 ${customInput.type} 值...`}
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setCustomInput(null)}
                className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
              >
                取消
              </button>
              <button
                onClick={() => handleCustomInputConfirm(customInput.type)}
                className="px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary-hover"
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 简化版选择器（仅 Agent + Model）
 *
 * 用于空间受限的场景
 */
export function CompactSessionSelector({
  config,
  onChange,
  disabled = false,
}: SessionConfigSelectorProps) {
  const [openDropdown, setOpenDropdown] = useState<SelectorType | null>(null)
  const [customInput, setCustomInput] = useState<{ type: SelectorType; value: string } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 动态 Agent 列表
  const dynamicAgents = useCliInfoStore(s => s.agents)
  const agentList = useMemo(() => {
    const emptyOption = { id: '', name: '不设置' }
    if (dynamicAgents.length > 0) {
      return [emptyOption, ...dynamicAgents.map(a => ({ id: a.id, name: a.name }))]
    }
    return PRESET_AGENTS
  }, [dynamicAgents])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenDropdown(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSelect = useCallback((type: SelectorType, value: string) => {
    // 处理 permission -> permissionMode 映射
    if (type === 'permission') {
      onChange({ ...config, permissionMode: value as PermissionMode })
    } else if (type === 'effort') {
      onChange({ ...config, effort: value as EffortLevel })
    } else {
      onChange({ ...config, [type]: value })
    }
    setOpenDropdown(null)
  }, [config, onChange])

  // 处理自定义输入确认
  const handleCustomInputConfirm = useCallback((type: SelectorType) => {
    if (!customInput || customInput.type !== type) return
    const value = customInput.value.trim()
    if (value) {
      handleSelect(type, value)
    }
    setCustomInput(null)
  }, [customInput, handleSelect])

  // 打开自定义输入模式
  const openCustomInput = useCallback((type: SelectorType) => {
    setCustomInput({ type, value: '' })
    setOpenDropdown(null)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  const getAgentLabel = (agentId?: string) => {
    if (!agentId) return '不设置'
    return agentList.find(a => a.id === agentId)?.name || agentId
  }

  const getModelLabel = (modelId?: string) => {
    if (!modelId) return '不设置'
    return PRESET_MODELS.find(m => m.id === modelId)?.name || modelId
  }

  const selectorLabels: Record<SelectorType, string> = {
    agent: 'Agent',
    model: '模型',
    effort: '努力',
    permission: '权限',
    profile: '端点',
  }

  return (
    <div ref={containerRef} className="flex items-center gap-0.5">
      {/* Agent */}
      <div className="relative">
        <button
          onClick={() => !disabled && setOpenDropdown(openDropdown === 'agent' ? null : 'agent')}
          disabled={disabled}
          className={clsx(
            'flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs transition-colors',
            disabled
              ? 'text-text-muted cursor-not-allowed'
              : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover',
            openDropdown === 'agent' && 'bg-primary/10 text-primary'
          )}
        >
          <Bot size={12} />
          <span className="max-w-[48px] truncate">{getAgentLabel(config.agent)}</span>
          <ChevronDown size={10} className="opacity-50" />
        </button>
        {openDropdown === 'agent' && (
          <div className="absolute bottom-full left-0 mb-1 bg-background-elevated border border-border rounded-lg shadow-lg min-w-[140px] z-50">
            {agentList.map(agent => (
              <button
                key={agent.id}
                onClick={() => handleSelect('agent', agent.id)}
                className={clsx(
                  'w-full px-2 py-1.5 text-left text-xs hover:bg-background-hover',
                  config.agent === agent.id && 'bg-primary/10 text-primary'
                )}
              >
                {agent.name}
              </button>
            ))}
            <div className="border-t border-border my-1" />
            <button
              onClick={() => openCustomInput('agent')}
              className="w-full px-2 py-1.5 text-left text-xs hover:bg-background-hover text-text-tertiary italic"
            >
              ✏️ 自定义...
            </button>
          </div>
        )}
      </div>

      {/* Model */}
      <div className="relative">
        <button
          onClick={() => !disabled && setOpenDropdown(openDropdown === 'model' ? null : 'model')}
          disabled={disabled}
          className={clsx(
            'flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs transition-colors',
            disabled
              ? 'text-text-muted cursor-not-allowed'
              : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover',
            openDropdown === 'model' && 'bg-primary/10 text-primary'
          )}
        >
          <Cpu size={12} />
          <span className="max-w-[48px] truncate">{getModelLabel(config.model)}</span>
          <ChevronDown size={10} className="opacity-50" />
        </button>
        {openDropdown === 'model' && (
          <div className="absolute bottom-full left-0 mb-1 bg-background-elevated border border-border rounded-lg shadow-lg min-w-[140px] z-50">
            {PRESET_MODELS.map(model => (
              <button
                key={model.id}
                onClick={() => handleSelect('model', model.id)}
                className={clsx(
                  'w-full px-2 py-1.5 text-left text-xs hover:bg-background-hover',
                  config.model === model.id && 'bg-primary/10 text-primary'
                )}
              >
                {model.name}
              </button>
            ))}
            <div className="border-t border-border my-1" />
            <button
              onClick={() => openCustomInput('model')}
              className="w-full px-2 py-1.5 text-left text-xs hover:bg-background-hover text-text-tertiary italic"
            >
              ✏️ 自定义...
            </button>
          </div>
        )}
      </div>

      {/* 自定义输入浮层 */}
      {customInput && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-background-elevated border border-border rounded-lg p-4 min-w-[280px] shadow-xl">
            <div className="text-xs text-text-secondary mb-2">
              输入自定义 {selectorLabels[customInput.type]} 值：
            </div>
            <input
              ref={inputRef}
              type="text"
              value={customInput.value}
              onChange={(e) => setCustomInput({ ...customInput, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCustomInputConfirm(customInput.type)
                if (e.key === 'Escape') setCustomInput(null)
              }}
              className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg outline-none focus:border-primary"
              placeholder={`输入 ${customInput.type} 值...`}
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setCustomInput(null)}
                className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
              >
                取消
              </button>
              <button
                onClick={() => handleCustomInputConfirm(customInput.type)}
                className="px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary-hover"
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default SessionConfigSelector
