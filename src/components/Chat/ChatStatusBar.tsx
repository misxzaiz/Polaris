/**
 * 聊天状态栏组件
 *
 * 显示当前对话的状态信息：
 * - 会话配置选择器 (Agent/Model/Effort/Permission)
 * - 引擎版本
 * - 语音识别按钮
 * - TTS 播放控制
 * - 输入状态提示
 * - 流式状态指示
 * - 输入字数
 */

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore, useSessionStore } from '../../stores';
import { useActiveSessionActions, useActiveSessionStreaming, useHasPendingQuestion, useHasActivePlan, useActiveSessionMessages } from '../../stores/conversationStore/useActiveSession';
import { useSessionConfig } from '../../stores/sessionConfigStore';
import { Paperclip, Loader2, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { IconMic, IconVolume, IconVolumeX } from '../Common/Icons';
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition';
import { useTTS } from '../../hooks/useTTS';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import type { SpeechConfig, VoiceCommand, TTSConfig, WakeWordConfig } from '../../types/speech';
import { DEFAULT_TTS_CONFIG } from '../../types/speech';
import { SessionConfigSelector } from './SessionConfigSelector';
import { voiceNotificationService } from '../../services/voiceNotificationService';
import { isAssistantMessage } from '../../types/chat';

/** 宽度分级阈值 */
const BREAKPOINTS = {
  /** 全部元素一行展示，无需展开 */
  full: 550,
  /** 主行显示 Agent + Model */
  medium: 400,
  /** 主行仅显示 Agent */
  narrow: 300,
} as const;

type SelectorType = 'agent' | 'model' | 'effort' | 'permission';

/** 根据容器宽度计算主行应显示的选择器类型 */
function getVisibleTypes(width: number): SelectorType[] {
  if (width >= BREAKPOINTS.full) return ['agent', 'model', 'effort', 'permission'];
  if (width >= BREAKPOINTS.medium) return ['agent', 'model', 'effort', 'permission'];
  if (width >= BREAKPOINTS.narrow) return ['agent', 'effort', 'permission'];
  return [];
}

/** 被主行隐藏的选择器类型 */
function getHiddenTypes(visible: SelectorType[]): SelectorType[] {
  const all: SelectorType[] = ['agent', 'model', 'effort', 'permission'];
  return all.filter(t => !visible.includes(t));
}

interface ChatStatusBarProps {
  children?: ReactNode;
}

/**
 * 聊天状态栏组件
 *
 * 宽度自适应布局：
 * - ≥680px：所有元素一行展示，无展开按钮
 * - 500-680px：主行显示 Agent+Model+状态+展开按钮，其余收入展开区
 * - 300-500px：主行仅 Agent+展开按钮，其余收入展开区
 * - <300px：仅展开按钮，全部收入展开区
 * - 点击展开按钮平滑显示/隐藏展开区
 */
export function ChatStatusBar({ children }: ChatStatusBarProps) {
  const { t } = useTranslation('chat');
  const { config, healthStatus, updateConfig } = useConfigStore();
  const isStreaming = useActiveSessionStreaming();
  const { interrupt } = useActiveSessionActions();
  const { messages, currentMessage } = useActiveSessionMessages();
  const {
    inputLength,
    attachmentCount,
    suggestionMode,
    appendSpeechTranscript,
    setSpeechCommand,
    speechCommand,
    undoSpeechTranscript,
    speechWakeActive,
  } = useSessionStore();

  // 直接从 conversationStore 获取状态（消除 chatInputStore 冗余同步）
  const hasPendingQuestion = useHasPendingQuestion();
  const hasActivePlan = useHasActivePlan();

  // 会话配置
  const { config: sessionConfig, setConfig: setSessionConfig } = useSessionConfig();

  // 容器宽度监听
  const { ref: containerRef, width: containerWidth } = useContainerWidth();

  // 根据宽度决定主行显示哪些选择器
  const visibleTypes = getVisibleTypes(containerWidth);
  const hiddenTypes = getHiddenTypes(visibleTypes);
  const isWide = containerWidth >= BREAKPOINTS.full;

  // 展开/收起
  const [expanded, setExpanded] = useState(false);

  // 语音识别配置
  const speechConfig = config?.speech as SpeechConfig | undefined;
  const speechEnabled = speechConfig?.enabled ?? true;

  // TTS 配置
  const ttsConfig = config?.tts as TTSConfig | undefined;
  const ttsEnabled = ttsConfig?.enabled ?? false;

  // TTS Hook
  const {
    status: ttsStatus,
    stop: stopTTS,
  } = useTTS();

  // 处理 TTS 按钮点击
  const handleTTSClick = useCallback(() => {
    if (!config) return;

    if (ttsStatus === 'playing') {
      stopTTS();
    } else if (ttsStatus === 'paused') {
      stopTTS();
      updateConfig({
        ...config,
        tts: { ...(ttsConfig || DEFAULT_TTS_CONFIG), enabled: false },
      });
    } else if (ttsStatus === 'idle' || ttsStatus === 'error') {
      if (!ttsEnabled) {
        updateConfig({
          ...config,
          tts: { ...(ttsConfig || DEFAULT_TTS_CONFIG), enabled: true },
        });
      }
    }
  }, [ttsStatus, stopTTS, ttsEnabled, ttsConfig, config, updateConfig]);

  // 唤醒词配置
  const wakeWordConfig = config?.wakeWord as WakeWordConfig | undefined;
  // 语音命令配置
  const voiceCommands = config?.voiceCommands;

  // 语音识别 Hook
  const {
    interimTranscript,
    isSupported: speechSupported,
    start: startSpeech,
    stop: stopSpeech,
    isListening,
  } = useSpeechRecognition({
    language: speechConfig?.language || 'zh-CN',
    onResult: (transcript) => {
      appendSpeechTranscript(transcript);
    },
    onCommand: (command: VoiceCommand) => {
      setSpeechCommand(command);
    },
    voiceCommands,
    wakeWordConfig: wakeWordConfig?.enabled ? wakeWordConfig : undefined,
    getWakeActive: () => useSessionStore.getState().speechWakeActive,
    setWakeActive: (active: boolean) => useSessionStore.getState().setSpeechWakeActive(active),
  });

  // 处理语音命令
  useEffect(() => {
    if (!speechCommand) return;

    switch (speechCommand) {
      case 'interrupt':
        if (isStreaming) {
          interrupt();
        }
        break;
      case 'undo':
        undoSpeechTranscript();
        break;
      case 'play': {
        // 优先播放正在流式输出的，否则找最后一条 assistant 消息
        // currentMessage 类型是 CurrentAssistantMessage，需要检查 blocks 存在
        const lastAssistant = currentMessage?.blocks
          ? { ...currentMessage, type: 'assistant' as const, timestamp: new Date().toISOString() }
          : [...messages].reverse().find(m => isAssistantMessage(m));
        if (lastAssistant) {
          voiceNotificationService.speakAIResponse(lastAssistant as any, { force: true });
        }
        break;
      }
    }

    if (speechCommand === 'interrupt' || speechCommand === 'undo' || speechCommand === 'play') {
      setSpeechCommand(null);
    }
  }, [speechCommand, isStreaming, interrupt, setSpeechCommand, undoSpeechTranscript, messages, currentMessage]);

  // 获取输入状态提示文本
  const getInputHint = () => {
    if (hasPendingQuestion) {
      return { text: t('question.pendingAnswer'), type: 'accent' as const };
    }
    if (hasActivePlan) {
      return { text: t('plan.pendingApproval'), type: 'violet' as const };
    }
    if (suggestionMode === 'workspace') {
      return { text: t('input.selectWorkspace'), type: 'default' as const };
    }
    if (suggestionMode === 'file') {
      return { text: t('input.selectFile'), type: 'default' as const };
    }
    if (suggestionMode === 'git') {
      return { text: t('input.gitContext'), type: 'default' as const };
    }
    if (attachmentCount > 0) {
      return { text: t('input.attachmentCount', { count: attachmentCount }), type: 'default' as const };
    }
    return null;
  };

  const inputHint = getInputHint();

  // 版本徽章
  const versionBadge = config?.defaultEngine === 'claude-code' && healthStatus?.claudeVersion ? (
    <span className="px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-500 border border-green-500/20 shrink-0">
      v{healthStatus.claudeVersion}
    </span>
  ) : null;

  // 是否有内容被折叠（需要展开按钮）
  const hasOverflow = !isWide && (hiddenTypes.length > 0 || !!versionBadge);

  // 是否处于唤醒词模式
  const wakeWordMode = wakeWordConfig?.enabled && isListening;

  // 语音识别按钮
  const speechButton = speechEnabled && speechSupported ? (
    <button
      onClick={isListening ? stopSpeech : startSpeech}
      className={clsx(
        'flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors shrink-0',
        isListening && speechWakeActive
          ? 'bg-green-500/10 text-green-500'
          : isListening
            ? 'bg-primary/10 text-primary'
            : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
      )}
      title={isListening ? t('speech.stop', '停止语音识别') : t('speech.start', '开始语音识别')}
    >
      <IconMic size={14} className={isListening ? 'animate-pulse' : ''} />
      {isListening && (
        <span className="max-w-[200px] truncate">
          {wakeWordMode
            ? (speechWakeActive
                ? t('speech.awake', '已唤醒...')
                : (interimTranscript || t('speech.waitingWake', '等待唤醒...')))
            : (interimTranscript || t('speech.listening', '正在听...'))
          }
        </span>
      )}
    </button>
  ) : null;

  // TTS 按钮
  const ttsButton = (
    <button
      onClick={handleTTSClick}
      disabled={ttsStatus === 'synthesizing'}
      className={clsx(
        'flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors shrink-0',
        ttsStatus === 'playing' && 'bg-primary/10 text-primary',
        ttsStatus === 'paused' && 'text-text-secondary hover:text-text-primary hover:bg-background-hover',
        ttsStatus === 'synthesizing' && 'text-warning cursor-wait',
        (ttsStatus === 'idle' || ttsStatus === 'error') && (ttsEnabled
          ? 'text-text-muted cursor-not-allowed'
          : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
        )
      )}
      title={
        ttsStatus === 'playing' ? t('tts.stop', '停止播放') :
        ttsStatus === 'paused' ? t('tts.disable', '关闭语音播放') :
        ttsStatus === 'synthesizing' ? t('tts.synthesizing', '合成中...') :
        ttsEnabled ? t('tts.idle', '语音播放') : t('tts.enable', '开启语音播放')
      }
    >
      {ttsStatus === 'synthesizing' && <Loader2 size={14} className="animate-spin" />}
      {(ttsStatus === 'playing' || ttsStatus === 'paused') && (
        <IconVolume size={14} className={ttsStatus === 'playing' ? 'animate-pulse' : ''} />
      )}
      {(ttsStatus === 'idle' || ttsStatus === 'error') && (
        <IconVolumeX size={14} />
      )}
    </button>
  );

  return (
    <div
      ref={containerRef}
      className={clsx(
        'grid px-4 text-xs text-text-tertiary',
        'bg-background-surface/50 border-t border-border-subtle',
        'transition-[grid-template-rows] duration-200 ease-in-out',
      )}
      style={{
        gridTemplateRows: isWide
          ? 'auto'
          : expanded
            ? 'auto auto'
            : 'auto 0fr',
      }}
    >
      {/* 主行 */}
      <div className="flex items-center justify-between gap-2 py-1.5 min-w-0">
        {/* 左侧：children + 按宽度显示的选择器 */}
        <div className="flex items-center gap-2 min-w-0">
          {children}
          {isWide && versionBadge}
          {visibleTypes.length > 0 && (
            <SessionConfigSelector
              config={sessionConfig}
              onChange={setSessionConfig}
              disabled={isStreaming}
              visibleTypes={visibleTypes}
            />
          )}
          {isWide && speechButton}
          {isWide && ttsButton}
        </div>

        {/* 右侧：展开按钮（始终可见） + 核心状态 */}
        <div className="flex items-center gap-2 shrink-0">
          {/* 流式状态 */}
          {isStreaming && (
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
              <span className="text-primary">{t('statusBar.responding')}</span>
            </div>
          )}

          {/* 输入状态提示 */}
          {inputHint && (
            <span className={clsx(
              'flex items-center gap-1.5',
              inputHint.type === 'accent' && 'text-accent',
              inputHint.type === 'violet' && 'text-violet-500'
            )}>
              {inputHint.type !== 'default' && <span className="w-1.5 h-1.5 bg-current rounded-full animate-pulse" />}
              {attachmentCount > 0 && inputHint.type === 'default' && <Paperclip size={12} />}
              {inputHint.text}
            </span>
          )}

          {/* 字数 */}
          {inputLength > 0 && (
            <span className="text-text-tertiary">{inputLength}</span>
          )}

          {/* 展开按钮（窄屏时始终可见，确保不被挤掉） */}
          {hasOverflow && (
            <button
              onClick={() => setExpanded(prev => !prev)}
              className={clsx(
                'flex items-center px-1 py-0.5 rounded transition-colors',
                'text-text-tertiary hover:text-text-primary hover:bg-background-hover',
                'shrink-0',
              )}
              title={expanded ? t('statusBar.collapse', '收起') : t('statusBar.expand', '展开更多')}
            >
              <ChevronDown
                size={14}
                className={clsx(
                  'transition-transform duration-200',
                  expanded && 'rotate-180',
                )}
              />
            </button>
          )}
        </div>
      </div>

      {/* 展开行（仅窄屏且有溢出内容时渲染） */}
      {!isWide && hasOverflow && (
        <div className={clsx(
          'transition-opacity duration-200',
          expanded ? 'opacity-100 overflow-visible' : 'opacity-0 overflow-hidden',
        )}>
          <div className="flex items-center gap-2 py-1.5 border-t border-border-subtle/50 flex-wrap">
            {/* 被隐藏的选择器 */}
            {hiddenTypes.length > 0 && (
              <SessionConfigSelector
                config={sessionConfig}
                onChange={setSessionConfig}
                disabled={isStreaming}
                visibleTypes={hiddenTypes}
              />
            )}
            {versionBadge}
            {speechButton}
            {ttsButton}
          </div>
        </div>
      )}
    </div>
  );
}