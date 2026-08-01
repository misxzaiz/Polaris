/**
 * AI 引擎配置 Tab（左右主从结构）
 *
 * 布局：左侧引擎列表（选中查看 / 设为默认）+ 右侧选中引擎详情
 * （能力标签 / 分发方式 / CLI 路径 / 安装状态 / 安装·卸载·检测）。
 *
 * 引擎列表从后端 `get_engine_metadata_list` 动态获取，
 * 新增引擎时只需在后端注册到 EngineRegistry，前端自动感知。
 * UI 专属配置（i18n 键、CLI 字段映射）在 ENGINE_UI_MAP 中维护。
 */

import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ClaudePathSelector } from '../../Common';
import { useConfigStore } from '@/stores';
import { useCliInfoStore } from '@/stores/cliInfoStore';
import { useEngineMetadataStore } from '@/stores/engineMetadataStore';
import type { Config, EngineId, EngineCapabilities, HealthStatus } from '@/types';
import type { EngineMetadata } from '@/types/engineMetadata';
import { getCapabilityLabels, getDistributionLabel } from '@/types/engineMetadata';
import { EngineInstallActions } from '../EngineInstallActions';
import { Bot, RotateCcw, Check, Cpu, Package, Terminal } from 'lucide-react';

interface AIEngineTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

// ============================================================================
// 引擎 UI 专属配置（i18n 键、CLI 字段映射等）
// 引擎列表从后端获取，此处仅维护 UI 呈现所需的额外信息。
// ============================================================================

type CliField = 'claudeCode' | 'codexCode' | 'piCode';

interface EngineUiConfig {
  /** 引擎 ID */
  id: EngineId
  /** i18n 名称键 */
  nameKey: string
  /** i18n 描述键 */
  descKey: string
  /** 内置引擎（无外部 CLI，无需安装） */
  builtin?: boolean
  /** CLI 路径所在的 config 字段 */
  cliField?: CliField
  /** CLI 默认命令名 */
  defaultCli?: string
  /** npm 全局包名（用于一键安装；仅 npx/npm 分发引擎） */
  npmPackage?: string
}

/**
 * UI 专属配置映射（keyed by engine ID）。
 * 新增引擎时在此加一条记录即可。
 */
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
  'simple-ai': {
    id: 'simple-ai',
    nameKey: 'engines.simpleAi.name',
    descKey: 'engines.simpleAi.description',
    builtin: true,
  },
  pi: {
    id: 'pi',
    nameKey: 'engines.pi.name',
    descKey: 'engines.pi.description',
    cliField: 'piCode',
    defaultCli: 'pi',
    npmPackage: '@earendil-works/pi-coding-agent',
  },
}

/** 从 healthStatus 解析某引擎的安装版本与可用性 */
export interface EngineRuntimeStatus {
  available: boolean
  version?: string
}

function resolveEngineStatus(
  engineId: string,
  health: HealthStatus | null,
): EngineRuntimeStatus {
  const uiConfig = ENGINE_UI_MAP[engineId]
  if (uiConfig?.builtin) return { available: true }

  // 按引擎 ID 映射到 HealthStatus 字段
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

/** 引擎能力标签渲染 */
function CapabilityTags({ capabilities }: { capabilities: EngineCapabilities }) {
  const labels = getCapabilityLabels(capabilities)
  if (labels.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 mt-3">
      {labels.map((label) => (
        <span
          key={label}
          className="text-[11px] px-2 py-0.5 rounded bg-primary/5 text-primary/70 border border-primary/10"
        >
          {label}
        </span>
      ))}
    </div>
  )
}

/** 状态徽章（已安装 vN / 内置 / 未检测到） */
function StatusBadge({
  engineId,
  status,
}: {
  engineId: string
  status: EngineRuntimeStatus
}) {
  const { t } = useTranslation(['settings', 'common'])
  const uiConfig = ENGINE_UI_MAP[engineId]
  if (uiConfig?.builtin) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-500 border border-blue-500/20 shrink-0">
        {t('aiEngine.builtinBadge', { defaultValue: '内置' })}
      </span>
    )
  }
  if (status.available) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-500 border border-green-500/20 shrink-0 inline-flex items-center gap-0.5">
        <Check size={9} />
        {status.version ? `v${status.version.replace(/^v/, '')}` : t('aiEngine.installedBadge', { defaultValue: '已安装' })}
      </span>
    )
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-text-tertiary/10 text-text-tertiary border border-border shrink-0">
      {t('aiEngine.notInstalledBadge', { defaultValue: '未安装' })}
    </span>
  )
}

export function AIEngineTab({ config, onConfigChange, loading }: AIEngineTabProps) {
  const { t } = useTranslation(['settings', 'common']);
  const { healthStatus, resetCliConfig, refreshHealth } = useConfigStore();
  const { agents } = useCliInfoStore();
  const [resetting, setResetting] = useState(false);
  const engineMetadatas = useEngineMetadataStore(s => s.metadatas);

  // 如果元数据未加载，触发加载
  useEffect(() => {
    const store = useEngineMetadataStore.getState()
    if (!store.loaded && !store.loading) {
      store.load()
    }
  }, [])

  // 当前查看的引擎（默认指向默认引擎）
  const [selectedId, setSelectedId] = useState<EngineId>(config.defaultEngine);

  // 选中引擎的元数据 + UI 配置
  const selectedMeta = useMemo(
    () => engineMetadatas.find(m => m.id === selectedId),
    [engineMetadatas, selectedId],
  );
  const selectedUiConfig = useMemo(
    () => ENGINE_UI_MAP[selectedId],
    [selectedId],
  );
  const selectedStatus = useMemo(
    () => resolveEngineStatus(selectedId, healthStatus),
    [selectedId, healthStatus],
  );

  // 引擎列表：从后端元数据获取，合并 UI 配置
  const engineList = useMemo(() => {
    if (engineMetadatas.length === 0) {
      // 兜底：使用 UI 配置
      return Object.values(ENGINE_UI_MAP)
    }
    return engineMetadatas.map(meta => ({
      id: meta.id,
      nameKey: ENGINE_UI_MAP[meta.id]?.nameKey ?? meta.name,
      descKey: ENGINE_UI_MAP[meta.id]?.descKey ?? meta.description ?? '',
      ...ENGINE_UI_MAP[meta.id],
    }))
  }, [engineMetadatas])

  const handleSetDefault = (engineId: EngineId) => {
    onConfigChange({ ...config, defaultEngine: engineId });
  };

  const handleSetAuxiliary = (engineId: string) => {
    // 空串 = 清除，跟随主引擎
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

  return (
    <div className="space-y-6">
      <label className="block text-sm font-medium text-text-secondary">
        {t('aiEngine.title')}
      </label>

      {/* 主从布局：左侧引擎列表 + 右侧详情 */}
      <div className="flex gap-5 items-start">
        {/* 左侧：引擎列表 */}
        <div className="w-56 shrink-0 space-y-1.5">
          {engineList.map((engine) => {
            const status = resolveEngineStatus(engine.id, healthStatus);
            const isSelected = selectedId === engine.id;
            const isDefault = config.defaultEngine === engine.id;
            const uiConfig = ENGINE_UI_MAP[engine.id]
            return (
              <button
                key={engine.id}
                type="button"
                onClick={() => setSelectedId(engine.id)}
                className={`w-full text-left p-3 rounded-lg border transition-all ${
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-surface hover:border-primary/30'
                }`}
              >
                <div className="flex items-center gap-2">
                  {uiConfig?.builtin ? (
                    <Cpu size={15} className="text-blue-400 shrink-0" />
                  ) : (
                    <Terminal size={15} className="text-text-tertiary shrink-0" />
                  )}
                  <span className="font-medium text-sm text-text-primary truncate flex-1">
                    {t(engine.nameKey)}
                  </span>
                  <StatusBadge engineId={engine.id} status={status} />
                </div>
                {isDefault && (
                  <div className="mt-1.5 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                    <Check size={9} />
                    {t('aiEngine.defaultBadge', { defaultValue: '默认引擎' })}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* 右侧：选中引擎详情 */}
        <div className="flex-1 min-w-0 p-4 bg-surface rounded-lg border border-border">
          {/* 标题 + 默认引擎操作 */}
          <div className="flex items-start justify-between gap-3 mb-1">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-medium text-text-primary">
                  {t(selectedUiConfig?.nameKey ?? selectedId)}
                </h3>
                <StatusBadge engineId={selectedId} status={selectedStatus} />
              </div>
              <p className="text-sm text-text-secondary mt-1">
                {t(selectedUiConfig?.descKey ?? '')}
              </p>
            </div>
            {config.defaultEngine === selectedId ? (
              <span className="shrink-0 inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md bg-primary/10 text-primary border border-primary/20">
                <Check size={12} />
                {t('aiEngine.currentDefault', { defaultValue: '当前默认' })}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => handleSetDefault(selectedId)}
                disabled={loading}
                className="shrink-0 text-xs px-2.5 py-1.5 rounded-md border border-primary/40 bg-primary/5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
              >
                {t('aiEngine.setDefault', { defaultValue: '设为默认' })}
              </button>
            )}
          </div>

          {/* 分发方式 */}
          {selectedMeta && (
            <div className="flex items-center gap-1.5 mt-2 text-xs text-text-tertiary">
              <Package size={12} />
              <span className="font-mono">{getDistributionLabel(selectedMeta.distribution)}</span>
            </div>
          )}

          {/* 能力标签 */}
          {selectedMeta && (
            <CapabilityTags capabilities={selectedMeta.capabilities} />
          )}

          {/* CLI 路径（非内置引擎） */}
          {selectedUiConfig?.cliField && (
            <div className="mt-4">
              <label className="block text-xs text-text-secondary mb-2">
                {t('claudeCode.cliPath', { defaultValue: 'CLI 路径' })}
              </label>
              <ClaudePathSelector
                value={getCliPath(selectedId)}
                onChange={(cmd) => handleCliPathChange(selectedUiConfig.cliField!, cmd)}
                engineType={selectedId}
                disabled={loading}
              />
            </div>
          )}

          {/* Pi 引擎专属：MCP 桥接开关 */}
          {selectedId === 'pi' && (
            <div className="mt-4 p-3 rounded-md border border-amber-500/25 bg-amber-500/5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="text-xs font-medium text-amber-600 dark:text-amber-400">
                    {t('aiEngine.piMcpBridge', { defaultValue: 'MCP 桥接（实验性）' })}
                  </h4>
                  <p className="text-[11px] text-text-secondary mt-1">
                    {t('aiEngine.piMcpBridgeHint', {
                      defaultValue:
                        '开启后移除 --no-extensions，把 Polaris MCP server 写入 pi auth.json extensions，让 pi 引擎能使用浏览器/电脑操作等 MCP 工具。pi extensions 协议未稳定，兼容性需实测，出问题请关闭。',
                    })}
                  </p>
                </div>
                <label className="shrink-0 inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.piCode?.enableExtensions ?? false}
                    onChange={(e) =>
                      onConfigChange({
                        ...config,
                        piCode: {
                          ...(config.piCode || { cliPath: 'pi' }),
                          enableExtensions: e.target.checked,
                        },
                      })
                    }
                    disabled={loading}
                    className="sr-only peer"
                  />
                  <span className="relative w-9 h-5 bg-border rounded-full peer-checked:bg-primary transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:w-4 after:h-4 after:rounded-full after:transition-transform peer-checked:after:translate-x-4" />
                </label>
              </div>
            </div>
          )}

          {/* 内置引擎说明 */}
          {selectedUiConfig?.builtin && (
            <div className="mt-4 text-xs text-text-secondary bg-blue-500/5 border border-blue-500/15 rounded-md px-3 py-2">
              {t('aiEngine.builtinHint', {
                defaultValue: '内置引擎无需安装外部 CLI，使用「模型供应商」中配置的 API 端点运行。',
              })}
            </div>
          )}

          {/* 安装 / 卸载 / 检测（npx/二进制分发引擎） */}
          {!selectedUiConfig?.builtin && selectedUiConfig?.npmPackage && (
            <EngineInstallActions
              engineId={selectedId}
              npmPackage={selectedUiConfig.npmPackage}
              installed={selectedStatus.available}
              version={selectedStatus.version}
              onChanged={refreshHealth}
            />
          )}
        </div>
      </div>

      {/* 辅助任务引擎（标题生成 / 润色等低频任务的专用引擎，留空跟随主引擎） */}
      <div className="p-4 rounded-lg border border-border bg-surface">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-text-primary flex items-center gap-1.5">
              <Bot size={14} />
              {t('aiEngine.auxiliaryTitle', { defaultValue: '辅助任务引擎' })}
            </h3>
            <p className="text-xs text-text-secondary mt-1">
              {t('aiEngine.auxiliaryDescription', {
                defaultValue:
                  '标题生成、提示词润色等低频辅助任务使用的引擎。留空则跟随默认引擎。建议选择更便宜的引擎以降低成本。',
              })}
            </p>
          </div>
          <select
            value={config.auxiliaryEngine ?? ''}
            onChange={(e) => handleSetAuxiliary(e.target.value)}
            disabled={loading}
            className="shrink-0 px-3 py-1.5 text-sm rounded-md border border-border bg-surface text-text-primary focus:outline-none focus:border-primary"
          >
            <option value="">
              {t('aiEngine.auxiliaryFollowDefault', { defaultValue: '跟随默认引擎' })}
            </option>
            {engineList.map((engine) => (
              <option key={engine.id} value={engine.id}>
                {t(engine.nameKey)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 重置 CLI 配置(测试/调试用) */}
      <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-amber-600 dark:text-amber-400">
              {t('aiEngine.resetCliTitle')}
            </h3>
            <p className="text-xs text-text-secondary mt-1">
              {t('aiEngine.resetCliDescription')}
            </p>
          </div>
          <button
            type="button"
            onClick={handleResetCliConfig}
            disabled={resetting || loading}
            className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw size={12} className={resetting ? 'animate-spin' : ''} />
            {resetting ? t('aiEngine.resetting') : t('aiEngine.resetCliAction')}
          </button>
        </div>
      </div>

      {/* 可用 Agent 列表 */}
      {agents.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-text-secondary">
              {t('aiEngine.availableAgents')} ({agents.length})
            </label>
          </div>
          <div className="space-y-1">
            {/* 内置 Agent */}
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
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 shrink-0">
                        {agent.defaultModel}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {/* 插件 Agent */}
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
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 shrink-0">
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

