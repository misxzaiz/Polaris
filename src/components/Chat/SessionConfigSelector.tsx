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
} from '../../types/sessionConfig'
import { useCliInfoStore } from '../../stores/cliInfoStore'

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

type SelectorType = 'agent' | 'model' | 'effort' | 'permission'

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
  const containerRef = useRef<HTMLDivElement>(null)

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
    if (dynamicAgents.length > 0) {
      return dynamicAgents.map(a => ({
        id: a.id,
        name: a.name,
        description: `${a.source === 'plugin' ? '插件' : '内置'}${a.defaultModel ? ` · ${a.defaultModel}` : ''}`,
      }))
    }
    return PRESET_AGENTS
  }, [dynamicAgents])

  // 获取当前选择的显示名称
  const getAgentLabel = useCallback((agentId?: string) => {
    if (!agentId) return t('sessionConfig.defaultAgent', '通用')
    const agent = agentList.find(a => a.id === agentId)
    return agent?.name || agentId
  }, [t, agentList])

  const getModelLabel = useCallback((modelId?: string) => {
    if (!modelId) return t('sessionConfig.defaultModel', 'Sonnet')
    const model = PRESET_MODELS.find(m => m.id === modelId)
    return model?.name || modelId
  }, [t])

  const getEffortLabel = useCallback((effort?: EffortLevel) => {
    const opt = EFFORT_OPTIONS.find(o => o.value === (effort || 'medium'))
    return opt?.label || effort || '中'
  }, [])

  const getPermissionLabel = useCallback((mode?: PermissionMode) => {
    const opt = PERMISSION_MODE_OPTIONS.find(o => o.value === (mode || 'default'))
    return opt?.label || mode || '默认'
  }, [])

  // 通用选择处理
  const handleSelect = useCallback((type: SelectorType, value: string) => {
    // 处理字段名映射
    const configKey = type === 'permission' ? 'permissionMode' : type
    onChange({
      ...config,
      [configKey]: value,
    })
    setOpenDropdown(null)
  }, [config, onChange])

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
        items.push(...PRESET_MODELS.map(m => ({
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
    }

    const getCurrentValue = (): string | undefined => {
      switch (type) {
        case 'agent': return config.agent
        case 'model': return config.model
        case 'effort': return config.effort
        case 'permission': return config.permissionMode
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
  }

  const ALL_TYPES: SelectorType[] = ['agent', 'model', 'effort', 'permission']
  const typesToShow = visibleTypes ?? ALL_TYPES

  return (
    <div ref={containerRef} className="flex items-center gap-1">
      {typesToShow.map(type => {
        const { icon, label, getValue } = selectorMeta[type]
        return <React.Fragment key={type}>{renderSelector(type, icon, label, getValue())}</React.Fragment>
      })}
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
  const containerRef = useRef<HTMLDivElement>(null)

  // 动态 Agent 列表
  const dynamicAgents = useCliInfoStore(s => s.agents)
  const agentList = useMemo(() => {
    if (dynamicAgents.length > 0) {
      return dynamicAgents.map(a => ({ id: a.id, name: a.name }))
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

  const getAgentLabel = (agentId?: string) => {
    if (!agentId) return '通用'
    return agentList.find(a => a.id === agentId)?.name || agentId
  }

  const getModelLabel = (modelId?: string) => {
    if (!modelId) return 'Sonnet'
    return PRESET_MODELS.find(m => m.id === modelId)?.name || modelId
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
          </div>
        )}
      </div>
    </div>
  )
}

export default SessionConfigSelector
