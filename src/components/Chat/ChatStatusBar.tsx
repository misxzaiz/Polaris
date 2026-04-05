/**
 * 聊天状态栏组件
 *
 * 显示当前对话的统计信息：
 * - 输入状态提示
 * - 消息数量
 * - 工具调用次数
 * - 会话时长
 * - Claude Code 版本
 * - 输入字数
 * - 语音识别按钮
 */

import { useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore, useChatInputStore } from '../../stores';
import { useActiveSessionActions, useActiveSessionMessages, useActiveSessionStreaming } from '../../stores/conversationStore/useActiveSession';
import { MessageSquare, Wrench, Clock, Paperclip, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { IconMic, IconVolume, IconVolumeX } from '../Common/Icons';
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition';
import { useTTS } from '../../hooks/useTTS';
import type { SpeechConfig, VoiceCommand, TTSConfig } from '../../types/speech';
import { DEFAULT_TTS_CONFIG } from '../../types/speech';

interface ChatStatusBarProps {
  /** 是否紧凑模式 */
  compact?: boolean;
}

/**
 * 计算会话时长
 */
function formatDuration(startTime: string | null, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (!startTime) return t('statusBar.minutes', { count: 0 });

  const start = new Date(startTime).getTime();
  const now = Date.now();
  const diffMs = now - start;

  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours > 0) {
    return t('statusBar.hoursMinutes', { hours, minutes: remainingMinutes });
  }
  return t('statusBar.minutes', { count: minutes });
}

/**
 * 聊天状态栏组件
 */
export function ChatStatusBar({ compact = false }: ChatStatusBarProps) {
  const { t } = useTranslation('chat');
  const { messages, currentMessage } = useActiveSessionMessages();
  const isStreaming = useActiveSessionStreaming();
  const { interrupt } = useActiveSessionActions();
  const { config, healthStatus, updateConfig } = useConfigStore();
  const {
    inputLength,
    attachmentCount,
    suggestionMode,
    hasPendingQuestion,
    hasActivePlan,
    appendSpeechTranscript,
    setSpeechCommand,
    speechCommand,
    undoSpeechTranscript,
  } = useChatInputStore();

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
      // 正在播放 → 停止
      stopTTS();
    } else if (ttsStatus === 'paused') {
      // 已暂停 → 关闭 TTS 设置
      stopTTS();
      updateConfig({
        ...config,
        tts: { ...(ttsConfig || DEFAULT_TTS_CONFIG), enabled: false },
      });
    } else if (ttsStatus === 'idle' || ttsStatus === 'error') {
      if (!ttsEnabled) {
        // 空闲且未开启 → 自动开启 TTS 设置
        updateConfig({
          ...config,
          tts: { ...(ttsConfig || DEFAULT_TTS_CONFIG), enabled: true },
        });
      }
    }
  }, [ttsStatus, stopTTS, ttsEnabled, ttsConfig, config, updateConfig]);

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
      // 追加到输入框
      appendSpeechTranscript(transcript);
    },
    onCommand: (command: VoiceCommand) => {
      // 设置命令，由 ChatInput 处理
      setSpeechCommand(command);
    }
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
      // 'send' 和 'clear' 由 ChatInput 处理
    }

    // 清除命令（保留 send 和 clear 给 ChatInput 处理）
    if (speechCommand === 'interrupt' || speechCommand === 'undo') {
      setSpeechCommand(null);
    }
  }, [speechCommand, isStreaming, interrupt, setSpeechCommand, undoSpeechTranscript]);

  // 计算统计数据
  const stats = useMemo(() => {
    // 消息数量（用户消息 + 助手消息）
    const userMessages = messages.filter(m => m.type === 'user').length;
    const assistantMessages = messages.filter(m => m.type === 'assistant').length;
    const totalMessages = userMessages + assistantMessages;

    // 如果有正在流式输出的消息，加 1
    const displayMessages = isStreaming && currentMessage ? totalMessages + 1 : totalMessages;

    // 工具调用次数
    let toolCalls = 0;
    for (const message of messages) {
      if (message.type === 'assistant' && message.blocks) {
        toolCalls += message.blocks.filter(b => b.type === 'tool_call' || b.type === 'tool_group').length;
      }
    }
    // 加上当前流式消息中的工具调用
    if (currentMessage?.blocks) {
      toolCalls += currentMessage.blocks.filter(b => b.type === 'tool_call' || b.type === 'tool_group').length;
    }

    // 会话开始时间（第一条消息的时间）
    const firstMessage = messages[0];
    const startTime = firstMessage?.timestamp || null;

    return {
      userMessages,
      assistantMessages,
      totalMessages: displayMessages,
      toolCalls,
      startTime,
    };
  }, [messages, currentMessage, isStreaming]);

  const duration = formatDuration(stats.startTime, t);
  const hasMessages = stats.totalMessages > 0;

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

  if (compact) {
    // 紧凑模式 - 不显示
    return null;
  }

  return (
    <div className={clsx(
      'flex items-center justify-between gap-4 px-4 py-1.5 text-xs text-text-tertiary',
      'bg-background-surface/50 border-t border-border-subtle'
    )}>
      <div className="flex items-center gap-4">
        {/* 版本 */}
        {config?.defaultEngine === 'claude-code' && healthStatus?.claudeVersion && (
          <span className="px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-500 border border-green-500/20">
            v{healthStatus.claudeVersion}
          </span>
        )}

        {/* 统计信息（有消息时显示） */}
        {hasMessages && (
          <>
            {/* 分隔线 */}
            <div className="w-px h-4 bg-border-subtle" />

            {/* 消息统计 */}
            <div className="flex items-center gap-1.5">
              <MessageSquare className="w-3.5 h-3.5 text-text-muted" />
              <span>
                <span className="text-text-secondary">{stats.userMessages}</span>
                <span className="mx-0.5">/</span>
                <span className="text-primary">{stats.assistantMessages}</span>
                <span className="ml-1 text-text-tertiary">{t('statusBar.conversations')}</span>
              </span>
            </div>

            {/* 工具调用 */}
            {stats.toolCalls > 0 && (
              <div className="flex items-center gap-1.5">
                <Wrench className="w-3.5 h-3.5 text-warning" />
                <span>
                  <span className="text-text-secondary">{stats.toolCalls}</span>
                  <span className="ml-1 text-text-tertiary">{t('statusBar.tools')}</span>
                </span>
              </div>
            )}

            {/* 会话时长 */}
            <div className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-text-muted" />
              <span>{duration}</span>
            </div>
          </>
        )}
      </div>

      {/* 右侧：语音、状态提示和字数 */}
      <div className="flex items-center gap-3">
        {/* 语音识别 */}
        {speechEnabled && speechSupported && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={isListening ? stopSpeech : startSpeech}
              className={clsx(
                'flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors',
                isListening
                  ? 'bg-primary/10 text-primary'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
              )}
              title={isListening ? t('speech.stop', '停止语音识别') : t('speech.start', '开始语音识别')}
            >
              <IconMic size={14} className={isListening ? 'animate-pulse' : ''} />
              {isListening && (
                <span className="max-w-[200px] truncate">
                  {interimTranscript || t('speech.listening', '正在听...')}
                </span>
              )}
            </button>
          </div>
        )}

        {/* TTS 播放控制 */}
        <button
          onClick={handleTTSClick}
          disabled={ttsStatus === 'synthesizing'}
          className={clsx(
            'flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors',
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

        {/* 流式状态指示 */}
        {isStreaming && (
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
            <span className="text-primary">{t('statusBar.responding')}</span>
          </div>
        )}

        {/* 字数 */}
        {inputLength > 0 && (
          <span className="text-text-tertiary">{inputLength}</span>
        )}
      </div>
    </div>
  );
}
