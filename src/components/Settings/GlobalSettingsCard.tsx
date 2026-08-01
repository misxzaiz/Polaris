/**
 * 全局设置卡片（辅助任务引擎 + 重置 CLI 配置）
 */
import { useTranslation } from 'react-i18next';
import { Bot, RotateCcw } from 'lucide-react';

interface GlobalSettingsCardProps {
  auxiliaryEngine: string | undefined;
  onAuxiliaryChange: (engineId: string) => void;
  onResetCli: () => void;
  resetting: boolean;
  loading: boolean;
  engineOptions: { id: string; nameKey: string }[];
  t: (key: string, options?: any) => string;
}

export function GlobalSettingsCard({
  auxiliaryEngine,
  onAuxiliaryChange,
  onResetCli,
  resetting,
  loading,
  engineOptions,
  t,
}: GlobalSettingsCardProps) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
      {/* 辅助任务引擎 */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-text-primary flex items-center gap-1.5">
            <Bot size={14} />
            {t('aiEngine.auxiliaryTitle', { defaultValue: '辅助任务引擎' })}
          </h3>
          <p className="text-xs text-text-secondary mt-1">
            {t('aiEngine.auxiliaryDescription', {
              defaultValue: '标题生成、提示词润色等低频辅助任务使用的引擎。留空则跟随默认引擎。',
            })}
          </p>
        </div>
        <select
          value={auxiliaryEngine ?? ''}
          onChange={(e) => onAuxiliaryChange(e.target.value)}
          disabled={loading}
          className="shrink-0 px-3 py-1.5 text-sm rounded-md border border-border bg-surface text-text-primary focus:outline-none focus:border-primary"
        >
          <option value="">
            {t('aiEngine.auxiliaryFollowDefault', { defaultValue: '跟随默认引擎' })}
          </option>
          {engineOptions.map((eng) => (
            <option key={eng.id} value={eng.id}>
              {t(eng.nameKey)}
            </option>
          ))}
        </select>
      </div>

      {/* 分隔线 */}
      <div className="border-t border-border" />

      {/* 重置 CLI 配置 */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-text-secondary flex items-center gap-1.5">
            <RotateCcw size={14} />
            {t('aiEngine.resetCliTitle')}
          </h3>
          <p className="text-xs text-text-secondary mt-1">
            {t('aiEngine.resetCliDescription')}
          </p>
        </div>
        <button
          type="button"
          onClick={onResetCli}
          disabled={resetting || loading}
          className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-2 rounded-md border border-border bg-surface text-text-secondary hover:bg-background-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RotateCcw size={12} className={resetting ? 'animate-spin' : ''} />
          {resetting ? t('aiEngine.resetting') : t('aiEngine.resetCliAction')}
        </button>
      </div>
    </div>
  );
}