/**
 * useVoiceDictation - 输入框语音听写（非全屏轻量模式）
 *
 * 点击麦克风 → 连续识别 → 每段最终结果通过 onText 回调追加到输入框（可编辑后手动发送）。
 * 与全屏语音伙伴共用 speechService 单例，故做互斥：全屏伙伴打开时不抢麦克风。
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { speechService } from '@/services/speechService';
import { useVoiceCompanionStore } from '@/stores/voiceCompanionStore';
import type { SpeechLanguage } from '@/types/speech';

export interface UseVoiceDictationReturn {
  /** 是否正在听写 */
  isDictating: boolean;
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
  const companionOpen = useVoiceCompanionStore((s) => s.isOpen);
  const isSupported = speechService.supported;

  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  const stop = useCallback(() => {
    speechService.stop();
    setIsDictating(false);
  }, []);

  const start = useCallback(() => {
    // 单例互斥：全屏语音伙伴占用麦克风时不启动
    if (useVoiceCompanionStore.getState().isOpen) return;
    if (!speechService.supported) return;

    speechService.setConfig({
      enabled: true,
      language,
      continuous: true, // 持续听写，直到用户再次点击停止
      interimResults: false, // 只取最终结果，整段追加更干净
    });
    speechService.setCallbacks({
      onResult: (text, isFinal) => {
        if (isFinal && text.trim()) onTextRef.current(text.trim());
      },
      onStatusChange: (s) => {
        if (s === 'idle') setIsDictating(false);
      },
      onError: () => setIsDictating(false),
    });
    speechService.start();
    setIsDictating(true);
  }, [language]);

  const toggle = useCallback(() => {
    if (isDictating) stop();
    else start();
  }, [isDictating, start, stop]);

  // 卸载或全屏伙伴打开时停止听写
  useEffect(() => {
    if (companionOpen && isDictating) stop();
  }, [companionOpen, isDictating, stop]);

  useEffect(() => {
    return () => {
      speechService.stop();
    };
  }, []);

  return { isDictating, isSupported, companionOpen, toggle, stop };
}
