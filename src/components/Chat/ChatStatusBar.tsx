/**
 * 聊天状态栏组件
 *
 * 显示当前对话的状态信息：
 * - 会话配置选择器 (Agent/Model/Effort/Permission)
 * - 引擎健康指示
 * - 语音区：听写麦克风（填输入框） + 语音伙伴「小陈」通话入口 + 听筒(TTS 朗读)
 * - 输入状态提示 / 流式状态 / 输入字数
 */

import { useState, useCallback, useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore, useSessionStore } from '@/stores';
import { useActiveSessionStreaming, useHasPendingQuestion, useHasActivePlan, useActiveSessionMessages } from '@/stores/conversationStore/useActiveSession';
import { useSessionConfig } from '@/stores/sessionConfigStore';
import { Paperclip, MoreHorizontal, Loader2, Mic, AudioLines, Volume2, VolumeX, RefreshCw, ShieldAlert } from 'lucide-react';
import { clsx } from 'clsx';
import { useTTS } from '@/hooks/useTTS';
import { useVoiceDictation } from '@/hooks/useVoiceDictation';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import type { TTSConfig, WakeWordConfig, VoiceCommandConfig, VoiceCommand } from '@/types/speech';
import { DEFAULT_TTS_CONFIG } from '@/types/speech';
import { SessionConfigSelector } from './SessionConfigSelector';
import { getSelectedEngineHealth } from '@/utils/engineHealth';
import { normalizeEngineId } from '@/utils/engineDisplay';
import { useActiveSessionId, useSessionMetadataList } from '@/stores/conversationStore/sessionStoreManager';
import { useVoiceCompanionStore } from '@/stores/voiceCompanionStore';
import { voiceNotificationService } from '@/services/voiceNotificationService';
import { isAssistantMessage } from '@/types/chat';
import { currentMode } from '@/services/transport';
import { useToastStore } from '@/stores/toastStore';

/**
 * 宽度分级阈值（主行可容纳的高频选择器数量）
 */
const BREAKPOINTS = {
  /** 主行可容纳 profile + model + effort，并显示版本号文字 */
  wide: 700,
  /** 主行可容纳 profile + model */
  medium: 500,
  /** 主行仅显示 profile（端点，最高优先级） */
  narrow: 400,
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
 * 四区布局：[会话操作] │ [配置选择器] … [语音区/健康] │ [输入状态]
 * - 配置选择器分层 + 宽度自适应（profile > model > effort，agent/permission 始终折叠）
 * - 语音区常驻右侧（不随宽度折叠，保证可发现性）：听写 / 通话 / 听筒
 * - 引擎版本降级为健康圆点（hover 显示版本号）
 */
export function ChatStatusBar({ children }: ChatStatusBarProps) {
  const { t } = useTranslation('chat');
  const { config, healthStatus, updateConfigPatch } = useConfigStore();
  const isStreaming = useActiveSessionStreaming();
  const activeSessionId = useActiveSessionId();
  const sessionMetadataList = useSessionMetadataList();
  const {
    inputLength,
    attachmentCount,
    suggestionMode,
    appendSpeechTranscript,
    speechCommand,
    setSpeechCommand,
    undoSpeechTranscript,
  } = useSessionStore();

  // 直接从 conversationStore 获取状态（消除 chatInputStore 冗余同步）
  const hasPendingQuestion = useHasPendingQuestion();
  const hasActivePlan = useHasActivePlan();

  // 会话消息（用于命令 "播放"）
  const { messages } = useActiveSessionMessages();

  // 会话配置
  const { config: sessionConfig, setConfig: setSessionConfig } = useSessionConfig();

  // 容器宽度监听
  const { ref: containerRef, width: containerWidth } = useContainerWidth();

  // 根据宽度决定主行显示哪些选择器
  const visibleTypes = getVisibleTypes(containerWidth);
  const hiddenTypes = getHiddenTypes(visibleTypes);
  // 是否在健康圆点旁显示版本号文字（窄屏仅显示圆点）
  const showVersionText = containerWidth >= BREAKPOINTS.wide;

  // 展开/收起
  const [expanded, setExpanded] = useState(false);

  // ===== 语音区 =====
  // 全屏语音伙伴入口
  const openVoiceCompanion = useVoiceCompanionStore((s) => s.open);

  // 唤醒词 + 语音命令配置（统一读全局 config）
  const wakeWordConfig = config?.wakeWord as WakeWordConfig | undefined;
  const voiceCommands = config?.voiceCommands as VoiceCommandConfig | undefined;
  const wakeWordEnabled = wakeWordConfig?.enabled && wakeWordConfig.words.length > 0;

  // 语音听写（填输入框，可编辑后发送）；与全屏伙伴经音频焦点仲裁互斥
  const {
    isDictating,
    interimText,
    wakeActive,
    toggle: toggleDictation,
    isSupported: dictationSupported,
    isSecureContext,
    companionOpen,
  } = useVoiceDictation(appendSpeechTranscript, undefined, {
    voiceCommands,
    wakeWordConfig: wakeWordEnabled ? wakeWordConfig : undefined,
    onCommand: (cmd: VoiceCommand) => {
      setSpeechCommand(cmd);
    },
  });

  // ===== 语音命令处理 =====
  // send/clear 留给 ChatInput 消费（handleSend 已处理 send、clear 清空输入框）
  // interrupt/undo/play 在此处处理
  useEffect(() => {
    const cmd = speechCommand;
    if (!cmd) return;

    switch (cmd) {
      case 'interrupt':
        if (isStreaming) {
          // ChatInput 也会消费 send，这里不处理 send/clear
        }
        break;
      case 'undo':
        undoSpeechTranscript();
        break;
      case 'play': {
        const lastAssistant = [...messages].reverse().find(m => isAssistantMessage(m));
        if (lastAssistant) {
          voiceNotificationService.speakAIResponse(lastAssistant as Parameters<typeof voiceNotificationService.speakAIResponse>[0], { force: true });
        }
        break;
      }
    }

    if (cmd !== 'send' && cmd !== 'clear') {
      setSpeechCommand(null);
    }
  }, [speechCommand, isStreaming, setSpeechCommand, undoSpeechTranscript, messages]);

  // ===== 同步恢复（Web 模式专用）=====
  // 手机锁屏/切后台导致断线后，手动触发：重连 WS → 重拉会话历史 → 续接新内容
  const [syncing, setSyncing] = useState(false);
  const handleSyncRecover = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    const toast = useToastStore.getState();
    try {
      const { manualRefreshActiveSession } = await import('@/services/webReconnectResync');
      const recovered = await manualRefreshActiveSession();
      if (recovered) {
        toast.success(t('statusBar.syncRecoverDone', '已恢复，继续接收新内容'));
      } else {
        toast.info(t('statusBar.syncRecoverNothing', '当前会话无需恢复'));
      }
    } catch (e) {
      toast.error(t('statusBar.syncRecoverFailed', '同步恢复失败'), String(e));
    } finally {
      setSyncing(false);
    }
  }, [syncing, t]);

  // 听筒（TTS 朗读控制）
  const ttsConfig = config?.tts as TTSConfig | undefined;
  const ttsEnabled = ttsConfig?.enabled ?? false;
  const { status: ttsStatus, stop: stopTTS } = useTTS();
  const setTTSEnabled = useCallback(
    (enabled: boolean) => {
      updateConfigPatch({ tts: { ...(ttsConfig || DEFAULT_TTS_CONFIG), enabled } });
    },
    [ttsConfig, updateConfigPatch],
  );
  const handleTTSClick = useCallback(() => {
    if (!config) return;
    if (ttsStatus === 'playing') {
      stopTTS();
    } else if (ttsStatus === 'paused') {
      stopTTS();
      setTTSEnabled(false);
    } else if (ttsStatus === 'idle' || ttsStatus === 'error') {
      // 任意空闲状态点击即开关：修复「开启后空闲时关不掉」
      setTTSEnabled(!ttsEnabled);
    }
  }, [ttsStatus, stopTTS, ttsEnabled, config, setTTSEnabled]);

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

  // 引擎健康指示：绿点=可用，灰点=不可用；版本号收入 tooltip
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

  // 是否有内容被折叠（需要「更多」按钮）：低频选择器（agent/permission）始终折叠
  const hasOverflow = hiddenTypes.length > 0;

  // 语音区是否内联在主行（窄屏折叠进「更多」面板，保证 260px 不溢出）
  const voiceInline = containerWidth >= BREAKPOINTS.medium;

  /**
   * 语音分段控件：听写(Mic) / 通话(AudioLines) / 朗读(Volume2)
   * 图标差异化 + 激活态自说明；panel 变体带文字标签（窄屏折叠面板用）
   */
  const renderVoiceSegment = (variant: 'inline' | 'panel') => {
    const withLabel = variant === 'panel';
    const btnBase = 'flex items-center gap-1 px-1.5 py-0.5 rounded-full transition-colors shrink-0 disabled:opacity-40';

    return (
      <div
        className={clsx(
          'flex items-center gap-0.5 p-0.5 rounded-full border border-border-subtle bg-background-surface/60 shrink-0',
          withLabel && 'self-start',
        )}
      >
        {/* 听写：识别填入输入框 */}
        {dictationSupported && (
          <button
            onClick={toggleDictation}
            disabled={companionOpen}
            className={clsx(
              btnBase,
              isDictating && wakeWordEnabled && wakeActive
                ? 'bg-green-500/10 text-green-500'
                : isDictating
                  ? 'bg-primary/10 text-primary'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover',
            )}
            title={
              companionOpen
                ? t('voiceCompanion.busy', '语音通话占用麦克风中')
                : isDictating
                  ? (wakeWordEnabled ? (wakeActive ? t('speech.awake', '已唤醒...') : t('speech.waitingWake', '等待唤醒...')) : t('speech.stop', '停止听写'))
                  : t('speech.dictate', '语音听写：识别结果填入输入框')
            }
          >
            <Mic size={13} className={isDictating ? 'animate-pulse' : ''} />
            {(withLabel || isDictating) && (
              <span>{isDictating ? (wakeWordEnabled ? (wakeActive ? t('speech.awakeShort', '已唤醒') : t('speech.waitingWake', '等待唤醒')) : t('speech.dictating', '听写中')) : t('speech.dictateLabel', '听写')}</span>
            )}
          </button>
        )}

        {/* 通话：全屏语音伙伴（声波图标，与听写区分） */}
        <button
          onClick={openVoiceCompanion}
          className={clsx(btnBase, 'text-primary hover:bg-primary/10')}
          title={t('voiceCompanion.entry', '和小陈语音通话')}
        >
          <AudioLines size={13} />
          {(withLabel || containerWidth >= BREAKPOINTS.wide) && (
            <span>{t('voiceCompanion.entryLabel', '小陈')}</span>
          )}
        </button>

        {/* 朗读：TTS 控制（任意状态可关） */}
        <button
          onClick={handleTTSClick}
          disabled={ttsStatus === 'synthesizing'}
          className={clsx(
            btnBase,
            ttsStatus === 'playing' && 'bg-primary/10 text-primary',
            ttsStatus === 'paused' && 'text-text-secondary hover:text-text-primary hover:bg-background-hover',
            ttsStatus === 'synthesizing' && 'text-warning cursor-wait',
            (ttsStatus === 'idle' || ttsStatus === 'error') && (ttsEnabled
              ? 'text-primary/70 hover:text-primary hover:bg-primary/10'
              : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
            ),
          )}
          title={
            ttsStatus === 'playing' ? t('tts.stop', '停止播放') :
            ttsStatus === 'paused' ? t('tts.disable', '关闭语音播放') :
            ttsStatus === 'synthesizing' ? t('tts.synthesizing', '合成中...') :
            ttsEnabled ? t('tts.disable', '关闭语音播放') : t('tts.enable', '开启语音播放')
          }
        >
          {ttsStatus === 'synthesizing' && <Loader2 size={13} className="animate-spin" />}
          {(ttsStatus === 'playing' || ttsStatus === 'paused') && (
            <Volume2 size={13} className={ttsStatus === 'playing' ? 'animate-pulse' : ''} />
          )}
          {(ttsStatus === 'idle' || ttsStatus === 'error') && (
            ttsEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />
          )}
          {withLabel && (
            <span>
              {ttsStatus === 'playing' ? t('tts.playing', '朗读中')
                : ttsEnabled ? t('tts.enabled', '朗读开') : t('tts.label', '朗读')}
            </span>
          )}
        </button>

        {/* 非安全上下文警告：语音功能受限 */}
        {!isSecureContext && (
          <span
            className="text-warning/70 hover:text-warning cursor-help"
            title={t('speech.insecureContext', '当前为 HTTP 环境，语音识别和语音合成受限。需要 HTTPS 或 localhost 才能完整使用语音功能。')}
          >
            <ShieldAlert size={12} />
          </span>
        )}
      </div>
    );
  };

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
      {/* 主行：[会话操作] │ [配置选择器] … [语音区/健康] │ [输入状态] */}
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
          {/* 更多按钮：展开低频配置（agent/permission） */}
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

        {/* 右侧：语音区(听写/通话/朗读) │ 健康 │ 输入状态 */}
        <div className="flex items-center gap-2 shrink-0 min-w-0">
          {/* 听写实时预览（ghost text） */}
          {isDictating && interimText && (
            <span className="italic text-text-muted truncate max-w-[160px]" title={interimText}>
              {interimText}
            </span>
          )}

          {voiceInline && renderVoiceSegment('inline')}
          {/* 同步恢复（仅 Web 模式）：断线/锁屏后手动补回丢失内容并续接 */}
          {currentMode === 'http' && (
            <button
              onClick={handleSyncRecover}
              disabled={syncing}
              className={clsx(
                'flex items-center px-1.5 py-0.5 rounded-full transition-colors shrink-0',
                syncing
                  ? 'text-primary cursor-wait'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover',
              )}
              title={t('statusBar.syncRecover', '同步恢复：重连并补回断线丢失的内容')}
            >
              <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            </button>
          )}
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

      {/* 折叠面板：低频选择器（agent/permission） + 窄屏折叠的语音区 */}
      {hasOverflow && (
        <div className={clsx(
          'transition-opacity duration-200',
          expanded ? 'opacity-100 overflow-visible' : 'opacity-0 overflow-hidden',
        )}>
          <div className="flex flex-col gap-2 py-2 border-t border-border-subtle/50">
            {!voiceInline && renderVoiceSegment('panel')}
            <SessionConfigSelector
              config={sessionConfig}
              onChange={setSessionConfig}
              disabled={isStreaming}
              visibleTypes={hiddenTypes}
              variant="panel"
            />
          </div>
        </div>
      )}
    </div>
  );
}
