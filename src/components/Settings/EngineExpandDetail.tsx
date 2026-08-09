/**
 * 引擎详情面板
 */
import { useTranslation } from 'react-i18next';
import { Package, Check, Puzzle, ExternalLink } from 'lucide-react';
import { ClaudePathSelector } from '../Common';
import { EngineInstallActions } from './EngineInstallActions';
import { getCapabilityLabels, getDistributionLabel } from '@/types/engineMetadata';
import { pluginRegistry } from '@/plugin-system';
import { openInDefaultApp } from '@/services/tauri/windowService';
import type { EngineCapabilities, EngineMetadata, Config, EngineId } from '@/types';
import type { EngineRuntimeStatus, EngineUiConfig, CliField } from './AIEngineTab';

interface EngineExpandDetailProps {
  engineId: EngineId;
  meta: EngineMetadata | undefined;
  uiConfig: EngineUiConfig | undefined;
  status: EngineRuntimeStatus;
  config: Config;
  onConfigChange: (config: Config) => void;
  onCliPathChange: (field: CliField, cmd: string) => void;
  getCliPath: (id: string) => string;
  loading: boolean;
  refreshHealth: () => void;
  /** 当前引擎是否为默认引擎 */
  isDefault: boolean;
  /** 设为默认引擎 */
  onSetDefault: () => void;
}

function CapabilityTags({ capabilities }: { capabilities: EngineCapabilities }) {
  const labels = getCapabilityLabels(capabilities);
  if (labels.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {labels.map((label) => (
        <span
          key={label}
          className="text-xs px-2 py-0.5 rounded bg-primary/5 text-primary/70 border border-primary/10"
        >
          {label}
        </span>
      ))}
    </div>
  );
}

export function EngineExpandDetail({
  engineId,
  meta,
  uiConfig,
  status,
  config,
  onConfigChange,
  onCliPathChange,
  getCliPath,
  loading,
  refreshHealth,
  isDefault,
  onSetDefault,
}: EngineExpandDetailProps) {
  const { t } = useTranslation(['settings', 'common']);

  return (
    <div className="space-y-4">
      {/* ====== 标题卡片 ====== */}
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-medium text-text-primary flex items-center gap-2 flex-wrap">
              {t(uiConfig?.nameKey ?? engineId)}
              {status.available && !uiConfig?.builtin && (
                <span className="text-xs px-2 py-0.5 rounded bg-green-500/10 text-green-500 border border-green-500/20">
                  {status.version ? `v${status.version.replace(/^v/, '')}` : '已安装'}
                </span>
              )}
              {uiConfig?.builtin && (
                <span className="text-xs px-2 py-0.5 rounded bg-blue-500/10 text-blue-500 border border-blue-500/20">
                  内置
                </span>
              )}
              {!status.available && !uiConfig?.builtin && (
                <span className="text-xs px-2 py-0.5 rounded bg-text-tertiary/10 text-text-tertiary border border-border">
                  未安装
                </span>
              )}
            </h3>
            {uiConfig && (
              <p className="text-sm text-text-secondary mt-1">{t(uiConfig.descKey ?? '')}</p>
            )}
          </div>
          <div className="shrink-0">
            {isDefault ? (
              <span className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md bg-primary/10 text-primary border border-primary/20">
                <Check size={12} />
                当前默认
              </span>
            ) : (
              <button
                type="button"
                onClick={onSetDefault}
                disabled={loading}
                className="text-xs px-2.5 py-1.5 rounded-md border border-primary/40 bg-primary/5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
              >
                设为默认
              </button>
            )}
          </div>
        </div>

        {meta && (
          <div className="flex items-center gap-1.5 mt-2 text-xs text-text-tertiary">
            <Package size={12} />
            <span className="font-mono">{getDistributionLabel(meta.distribution)}</span>
          </div>
        )}

        {meta && <CapabilityTags capabilities={meta.capabilities} />}
      </div>

      {/* ====== CLI 路径（非内置引擎） ====== */}
      {uiConfig?.cliField && (
        <div className="bg-surface border border-border rounded-lg p-4">
          <label className="block text-xs text-text-secondary mb-1.5">CLI 路径</label>
          <ClaudePathSelector
            value={getCliPath(engineId)}
            onChange={(cmd) => onCliPathChange(uiConfig.cliField!, cmd)}
            engineType={engineId}
            disabled={loading}
          />
        </div>
      )}

      {/* ====== 安装/卸载（npx/二进制分发引擎） ====== */}
      {!uiConfig?.builtin && uiConfig?.npmPackage && (
        <div className="bg-surface border border-border rounded-lg p-4">
          <EngineInstallActions
            engineId={engineId}
            npmPackage={uiConfig.npmPackage}
            installed={status.available}
            version={status.version}
            onChanged={refreshHealth}
          />
        </div>
      )}

      {/* ====== 插件引擎安装引导（非已知引擎且 distribution 为 custom-path） ====== */}
      {!uiConfig && meta?.distribution.type === 'custom-path' && (
        <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <Puzzle size={13} />
            <span className="font-medium">插件引擎</span>
            {(() => {
              const pluginId = pluginRegistry.getPluginIdForEngine(engineId)
              return pluginId ? (
                <span className="text-text-muted">· 来自插件 {pluginId}</span>
              ) : null
            })()}
          </div>

          {/* CLI 安装状态 */}
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono text-text-primary">{meta.distribution.path}</span>
            {status.available ? (
              <span className="text-xs px-2 py-0.5 rounded bg-green-500/10 text-green-500 border border-green-500/20">
                已安装
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded bg-text-tertiary/10 text-text-tertiary border border-border">
                未安装
              </span>
            )}
          </div>

          {/* 安装指引 */}
          {meta.installGuide && (
            <div className="text-xs text-text-tertiary leading-relaxed whitespace-pre-wrap">
              {meta.installGuide}
            </div>
          )}

          {/* 无安装指引时显示默认提示 */}
          {!meta.installGuide && !status.available && (
            <div className="text-xs text-text-tertiary">
              请确保 <code className="font-mono bg-background-elevated px-1 rounded">{meta.distribution.path}</code> 已安装并在 PATH 中可用。
            </div>
          )}

          {/* npm 分发的插件引擎：一键安装/卸载 CLI */}
          {meta.npmPackage && (
            <EngineInstallActions
              engineId={engineId}
              npmPackage={meta.npmPackage}
              installed={status.available}
              version={status.version}
              onChanged={refreshHealth}
            />
          )}

          {/* 非 npm 分发（OMP 等 curl|sh 安装）：打开安装页面 */}
          {meta.installUrl && (
            <button
              type="button"
              onClick={() => openInDefaultApp(meta.installUrl!)}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-md border border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 transition-colors"
            >
              <ExternalLink size={13} />
              {t('aiEngine.openInstallPage', { defaultValue: '打开安装页面' })}
            </button>
          )}
        </div>
      )}

      {/* ====== Pi 引擎专属：MCP 桥接 ====== */}
      {engineId === 'pi' && (
        <div className="bg-surface border border-amber-500/25 rounded-lg p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-xs font-medium text-amber-600 dark:text-amber-400">
                {t('aiEngine.piMcpBridge', { defaultValue: 'MCP 桥接（实验性）' })}
              </h4>
              <p className="text-xs text-text-secondary mt-1">
                {t('aiEngine.piMcpBridgeHint', {
                  defaultValue: '开启后移除 --no-extensions，把 Polaris MCP server 写入 pi auth.json extensions，让 pi 引擎能使用浏览器/电脑操作等 MCP 工具。',
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

      {/* ====== 内置引擎说明 ====== */}
      {uiConfig?.builtin && (
        <div className="bg-surface border border-blue-500/15 rounded-lg p-4 text-xs text-text-secondary">
          {t('aiEngine.builtinHint', {
            defaultValue: '内置引擎无需安装外部 CLI，使用「模型供应商」中配置的 API 端点运行。',
          })}
        </div>
      )}
    </div>
  );
}