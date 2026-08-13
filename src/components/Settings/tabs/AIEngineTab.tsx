/**
 * AI 引擎配置 Tab
 *
 * 布局：顶部 Tab 栏 + 引擎详情 + 全局设置
 * Tab 栏可横向滚动，支持 10+ 引擎。
 * 每个 Tab 显示引擎名称和状态徽章（版本/内置/未安装）。
 * 默认引擎 Tab 带有「默认」标记。
 */
import { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronDown } from 'lucide-react';
import { useConfigStore } from '@/stores';
import { useCliInfoStore } from '@/stores/cliInfoStore';
import { useEngineMetadataStore } from '@/stores/engineMetadataStore';
import type { Config, EngineId, HealthStatus } from '@/types';
import type { EngineMetadata } from '@/types/engineMetadata';

import { EngineExpandDetail } from '../EngineExpandDetail';
import { GlobalSettingsCard } from '../GlobalSettingsCard';

interface AIEngineTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

// ============================================================================
// 引擎 UI 专属配置
// ============================================================================

export type CliField = 'claudeCode' | 'codexCode' | 'piCode';

export interface EngineUiConfig {
  id: EngineId
  nameKey: string
  descKey: string
  builtin?: boolean
  cliField?: CliField
  defaultCli?: string
  npmPackage?: string
}

const ENGINE_UI_MAP: Record<string, EngineUiConfig> = {
  'claude-code': {
    id: 'claude-code',
    nameKey: 'engines.claudeCode.name',
    descKey: 'engines.claudeCode.description',
    cliField: 'claudeCode',
    defaultCli: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
  },
  codex: {
    id: 'codex',
    nameKey: 'engines.codex.name',
    descKey: 'engines.codex.description',
    cliField: 'codexCode',
    defaultCli: 'codex',
    npmPackage: '@openai/codex',
  },
  pi: {
    id: 'pi',
    nameKey: 'engines.pi.name',
    descKey: 'engines.pi.description',
    cliField: 'piCode',
    defaultCli: 'pi',
    npmPackage: '@earendil-works/pi-coding-agent',
  },
  'simple-ai': {
    id: 'simple-ai',
    nameKey: 'engines.simpleAi.name',
    descKey: 'engines.simpleAi.description',
    builtin: true,
  },
  dsh: {
    id: 'dsh',
    nameKey: 'engines.dsh.name',
    descKey: 'engines.dsh.description',
    defaultCli: 'dsh',
    npmPackage: '@deepseek-ai/dsh',
  },
}

export interface EngineRuntimeStatus {
  available: boolean
  version?: string
}

function resolveEngineStatus(
  engineId: string,
  health: HealthStatus | null,
  meta?: EngineMetadata,
): EngineRuntimeStatus {
  const uiConfig = ENGINE_UI_MAP[engineId]
  if (uiConfig?.builtin) return { available: true }

  // 已知引擎：用 healthStatus 的 CLI 检测结果
  const fieldMap: Record<string, { available: string; version: string }> = {
    'claude-code': { available: 'claudeAvailable', version: 'claudeVersion' },
    codex: { available: 'codexAvailable', version: 'codexVersion' },
    pi: { available: 'piAvailable', version: 'piVersion' },
  }
  const fields = fieldMap[engineId]
  if (fields && health) {
    return {
      available: !!(health as any)[fields.available],
      version: (health as any)[fields.version],
    }
  }

  // 插件引擎：用后端元数据里的 CLI 可用性（is_available() 已计算）
  if (meta?.distribution.type === 'custom-path') {
    return { available: meta.distribution.available }
  }

  return { available: false }
}

/** 状态徽章配置 */
function getTabBadge(engineId: string, status: EngineRuntimeStatus): { label: string; className: string } | null {
  const uiConfig = ENGINE_UI_MAP[engineId]
  if (uiConfig?.builtin) {
    return { label: '内置', className: 'text-blue-500 bg-blue-500/10 border-blue-500/20' }
  }
  if (status.available) {
    return {
      label: status.version ? `v${status.version.replace(/^v/, '')}` : '已安装',
      className: 'text-green-500 bg-green-500/10 border-green-500/20',
    }
  }
  return { label: '未安装', className: 'text-text-tertiary bg-text-tertiary/10 border-border' }
}

// 最多在 Tab 栏显示多少个引擎，超出部分折叠到「更多」下拉
const MAX_VISIBLE_TABS = 5;

export function AIEngineTab({ config, onConfigChange, loading }: AIEngineTabProps) {
  const { t } = useTranslation(['settings', 'common']);
  const { healthStatus, resetCliConfig, refreshHealth } = useConfigStore();
  const { agents } = useCliInfoStore();
  const [resetting, setResetting] = useState(false);
  const [selectedId, setSelectedId] = useState<EngineId>(config.defaultEngine);
  const [showMore, setShowMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const engineMetadatas = useEngineMetadataStore(s => s.metadatas);

  useEffect(() => {
    const store = useEngineMetadataStore.getState()
    if (!store.loaded && !store.loading) {
      store.load()
    }
  }, [])

  // 点击外部关闭「更多」下拉
  useEffect(() => {
    if (!showMore) return;
    const handleClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setShowMore(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMore]);

  // 引擎列表
  const engineList = useMemo(() => {
    if (engineMetadatas.length === 0) {
      return Object.values(ENGINE_UI_MAP)
    }
    return engineMetadatas.map(meta => ({
      ...ENGINE_UI_MAP[meta.id],
      id: meta.id,
      nameKey: ENGINE_UI_MAP[meta.id]?.nameKey ?? meta.name,
      descKey: ENGINE_UI_MAP[meta.id]?.descKey ?? meta.description ?? '',
    }))
  }, [engineMetadatas])

  // 当前选中引擎的元数据 + UI 配置
  const selectedMeta = useMemo(
    () => engineMetadatas.find(m => m.id === selectedId),
    [engineMetadatas, selectedId],
  );
  const selectedUiConfig = useMemo(
    () => ENGINE_UI_MAP[selectedId],
    [selectedId],
  );
  const selectedStatus = useMemo(
    () => resolveEngineStatus(selectedId, healthStatus, selectedMeta),
    [selectedId, healthStatus, selectedMeta],
  );

  // 可见 Tab 和溢出引擎
  const { visibleTabs, overflowEngines } = useMemo(() => {
    if (engineList.length <= MAX_VISIBLE_TABS) {
      return { visibleTabs: engineList, overflowEngines: [] }
    }
    // 确保选中的引擎在可见范围内
    const selectedIdx = engineList.findIndex(e => e.id === selectedId)
    if (selectedIdx < MAX_VISIBLE_TABS) {
      return { visibleTabs: engineList.slice(0, MAX_VISIBLE_TABS), overflowEngines: engineList.slice(MAX_VISIBLE_TABS) }
    }
    // 选中的引擎在溢出区，把最后一个可见位置换成选中的引擎
    const visible = engineList.slice(0, MAX_VISIBLE_TABS - 1)
    const overflow = engineList.slice(MAX_VISIBLE_TABS - 1)
    return { visibleTabs: visible, overflowEngines: overflow }
  }, [engineList, selectedId])

  const handleSetDefault = (engineId: EngineId) => {
    onConfigChange({ ...config, defaultEngine: engineId });
  };

  const handleSetAuxiliary = (engineId: string) => {
    onConfigChange({ ...config, auxiliaryEngine: engineId || undefined });
  };

  const handleCliPathChange = (field: CliField, cmd: string) => {
    if (field === 'claudeCode') {
      onConfigChange({ ...config, claudeCode: { ...config.claudeCode, cliPath: cmd } });
    } else if (field === 'codexCode') {
      onConfigChange({ ...config, codexCode: { ...(config.codexCode || { cliPath: 'codex' }), cliPath: cmd } });
    } else if (field === 'piCode') {
      onConfigChange({ ...config, piCode: { ...(config.piCode || { cliPath: 'pi' }), cliPath: cmd } });
    }
  };

  const getCliPath = (engineId: string): string => {
    const uiConfig = ENGINE_UI_MAP[engineId]
    if (uiConfig?.cliField === 'claudeCode') return config.claudeCode?.cliPath || uiConfig.defaultCli || 'claude';
    if (uiConfig?.cliField === 'codexCode') return config.codexCode?.cliPath || uiConfig.defaultCli || 'codex';
    if (uiConfig?.cliField === 'piCode') return config.piCode?.cliPath || uiConfig.defaultCli || 'pi';
    return '';
  };

  const handleResetCliConfig = async () => {
    const confirmed = window.confirm(t('aiEngine.resetCliConfirm'));
    if (!confirmed) return;
    setResetting(true);
    try {
      await resetCliConfig();
    } finally {
      setResetting(false);
    }
  };

  const selectEngine = (id: EngineId) => {
    setSelectedId(id);
    setShowMore(false);
  };

  return (
    <div className="space-y-4">
      {/* ====== Tab 栏 ====== */}
      <div className="flex items-end gap-0 overflow-x-auto border-b border-border">
        {visibleTabs.map(engine => {
          const meta = engineMetadatas.find(m => m.id === engine.id)
          const status = resolveEngineStatus(engine.id, healthStatus, meta);
          const badge = getTabBadge(engine.id, status);
          const isDefault = config.defaultEngine === engine.id;
          const isActive = selectedId === engine.id;
          return (
            <button
              key={engine.id}
              type="button"
              onClick={() => selectEngine(engine.id)}
              className={`shrink-0 flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap
                ${isActive
                  ? 'border-primary text-text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary hover:border-border'
                }
              `}
            >
              {t(engine.nameKey)}
              {badge && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badge.className}`}>
                  {badge.label}
                </span>
              )}
              {isDefault && (
                <span className="text-[10px] text-primary">默认</span>
              )}
            </button>
          );
        })}

        {/* 更多引擎下拉 */}
        {overflowEngines.length > 0 && (
          <div ref={moreRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setShowMore(v => !v)}
              className={`flex items-center gap-1 px-3 py-2 text-sm font-medium border-b-2 transition-colors
                ${showMore
                  ? 'border-primary text-text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary hover:border-border'
                }
              `}
            >
              更多
              <ChevronDown size={12} />
            </button>

            {showMore && (
              <div className="absolute top-full right-0 mt-1 z-50 bg-surface border border-border rounded-lg shadow-lg py-1 min-w-[160px]">
                {overflowEngines.map(engine => {
                  const meta = engineMetadatas.find(m => m.id === engine.id)
                  const status = resolveEngineStatus(engine.id, healthStatus, meta);
                  const badge = getTabBadge(engine.id, status);
                  const isDefault = config.defaultEngine === engine.id;
                  return (
                    <button
                      key={engine.id}
                      type="button"
                      onClick={() => selectEngine(engine.id)}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-background-hover transition-colors
                        ${selectedId === engine.id ? 'bg-primary/5 text-text-primary' : 'text-text-secondary'}
                      `}
                    >
                      <span className="flex-1 truncate">{t(engine.nameKey)}</span>
                      {badge && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${badge.className}`}>
                          {badge.label}
                        </span>
                      )}
                      {isDefault && (
                        <span className="text-[10px] text-primary shrink-0">默认</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ====== 引擎详情 ====== */}
      <EngineExpandDetail
        engineId={selectedId}
        meta={selectedMeta}
        uiConfig={selectedUiConfig}
        status={selectedStatus}
        config={config}
        onConfigChange={onConfigChange}
        onCliPathChange={handleCliPathChange}
        getCliPath={getCliPath}
        loading={loading}
        refreshHealth={refreshHealth}
        isDefault={config.defaultEngine === selectedId}
        onSetDefault={() => handleSetDefault(selectedId)}
      />

      {/* ====== 全局设置 ====== */}
      <GlobalSettingsCard
        auxiliaryEngine={config.auxiliaryEngine}
        onAuxiliaryChange={handleSetAuxiliary}
        onResetCli={handleResetCliConfig}
        resetting={resetting}
        loading={loading}
        engineOptions={engineList}
        t={t}
      />

      {/* ====== 可用 Agent 列表 ====== */}
      {agents.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-text-secondary">
              {t('aiEngine.availableAgents')} ({agents.length})
            </label>
          </div>
          <div className="space-y-1">
            {agents.filter(a => a.source === 'builtin').length > 0 && (
              <div>
                <div className="text-xs text-text-tertiary px-2 py-1">
                  {t('aiEngine.builtinAgents')}
                </div>
                {agents.filter(a => a.source === 'builtin').map(agent => (
                  <div key={agent.id} className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-background-hover">
                    <Bot size={14} className="text-blue-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-text-primary truncate">{agent.name}</div>
                      <div className="text-xs text-text-tertiary truncate">{agent.id}</div>
                    </div>
                    {agent.defaultModel && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 shrink-0">
                        {agent.defaultModel}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {agents.filter(a => a.source === 'plugin').length > 0 && (
              <div>
                <div className="text-xs text-text-tertiary px-2 py-1 mt-1">
                  {t('aiEngine.pluginAgents')}
                </div>
                {agents.filter(a => a.source === 'plugin').map(agent => (
                  <div key={agent.id} className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-background-hover">
                    <Bot size={14} className="text-purple-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-text-primary truncate">{agent.name}</div>
                      <div className="text-xs text-text-tertiary truncate">{agent.id}</div>
                    </div>
                    {agent.defaultModel && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 shrink-0">
                        {agent.defaultModel}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}