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
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { speechService } from '@/services/speechService';
import { audioFocusManager } from '@/services/audioFocusManager';
import { useVoiceCompanionStore } from '@/stores/voiceCompanionStore';
import type { SpeechLanguage } from '@/types/speech';

export interface UseVoiceDictationReturn {
  /** 是否正在听写 */
  isDictating: boolean;
  /** 识别中的临时文本（实时预览，final 后清空） */
  interimText: string;
  /** 是否支持语音识别 */
  isSupported: boolean;
  /** 全屏语音伙伴是否打开（打开时听写不可用，互斥） */
  companionOpen: boolean;
  /** 切换听写 */
  toggle: () => void;
  /** 停止听写 */
  stop: () => void;
}

export function useVoiceDictation(
  onText: (text: string) => void,
  language: SpeechLanguage = 'zh-CN',
): UseVoiceDictationReturn {
  const [isDictating, setIsDictating] = useState(false);
  const [interimText, setInterimText] = useState('');
  const companionOpen = useVoiceCompanionStore((s) => s.isOpen);
  const isSupported = speechService.supported;

  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  const stop = useCallback(() => {
    if (audioFocusManager.isHeldBy('dictation')) {
      speechService.stop();
      audioFocusManager.release('dictation');
    }
    setIsDictating(false);
    setInterimText('');
  }, []);

  const start = useCallback(() => {
    if (!speechService.supported) return;
    // 焦点仲裁：通话占用时申请失败，不抢麦克风
    if (!audioFocusManager.request('dictation')) return;

    speechService.setConfig({
      enabled: true,
      language,
      continuous: true, // 持续听写，直到用户再次点击停止
      interimResults: true, // 实时预览识别中的文本
    });
    speechService.setCallbacks({
      onResult: (text, isFinal) => {
        if (isFinal) {
          setInterimText('');
          if (text.trim()) onTextRef.current(text.trim());
        } else {
          setInterimText(text);
        }
      },
      onStatusChange: (s) => {
        if (s === 'idle') {
          setIsDictating(false);
          setInterimText('');
        }
      },
      onError: () => {
        setIsDictating(false);
        setInterimText('');
      },
    });
    speechService.start();
    setIsDictating(true);
  }, [language]);

  const toggle = useCallback(() => {
    if (isDictating) stop();
    else start();
  }, [isDictating, start, stop]);

  // 焦点被抢占（如通话开启）→ 复位 UI；麦克风已被新持有者接管，无需亲自 stop
  useEffect(() => {
    return audioFocusManager.subscribe((owner) => {
      if (owner !== 'dictation') {
        setIsDictating(false);
        setInterimText('');
      }
    });
  }, []);

  // 卸载：仅在自己仍持有焦点时停止识别（避免误杀通话麦克风）
  useEffect(() => {
    return () => {
      if (audioFocusManager.isHeldBy('dictation')) {
        speechService.stop();
        audioFocusManager.release('dictation');
      }
    };
  }, []);

  return { isDictating, interimText, isSupported, companionOpen, toggle, stop };
}
