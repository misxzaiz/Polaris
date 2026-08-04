/**
 * 主题设置 Tab
 * 包含：主题管理器、对话显示、窗口透明度
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { Config, WindowSettings, ChatDisplayDensity, ChatDisplayFontFamily } from '@/types';
import { DEFAULT_CHAT_DISPLAY_SETTINGS, getChatDisplayStyleVars, normalizeChatDisplaySettings } from '@/types';
import { ThemeManager } from '@/components/Theme/ThemeManager';

interface ThemeTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

export function ThemeTab({ config, onConfigChange, loading }: ThemeTabProps) {
  const { t } = useTranslation('settings');

  const currentTheme = config.theme ?? 'dark';
  const chatDisplay = normalizeChatDisplaySettings(config.chatDisplay);

  const updateChatDisplay = (patch: Partial<typeof chatDisplay>) => {
    onConfigChange({
      ...config,
      chatDisplay: normalizeChatDisplaySettings({ ...chatDisplay, ...patch }),
    });
  };

  const applyChatDensityPreset = (density: ChatDisplayDensity) => {
    const preset = {
      compact: { fontSize: 13, lineHeight: 1.45, paragraphSpacing: 2, messageSpacing: 'compact' as const, codeFontSize: 12 },
      comfortable: DEFAULT_CHAT_DISPLAY_SETTINGS,
      spacious: { fontSize: 16, lineHeight: 1.7, paragraphSpacing: 8, messageSpacing: 'spacious' as const, codeFontSize: 14 },
    }[density];
    onConfigChange({
      ...config,
      chatDisplay: normalizeChatDisplaySettings({ ...chatDisplay, ...preset }),
    });
  };

  const resetChatDisplay = () => {
    onConfigChange({ ...config, chatDisplay: DEFAULT_CHAT_DISPLAY_SETTINGS });
  };

  const formatLineHeight = (value: number) => value.toFixed(2);

  const ChatSlider = ({
    label,
    hint,
    value,
    min,
    max,
    step,
    suffix,
    format = String,
    onChange,
  }: {
    label: string;
    hint: string;
    value: number;
    min: number;
    max: number;
    step: number;
    suffix?: string;
    format?: (value: number) => string;
    onChange: (value: number) => void;
  }) => (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary">{label}</div>
        <div className="text-xs text-text-secondary">{hint}</div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={loading}
          className="w-28 h-1.5 bg-border rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        <span className="text-xs text-text-secondary w-12 text-right tabular-nums">
          {format(value)}{suffix}
        </span>
      </div>
    </div>
  );

  const SegmentedButton = <T extends string>({
    value,
    options,
    onChange,
  }: {
    value: T;
    options: Array<{ value: T; label: string }>;
    onChange: (value: T) => void;
  }) => (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          disabled={loading}
          className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
            value === option.value
              ? 'bg-primary text-on-primary'
              : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
          } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  // 获取窗口设置，默认值
  const windowSettings: WindowSettings = config.window || {
    normalOpacity: 100,
    compactOpacity: 100,
  };

  // 处理大窗透明度变化
  const handleNormalOpacityChange = (value: number) => {
    onConfigChange({
      ...config,
      window: { ...windowSettings, normalOpacity: value },
    });
  };

  // 处理小窗透明度变化
  const handleCompactOpacityChange = (value: number) => {
    onConfigChange({
      ...config,
      window: { ...windowSettings, compactOpacity: value },
    });
  };

  // 透明度滑块组件
  const OpacitySlider = ({
    label,
    hint,
    value,
    onChange,
  }: {
    label: string;
    hint: string;
    value: number;
    onChange: (value: number) => void;
  }) => (
    <div className="flex items-center justify-between">
      <div className="flex-1 mr-4">
        <div className="text-sm text-text-primary">{label}</div>
        <div className="text-xs text-text-secondary">{hint}</div>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min="0"
          max="100"
          step="5"
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          disabled={loading}
          className="w-24 h-1.5 bg-border rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        <span className="text-xs text-text-secondary w-10 text-right">
          {value}%
        </span>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* 主题管理器（卡片列表 + 编辑 + 导入导出） */}
      <ThemeManager />

      {/* 对话显示 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between mb-4 gap-3">
          <div>
            <h3 className="text-sm font-medium text-text-primary">{t('chatDisplay.title')}</h3>
            <div className="text-xs text-text-secondary mt-1">{t('chatDisplay.hint')}</div>
          </div>
          <button
            type="button"
            onClick={resetChatDisplay}
            disabled={loading}
            className={`px-3 py-1.5 text-xs rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {t('chatDisplay.reset')}
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text-primary">{t('chatDisplay.preset')}</div>
              <div className="text-xs text-text-secondary">{t('chatDisplay.presetHint')}</div>
            </div>
            <SegmentedButton<ChatDisplayDensity>
              value={chatDisplay.messageSpacing}
              onChange={applyChatDensityPreset}
              options={[
                { value: 'compact', label: t('chatDisplay.compact') },
                { value: 'comfortable', label: t('chatDisplay.comfortable') },
                { value: 'spacious', label: t('chatDisplay.spacious') },
              ]}
            />
          </div>

          <ChatSlider
            label={t('chatDisplay.fontSize')}
            hint={t('chatDisplay.fontSizeHint')}
            value={chatDisplay.fontSize}
            min={12}
            max={20}
            step={1}
            suffix="px"
            onChange={(fontSize) => updateChatDisplay({ fontSize })}
          />
          <ChatSlider
            label={t('chatDisplay.lineHeight')}
            hint={t('chatDisplay.lineHeightHint')}
            value={chatDisplay.lineHeight}
            min={1.35}
            max={1.8}
            step={0.05}
            format={formatLineHeight}
            onChange={(lineHeight) => updateChatDisplay({ lineHeight })}
          />
          <ChatSlider
            label={t('chatDisplay.paragraphSpacing')}
            hint={t('chatDisplay.paragraphSpacingHint')}
            value={chatDisplay.paragraphSpacing}
            min={0}
            max={12}
            step={1}
            suffix="px"
            onChange={(paragraphSpacing) => updateChatDisplay({ paragraphSpacing })}
          />
          <ChatSlider
            label={t('chatDisplay.codeFontSize')}
            hint={t('chatDisplay.codeFontSizeHint')}
            value={chatDisplay.codeFontSize}
            min={11}
            max={18}
            step={1}
            suffix="px"
            onChange={(codeFontSize) => updateChatDisplay({ codeFontSize })}
          />

          <div className="flex items-center justify-between gap-4 pt-1">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text-primary">{t('chatDisplay.fontFamily')}</div>
              <div className="text-xs text-text-secondary">{t('chatDisplay.fontFamilyHint')}</div>
            </div>
            <SegmentedButton<ChatDisplayFontFamily>
              value={chatDisplay.fontFamily}
              onChange={(fontFamily) => updateChatDisplay({ fontFamily })}
              options={[
                { value: 'system', label: t('chatDisplay.systemFont') },
                { value: 'serif', label: t('chatDisplay.serifFont') },
                { value: 'mono', label: t('chatDisplay.monoFont') },
              ]}
            />
          </div>

          <div className="p-3 rounded-lg bg-background-base border border-border-subtle chat-display-root" style={getChatDisplayStyleVars(chatDisplay)}>
            <div className="text-xs font-medium text-text-secondary mb-2">{t('chatDisplay.preview')}</div>
            <div className="chat-user-message flex justify-end">
              <div className="chat-user-bubble bg-gradient-to-br from-primary to-primary-600 text-white shadow-glow max-w-[85%]">
                <div className="chat-user-text whitespace-pre-wrap break-words">{t('chatDisplay.previewUser')}</div>
              </div>
            </div>
            <div className="chat-assistant-message flex gap-2">
              <div className="shrink-0 mt-0.5">
                <div className="w-5 h-5 rounded-full bg-primary-faint flex items-center justify-center text-[11px] text-primary font-semibold">AI</div>
              </div>
              <div className="chat-assistant-content flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-text-primary">Polaris</span>
                  <span className="text-xs text-text-tertiary">09:41</span>
                </div>
                <div className="chat-prose prose prose-invert max-w-none">
                  <p>{t('chatDisplay.previewAssistant')}</p>
                  <ul>
                    <li>{t('chatDisplay.previewListOne')}</li>
                    <li>{t('chatDisplay.previewListTwo')}</li>
                  </ul>
                  <pre className="chat-code-pre !bg-background-base !m-0 !rounded-lg border border-border-subtle overflow-x-auto"><code className="chat-code-text text-text-secondary">const readable = true;</code></pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 窗口透明度设置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('window.opacityTitle')}
        </h3>

        {/* 大窗模式透明度 */}
        <div className="mb-4">
          <OpacitySlider
            label={t('window.normalOpacity')}
            hint={t('window.normalOpacityHint')}
            value={windowSettings.normalOpacity}
            onChange={handleNormalOpacityChange}
          />
        </div>

        {/* 小屏模式透明度 */}
        <OpacitySlider
          label={t('window.compactOpacity')}
          hint={t('window.compactOpacityHint')}
          value={windowSettings.compactOpacity}
          onChange={handleCompactOpacityChange}
        />
      </div>
    </div>
  );
}