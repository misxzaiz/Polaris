/**
 * 引擎展开详情面板
 */
import { useTranslation } from 'react-i18next';
import { Package } from 'lucide-react';
import { ClaudePathSelector } from '../Common';
import { EngineInstallActions } from './EngineInstallActions';
import { getCapabilityLabels, getDistributionLabel } from '@/types/engineMetadata';
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
}: EngineExpandDetailProps) {
  const { t } = useTranslation(['settings', 'common']);

  return (
    <div className="pt-3 space-y-4">
      {/* 描述 */}
      {uiConfig && (
        <p className="text-sm text-text-secondary">{t(uiConfig.descKey ?? '')}</p>
      )}

      {/* 分发方式 */}
      {meta && (
        <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
          <Package size={12} />
          <span className="font-mono">{getDistributionLabel(meta.distribution)}</span>
        </div>
      )}

      {/* 能力标签 */}
      {meta && <CapabilityTags capabilities={meta.capabilities} />}

      {/* CLI 路径（非内置引擎） */}
      {uiConfig?.cliField && (
        <div>
          <label className="block text-xs text-text-secondary mb-1.5">
            CLI 路径
          </label>
          <ClaudePathSelector
            value={getCliPath(engineId)}
            onChange={(cmd) => onCliPathChange(uiConfig.cliField!, cmd)}
            engineType={engineId}
            disabled={loading}
          />
        </div>
      )}

      {/* 安装 / 卸载（npx/二进制分发引擎） */}
      {!uiConfig?.builtin && uiConfig?.npmPackage && (
        <EngineInstallActions
          engineId={engineId}
          npmPackage={uiConfig.npmPackage}
          installed={status.available}
          version={status.version}
          onChanged={refreshHealth}
        />
      )}

      {/* Pi 引擎专属：MCP 桥接开关 */}
      {engineId === 'pi' && (
        <div className="p-3 rounded-md border border-amber-500/25 bg-amber-500/5">
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

      {/* 内置引擎说明 */}
      {uiConfig?.builtin && (
        <div className="text-xs text-text-secondary bg-blue-500/5 border border-blue-500/15 rounded-md px-3 py-2">
          {t('aiEngine.builtinHint', {
            defaultValue: '内置引擎无需安装外部 CLI，使用「模型供应商」中配置的 API 端点运行。',
          })}
        </div>
      )}
    </div>
  );
}