/**
 * AI 引擎配置 Tab
 *
 * 布局：引擎摘要列表（垂直）+ 展开详情 + 全局设置
 * 默认引擎始终置顶展开，其余引擎可点击展开。
 * 搜索框过滤引擎列表，未安装引擎降低透明度。
 */
import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
import { useConfigStore } from '@/stores';
import { useCliInfoStore } from '@/stores/cliInfoStore';
import { useEngineMetadataStore } from '@/stores/engineMetadataStore';
import type { Config, EngineId, HealthStatus } from '@/types';

import { EngineSearchBar } from '../EngineSearchBar';
import { EngineRow, getStatusConfig } from '../EngineRow';
import { EngineExpandDetail } from '../EngineExpandDetail';
import { GlobalSettingsCard } from '../GlobalSettingsCard';

interface AIEngineTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

// ============================================================================
// 引擎 UI 专属配置（i18n 键、CLI 字段映射等）
// 引擎列表从后端获取，此处仅维护 UI 呈现所需的额外信息。
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
}

export interface EngineRuntimeStatus {
  available: boolean
  version?: string
}

function resolveEngineStatus(engineId: string, health: HealthStatus | null): EngineRuntimeStatus {
  const uiConfig = ENGINE_UI_MAP[engineId]
  if (uiConfig?.builtin) return { available: true }

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
  return { available: false }
}

export function AIEngineTab({ config, onConfigChange, loading }: AIEngineTabProps) {
  const { t } = useTranslation(['settings', 'common']);
  const { healthStatus, resetCliConfig, refreshHealth } = useConfigStore();
  const { agents } = useCliInfoStore();
  const [resetting, setResetting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState<EngineId | null>(null);
  const engineMetadatas = useEngineMetadataStore(s => s.metadatas);

  useEffect(() => {
    const store = useEngineMetadataStore.getState()
    if (!store.loaded && !store.loading) {
      store.load()
    }
  }, [])

  // 引擎列表：从后端元数据获取，合并 UI 配置
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

  // 搜索过滤
  const filteredEngines = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return engineList
    return engineList.filter(e => {
      const name = t(e.nameKey).toLowerCase()
      const desc = t(e.descKey).toLowerCase()
      return name.includes(q) || desc.includes(q)
    })
  }, [engineList, searchQuery, t])

  // 分组：默认引擎、已安装、未安装
  const { defaultEngine, installed, available } = useMemo(() => {
    const def = engineList.find(e => e.id === config.defaultEngine)
    const rest = engineList.filter(e => e.id !== config.defaultEngine)
    const inst = rest.filter(e => {
      const s = resolveEngineStatus(e.id, healthStatus)
      return s.available || ENGINE_UI_MAP[e.id]?.builtin
    })
    const avail = rest.filter(e => {
      const s = resolveEngineStatus(e.id, healthStatus)
      return !s.available && !ENGINE_UI_MAP[e.id]?.builtin
    })
    return { defaultEngine: def, installed: inst, available: avail }
  }, [engineList, config.defaultEngine, healthStatus])

  // 当前展开的引擎（搜索时固定展开第一个匹配项）
  const resolvedExpandedId = useMemo(() => {
    if (searchQuery.trim() && filteredEngines.length > 0) {
      return filteredEngines[0].id
    }
    return expandedId
  }, [searchQuery, filteredEngines, expandedId])

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

  const toggleExpand = (id: EngineId) => {
    setExpandedId(prev => prev === id ? null : id);
  };

  const renderEngineDetail = (engineId: EngineId) => {
    const meta = engineMetadatas.find(m => m.id === engineId)
    const uiConfig = ENGINE_UI_MAP[engineId]
    const status = resolveEngineStatus(engineId, healthStatus)
    return (
      <EngineExpandDetail
        engineId={engineId}
        meta={meta}
        uiConfig={uiConfig}
        status={status}
        config={config}
        onConfigChange={onConfigChange}
        onCliPathChange={handleCliPathChange}
        getCliPath={getCliPath}
        loading={loading}
        refreshHealth={refreshHealth}
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* 搜索栏 */}
      <EngineSearchBar value={searchQuery} onChange={setSearchQuery} />

      {/* 空结果 */}
      {filteredEngines.length === 0 && (
        <div className="py-12 text-center text-sm text-text-tertiary">
          没有匹配的引擎
        </div>
      )}

      {/* 默认引擎（始终置顶展开） */}
      {defaultEngine && !searchQuery && (
        <EngineRow
          icon={ENGINE_UI_MAP[defaultEngine.id]?.builtin ? 'cpu' : 'terminal'}
          name={t(defaultEngine.nameKey)}
          status={getStatusConfig(
            resolveEngineStatus(defaultEngine.id, healthStatus),
            ENGINE_UI_MAP[defaultEngine.id]?.builtin,
          )}
          isDefault={true}
          isExpanded={true}
          onToggle={() => toggleExpand(defaultEngine.id)}
        >
          {renderEngineDetail(defaultEngine.id)}
        </EngineRow>
      )}

      {/* 已安装引擎 */}
      {installed.length > 0 && !searchQuery && (
        <div className="text-xs font-medium text-text-tertiary px-0.5">已安装</div>
      )}
      {installed.map(engine => (
        <EngineRow
          key={engine.id}
          icon={ENGINE_UI_MAP[engine.id]?.builtin ? 'cpu' : 'terminal'}
          name={t(engine.nameKey)}
          status={getStatusConfig(
            resolveEngineStatus(engine.id, healthStatus),
            ENGINE_UI_MAP[engine.id]?.builtin,
          )}
          isDefault={false}
          isExpanded={resolvedExpandedId === engine.id}
          onToggle={() => toggleExpand(engine.id)}
          actions={
            <button
              type="button"
              onClick={() => handleSetDefault(engine.id)}
              disabled={loading}
              className="text-xs px-2 py-1 rounded border border-primary/40 bg-primary/5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
            >
              设为默认
            </button>
          }
        >
          {resolvedExpandedId === engine.id && renderEngineDetail(engine.id)}
        </EngineRow>
      ))}

      {/* 未安装引擎 */}
      {available.length > 0 && !searchQuery && (
        <div className="text-xs font-medium text-text-tertiary px-0.5 pt-1">可安装</div>
      )}
      {available.map(engine => (
        <EngineRow
          key={engine.id}
          icon={ENGINE_UI_MAP[engine.id]?.builtin ? 'cpu' : 'terminal'}
          name={t(engine.nameKey)}
          status={getStatusConfig(
            resolveEngineStatus(engine.id, healthStatus),
            ENGINE_UI_MAP[engine.id]?.builtin,
          )}
          isDefault={false}
          isExpanded={resolvedExpandedId === engine.id}
          dimmed={true}
          onToggle={() => toggleExpand(engine.id)}
        >
          {resolvedExpandedId === engine.id && renderEngineDetail(engine.id)}
        </EngineRow>
      ))}

      {/* 搜索模式：默认展开第一个匹配项 */}
      {searchQuery.trim() && filteredEngines.map(engine => (
        <EngineRow
          key={engine.id}
          icon={ENGINE_UI_MAP[engine.id]?.builtin ? 'cpu' : 'terminal'}
          name={t(engine.nameKey)}
          status={getStatusConfig(
            resolveEngineStatus(engine.id, healthStatus),
            ENGINE_UI_MAP[engine.id]?.builtin,
          )}
          isDefault={config.defaultEngine === engine.id}
          isExpanded={resolvedExpandedId === engine.id}
          onToggle={() => toggleExpand(engine.id)}
          actions={
            config.defaultEngine !== engine.id && (
              <button
                type="button"
                onClick={() => handleSetDefault(engine.id)}
                disabled={loading}
                className="text-xs px-2 py-1 rounded border border-primary/40 bg-primary/5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
              >
                设为默认
              </button>
            )
          }
        >
          {resolvedExpandedId === engine.id && renderEngineDetail(engine.id)}
        </EngineRow>
      ))}

      {/* 全局设置 */}
      <GlobalSettingsCard
        auxiliaryEngine={config.auxiliaryEngine}
        onAuxiliaryChange={handleSetAuxiliary}
        onResetCli={handleResetCliConfig}
        resetting={resetting}
        loading={loading}
        engineOptions={engineList}
        t={t}
      />

      {/* 可用 Agent 列表 */}
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