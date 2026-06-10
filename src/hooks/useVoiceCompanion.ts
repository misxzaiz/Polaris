/**
 * useVoiceCompanion - 语音伙伴核心编排 Hook（v3：半双工回声治理 + 焦点仲裁 + 隐形人格）
 *
 * 状态机：idle → standby(待命,只听"小白") → listening(激活,连续识别) → thinking
 *       → speaking(朗读) → cooldown(回声冷却) → listening
 *
 * 回声治理（解决"小白把自己的话录成输入"）：
 *   - 默认半双工：speaking 时 speechService.pause() 暂停识别 → 最大回声窗口被物理隔离；
 *     打断方式为点击光球/主按钮/空格键（由 UI 层调用 interruptSpeaking）。
 *   - TTS 结束 → resume() 恢复识别并进入 cooldown（默认 800ms）：识别器恢复期间
 *     扬声器尾音可能成为识别结果，cooldown 内的 final 结果先过 isLikelyEcho
 *     （bigram 相似度，比子串包含更耐 ASR 同音错字）→ 回声丢弃；
 *     非回声 = 用户真在说话 → 提前结束冷却并按正常聆听处理（不吞首句）。
 *   - 实验性全双工（config.fullDuplex）：speaking 保持识别，isLikelyEcho 过滤
 *     + 唤醒词「小白」穿透打断（外放场景有回声风险，设置中明示）。
 *
 * 人格注入：每次发送经 sendMessage 的 oneTimeSystemPrompt 通道（appendSystemPrompt），
 * 不再拼接进用户消息 → 消息流中不可见，切会话/切模式天然生效。
 *
 * 音频焦点：打开通话即持有 'companion' 焦点（最高优先级），听写/语音通知让位。
 */

import { useEffect, useRef, useCallback } from 'react';
import { useVoiceCompanionStore } from '@/stores/voiceCompanionStore';
import { speechService } from '@/services/speechService';
import { voiceTts } from '@/services/voiceCompanion/streamingTts';
import { audioFocusManager } from '@/services/audioFocusManager';
import { buildCompanionSystemPrompt } from '@/services/voiceCompanion/companionPrompt';
import { extractSpeakableText, shouldSpeakText } from '@/services/ttsTextFilter';
import { checkVoiceCommand, matchWakeWord, isLikelyEcho, type VoiceCommand } from '@/types/speech';
import {
  useActiveSessionActions,
  useActiveSessionStreaming,
  useActiveSessionMessages,
} from '@/stores/conversationStore/useActiveSession';
import { isAssistantMessage, type AssistantChatMessage } from '@/types/chat';
import { createLogger } from '@/utils/logger';

const log = createLogger('useVoiceCompanion');

/** 冷却结束后，回声指纹再保留的兜底窗口（毫秒） */
const ECHO_GUARD_AFTER_COOLDOWN_MS = 1200;

export function useVoiceCompanion() {
  // —— 渲染态 ——
  const isOpen = useVoiceCompanionStore((s) => s.isOpen);
  const phase = useVoiceCompanionStore((s) => s.phase);
  const transcript = useVoiceCompanionStore((s) => s.transcript);
  const lastUserText = useVoiceCompanionStore((s) => s.lastUserText);
  const lastReply = useVoiceCompanionStore((s) => s.lastReply);
  const muted = useVoiceCompanionStore((s) => s.muted);
  const errorMessage = useVoiceCompanionStore((s) => s.errorMessage);
  const config = useVoiceCompanionStore((s) => s.config);

  // —— 主对话管道 ——
  const { sendMessage, interrupt } = useActiveSessionActions();
  const isStreaming = useActiveSessionStreaming();
  const { messages } = useActiveSessionMessages();

  const isSupported = speechService.supported;

  // —— refs（避免闭包陈旧） ——
  const awaitingReplyRef = useRef(false); // 是否等待语音发起的回复
  const prevStreamingRef = useRef(false); // 检测 isStreaming 边沿
  const speakingTextRef = useRef(''); // 当前朗读文本（回声指纹）
  const bufferRef = useRef(''); // 累积输入缓冲
  const standbyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 停顿合并发送
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 回声冷却
  const echoGuardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 冷却后指纹保留
  const handleResultRef = useRef<(text: string, isFinal: boolean) => void>(() => {}); // 稳定回调引用

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) {
      clearTimeout(ref.current);
      ref.current = null;
    }
  };

  // ===== 激活后静默 → 回待命 =====
  const resetStandbyTimer = useCallback(() => {
    clearTimer(standbyTimerRef);
    const { config: cfg } = useVoiceCompanionStore.getState();
    if (cfg.standbyTimeout > 0 && cfg.wakeWord.enabled) {
      standbyTimerRef.current = setTimeout(() => {
        const st = useVoiceCompanionStore.getState();
        if (st.phase === 'listening') {
          st.setPhase('standby');
          st.setTranscript('');
          bufferRef.current = '';
        }
      }, cfg.standbyTimeout);
    }
  }, []);

  // ===== 进入激活聆听 =====
  const activate = useCallback(() => {
    const st = useVoiceCompanionStore.getState();
    st.setError(null);
    st.setPhase('listening');
    bufferRef.current = '';
    resetStandbyTimer();
  }, [resetStandbyTimer]);

  // ===== 回到待命 =====
  const toStandby = useCallback(() => {
    clearTimer(standbyTimerRef);
    const st = useVoiceCompanionStore.getState();
    st.setPhase('standby');
    st.setTranscript('');
    bufferRef.current = '';
  }, []);

  // ===== 发送一段文本（人格经 oneTimeSystemPrompt 隐形注入） =====
  const sendText = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      const st = useVoiceCompanionStore.getState();
      const { config: cfg } = st;
      st.setTranscript('');
      st.setLastUserText(clean);
      st.setPhase('thinking');
      bufferRef.current = '';
      awaitingReplyRef.current = true;
      clearTimer(standbyTimerRef);
      clearTimer(autoSendTimerRef);

      log.info('语音发送', { text: clean, mode: cfg.mode });
      void sendMessage(clean, undefined, undefined, {
        oneTimeSystemPrompt: buildCompanionSystemPrompt(cfg.mode),
      });
    },
    [sendMessage],
  );

  // ===== 结束朗读后的善后：恢复识别 + 冷却 =====
  const enterCooldown = useCallback(() => {
    const st = useVoiceCompanionStore.getState();
    const { config: cfg } = st;
    // 恢复识别（半双工时 speaking 期间被 pause）
    if (!cfg.fullDuplex && !st.muted) {
      speechService.resume();
    }
    st.setPhase('cooldown');
    clearTimer(cooldownTimerRef);
    cooldownTimerRef.current = setTimeout(() => {
      cooldownTimerRef.current = null;
      const cur = useVoiceCompanionStore.getState();
      if (cur.phase === 'cooldown') {
        cur.setPhase('listening');
        resetStandbyTimer();
      }
      // 指纹再保留一小段时间兜底迟到的回声，之后清除
      clearTimer(echoGuardTimerRef);
      echoGuardTimerRef.current = setTimeout(() => {
        echoGuardTimerRef.current = null;
        speakingTextRef.current = '';
      }, ECHO_GUARD_AFTER_COOLDOWN_MS);
    }, Math.max(0, cfg.echoCooldownMs));
  }, [resetStandbyTimer]);

  // ===== 打断朗读（点击光球/主按钮/空格） =====
  const interruptSpeaking = useCallback(() => {
    const st = useVoiceCompanionStore.getState();
    voiceTts.stop();
    speakingTextRef.current = '';
    clearTimer(cooldownTimerRef);
    clearTimer(echoGuardTimerRef);
    if (!st.config.fullDuplex && !st.muted) {
      speechService.resume();
    }
    activate();
  }, [activate]);

  // ===== 中断 AI（思考/朗读中） =====
  const interruptAI = useCallback(() => {
    const st = useVoiceCompanionStore.getState();
    voiceTts.stop();
    speakingTextRef.current = '';
    awaitingReplyRef.current = false;
    clearTimer(cooldownTimerRef);
    clearTimer(echoGuardTimerRef);
    void interrupt();
    if (!st.config.fullDuplex && !st.muted && st.phase === 'speaking') {
      speechService.resume();
    }
    activate();
  }, [interrupt, activate]);

  // ===== 执行语音命令 =====
  const executeCommand = useCallback(
    (cmd: VoiceCommand) => {
      const st = useVoiceCompanionStore.getState();
      switch (cmd) {
        case 'send':
          if (bufferRef.current.trim()) sendText(bufferRef.current);
          break;
        case 'clear':
        case 'undo':
          bufferRef.current = '';
          st.setTranscript('');
          break;
        case 'interrupt':
          interruptAI();
          break;
        case 'play':
          if (st.lastReply) {
            speakingTextRef.current = st.lastReply;
            void voiceTts.speak(st.lastReply, { voice: st.config.voice, rate: st.config.rate });
          }
          break;
      }
    },
    [sendText, interruptAI],
  );

  // ===== 停顿合并发送：累积期间反复重置定时器，静默达阈值才整段发出 =====
  const scheduleAutoSend = useCallback(() => {
    clearTimer(autoSendTimerRef);
    const { config: cfg } = useVoiceCompanionStore.getState();
    autoSendTimerRef.current = setTimeout(() => {
      if (bufferRef.current.trim()) sendText(bufferRef.current);
    }, Math.max(300, cfg.autoSendDelay));
  }, [sendText]);

  // ===== listening 阶段的最终结果处理（命令优先，否则累积合并） =====
  const handleListeningFinal = useCallback(
    (finalText: string) => {
      const st = useVoiceCompanionStore.getState();
      const { config: cfg } = st;
      resetStandbyTimer();
      const cmd = checkVoiceCommand(finalText, cfg.voiceCommands);
      if (cmd) {
        clearTimer(autoSendTimerRef);
        executeCommand(cmd);
        return;
      }
      bufferRef.current = bufferRef.current ? `${bufferRef.current} ${finalText}` : finalText;
      st.setTranscript(bufferRef.current);
      if (cfg.autoSend) scheduleAutoSend(); // 不立即发，攒一会儿合并
    },
    [resetStandbyTimer, executeCommand, scheduleAutoSend],
  );

  // ===== 识别结果分流（按阶段） =====
  const handleResult = useCallback(
    (text: string, isFinal: boolean) => {
      const st = useVoiceCompanionStore.getState();
      const { phase: cur, config: cfg } = st;

      // 实时字幕：聆听/待命显示；冷却期不上屏（可能是回声尾巴）
      if (!isFinal) {
        if (cur === 'listening' || cur === 'standby') {
          const sep = bufferRef.current ? ' ' : '';
          st.setTranscript(bufferRef.current + sep + text);
          // 还在说话 → 推迟自动发送
          if (cur === 'listening') clearTimer(autoSendTimerRef);
        }
        return;
      }

      const finalText = text.trim();
      if (!finalText) return;

      // —— speaking（仅全双工会收到结果）：回声过滤 + 仅唤醒词穿透 ——
      if (cur === 'speaking') {
        if (speakingTextRef.current && isLikelyEcho(finalText, speakingTextRef.current)) {
          log.debug('speaking 回声丢弃', { text: finalText });
          return;
        }
        const wake = matchWakeWord(finalText, cfg.wakeWord.words);
        if (wake) {
          voiceTts.stop();
          speakingTextRef.current = '';
          activate();
          if (wake.content) {
            bufferRef.current = wake.content;
            st.setTranscript(wake.content);
            if (cfg.autoSend) scheduleAutoSend();
          }
        }
        return; // 非回声非唤醒一律丢弃
      }

      // —— cooldown：回声丢弃；真人声提前结束冷却并按聆听处理 ——
      if (cur === 'cooldown') {
        if (speakingTextRef.current && isLikelyEcho(finalText, speakingTextRef.current)) {
          log.debug('cooldown 回声丢弃', { text: finalText });
          return;
        }
        clearTimer(cooldownTimerRef);
        speakingTextRef.current = '';
        st.setPhase('listening');
        handleListeningFinal(finalText);
        return;
      }

      // —— thinking：监听打断 ——
      if (cur === 'thinking') {
        const wake = matchWakeWord(finalText, cfg.wakeWord.words);
        const cmd = checkVoiceCommand(finalText, cfg.voiceCommands);
        if (wake || cmd === 'interrupt') interruptAI();
        return;
      }

      // —— standby：只认唤醒词 ——
      if (cur === 'standby') {
        if (!cfg.wakeWord.enabled) {
          activate();
          bufferRef.current = finalText;
          st.setTranscript(finalText);
          if (cfg.autoSend) scheduleAutoSend();
          return;
        }
        const wake = matchWakeWord(finalText, cfg.wakeWord.words);
        if (wake) {
          activate();
          if (wake.content) {
            bufferRef.current = wake.content;
            st.setTranscript(wake.content);
            if (cfg.autoSend) scheduleAutoSend();
          } else {
            st.setTranscript('');
          }
        }
        return;
      }

      // —— listening（激活） ——
      if (cur === 'listening') {
        // 冷却后的兜底窗口内仍过滤迟到回声
        if (speakingTextRef.current && isLikelyEcho(finalText, speakingTextRef.current)) {
          log.debug('listening 迟到回声丢弃', { text: finalText });
          return;
        }
        handleListeningFinal(finalText);
      }
    },
    [activate, scheduleAutoSend, handleListeningFinal, interruptAI],
  );

  // 固定回调引用，避免 setup effect 因 handleResult 变化反复重注册
  useEffect(() => {
    handleResultRef.current = handleResult;
  }, [handleResult]);

  // ===== 注册回调 + 启动（界面打开时） =====
  useEffect(() => {
    if (!isOpen) return;

    // 持有音频焦点：听写/语音通知让位（companion 优先级最高，必成功）
    audioFocusManager.request('companion');

    const st = useVoiceCompanionStore.getState();
    speechService.setConfig({
      enabled: true,
      language: st.config.language,
      continuous: true,
      interimResults: true,
    });

    speechService.setCallbacks({
      onResult: (text, isFinal) => handleResultRef.current(text, isFinal),
      onError: (err) => {
        if (err.type === 'no-speech' || err.type === 'aborted') {
          log.debug('语音识别可恢复错误', { type: err.type });
          return;
        }
        useVoiceCompanionStore.getState().setError(err.message || '语音识别出错');
      },
    });

    voiceTts.onStart = () => {
      const cur = useVoiceCompanionStore.getState();
      cur.setPhase('speaking');
      // 半双工：朗读期间物理暂停识别，回声无从进入
      if (!cur.config.fullDuplex) {
        speechService.pause();
      }
    };
    voiceTts.onDone = () => {
      const cur = useVoiceCompanionStore.getState();
      if (cur.phase !== 'speaking') return;
      if (cur.config.fullDuplex) {
        // 全双工：指纹再兜底一段时间后清除
        clearTimer(echoGuardTimerRef);
        echoGuardTimerRef.current = setTimeout(() => {
          echoGuardTimerRef.current = null;
          speakingTextRef.current = '';
        }, ECHO_GUARD_AFTER_COOLDOWN_MS);
        activate();
      } else {
        enterCooldown();
      }
    };

    // 启动：默认进入待命（喊"小白"激活）；未开唤醒词则直接聆听
    if (st.config.wakeWord.enabled) {
      st.setPhase('standby');
    } else {
      st.setPhase('listening');
      resetStandbyTimer();
    }
    try {
      speechService.start();
    } catch (e) {
      log.error('启动语音识别失败', e instanceof Error ? e : new Error(String(e)));
      st.setError('启动麦克风失败');
    }

    return () => {
      clearTimer(standbyTimerRef);
      clearTimer(autoSendTimerRef);
      clearTimer(cooldownTimerRef);
      clearTimer(echoGuardTimerRef);
      speechService.stop();
      voiceTts.stop();
      voiceTts.onStart = undefined;
      voiceTts.onDone = undefined;
      speakingTextRef.current = '';
      bufferRef.current = '';
      awaitingReplyRef.current = false;
      audioFocusManager.release('companion');
    };
  }, [isOpen, config.language, activate, resetStandbyTimer, enterCooldown]);

  // ===== AI 回复完成 → 朗读 =====
  useEffect(() => {
    if (!isOpen) {
      prevStreamingRef.current = isStreaming;
      return;
    }
    if (prevStreamingRef.current && !isStreaming && awaitingReplyRef.current) {
      awaitingReplyRef.current = false;
      const lastAssistant = [...messages].reverse().find((m) => isAssistantMessage(m));
      const st = useVoiceCompanionStore.getState();
      if (lastAssistant) {
        const replyText = extractSpeakableText(lastAssistant as AssistantChatMessage);
        if (shouldSpeakText(replyText)) {
          st.setLastReply(replyText);
          speakingTextRef.current = replyText; // 回声指纹
          void voiceTts.speak(replyText, { voice: st.config.voice, rate: st.config.rate });
          prevStreamingRef.current = isStreaming;
          return;
        }
      }
      // 无可朗读内容 → 回到聆听
      if (st.phase === 'thinking') {
        st.setPhase('listening');
        resetStandbyTimer();
      }
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, messages, isOpen, resetStandbyTimer]);

  // ===== 主操作按钮：随阶段 =====
  const handleMainAction = useCallback(() => {
    const cur = useVoiceCompanionStore.getState().phase;
    switch (cur) {
      case 'standby':
        activate();
        break;
      case 'listening':
        if (bufferRef.current.trim()) sendText(bufferRef.current);
        else toStandby();
        break;
      case 'thinking':
        interruptAI();
        break;
      case 'speaking':
      case 'cooldown':
        interruptSpeaking();
        break;
      case 'error':
        try {
          speechService.start();
          activate();
        } catch {
          /* 保持 error 态 */
        }
        break;
      default:
        activate();
    }
  }, [activate, toStandby, sendText, interruptAI, interruptSpeaking]);

  // ===== 光球点击：speaking/thinking=打断，standby=唤醒 =====
  const handleOrbClick = useCallback(() => {
    const cur = useVoiceCompanionStore.getState().phase;
    if (cur === 'speaking' || cur === 'cooldown') interruptSpeaking();
    else if (cur === 'thinking') interruptAI();
    else if (cur === 'standby' || cur === 'idle' || cur === 'error') handleMainAction();
  }, [interruptSpeaking, interruptAI, handleMainAction]);

  // ===== 静音（暂停麦克风） =====
  const toggleMute = useCallback(() => {
    const st = useVoiceCompanionStore.getState();
    const next = !st.muted;
    st.setMuted(next);
    if (next) {
      clearTimer(standbyTimerRef);
      clearTimer(autoSendTimerRef);
      speechService.stop();
      st.setPhase('idle');
    } else {
      st.setPhase(st.config.wakeWord.enabled ? 'standby' : 'listening');
      try {
        speechService.start();
      } catch {
        /* ignore */
      }
    }
  }, []);

  // ===== 挂断 =====
  const hangup = useCallback(() => {
    clearTimer(standbyTimerRef);
    clearTimer(autoSendTimerRef);
    clearTimer(cooldownTimerRef);
    clearTimer(echoGuardTimerRef);
    speechService.stop();
    voiceTts.stop();
    speakingTextRef.current = '';
    bufferRef.current = '';
    awaitingReplyRef.current = false;
    const st = useVoiceCompanionStore.getState();
    st.reset();
    st.close();
  }, []);

  return {
    isOpen,
    phase,
    transcript,
    lastUserText,
    lastReply,
    muted,
    errorMessage,
    config,
    isSupported,
    handleMainAction,
    handleOrbClick,
    interruptSpeaking,
    toggleMute,
    hangup,
  };
}
