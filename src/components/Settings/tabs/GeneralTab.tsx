/**
 * 通用设置 Tab
 * 包含语言、交互、翻译、数据存储、系统提示词等通用偏好
 */

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical, ChevronUp, ChevronDown, PanelLeft } from 'lucide-react';
import type { Config } from '@/types';
import { useViewStore } from '@/stores/viewStore';
import { pluginRegistry } from '@/plugin-system';
import { usePluginStore, isPluginUiEnabled } from '@/stores/pluginStore';
import { DataStorageCard } from './DataStorageCard';
import { DispatchSettingsSection } from './DispatchSettingsSection';
import { FocusModeSettings } from './FocusModeSettings';
import { SystemPromptSection } from './SystemPromptSection';

// ─── 常量 ───────────────────────────────────────────

const LEFT_PANEL_MIN = 200
const LEFT_PANEL_MAX = 600

interface GeneralTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

export function GeneralTab({ config, onConfigChange, loading }: GeneralTabProps) {
  const { t } = useTranslation('settings');

  // ── 左侧面板宽度 ──
  const leftPanelWidth = useViewStore((s) => s.leftPanelWidth);
  const setLeftPanelWidth = useViewStore((s) => s.setLeftPanelWidth);

  // ── Activity Bar 图标顺序 ──
  const pluginStates = usePluginStore((s) => s.pluginStates);
  const panelOrder = useViewStore((s) => s.panelOrder);
  const setPanelOrder = useViewStore((s) => s.setPanelOrder);

  // 所有注册的 activityBar 面板（按 order 排序）
  const allPanels = useMemo(() => {
    return pluginRegistry
      .listViewContributions('activityBar')
      .filter((view) => isPluginUiEnabled(pluginStates, view.pluginId))
      .sort((a, b) => a.order - b.order);
  }, [pluginStates]);

  // 当前生效的排序列表
  const orderedPanels = useMemo(() => {
    if (!panelOrder || panelOrder.length === 0) return allPanels;
    const orderMap = new Map(panelOrder.map((id, idx) => [id, idx]));
    const sorted = [...allPanels].sort((a, b) => {
      const oa = orderMap.get(a.id);
      const ob = orderMap.get(b.id);
      if (oa !== undefined && ob !== undefined) return oa - ob;
      if (oa !== undefined) return -1;
      if (ob !== undefined) return 1;
      return a.order - b.order;
    });
    return sorted;
  }, [allPanels, panelOrder]);

  const handleMoveUp = useCallback((index: number) => {
    if (index <= 0) return;
    const newOrder = orderedPanels.map((p) => p.id);
    [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
    setPanelOrder(newOrder);
  }, [orderedPanels, setPanelOrder]);

  const handleMoveDown = useCallback((index: number) => {
    if (index >= orderedPanels.length - 1) return;
    const newOrder = orderedPanels.map((p) => p.id);
    [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
    setPanelOrder(newOrder);
  }, [orderedPanels, setPanelOrder]);

  const handleResetOrder = useCallback(() => {
    setPanelOrder(null);
  }, [setPanelOrder]);

  const panelIconMap: Record<string, React.ReactNode> = {
    Files: <PanelLeft size={14} />,
    GitPullRequest: <span className="text-[11px]">Git</span>,
    Globe2: <span className="text-[11px]">Web</span>,
    Languages: <span className="text-[11px]">L10n</span>,
    Terminal: <span className="text-[11px]">$</span>,
    Code2: <span className="text-[11px]">{'{}'}</span>,
    Bot: <span className="text-[11px]">Bot</span>,
    Activity: <span className="text-[11px]">AI</span>,
  };

  return (
    <div className="space-y-6">
      {/* 左侧面板宽度 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('leftPanel.title', '左侧面板')}
        </h3>
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-text-secondary">
              {t('leftPanel.width', '面板宽度')}
            </div>
            <div className="text-sm font-medium text-text-primary">
              {leftPanelWidth}px
            </div>
          </div>
          <input
            type="range"
            min={LEFT_PANEL_MIN}
            max={LEFT_PANEL_MAX}
            step={10}
            value={leftPanelWidth}
            onChange={(e) => setLeftPanelWidth(Number(e.target.value))}
            className="w-full h-2 rounded-full appearance-none cursor-pointer bg-background-surface accent-primary
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:cursor-pointer
              [&::-webkit-slider-thumb]:shadow-sm"
            aria-label={t('leftPanel.width', '面板宽度')}
          />
          <div className="flex justify-between text-[10px] text-text-tertiary mt-1">
            <span>{LEFT_PANEL_MIN}px</span>
            <span>{LEFT_PANEL_MAX}px</span>
          </div>
        </div>
      </div>

      {/* Activity Bar 图标顺序 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('activityBar.title', 'Activity Bar 图标顺序')}
        </h3>
        <div className="space-y-1">
          {orderedPanels.map((panel, index) => (
            <div
              key={panel.id}
              className="flex items-center gap-2 rounded-md border border-border-subtle bg-background-surface px-2.5 py-2"
            >
              <GripVertical size={14} className="shrink-0 text-text-tertiary" />
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-background-hover text-text-secondary">
                {panelIconMap[panel.icon] || <span className="text-[11px]">?</span>}
              </span>
              <span className="min-w-0 flex-1 text-sm text-text-primary">
                {t(panel.labelKey, { defaultValue: panel.labelDefault ?? panel.panelType })}
              </span>
              <div className="flex shrink-0 gap-0.5">
                <button
                  type="button"
                  onClick={() => handleMoveUp(index)}
                  disabled={index === 0}
                  className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                  title={t('buttons.moveUp', '上移')}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => handleMoveDown(index)}
                  disabled={index >= orderedPanels.length - 1}
                  className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                  title={t('buttons.moveDown', '下移')}
                >
                  <ChevronDown size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
        {panelOrder && panelOrder.length > 0 && (
          <button
            type="button"
            onClick={handleResetOrder}
            className="mt-2 rounded px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary"
          >
            {t('activityBar.resetOrder', '重置为默认顺序')}
          </button>
        )}
        <div className="mt-2 text-[11px] text-text-tertiary">
          {t('activityBar.hint', '调整 Activity Bar 中图标的显示顺序，拖拽或上下移动调整。')}
        </div>
      </div>

      {/* 语言设置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('language.title')}</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-text-primary">{t('language.current')}</div>
            <div className="text-xs text-text-secondary">{t('language.hint')}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onConfigChange({ ...config, language: 'zh-CN' })}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                (config.language || 'zh-CN') === 'zh-CN'
                  ? 'bg-primary text-on-primary'
                  : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              中文
            </button>
            <button
              type="button"
              onClick={() => onConfigChange({ ...config, language: 'en-US' })}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                config.language === 'en-US'
                  ? 'bg-primary text-on-primary'
                  : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              English
            </button>
          </div>
        </div>
      </div>

      {/* 交互设置 — AskUserQuestion 等 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('interaction.title', '交互')}
        </h3>
        <div className="flex items-center justify-between">
          <div className="flex-1 pr-4">
            <div className="text-sm text-text-primary">
              {t('interaction.askMcpEnabled', '允许 AI 弹出问题卡片')}
            </div>
            <div className="text-xs text-text-secondary">
              {t(
                'interaction.askMcpEnabledHint',
                '允许 AI 通过 polaris-ask MCP 在对话中弹出问题卡片向你提问。关闭后 AI 将无法主动提问。'
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() =>
              onConfigChange({
                ...config,
                interaction: {
                  ...(config.interaction ?? { askMcpEnabled: true }),
                  askMcpEnabled: !(config.interaction?.askMcpEnabled ?? true),
                },
              })
            }
            disabled={loading}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              (config.interaction?.askMcpEnabled ?? true)
                ? 'bg-primary'
                : 'bg-border'
            } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            aria-pressed={config.interaction?.askMcpEnabled ?? true}
            aria-label={t('interaction.askMcpEnabled', '允许 AI 弹出问题卡片')}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                (config.interaction?.askMcpEnabled ?? true)
                  ? 'translate-x-4.5 translate-x-[18px]'
                  : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>

      {/* 派发任务设置 — 策略/结果注入/队员预设 */}
      <DispatchSettingsSection config={config} onConfigChange={onConfigChange} loading={loading} />

      {/* 阅读聚焦模式 — 独立 store，即时生效 */}
      <FocusModeSettings />

      {/* 翻译设置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('baiduTranslate.title', '百度翻译 API')}
        </h3>

        <div className="mb-4">
          <label className="block text-xs text-text-secondary mb-2">
            App ID
          </label>
          <input
            type="text"
            value={config.baiduTranslate?.appId || ''}
            onChange={(e) => onConfigChange({
              ...config,
              baiduTranslate: { ...config.baiduTranslate, appId: e.target.value, secretKey: config.baiduTranslate?.secretKey || '' }
            })}
            placeholder={t('baiduTranslate.appIdPlaceholder', '百度翻译 App ID')}
            className="w-full px-3 py-2 bg-background-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading}
          />
        </div>

        <div className="mb-4">
          <label className="block text-xs text-text-secondary mb-2">
            Secret Key
          </label>
          <input
            type="password"
            value={config.baiduTranslate?.secretKey || ''}
            onChange={(e) => onConfigChange({
              ...config,
              baiduTranslate: { ...config.baiduTranslate, appId: config.baiduTranslate?.appId || '', secretKey: e.target.value }
            })}
            placeholder={t('baiduTranslate.secretKeyPlaceholder', '百度翻译 Secret Key')}
            className="w-full px-3 py-2 bg-background-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading}
          />
        </div>

        <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <div className="flex-1">
              <p className="text-xs text-text-primary">
                <span className="font-medium">{t('baiduTranslate.configHint', '配置说明：')}</span>
              </p>
              <ul className="text-xs text-text-tertiary mt-1 space-y-1 list-disc list-inside">
                <li>{t('baiduTranslate.platform', '访问百度翻译开放平台申请 API')}</li>
                <li>{t('baiduTranslate.freeQuota', '标准版免费，每月 200 万字符')}</li>
                <li>{t('baiduTranslate.usage', '支持选中文字右键翻译')}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* 数据存储 */}
      <DataStorageCard />

      {/* 系统提示词 */}
      <SystemPromptSection />
    </div>
  );
}