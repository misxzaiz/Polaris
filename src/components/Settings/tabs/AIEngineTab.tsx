/**
 * AI 引擎配置 Tab（左右主从结构）
 *
 * 布局：左侧引擎列表（选中查看 / 设为默认）+ 右侧选中引擎详情
 * （能力标签 / 分发方式 / CLI 路径 / 安装状态 / 安装·卸载·检测）。
 *
 * 模型供应商 Profile 管理已抽离至独立的 ModelProviderTab（设置 → 模型供应商）。
 * 引擎能力信息（工具调用 / 图片输入 / 流式输出等）以标签形式展示。
 */

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ClaudePathSelector } from '../../Common';
import { useConfigStore } from '@/stores';
import { useCliInfoStore } from '@/stores/cliInfoStore';
import type { Config, EngineId, EngineCapabilities, HealthStatus } from '@/types';
import { getCapabilityLabels } from '@/types/engineMetadata';
import { EngineInstallActions } from '../EngineInstallActions';
import { Bot, RotateCcw, Check, Cpu, Package, Terminal } from 'lucide-react';

interface AIEngineTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

// ============================================================================
// 引擎元数据（前端镜像，作为后端 EngineMetadata 的视图模型）
// ============================================================================

type CliField = 'claudeCode' | 'codexCode' | 'mimoCode';

interface EngineMetaEntry {
  id: EngineId
  nameKey: string
  descKey: string
  capabilities: EngineCapabilities
  /** 分发方式展示文本 */
  distribution: string
  /** 内置引擎（无外部 CLI，无需安装） */
  builtin?: boolean
  /** CLI 路径所在的 config 字段 */
  cliField?: CliField
  /** CLI 默认命令名 */
  defaultCli?: string
  /** npm 全局包名（用于一键安装；仅 npx/npm 分发引擎） */
  npmPackage?: string
}

const ENGINE_META: EngineMetaEntry[] = [
  {
    id: 'claude-code',
    nameKey: 'engines.claudeCode.name',
    descKey: 'engines.claudeCode.description',
    capabilities: {
      tools: true,
      imageInput: true,
      streaming: true,
      interrupt: true,
      resume: true,
      stdinInput: true,
      forkSession: true,
    },
    distribution: 'npx @anthropic-ai/claude-code',
    cliField: 'claudeCode',
    defaultCli: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    nameKey: 'engines.codex.name',
    descKey: 'engines.codex.description',
    capabilities: {
      tools: true,
      imageInput: false,
      streaming: true,
      interrupt: true,
      resume: true,
      stdinInput: false,
      forkSession: false,
    },
    distribution: 'npm @openai/codex',
    cliField: 'codexCode',
    defaultCli: 'codex',
    npmPackage: '@openai/codex',
  },
  {
    id: 'simple-ai',
    nameKey: 'engines.simpleAi.name',
    descKey: 'engines.simpleAi.description',
    capabilities: {
      tools: true,
      imageInput: false,
      streaming: true,
      interrupt: true,
      resume: true,
      stdinInput: false,
      forkSession: false,
    },
    distribution: '内置引擎',
    builtin: true,
  },
  {
    id: 'mimo',
    nameKey: 'engines.mimo.name',
    descKey: 'engines.mimo.description',
    capabilities: {
      tools: true,
      imageInput: false,
      streaming: true,
      interrupt: true,
      resume: true,
      stdinInput: true,
      forkSession: false,
    },
    distribution: 'npx mimocode',
    cliField: 'mimoCode',
    defaultCli: 'mimo',
    npmPackage: 'mimocode',
  },
]

/** 从 healthStatus 解析某引擎的安装版本与可用性 */
export interface EngineRuntimeStatus {
  available: boolean
  version?: string
}

function resolveEngineStatus(
  engine: EngineMetaEntry,
  health: HealthStatus | null,
): EngineRuntimeStatus {
  if (engine.builtin) return { available: true }
  switch (engine.id) {
    case 'claude-code':
      return { available: !!health?.claudeAvailable, version: health?.claudeVersion }
    case 'codex':
      return { available: !!health?.codexAvailable, version: health?.codexVersion }
    case 'mimo':
      return { available: !!health?.mimoVersion, version: health?.mimoVersion }
    default:
      return { available: false }
  }
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
  engine,
  status,
}: {
  engine: EngineMetaEntry
  status: EngineRuntimeStatus
}) {
  const { t } = useTranslation(['settings', 'common'])
  if (engine.builtin) {
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
  // 当前查看的引擎（默认指向默认引擎）
  const [selectedId, setSelectedId] = useState<EngineId>(config.defaultEngine);

  const selected = useMemo(
    () => ENGINE_META.find((e) => e.id === selectedId) ?? ENGINE_META[0],
    [selectedId],
  );
  const selectedStatus = resolveEngineStatus(selected, healthStatus);

  const handleSetDefault = (engineId: EngineId) => {
    onConfigChange({ ...config, defaultEngine: engineId });
  };

  const handleCliPathChange = (field: CliField, cmd: string) => {
    if (field === 'claudeCode') {
      onConfigChange({ ...config, claudeCode: { ...config.claudeCode, cliPath: cmd } });
    } else if (field === 'codexCode') {
      onConfigChange({ ...config, codexCode: { ...(config.codexCode || { cliPath: 'codex' }), cliPath: cmd } });
    } else {
      onConfigChange({ ...config, mimoCode: { ...(config.mimoCode || { cliPath: 'mimo' }), cliPath: cmd } });
    }
  };

  const getCliPath = (engine: EngineMetaEntry): string => {
    if (engine.cliField === 'claudeCode') return config.claudeCode?.cliPath || 'claude';
    if (engine.cliField === 'codexCode') return config.codexCode?.cliPath || 'codex';
    if (engine.cliField === 'mimoCode') return config.mimoCode?.cliPath || 'mimo';
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
          {ENGINE_META.map((engine) => {
            const status = resolveEngineStatus(engine, healthStatus);
            const isSelected = selectedId === engine.id;
            const isDefault = config.defaultEngine === engine.id;
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
                  {engine.builtin ? (
                    <Cpu size={15} className="text-blue-400 shrink-0" />
                  ) : (
                    <Terminal size={15} className="text-text-tertiary shrink-0" />
                  )}
                  <span className="font-medium text-sm text-text-primary truncate flex-1">
                    {t(engine.nameKey)}
                  </span>
                  <StatusBadge engine={engine} status={status} />
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
                <h3 className="text-base font-medium text-text-primary">{t(selected.nameKey)}</h3>
                <StatusBadge engine={selected} status={selectedStatus} />
              </div>
              <p className="text-sm text-text-secondary mt-1">{t(selected.descKey)}</p>
            </div>
            {config.defaultEngine === selected.id ? (
              <span className="shrink-0 inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md bg-primary/10 text-primary border border-primary/20">
                <Check size={12} />
                {t('aiEngine.currentDefault', { defaultValue: '当前默认' })}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => handleSetDefault(selected.id)}
                disabled={loading}
                className="shrink-0 text-xs px-2.5 py-1.5 rounded-md border border-primary/40 bg-primary/5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
              >
                {t('aiEngine.setDefault', { defaultValue: '设为默认' })}
              </button>
            )}
          </div>

          {/* 分发方式 */}
          <div className="flex items-center gap-1.5 mt-2 text-xs text-text-tertiary">
            <Package size={12} />
            <span className="font-mono">{selected.distribution}</span>
          </div>

          {/* 能力标签 */}
          <CapabilityTags capabilities={selected.capabilities} />

          {/* CLI 路径（非内置引擎） */}
          {selected.cliField && (
            <div className="mt-4">
              <label className="block text-xs text-text-secondary mb-2">
                {t('claudeCode.cliPath', { defaultValue: 'CLI 路径' })}
              </label>
              <ClaudePathSelector
                value={getCliPath(selected)}
                onChange={(cmd) => handleCliPathChange(selected.cliField!, cmd)}
                engineType={selected.id}
                disabled={loading}
              />
            </div>
          )}

          {/* 内置引擎说明 */}
          {selected.builtin && (
            <div className="mt-4 text-xs text-text-secondary bg-blue-500/5 border border-blue-500/15 rounded-md px-3 py-2">
              {t('aiEngine.builtinHint', {
                defaultValue: '内置引擎无需安装外部 CLI，使用「模型供应商」中配置的 API 端点运行。',
              })}
            </div>
          )}

          {/* 安装 / 卸载 / 检测（npx/二进制分发引擎） */}
          {!selected.builtin && selected.npmPackage && (
            <EngineInstallActions
              engineId={selected.id}
              npmPackage={selected.npmPackage}
              installed={selectedStatus.available}
              version={selectedStatus.version}
              onChanged={refreshHealth}
            />
          )}
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
