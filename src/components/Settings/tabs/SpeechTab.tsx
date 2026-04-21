/**
 * 语音配置 Tab
 * 包含语音输入和语音输出 (TTS) 配置
 */

import { useTranslation } from 'react-i18next';
import { useState, useCallback, type KeyboardEvent } from 'react';
import type { Config } from '../../../types';
import type { SpeechLanguage, TTSVoice, WakeWordConfig, VoiceNotificationConfig, VoiceCommandEntry, VoiceCommand } from '../../../types/speech';
import {
  SPEECH_LANGUAGE_OPTIONS,
  DEFAULT_SPEECH_CONFIG,
  DEFAULT_TTS_CONFIG,
  DEFAULT_WAKE_WORD_CONFIG,
  DEFAULT_VOICE_NOTIFICATION_CONFIG,
  DEFAULT_VOICE_COMMAND_CONFIG,
  TTS_VOICE_OPTIONS,
  TTS_RATE_OPTIONS,
} from '../../../types/speech';
import { ttsService } from '../../../services/ttsService';
import { voiceNotificationService } from '../../../services/voiceNotificationService';
import { createLogger } from '../../../utils/logger';

const log = createLogger('SpeechTab');

interface SpeechTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

export function SpeechTab({ config, onConfigChange, loading }: SpeechTabProps) {
  const { t } = useTranslation('settings');
  const [isTestingVoice, setIsTestingVoice] = useState(false);
  const [newWakeWord, setNewWakeWord] = useState('');
  const [newWakeResponse, setNewWakeResponse] = useState('');
  const [newKeywordByCommand, setNewKeywordByCommand] = useState<Record<VoiceCommand, string>>({
    send: '', clear: '', undo: '', interrupt: '', play: '',
  });

  // 获取语音配置（带默认值）
  const speechConfig = config.speech ?? DEFAULT_SPEECH_CONFIG;
  const ttsConfig = config.tts ?? DEFAULT_TTS_CONFIG;
  const voiceCommands = config.voiceCommands ?? DEFAULT_VOICE_COMMAND_CONFIG;
  const wakeWordConfig = config.wakeWord ?? DEFAULT_WAKE_WORD_CONFIG;
  const notifConfig = config.voiceNotification ?? DEFAULT_VOICE_NOTIFICATION_CONFIG;

  const updateSpeechConfig = (updates: Partial<typeof speechConfig>) => {
    onConfigChange({
      ...config,
      speech: {
        ...speechConfig,
        ...updates,
      },
    });
  };

  const updateWakeWordConfig = useCallback((updates: Partial<WakeWordConfig>) => {
    onConfigChange({
      ...config,
      wakeWord: {
        ...wakeWordConfig,
        ...updates,
      },
    });
  }, [config, wakeWordConfig, onConfigChange]);

  const addWakeWord = useCallback(() => {
    const word = newWakeWord.trim();
    if (!word || wakeWordConfig.words.includes(word)) return;
    updateWakeWordConfig({ words: [...wakeWordConfig.words, word] });
    setNewWakeWord('');
  }, [newWakeWord, wakeWordConfig.words, updateWakeWordConfig]);

  const removeWakeWord = useCallback((word: string) => {
    updateWakeWordConfig({ words: wakeWordConfig.words.filter(w => w !== word) });
  }, [wakeWordConfig.words, updateWakeWordConfig]);

  const handleWakeWordKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addWakeWord();
    }
  }, [addWakeWord]);

  const updateNotifConfig = useCallback((updates: Partial<VoiceNotificationConfig>) => {
    const newNotifConfig = { ...notifConfig, ...updates };
    onConfigChange({
      ...config,
      voiceNotification: newNotifConfig,
    });
    // 配置变更时触发语音包重新生成
    voiceNotificationService.preGenerateVoicePackage();
  }, [config, notifConfig, onConfigChange]);

  const addWakeResponseText = useCallback(() => {
    const text = newWakeResponse.trim();
    if (!text || notifConfig.wakeResponseTexts.includes(text)) return;
    updateNotifConfig({ wakeResponseTexts: [...notifConfig.wakeResponseTexts, text] });
    setNewWakeResponse('');
  }, [newWakeResponse, notifConfig.wakeResponseTexts, updateNotifConfig]);

  const removeWakeResponseText = useCallback((text: string) => {
    updateNotifConfig({ wakeResponseTexts: notifConfig.wakeResponseTexts.filter(t => t !== text) });
  }, [notifConfig.wakeResponseTexts, updateNotifConfig]);

  const handleWakeResponseKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addWakeResponseText();
    }
  }, [addWakeResponseText]);

  // ===== 语音命令关键词管理 =====

  const updateVoiceCommands = useCallback((newCommands: VoiceCommandEntry[]) => {
    onConfigChange({ ...config, voiceCommands: newCommands });
  }, [config, onConfigChange]);

  const addCommandKeyword = useCallback((commandType: VoiceCommand) => {
    const keyword = newKeywordByCommand[commandType]?.trim();
    if (!keyword) return;
    const entry = voiceCommands.find(e => e.type === commandType);
    if (!entry) return;
    if (entry.keywords.includes(keyword)) return;
    updateVoiceCommands(
      voiceCommands.map(e =>
        e.type === commandType ? { ...e, keywords: [...e.keywords, keyword] } : e
      )
    );
    setNewKeywordByCommand(prev => ({ ...prev, [commandType]: '' }));
  }, [newKeywordByCommand, voiceCommands, updateVoiceCommands]);

  const removeCommandKeyword = useCallback((commandType: VoiceCommand, keyword: string) => {
    updateVoiceCommands(
      voiceCommands.map(e =>
        e.type === commandType ? { ...e, keywords: e.keywords.filter(k => k !== keyword) } : e
      )
    );
  }, [voiceCommands, updateVoiceCommands]);

  const handleCommandKeywordKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>, commandType: VoiceCommand) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCommandKeyword(commandType);
    }
  }, [addCommandKeyword]);

  const resetCommandsToDefault = useCallback(() => {
    updateVoiceCommands([...DEFAULT_VOICE_COMMAND_CONFIG]);
  }, [updateVoiceCommands]);

  const updateTTSConfig = (updates: Partial<typeof ttsConfig>) => {
    const newConfig = {
      ...config,
      tts: {
        ...ttsConfig,
        ...updates,
      },
    };
    onConfigChange(newConfig);

    // 同步更新 TTS 服务配置
    ttsService.setConfig(newConfig.tts ?? DEFAULT_TTS_CONFIG);

    // TTS 角色/语速变更时重新生成语音包
    if (updates.voice || updates.rate) {
      voiceNotificationService.preGenerateVoicePackage();
    }
  };

  // 测试语音
  const testVoice = async () => {
    if (isTestingVoice) return;

    setIsTestingVoice(true);
    try {
      // 先停止当前播放
      ttsService.stop();

      // 更新配置
      ttsService.setConfig(ttsConfig);

      // 播放测试文本
      await ttsService.speak('你好，这是语音测试。');
    } catch (error) {
      log.error('Voice test failed:', error instanceof Error ? error : new Error(String(error)));
    } finally {
      setIsTestingVoice(false);
    }
  };

  // 停止测试
  const stopTest = () => {
    ttsService.stop();
    setIsTestingVoice(false);
  };

  return (
    <div className="space-y-6">
      {/* ========== 语音输入部分 ========== */}
      <div className="border-b border-border pb-6">
        <h2 className="text-base font-medium text-text-primary mb-4">
          {t('speech.input.title', '语音输入')}
        </h2>

        {/* 启用语音输入 */}
        <div className="p-4 bg-surface rounded-lg border border-border mb-4">
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
        <div className="p-4 bg-surface rounded-lg border border-border mb-4">
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

        {/* 唤醒词设置（仅语音输入启用时显示） */}
        {speechConfig.enabled && (
          <div className="p-4 bg-surface rounded-lg border border-border mb-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-medium text-text-primary">
                  {t('speech.wakeWord.title', '唤醒词模式')}
                </h3>
                <p className="text-xs text-text-secondary mt-1">
                  {t('speech.wakeWord.desc', '开启后，语音识别将持续运行，但只有说出唤醒词后的内容才会写入输入框')}
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={wakeWordConfig.enabled}
                  onChange={(e) => updateWakeWordConfig({ enabled: e.target.checked })}
                  disabled={loading}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-border rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
              </label>
            </div>

            {/* 唤醒词列表 */}
            {wakeWordConfig.enabled && (
              <div>
                {wakeWordConfig.words.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {wakeWordConfig.words.map(word => (
                      <span
                        key={word}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-primary/10 text-primary rounded text-xs"
                      >
                        {word}
                        <button
                          onClick={() => removeWakeWord(word)}
                          className="text-primary/60 hover:text-primary"
                          title={t('speech.wakeWord.remove', '删除')}
                        >
                          &times;
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-warning mb-3">
                    {t('speech.wakeWord.empty', '请至少添加一个唤醒词，否则唤醒模式无法生效')}
                  </p>
                )}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newWakeWord}
                    onChange={(e) => setNewWakeWord(e.target.value)}
                    onKeyDown={handleWakeWordKeyDown}
                    placeholder={t('speech.wakeWord.placeholder', '输入唤醒词，按回车添加')}
                    disabled={loading}
                    className="flex-1 px-3 py-1.5 bg-background border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  />
                  <button
                    onClick={addWakeWord}
                    disabled={loading || !newWakeWord.trim()}
                    className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {t('speech.wakeWord.add', '添加')}
                  </button>
                </div>
                <p className="text-xs text-text-tertiary mt-2">
                  {t('speech.wakeWord.hint', '说唤醒词后，后续语音内容将写入输入框；发送后自动回到待命状态')}
                </p>
              </div>
            )}
          </div>
        )}

        {/* 语音命令说明 */}
        <div className="p-4 bg-surface rounded-lg border border-border">
          <h3 className="text-sm font-medium text-text-primary mb-3">
            {t('speech.commands.title', '语音命令')}
          </h3>
          <div className="space-y-3">
            {voiceCommands.map(entry => (
              <div key={entry.type} className="p-3 bg-background rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-medium text-text-primary">{entry.label}</span>
                  <span className="text-xs text-text-tertiary">({entry.type})</span>
                </div>
                {/* 关键词标签 */}
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {entry.keywords.map(keyword => (
                    <span
                      key={keyword}
                      className="inline-flex items-center gap-1 px-2 py-1 bg-primary/10 text-primary rounded text-xs"
                    >
                      {keyword}
                      <button
                        onClick={() => removeCommandKeyword(entry.type, keyword)}
                        className="text-primary/60 hover:text-primary"
                        title={t('speech.commands.removeKeyword', '删除')}
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                  {entry.keywords.length === 0 && (
                    <span className="text-xs text-warning">
                      {t('speech.commands.noKeywords', '无关键词，请至少添加一个')}
                    </span>
                  )}
                </div>
                {/* 添加关键词输入 */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newKeywordByCommand[entry.type] ?? ''}
                    onChange={(e) => setNewKeywordByCommand(prev => ({ ...prev, [entry.type]: e.target.value }))}
                    onKeyDown={(e) => handleCommandKeywordKeyDown(e, entry.type)}
                    placeholder={t('speech.commands.addKeywordPlaceholder', '输入关键词，按回车添加')}
                    disabled={loading}
                    className="flex-1 px-2 py-1 bg-surface border border-border rounded text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button
                    onClick={() => addCommandKeyword(entry.type)}
                    disabled={loading || !(newKeywordByCommand[entry.type] ?? '').trim()}
                    className="px-2 py-1 bg-primary text-white rounded text-xs hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {t('speech.commands.addKeyword', '添加')}
                  </button>
                </div>
              </div>
            ))}
            <button
              onClick={resetCommandsToDefault}
              disabled={loading}
              className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
            >
              {t('speech.commands.resetToDefault', '恢复默认命令')}
            </button>
          </div>
        </div>
      </div>

      {/* ========== 语音输出部分 (TTS) ========== */}
      <div>
        <h2 className="text-base font-medium text-text-primary mb-4">
          {t('speech.output.title', '语音输出')}
        </h2>

        {/* 启用语音输出 */}
        <div className="p-4 bg-surface rounded-lg border border-border mb-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-text-primary">
                {t('speech.tts.enabled.title', '启用语音输出')}
              </h3>
              <p className="text-xs text-text-secondary mt-1">
                {t('speech.tts.enabled.desc', 'AI 回复完成后自动朗读文本内容')}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={ttsConfig.enabled}
                onChange={(e) => updateTTSConfig({ enabled: e.target.checked })}
                disabled={loading}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-border rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>
        </div>

        {/* TTS 详细配置 */}
        {ttsConfig.enabled && (
          <>
            {/* 语音选择 */}
            <div className="p-4 bg-surface rounded-lg border border-border mb-4">
              <h3 className="text-sm font-medium text-text-primary mb-3">
                {t('speech.tts.voice.title', '语音角色')}
              </h3>
              <select
                value={ttsConfig.voice}
                onChange={(e) => updateTTSConfig({ voice: e.target.value as TTSVoice })}
                disabled={loading}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              >
                {TTS_VOICE_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label} - {option.description}
                  </option>
                ))}
              </select>
            </div>

            {/* 语速选择 */}
            <div className="p-4 bg-surface rounded-lg border border-border mb-4">
              <h3 className="text-sm font-medium text-text-primary mb-3">
                {t('speech.tts.rate.title', '语速')}
              </h3>
              <select
                value={ttsConfig.rate}
                onChange={(e) => updateTTSConfig({ rate: e.target.value })}
                disabled={loading}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              >
                {TTS_RATE_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 音量控制 */}
            <div className="p-4 bg-surface rounded-lg border border-border mb-4">
              <h3 className="text-sm font-medium text-text-primary mb-3">
                {t('speech.tts.volume.title', '音量')}: {Math.round(ttsConfig.volume * 100)}%
              </h3>
              <input
                type="range"
                min="0"
                max="100"
                value={ttsConfig.volume * 100}
                onChange={(e) => updateTTSConfig({ volume: parseInt(e.target.value) / 100 })}
                disabled={loading}
                className="w-full h-2 bg-border rounded-lg appearance-none cursor-pointer accent-primary"
              />
            </div>

            {/* 自动播放 */}
            <div className="p-4 bg-surface rounded-lg border border-border mb-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-text-primary">
                    {t('speech.tts.autoPlay.title', '自动播放')}
                  </h3>
                  <p className="text-xs text-text-secondary mt-1">
                    {t('speech.tts.autoPlay.desc', '消息完成后自动朗读，关闭后需手动触发')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ttsConfig.autoPlay}
                    onChange={(e) => updateTTSConfig({ autoPlay: e.target.checked })}
                    disabled={loading}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-border rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
                </label>
              </div>
            </div>

            {/* 测试按钮 */}
            <div className="p-4 bg-surface rounded-lg border border-border">
              <h3 className="text-sm font-medium text-text-primary mb-3">
                {t('speech.tts.test.title', '测试语音')}
              </h3>
              <div className="flex gap-2">
                <button
                  onClick={testVoice}
                  disabled={loading || isTestingVoice}
                  className="flex-1 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isTestingVoice
                    ? t('speech.tts.test.playing', '播放中...')
                    : t('speech.tts.test.play', '播放测试')
                  }
                </button>
                <button
                  onClick={stopTest}
                  disabled={!isTestingVoice}
                  className="px-4 py-2 bg-danger text-white rounded-lg text-sm font-medium hover:bg-danger/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {t('speech.tts.test.stop', '停止')}
                </button>
              </div>
            </div>
          </>
        )}

        {/* TTS 提示信息 */}
        <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg mt-4">
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <div className="flex-1">
              <p className="text-xs text-text-primary">
                <span className="font-medium">{t('speech.tts.tips.title', '使用说明')}：</span>
              </p>
              <ul className="text-xs text-text-tertiary mt-1 space-y-1 list-disc list-inside">
                <li>{t('speech.tts.tips.filter', '自动过滤代码块、工具调用等内容，只朗读纯文本')}</li>
                <li>{t('speech.tts.tips.interrupt', '发送新消息或中断对话时会自动停止朗读')}</li>
                <li>{t('speech.tts.tips.online', '语音合成需要网络连接')}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* ========== 语音提醒部分 ========== */}
      <div className="border-t border-border pt-6">
        <h2 className="text-base font-medium text-text-primary mb-4">
          {t('speech.notification.title', '语音提醒')}
        </h2>

        {/* 总开关 */}
        <div className="p-4 bg-surface rounded-lg border border-border mb-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-text-primary">
                {t('speech.notification.enabled.title', '启用语音提醒')}
              </h3>
              <p className="text-xs text-text-secondary mt-1">
                {t('speech.notification.enabled.desc', '在关键事件时通过语音播报提醒，如消息已发送、唤醒回应等')}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={notifConfig.enabled}
                onChange={(e) => updateNotifConfig({ enabled: e.target.checked })}
                disabled={loading}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-border rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>
        </div>

        {/* 各场景开关 */}
        {notifConfig.enabled && (
          <>
            {/* 发送确认 */}
            <div className="p-4 bg-surface rounded-lg border border-border mb-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-medium text-text-primary">
                    {t('speech.notification.sendConfirm.title', '发送确认')}
                  </h3>
                  <p className="text-xs text-text-secondary mt-1">
                    {t('speech.notification.sendConfirm.desc', '发送消息后播报确认语音')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifConfig.sendConfirm}
                    onChange={(e) => updateNotifConfig({ sendConfirm: e.target.checked })}
                    disabled={loading}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-border rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
                </label>
              </div>
              {notifConfig.sendConfirm && (
                <div>
                  <label className="text-xs text-text-secondary mb-1 block">
                    {t('speech.notification.sendConfirm.label', '播报文本')}
                  </label>
                  <input
                    type="text"
                    value={notifConfig.sendConfirmText}
                    onChange={(e) => updateNotifConfig({ sendConfirmText: e.target.value })}
                    disabled={loading}
                    className="w-full px-3 py-1.5 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  />
                </div>
              )}
            </div>

            {/* 唤醒回应 */}
            <div className="p-4 bg-surface rounded-lg border border-border mb-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-medium text-text-primary">
                    {t('speech.notification.wakeResponse.title', '唤醒回应')}
                  </h3>
                  <p className="text-xs text-text-secondary mt-1">
                    {t('speech.notification.wakeResponse.desc', '唤醒词匹配后播报回应语音，随机选择一条')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifConfig.wakeResponse}
                    onChange={(e) => updateNotifConfig({ wakeResponse: e.target.checked })}
                    disabled={loading}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-border rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
                </label>
              </div>
              {notifConfig.wakeResponse && (
                <div>
                  {notifConfig.wakeResponseTexts.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {notifConfig.wakeResponseTexts.map(text => (
                        <span
                          key={text}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-green-500/10 text-green-600 rounded text-xs"
                        >
                          {text}
                          <button
                            onClick={() => removeWakeResponseText(text)}
                            className="text-green-600/60 hover:text-green-600"
                            title={t('speech.notification.wakeResponse.remove', '删除')}
                          >
                            &times;
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newWakeResponse}
                      onChange={(e) => setNewWakeResponse(e.target.value)}
                      onKeyDown={handleWakeResponseKeyDown}
                      placeholder={t('speech.notification.wakeResponse.placeholder', '输入回应语，按回车添加')}
                      disabled={loading}
                      className="flex-1 px-3 py-1.5 bg-background border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    />
                    <button
                      onClick={addWakeResponseText}
                      disabled={loading || !newWakeResponse.trim()}
                      className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {t('speech.notification.wakeResponse.add', '添加')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 错误提醒 */}
            <div className="p-4 bg-surface rounded-lg border border-border mb-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-medium text-text-primary">
                    {t('speech.notification.errorAlert.title', '错误提醒')}
                  </h3>
                  <p className="text-xs text-text-secondary mt-1">
                    {t('speech.notification.errorAlert.desc', '聊天出错时播报错误提醒')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifConfig.errorAlert}
                    onChange={(e) => updateNotifConfig({ errorAlert: e.target.checked })}
                    disabled={loading}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-border rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
                </label>
              </div>
              {notifConfig.errorAlert && (
                <div>
                  <label className="text-xs text-text-secondary mb-1 block">
                    {t('speech.notification.errorAlert.label', '播报文本')}
                  </label>
                  <input
                    type="text"
                    value={notifConfig.errorAlertText}
                    onChange={(e) => updateNotifConfig({ errorAlertText: e.target.value })}
                    disabled={loading}
                    className="w-full px-3 py-1.5 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  />
                </div>
              )}
            </div>

            {/* 后台完成通知 */}
            <div className="p-4 bg-surface rounded-lg border border-border mb-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-medium text-text-primary">
                    {t('speech.notification.backgroundNotify.title', '后台完成通知')}
                  </h3>
                  <p className="text-xs text-text-secondary mt-1">
                    {t('speech.notification.backgroundNotify.desc', '后台任务完成时播报通知')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifConfig.backgroundNotify}
                    onChange={(e) => updateNotifConfig({ backgroundNotify: e.target.checked })}
                    disabled={loading}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-border rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
                </label>
              </div>
              {notifConfig.backgroundNotify && (
                <div>
                  <label className="text-xs text-text-secondary mb-1 block">
                    {t('speech.notification.backgroundNotify.label', '播报文本')}
                  </label>
                  <input
                    type="text"
                    value={notifConfig.backgroundNotifyText}
                    onChange={(e) => updateNotifConfig({ backgroundNotifyText: e.target.value })}
                    disabled={loading}
                    className="w-full px-3 py-1.5 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  />
                </div>
              )}
            </div>

            {/* AI 回复朗读提示 */}
            <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
              <div className="flex items-start gap-2">
                <svg className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                </svg>
                <p className="text-xs text-text-secondary">
                  {t('speech.notification.autoPlayHint', 'AI 回复自动朗读由上方「自动播放」开关控制，开启后 AI 每次回复完成都会自动朗读内容。')}
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
