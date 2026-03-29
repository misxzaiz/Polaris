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
              {t('speech.enabled.desc', '在状态栏点击语音按钮开始连续语音识别')}
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

      {/* 语音命令说明 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('speech.commands.title', '语音命令')}
        </h3>
        <div className="space-y-2 text-xs text-text-secondary">
          <div className="flex items-center gap-2">
            <code className="px-2 py-1 bg-background rounded text-text-primary">发送</code>
            <span>{t('speech.commands.send', '发送消息')}</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="px-2 py-1 bg-background rounded text-text-primary">清空</code>
            <span>{t('speech.commands.clear', '清空输入框')}</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="px-2 py-1 bg-background rounded text-text-primary">撤回</code>
            <span>{t('speech.commands.undo', '撤回最后输入')}</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="px-2 py-1 bg-background rounded text-text-primary">中断</code>
            <span>{t('speech.commands.interrupt', '中断对话')}</span>
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
              <li>{t('speech.tips.button', '点击状态栏语音按钮开始/停止识别')}</li>
              <li>{t('speech.tips.continuous', '开启后持续识别，直到手动关闭')}</li>
              <li>{t('speech.tips.requirement', '需要麦克风权限和网络连接')}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
