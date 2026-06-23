/**
 * useVoiceDictation - 输入框语音听写（非全屏轻量模式）
 *
 * 点击麦克风 → 连续识别 → 每段最终结果通过 onText 回调追加到输入框（可编辑后手动发送），
 * 识别中的临时结果经 onInterim 实时预览（状态栏 ghost text）。
 *
 * 与全屏语音伙伴/语音通知共用 speechService 单例，经 audioFocusManager 仲裁：
 *   - 启动前申请 'dictation' 焦点，被 'companion'（更高优先级）持有时申请失败不启动；
 *   - 通话开启会抢占焦点 → 本 hook 经订阅感知并复位 UI（无需亲自 stop，麦克风已被接管）；
 *   - 卸载时仅在自己仍持有焦点时才停止识别，避免误杀通话麦克风。
 *
 * 唤醒词 + 命令管线：
 *   - final 结果先过 checkVoiceCommand 检测命令（命中则 onCommand 回调，不进输入框）；
 *   - 未命中命令且 wakeWord 启用 → 用 speechWakeActive 门控：
 *     待命 → matchWakeWord 命中 → setWakeActive(true) + 唤醒回应播报 + 唤醒词后内容写入；
 *     不命中 → 丢弃。
 *   - 发送后 handleSend 中 setSpeechWakeActive(false) 回待命（需重新唤醒）。
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { speechService } from '@/services/speechService';
import { audioFocusManager } from '@/services/audioFocusManager';
import { useVoiceCompanionStore } from '@/stores/voiceCompanionStore';
import { useSessionStore } from '@/stores';
import { voiceNotificationService } from '@/services/voiceNotificationService';
import type { SpeechControl } from '@/services/voiceNotificationService';
import type { SpeechLanguage, VoiceCommand, VoiceCommandConfig, WakeWordConfig } from '@/types/speech';
import { checkVoiceCommand, matchWakeWord } from '@/types/speech';
import { createLogger } from '@/utils/logger';

const log = createLogger('useVoiceDictation');

export interface UseVoiceDictationOptions {
  /** 识别语言 */
  language?: SpeechLanguage;
  /** 语音命令配置（用户自定义 + 默认合并） */
  voiceCommands?: VoiceCommandConfig;
  /** 唤醒词配置（启用时生效） */
  wakeWordConfig?: WakeWordConfig;
  /** 语音命令回调 */
  onCommand?: (command: VoiceCommand) => void;
}

export interface UseVoiceDictationReturn {
  /** 是否正在听写 */
  isDictating: boolean;
  /** 识别中的临时文本（实时预览，final 后清空） */
  interimText: string;
  /** 是否支持语音识别 */
  isSupported: boolean;
  /** 是否为安全上下文（HTTPS 或 localhost），非安全上下文下语音功能受限 */
  isSecureContext: boolean;
  /** 全屏语音伙伴是否打开（打开时听写不可用，互斥） */
  companionOpen: boolean;
  /** 当前是否已唤醒（唤醒词模式下有用） */
  wakeActive: boolean;
  /** 切换听写 */
  toggle: () => void;
  /** 停止听写 */
  stop: () => void;
}

export function useVoiceDictation(
  onText: (text: string) => void,
  language: SpeechLanguage = 'zh-CN',
  options: UseVoiceDictationOptions = {},
): UseVoiceDictationReturn {
  const {
    language: optLanguage = language,
    voiceCommands,
    wakeWordConfig,
    onCommand,
  } = options;

  const [isDictating, setIsDictating] = useState(false);
  const [interimText, setInterimText] = useState('');
  const companionOpen = useVoiceCompanionStore((s) => s.isOpen);
  const isSupported = speechService.supported;

  const onTextRef = useRef(onText);
  const onCommandRef = useRef(onCommand);
  const voiceCommandsRef = useRef(voiceCommands);
  const wakeWordConfigRef = useRef(wakeWordConfig);
  useEffect(() => { onTextRef.current = onText; }, [onText]);
  useEffect(() => { onCommandRef.current = onCommand; }, [onCommand]);
  useEffect(() => { voiceCommandsRef.current = voiceCommands; }, [voiceCommands]);
  useEffect(() => { wakeWordConfigRef.current = wakeWordConfig; }, [wakeWordConfig]);

  /** 静默标志：唤醒回应播报期间为 true，丢弃所有识别结果 */
  const muteRef = useRef(false);

  const getWakeActive = useCallback(() => useSessionStore.getState().speechWakeActive, []);
  const setWakeActive = useCallback((active: boolean) => {
    useSessionStore.getState().setSpeechWakeActive(active);
  }, []);

  const stop = useCallback(() => {
    if (audioFocusManager.isHeldBy('dictation')) {
      speechService.stop();
      audioFocusManager.release('dictation');
    }
    setWakeActive(false);
    setIsDictating(false);
    setInterimText('');
  }, [setWakeActive]);

  const registerDictationHandlers = useCallback(() => {
    const speechControl: SpeechControl = {
      pause: () => {
        muteRef.current = true;
        speechService.pause();
        log.debug('语音识别已暂停 + 静默窗口开启');
      },
      resume: () => {
        speechService.resume();
        setTimeout(() => {
          muteRef.current = false;
          log.debug('静默窗口关闭，识别结果恢复正常处理');
        }, 300);
      },
    };
    voiceNotificationService.setSpeechControl(speechControl);

    // 启动时注入回调
    speechService.setCallbacks({
      onResult: (text, isFinal) => {
        if (muteRef.current) {
          log.debug('静默窗口中，丢弃识别结果', { text });
          return;
        }

        if (isFinal) {
          const cleanText = text.trim();
          if (!cleanText) {
            setInterimText('');
            return;
          }

          // 1. 检查语音命令
          const cmd = checkVoiceCommand(cleanText, voiceCommandsRef.current);
          if (cmd) {
            log.info('检测到语音命令:', { cmd });
            onCommandRef.current?.(cmd);
            setInterimText('');
            return; // 命令不填入输入框
          }

          // 2. 唤醒词模式未启用 → 直接写入
          const wakeConfig = wakeWordConfigRef.current;
          if (!wakeConfig?.enabled) {
            log.debug('唤醒词未启用，写入听写文本', { text: cleanText });
            onTextRef.current(cleanText);
            setInterimText('');
            return;
          }

          // 3. 唤醒词门控
          const isActive = getWakeActive();

          if (!isActive) {
            // 待命状态：检查唤醒词
            const match = matchWakeWord(cleanText, wakeConfig.words);
            if (match) {
              log.info('唤醒词匹配:', { wakeWord: match.wakeWord, content: match.content });
              setWakeActive(true);
              // 唤醒回应播报（暂停识别防回声）
              voiceNotificationService.notifyWakeResponse();
              // 唤醒词后紧跟的内容也写入
              if (match.content) {
                log.debug('唤醒词后内容写入听写文本', { text: match.content });
                onTextRef.current(match.content);
              }
            } else {
              log.debug('待命状态未匹配唤醒词，丢弃识别文本', { text: cleanText, words: wakeConfig.words });
            }
            // 不匹配 → 丢弃
            setInterimText('');
          } else {
            // 已激活 → 正常写入
            log.debug('已唤醒，写入听写文本', { text: cleanText });
            onTextRef.current(cleanText);
            setInterimText('');
          }
        } else {
          setInterimText(text);
        }
      },
      onStatusChange: (s) => {
        if (s === 'listening') {
          setIsDictating(true);
        } else if (s === 'idle' || s === 'error') {
          setIsDictating(false);
          setInterimText('');
        }
      },
      onError: () => {
        setIsDictating(false);
        setInterimText('');
      },
    });
  }, [getWakeActive, setWakeActive]);

  // ===== 启动：注入 SpeechControl + 注册回调 =====
  useEffect(() => {
    registerDictationHandlers();
  }, [registerDictationHandlers]);

  const start = useCallback(() => {
    if (!speechService.supported) return;
    // 焦点仲裁：通话占用时申请失败，不抢麦克风
    if (!audioFocusManager.request('dictation')) return;

    // speechService 是全局单例，全屏通话会覆盖回调；每次听写启动前都重新夺回处理权。
    registerDictationHandlers();
    if (wakeWordConfigRef.current?.enabled) {
      // 用户手动点击输入框麦克风时，意图已经明确：直接进入听写，不再要求额外唤醒词。
      setWakeActive(true);
    }
    speechService.setConfig({
      enabled: true,
      language: optLanguage,
      continuous: true,
      interimResults: true,
    });
    speechService.start();
  }, [optLanguage, registerDictationHandlers, setWakeActive]);

  const toggle = useCallback(() => {
    if (isDictating) stop();
    else start();
  }, [isDictating, start, stop]);

  // 焦点被抢占 → 复位 UI
  useEffect(() => {
    return audioFocusManager.subscribe((owner) => {
      if (owner !== 'dictation') {
        setIsDictating(false);
        setInterimText('');
      }
    });
  }, []);

  // 卸载：仅在自己仍持有焦点时停止识别
  useEffect(() => {
    return () => {
      if (audioFocusManager.isHeldBy('dictation')) {
        speechService.stop();
        audioFocusManager.release('dictation');
      }
    };
  }, []);

  return {
    isDictating,
    interimText,
    isSupported,
    isSecureContext: speechService.isSecureContext,
    companionOpen,
    wakeActive: getWakeActive(),
    toggle,
    stop,
  };
}
