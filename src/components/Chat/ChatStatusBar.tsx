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
import { useConfigStore, useSessionStore } from '@/stores';
import { useActiveSessionActions, useActiveSessionStreaming, useHasPendingQuestion, useHasActivePlan, useActiveSessionMessages } from '@/stores/conversationStore/useActiveSession';
import { useSessionConfig } from '@/stores/sessionConfigStore';
import { Paperclip, Loader2, MoreHorizontal } from 'lucide-react';
import { clsx } from 'clsx';
import { IconMic, IconVolume, IconVolumeX } from '../Common/Icons';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useTTS } from '@/hooks/useTTS';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import type { SpeechConfig, VoiceCommand, TTSConfig, WakeWordConfig } from '@/types/speech';
import type { AssistantChatMessage } from '@/types/chat';
import { DEFAULT_TTS_CONFIG } from '@/types/speech';
import { SessionConfigSelector } from './SessionConfigSelector';
import { voiceNotificationService } from '@/services/voiceNotificationService';
import { isAssistantMessage } from '@/types/chat';
import { getSelectedEngineHealth } from '@/utils/engineHealth';
import { normalizeEngineId } from '@/utils/engineDisplay';
import { useActiveSessionId, useSessionMetadataList } from '@/stores/conversationStore/sessionStoreManager';

/**
 * 宽度分级阈值（主行可容纳的高频选择器数量）
 *
 * 选择器分两层：
 * - 主行（高频，按宽度收敛）：profile > model > effort
 * - 折叠面板（低频，始终收纳）：agent、permission
 */
const BREAKPOINTS = {
  /** 主行可容纳 profile + model + effort，并内联显示语音/TTS */
  wide: 600,
  /** 主行可容纳 profile + model */
  medium: 360,
  /** 主行仅显示 profile（端点，最高优先级） */
  narrow: 260,
} as const;

type SelectorType = 'agent' | 'model' | 'effort' | 'permission' | 'profile';

/** 主行核心选择器优先级（高频，按宽度从前往后保留） */
const PRIMARY_PRIORITY: SelectorType[] = ['profile', 'model', 'effort'];
/** 低频选择器：始终收纳到「更多」折叠面板 */
const SECONDARY_TYPES: SelectorType[] = ['agent', 'permission'];

/** 根据容器宽度计算主行应显示的选择器类型 */
function getVisibleTypes(width: number): SelectorType[] {
  if (width >= BREAKPOINTS.wide) return ['profile', 'model', 'effort'];
  if (width >= BREAKPOINTS.medium) return ['profile', 'model'];
  if (width >= BREAKPOINTS.narrow) return ['profile'];
  return [];
}

/** 被折叠到「更多」面板的选择器类型（低频 + 主行放不下的高频） */
function getHiddenTypes(visible: SelectorType[]): SelectorType[] {
  const all: SelectorType[] = [...PRIMARY_PRIORITY, ...SECONDARY_TYPES];
  return all.filter(t => !visible.includes(t));
}

interface ChatStatusBarProps {
  children?: ReactNode;
}

/**
 * 聊天状态栏组件
 *
 * 四区布局：[会话操作] │ [配置选择器] … [工具/健康] │ [输入状态]
 *
 * 配置选择器分层 + 宽度自适应：
 * - ≥480px：主行显示 端点 + 模型 + 努力，并内联语音/TTS
 * - 360–480px：主行显示 端点 + 模型，语音/TTS 收入折叠面板
 * - 260–360px：主行仅显示 端点（最高优先级）
 * - <260px：配置全部收入折叠面板
 * - agent / permission 为低频项，始终收入「更多」折叠面板
 * - 引擎版本降级为健康圆点（hover 显示版本号）
 */
export function ChatStatusBar({ children }: ChatStatusBarProps) {
  const { t } = useTranslation('chat');
  const { config, healthStatus, updateConfigPatch } = useConfigStore();
  const isStreaming = useActiveSessionStreaming();
  const { interrupt } = useActiveSessionActions();
  const { messages, currentMessage } = useActiveSessionMessages();
  const activeSessionId = useActiveSessionId();
  const sessionMetadataList = useSessionMetadataList();
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
  // 工具按钮（语音/TTS）是否内联在主行（窄屏收入折叠面板）
  const showToolsInline = containerWidth >= BREAKPOINTS.wide;
  // 是否在健康圆点旁显示版本号文字（窄屏仅显示圆点）
  const showVersionText = containerWidth >= BREAKPOINTS.wide;

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
      updateConfigPatch({
        tts: { ...(ttsConfig || DEFAULT_TTS_CONFIG), enabled: false },
      });
    } else if (ttsStatus === 'idle' || ttsStatus === 'error') {
      if (!ttsEnabled) {
        updateConfigPatch({
          tts: { ...(ttsConfig || DEFAULT_TTS_CONFIG), enabled: true },
        });
      }
    }
  }, [ttsStatus, stopTTS, ttsEnabled, ttsConfig, config, updateConfigPatch]);

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
          voiceNotificationService.speakAIResponse(lastAssistant as AssistantChatMessage, { force: true });
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

  // 引擎健康指示（替代醒目的版本徽章）：绿点=可用，灰点=不可用；版本号收入 tooltip
  const activeSessionMetadata = sessionMetadataList.find(session => session.id === activeSessionId);
  const activeEngineId = normalizeEngineId(activeSessionMetadata?.engineId || config?.defaultEngine);
  const selectedEngineHealth = getSelectedEngineHealth(config, healthStatus, activeEngineId);
  const engineTooltip = selectedEngineHealth.available
    ? `${selectedEngineHealth.name}${selectedEngineHealth.version ? ` ${selectedEngineHealth.version}` : ''}`
    : t('statusBar.engineUnavailable', '引擎不可用');
  const healthIndicator = (
    <div className="flex items-center gap-1 shrink-0" title={engineTooltip}>
      <span className={clsx(
        'w-1.5 h-1.5 rounded-full',
        selectedEngineHealth.available ? 'bg-green-500' : 'bg-text-muted',
      )} />
      {showVersionText && selectedEngineHealth.version && (
        <span className="text-text-muted">{selectedEngineHealth.version}</span>
      )}
    </div>
  );

  // 是否有内容被折叠（需要「更多」按钮）：低频选择器始终折叠 + 窄屏收纳工具按钮
  const hasOverflow = hiddenTypes.length > 0 || !showToolsInline;

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
        gridTemplateRows: expanded ? 'auto auto' : 'auto 0fr',
      }}
    >
      {/* 主行：[会话操作] │ [配置选择器] … [工具/健康] │ [输入状态] */}
      <div className="flex items-center justify-between gap-2 py-1.5 min-w-0">
        {/* 左侧：会话操作 + 配置选择器 + 更多按钮 */}
        <div className="flex items-center gap-2 min-w-0">
          {children}
          {children && <span className="w-px h-3.5 bg-border-subtle shrink-0" aria-hidden="true" />}
          {visibleTypes.length > 0 && (
            <SessionConfigSelector
              config={sessionConfig}
              onChange={setSessionConfig}
              disabled={isStreaming}
              visibleTypes={visibleTypes}
            />
          )}
          {/* 更多按钮：展开低频配置（agent/permission）+ 窄屏收纳的项 */}
          {hasOverflow && (
            <button
              onClick={() => setExpanded(prev => !prev)}
              className={clsx(
                'flex items-center px-1.5 py-0.5 rounded transition-colors shrink-0',
                expanded
                  ? 'bg-primary/10 text-primary'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover',
              )}
              title={expanded ? t('statusBar.collapse', '收起') : t('statusBar.more', '更多设置')}
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        </div>

        {/* 右侧：工具/健康 │ 输入状态 */}
        <div className="flex items-center gap-2 shrink-0">
          {showToolsInline && speechButton}
          {showToolsInline && ttsButton}
          {healthIndicator}

          {(isStreaming || inputHint || inputLength > 0) && (
            <span className="w-px h-3.5 bg-border-subtle shrink-0" aria-hidden="true" />
          )}

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
        </div>
      </div>

      {/* 折叠面板：低频选择器（agent/permission）+ 窄屏收纳的工具按钮 */}
      {hasOverflow && (
        <div className={clsx(
          'transition-opacity duration-200',
          expanded ? 'opacity-100 overflow-visible' : 'opacity-0 overflow-hidden',
        )}>
          <div className="flex flex-col gap-1 py-2 border-t border-border-subtle/50">
            {hiddenTypes.length > 0 && (
              <SessionConfigSelector
                config={sessionConfig}
                onChange={setSessionConfig}
                disabled={isStreaming}
                visibleTypes={hiddenTypes}
                variant="panel"
              />
            )}
            {!showToolsInline && (
              <div className="flex items-center gap-2 pt-0.5">
                {speechButton}
                {ttsButton}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
