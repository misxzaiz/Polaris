/**
 * useVoiceCompanion - 语音伙伴核心编排 Hook（v2：连续 + 唤醒 + 命令 + 软全双工）
 *
 * 状态机：idle → standby(待命,只听"小白") → listening(激活,连续识别) → thinking → speaking(朗读)
 *
 * 软全双工防回声（解决"小白把自己的话录成输入"）：
 *   - 全程开麦（continuous），不暂停识别 → 因此 speaking 时也能听到用户喊"小白"打断；
 *   - speaking 时对识别结果做「回声指纹过滤」：若识别文本是当前正在朗读文本的子串 → 判回声丢弃；
 *   - speaking 时只有唤醒词「小白」能穿透 → 打断朗读、进入聆听；
 *   - 人格 prompt 额外要求"绝不自称小白"，杜绝朗读到自身名字时自我打断。
 *
 * 命令（listening 阶段，复用 checkVoiceCommand）：发送/清空/中断/朗读。
 * 唤醒（standby/speaking，复用 matchWakeWord）：喊"小白"激活或打断。
 */

import { useEffect, useRef, useCallback } from 'react';
import { useVoiceCompanionStore } from '@/stores/voiceCompanionStore';
import { speechService } from '@/services/speechService';
import { voiceTts } from '@/services/voiceCompanion/streamingTts';
import { buildCompanionSystemPrompt } from '@/services/voiceCompanion/companionPrompt';
import { extractSpeakableText, shouldSpeakText } from '@/services/ttsTextFilter';
import { checkVoiceCommand, matchWakeWord, type VoiceCommand } from '@/types/speech';
import {
  useActiveSessionActions,
  useActiveSessionStreaming,
  useActiveSessionMessages,
} from '@/stores/conversationStore/useActiveSession';
import { isAssistantMessage, type AssistantChatMessage } from '@/types/chat';
import { createLogger } from '@/utils/logger';

const log = createLogger('useVoiceCompanion');

/** 去标点/空白，用于回声指纹与命令匹配 */
function normalize(s: string): string {
  return s.replace(/[。！？，、,.!?；;\s]/g, '');
}

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
  const injectedModeRef = useRef<string | null>(null); // 人格注入过的模式
  const awaitingReplyRef = useRef(false); // 是否等待语音发起的回复
  const prevStreamingRef = useRef(false); // 检测 isStreaming 边沿
  const speakingTextRef = useRef(''); // 当前朗读文本（回声指纹）
  const bufferRef = useRef(''); // 累积输入缓冲
  const standbyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ===== 激活后静默 → 回待命 =====
  const resetStandbyTimer = useCallback(() => {
    if (standbyTimerRef.current) clearTimeout(standbyTimerRef.current);
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
    if (standbyTimerRef.current) clearTimeout(standbyTimerRef.current);
    const st = useVoiceCompanionStore.getState();
    st.setPhase('standby');
    st.setTranscript('');
    bufferRef.current = '';
  }, []);

  // ===== 发送一段文本（注入人格） =====
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
      if (standbyTimerRef.current) clearTimeout(standbyTimerRef.current);

      let prompt = clean;
      if (injectedModeRef.current !== cfg.mode) {
        prompt = `${buildCompanionSystemPrompt(cfg.mode)}\n\n（以上是你的角色设定，现在开始用语音和我对话）\n${clean}`;
        injectedModeRef.current = cfg.mode;
      }
      log.info('语音发送', { text: clean });
      void sendMessage(prompt);
    },
    [sendMessage],
  );

  // ===== 中断 AI（思考/朗读中） =====
  const interruptAI = useCallback(() => {
    voiceTts.stop();
    speakingTextRef.current = '';
    awaitingReplyRef.current = false;
    void interrupt();
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

  // ===== 识别结果分流（按阶段） =====
  const handleResult = useCallback(
    (text: string, isFinal: boolean) => {
      const st = useVoiceCompanionStore.getState();
      const { phase: cur, config: cfg } = st;

      if (!isFinal) {
        // 仅激活聆听时显示实时字幕
        if (cur === 'listening') st.setTranscript(bufferRef.current + text);
        return;
      }

      const finalText = text.trim();
      if (!finalText) return;

      // —— speaking：回声过滤 + 仅"小白"穿透打断 ——
      if (cur === 'speaking') {
        const norm = normalize(finalText);
        const spk = normalize(speakingTextRef.current);
        if (norm && spk && spk.includes(norm)) return; // 回声，丢弃
        const wake = matchWakeWord(finalText, cfg.wakeWord.words);
        if (wake) {
          voiceTts.stop();
          speakingTextRef.current = '';
          activate();
          if (wake.content) sendText(wake.content);
        }
        return; // 非回声非唤醒一律丢弃
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
          sendText(finalText);
          return;
        }
        const wake = matchWakeWord(finalText, cfg.wakeWord.words);
        if (wake) {
          activate();
          if (wake.content) sendText(wake.content);
        }
        return;
      }

      // —— listening（激活）：命令优先，否则累积/自动发送 ——
      resetStandbyTimer();
      const cmd = checkVoiceCommand(finalText, cfg.voiceCommands);
      if (cmd) {
        executeCommand(cmd);
        return;
      }
      bufferRef.current = bufferRef.current ? `${bufferRef.current} ${finalText}` : finalText;
      st.setTranscript(bufferRef.current);
      if (cfg.autoSend) sendText(bufferRef.current);
    },
    [activate, resetStandbyTimer, sendText, executeCommand, interruptAI],
  );

  // ===== 注册回调 + 启动（界面打开时） =====
  useEffect(() => {
    if (!isOpen) return;

    const st = useVoiceCompanionStore.getState();
    speechService.setConfig({
      enabled: true,
      language: st.config.language,
      continuous: true, // 全程连续聆听
      interimResults: true,
    });

    speechService.setCallbacks({
      onResult: (text, isFinal) => handleResult(text, isFinal),
      onError: (err) => {
        if (err.type === 'no-speech' || err.type === 'aborted') {
          log.debug('语音识别可恢复错误', { type: err.type });
          return;
        }
        useVoiceCompanionStore.getState().setError(err.message || '语音识别出错');
      },
    });

    voiceTts.onStart = () => useVoiceCompanionStore.getState().setPhase('speaking');
    voiceTts.onDone = () => {
      speakingTextRef.current = '';
      // 朗读结束回到激活聆听（仍在对话中，无需再喊"小白"）
      const cur = useVoiceCompanionStore.getState().phase;
      if (cur === 'speaking') activate();
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
      if (standbyTimerRef.current) clearTimeout(standbyTimerRef.current);
      speechService.stop();
      voiceTts.stop();
      voiceTts.onStart = undefined;
      voiceTts.onDone = undefined;
      speakingTextRef.current = '';
      bufferRef.current = '';
      awaitingReplyRef.current = false;
    };
  }, [isOpen, config.language, handleResult, activate, resetStandbyTimer]);

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
        voiceTts.stop();
        speakingTextRef.current = '';
        activate();
        break;
      default:
        activate();
    }
  }, [activate, toStandby, sendText, interruptAI]);

  // ===== 静音（暂停麦克风） =====
  const toggleMute = useCallback(() => {
    const st = useVoiceCompanionStore.getState();
    const next = !st.muted;
    st.setMuted(next);
    if (next) {
      if (standbyTimerRef.current) clearTimeout(standbyTimerRef.current);
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
    if (standbyTimerRef.current) clearTimeout(standbyTimerRef.current);
    speechService.stop();
    voiceTts.stop();
    speakingTextRef.current = '';
    bufferRef.current = '';
    awaitingReplyRef.current = false;
    injectedModeRef.current = null;
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
    toggleMute,
    hangup,
  };
}
