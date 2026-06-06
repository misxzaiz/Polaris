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
import { ChevronDown, Bot, Cpu, Zap, Shield, Plug } from 'lucide-react'
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
import { useConfigStore } from '@/stores'
import { useModelProfileStore } from '@/stores/modelProfileStore'
import { isProfileForEngine } from '@/types/modelProfile'

interface SessionConfigSelectorProps {
  /** 当前配置 */
  config: SessionRuntimeConfig
  /** 配置变更回调 */
  onChange: (config: SessionRuntimeConfig) => void
  /** 是否禁用 */
  disabled?: boolean
  /** 只渲染指定类型的选择器，不传则渲染全部 */
  visibleTypes?: SelectorType[]
  /** 布局变体：inline 横向紧凑（主行），panel 纵向带 label（折叠面板） */
  variant?: 'inline' | 'panel'
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
  variant = 'inline',
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
    const emptyOption = { id: '', name: t('sessionConfig.noAgent'), description: t('sessionConfig.noAgentDesc') }
    if (dynamicAgents.length > 0) {
      return [
        emptyOption,
        ...dynamicAgents.map(a => ({
          id: a.id,
          name: a.name,
          description: `${a.source === 'plugin' ? t('sessionConfig.pluginSource') : t('sessionConfig.builtinSource')}${a.defaultModel ? ` · ${a.defaultModel}` : ''}`,
        }))
      ]
    }
    return PRESET_AGENTS
  }, [dynamicAgents, t])

  // 模型 Profile 列表
  const profiles = useModelProfileStore(s => s.profiles)

  // 当前引擎（用于过滤 Profile）
  const defaultEngine = useConfigStore(s => s.config?.defaultEngine || 'claude-code')
  const currentEngine: 'claude' | 'codex' = defaultEngine === 'codex' ? 'codex' : 'claude'

  // 模型列表：仅官方模型档位（opus/sonnet/haiku）。
  // 第三方端点请使用独立的「端点（profile）」选择器——model 字段会原样传给 CLI 的 --model，
  // 混入 profile: 项会被当作无效模型名，故此处不再合并 Profile。
  const modelList = PRESET_MODELS

  // 按当前引擎过滤 Profile 列表
  const compatibleProfiles = useMemo(() => {
    return profiles.filter(p => isProfileForEngine(p, currentEngine))
  }, [profiles, currentEngine])

  // 获取当前选择的显示名称
  const getAgentLabel = useCallback((agentId?: string) => {
    if (!agentId) return t('sessionConfig.noAgent')
    const agent = agentList.find(a => a.id === agentId)
    return agent?.name || agentId
  }, [t, agentList])

  const getModelLabel = useCallback((modelId?: string) => {
    if (!modelId) return t('sessionConfig.noModel')
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
    if (!effort) return t('sessionConfig.noEffort')
    const opt = EFFORT_OPTIONS.find(o => o.value === effort)
    return opt?.label || effort
  }, [t])

  const getPermissionLabel = useCallback((mode?: PermissionMode | '') => {
    if (!mode) return t('sessionConfig.noPermission')
    const opt = PERMISSION_MODE_OPTIONS.find(o => o.value === mode)
    return opt?.label || mode
  }, [t])

  // 通用选择处理
  const handleSelect = useCallback((type: SelectorType, value: string) => {
    // 跳过提示项
    if (value === '__skipped__') return
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
      case 'profile': {
        // 官方 API（空 = 不使用 Profile）
        items.push({
          value: '',
          label: t('sessionConfig.officialApi'),
          description: t('sessionConfig.officialApiDesc'),
        })
        // 过滤出与当前引擎兼容的 Profile
        items.push(...compatibleProfiles.map(p => ({
          value: p.id,
          label: `${p.wireApi === 'openai-chat-completions' ? '🔵' : '🔄'} ${p.name}`,
          description: p.description || `${p.model} @ ${new URL(p.baseUrl).hostname}${p.wireApi === 'openai-chat-completions' ? ' (OpenAI)' : ''}`,
        })))
        // 如果有被过滤掉的 Profile，显示提示
        const skippedCount = profiles.length - compatibleProfiles.length
        if (skippedCount > 0) {
          items.push({
            value: '__skipped__',
            label: `… 另有 ${skippedCount} 个 Profile 不适用于当前引擎`,
            description: '',
          })
        }
        break
      }
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
          ✏️ {t('sessionConfig.custom')}
        </button>
      </div>
    )
  }

  // 选择器元数据映射（图标需可区分：profile 用 Plug，与 model 的 Cpu 区分开）
  const selectorMeta: Record<SelectorType, { icon: React.ReactNode; label: string; getValue: () => string }> = {
    agent: {
      icon: <Bot size={12} />,
      label: t('sessionConfig.agent'),
      getValue: () => getAgentLabel(config.agent),
    },
    model: {
      icon: <Cpu size={12} />,
      label: t('sessionConfig.model'),
      getValue: () => getModelLabel(config.model),
    },
    effort: {
      icon: <Zap size={12} />,
      label: t('sessionConfig.effort'),
      getValue: () => getEffortLabel(config.effort),
    },
    permission: {
      icon: <Shield size={12} />,
      label: t('sessionConfig.permission'),
      getValue: () => getPermissionLabel(config.permissionMode),
    },
    profile: {
      icon: <Plug size={12} />,
      label: t('sessionConfig.profile'),
      getValue: () => {
        if (!config.modelProfileId) return t('sessionConfig.noProfile')
        const profile = profiles.find(p => p.id === config.modelProfileId)
        if (!profile) return t('sessionConfig.noProfile')
        return `${profile.wireApi === 'openai-chat-completions' ? '🔵' : '🔄'} ${profile.name}`
      },
    },
  }

  // 各选择器值的最大宽度：profile（端点）最常用，给更宽的展示空间
  const VALUE_MAX_W: Record<SelectorType, string> = {
    profile: 'max-w-[140px]',
    model: 'max-w-[90px]',
    effort: 'max-w-[64px]',
    agent: 'max-w-[90px]',
    permission: 'max-w-[72px]',
  }

  // 渲染单个选择器按钮
  // - inline：横向紧凑，仅图标 + 截断值（主行）
  // - panel：纵向，图标 + 字段名 + 值（折叠面板，可读性优先）
  const renderSelector = (type: SelectorType, mode: 'inline' | 'panel') => {
    const { icon, label, getValue } = selectorMeta[type]
    const currentValue = getValue()
    return (
      <div className={clsx('relative', mode === 'panel' && 'w-full')}>
        <button
          onClick={() => !disabled && setOpenDropdown(openDropdown === type ? null : type)}
          disabled={disabled}
          className={clsx(
            'flex items-center gap-1 rounded text-xs transition-colors',
            mode === 'panel' ? 'w-full px-2 py-1' : 'px-1.5 py-0.5',
            disabled
              ? 'text-text-muted cursor-not-allowed'
              : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover',
            openDropdown === type && 'bg-primary/10 text-primary'
          )}
          title={t(`sessionConfig.${type}Tooltip`)}
        >
          <span className="shrink-0">{icon}</span>
          {mode === 'panel' && <span className="shrink-0 text-text-muted">{label}</span>}
          <span className={clsx('truncate', mode === 'panel' ? 'flex-1 text-left' : VALUE_MAX_W[type])}>
            {currentValue}
          </span>
          <ChevronDown size={12} className="opacity-50 shrink-0" />
        </button>
        {renderDropdown(type)}
      </div>
    )
  }

  const ALL_TYPES: SelectorType[] = ['agent', 'model', 'effort', 'permission', 'profile']
  const typesToShow = visibleTypes ?? ALL_TYPES

  return (
    <div ref={containerRef} className={clsx(variant === 'panel' ? 'flex flex-col gap-0.5 w-full' : 'flex items-center gap-1')}>
      {typesToShow.map(type => (
        <React.Fragment key={type}>{renderSelector(type, variant)}</React.Fragment>
      ))}
      {/* 自定义输入浮层 */}
      {customInput && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-background-elevated border border-border rounded-lg p-4 min-w-[280px] shadow-xl">
            <div className="text-xs text-text-secondary mb-2">
              {t('sessionConfig.customInputLabel', { type: selectorMeta[customInput.type].label })}
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
              placeholder={t('sessionConfig.customInputPlaceholder', { type: customInput.type })}
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setCustomInput(null)}
                className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
              >
                {t('sessionConfig.cancel')}
              </button>
              <button
                onClick={() => handleCustomInputConfirm(customInput.type)}
                className="px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary-hover"
              >
                {t('sessionConfig.confirm')}
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
  const { t } = useTranslation('chat')
  const [openDropdown, setOpenDropdown] = useState<SelectorType | null>(null)
  const [customInput, setCustomInput] = useState<{ type: SelectorType; value: string } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 动态 Agent 列表
  const dynamicAgents = useCliInfoStore(s => s.agents)
  const agentList = useMemo(() => {
    const emptyOption = { id: '', name: t('sessionConfig.noAgent') }
    if (dynamicAgents.length > 0) {
      return [emptyOption, ...dynamicAgents.map(a => ({ id: a.id, name: a.name }))]
    }
    return PRESET_AGENTS
  }, [dynamicAgents, t])

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
    if (!agentId) return t('sessionConfig.noAgent')
    return agentList.find(a => a.id === agentId)?.name || agentId
  }

  const getModelLabel = (modelId?: string) => {
    if (!modelId) return t('sessionConfig.noModel')
    return PRESET_MODELS.find(m => m.id === modelId)?.name || modelId
  }

  const selectorLabels: Record<SelectorType, string> = {
    agent: t('sessionConfig.agent'),
    model: t('sessionConfig.model'),
    effort: t('sessionConfig.effort'),
    permission: t('sessionConfig.permission'),
    profile: t('sessionConfig.profile'),
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
              ✏️ {t('sessionConfig.custom')}
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
              ✏️ {t('sessionConfig.custom')}
            </button>
          </div>
        )}
      </div>

      {/* 自定义输入浮层 */}
      {customInput && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-background-elevated border border-border rounded-lg p-4 min-w-[280px] shadow-xl">
            <div className="text-xs text-text-secondary mb-2">
              {t('sessionConfig.customInputLabel', { type: selectorLabels[customInput.type] })}
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
              placeholder={t('sessionConfig.customInputPlaceholder', { type: customInput.type })}
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setCustomInput(null)}
                className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
              >
                {t('sessionConfig.cancel')}
              </button>
              <button
                onClick={() => handleCustomInputConfirm(customInput.type)}
                className="px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary-hover"
              >
                {t('sessionConfig.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default SessionConfigSelector
