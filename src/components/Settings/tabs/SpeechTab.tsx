/**
 * 语音输入配置 Tab
 */

import { useTranslation } from 'react-i18next';
import type { Config } from '../../../types';
import type { SpeechLanguage } from '../../../types/speech';
import { SPEECH_LANGUAGE_OPTIONS, DEFAULT_SPEECH_CONFIG } from '../../../types/speech';

interface SpeechTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

export function SpeechTab({ config, onConfigChange, loading }: SpeechTabProps) {
  const { t } = useTranslation('settings');

  // 获取语音配置（带默认值）
  const speechConfig = config.speech ?? DEFAULT_SPEECH_CONFIG;

  const updateSpeechConfig = (updates: Partial<typeof speechConfig>) => {
    onConfigChange({
      ...config,
      speech: {
        ...speechConfig,
        ...updates,
      },
    });
  };

  return (
    <div className="space-y-6">
      {/* 启用语音输入 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-text-primary">
              {t('speech.enabled.title', '启用语音输入')}
            </h3>
            <p className="text-xs text-text-secondary mt-1">
              {t('speech.enabled.desc', '使用语音输入功能快速输入文本')}
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={speechConfig.enabled}
              onChange={(e) => updateSpeechConfig({ enabled: e.target.checked })}
              disabled={loading}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-border rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
          </label>
        </div>
      </div>

      {/* 快捷键设置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('speech.shortcut.title', '快捷键')}
        </h3>
        <div className="space-y-2">
          <input
            type="text"
            value={speechConfig.shortcut}
            onChange={(e) => updateSpeechConfig({ shortcut: e.target.value })}
            disabled={loading}
            placeholder="Ctrl+Space"
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
          />
          <p className="text-xs text-text-tertiary">
            {t('speech.shortcut.hint', '按下快捷键：输入框有内容则发送，无内容则启动语音识别')}
          </p>
        </div>
      </div>

      {/* 语言选择 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('speech.language.title', '识别语言')}
        </h3>
        <select
          value={speechConfig.language}
          onChange={(e) => updateSpeechConfig({ language: e.target.value as SpeechLanguage })}
          disabled={loading}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
        >
          {SPEECH_LANGUAGE_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {/* 高级选项 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('speech.advanced.title', '高级选项')}
        </h3>

        <div className="space-y-4">
          {/* 连续识别 */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-text-primary">
                {t('speech.continuous.title', '连续识别')}
              </span>
              <p className="text-xs text-text-tertiary">
                {t('speech.continuous.desc', '持续监听并识别语音')}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={speechConfig.continuous}
                onChange={(e) => updateSpeechConfig({ continuous: e.target.checked })}
                disabled={loading}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-border rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>

          {/* 显示临时结果 */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-text-primary">
                {t('speech.interimResults.title', '显示临时结果')}
              </span>
              <p className="text-xs text-text-tertiary">
                {t('speech.interimResults.desc', '实时显示识别中的文本')}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={speechConfig.interimResults}
                onChange={(e) => updateSpeechConfig({ interimResults: e.target.checked })}
                disabled={loading}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-border rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>
        </div>
      </div>

      {/* 提示信息 */}
      <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
        <div className="flex items-start gap-2">
          <svg className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
          <div className="flex-1">
            <p className="text-xs text-text-primary">
              <span className="font-medium">{t('speech.tips.title', '使用说明')}：</span>
            </p>
            <ul className="text-xs text-text-tertiary mt-1 space-y-1 list-disc list-inside">
              <li>{t('speech.tips.shortcut', '按 Ctrl+Space 快速启动语音识别')}</li>
              <li>{t('speech.tips.requirement', '需要麦克风权限和网络连接')}</li>
              <li>{t('speech.tips.platform', 'Windows 平台支持最佳，macOS/Linux 需要实际测试')}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
