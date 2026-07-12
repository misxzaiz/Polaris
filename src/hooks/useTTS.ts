/**
 * TTS 语音合成 Hook
 *
 * 管理 TTS 状态，提供播放控制接口
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { ttsService } from '@/services/ttsService';
import { useConfigStore } from '@/stores';
import type { TTSStatus, TTSConfig } from '@/types/speech';

interface UseTTSReturn {
  /** 当前状态 */
  status: TTSStatus;
  /** 是否正在播放或合成 */
  isPlaying: boolean;
  /** 是否暂停 */
  isPaused: boolean;
  /** 停止播放 */
  stop: () => void;
  /** 暂停播放 */
  pause: () => void;
  /** 恢复播放 */
  resume: () => void;
  /** 切换播放/暂停 */
  toggle: () => void;
  /** 播放指定文本 */
  speak: (text: string) => Promise<void>;
}

/**
 * TTS Hook
 */
export function useTTS(): UseTTSReturn {
  const [status, setStatus] = useState<TTSStatus>('idle');
  const mountedRef = useRef(true);

  // 获取 TTS 配置
  const ttsConfig = useConfigStore(state => state.config?.tts as TTSConfig | undefined);

  useEffect(() => {
    mountedRef.current = true;

    // 同步配置到 ttsService
    if (ttsConfig) {
      ttsService.setConfig(ttsConfig);
    }

    // 设置状态回调
    ttsService.setCallbacks({
      onStatusChange: (newStatus) => {
        if (mountedRef.current) {
          setStatus(newStatus);
        }
      },
    });

    // 初始化状态
    setStatus(ttsService.getStatus());

    return () => {
      mountedRef.current = false;
      // 清除回调
      ttsService.setCallbacks({});
    };
  }, [ttsConfig]);

  const stop = useCallback(() => {
    ttsService.stop();
  }, []);

  const pause = useCallback(() => {
    ttsService.pause();
  }, []);

  const resume = useCallback(() => {
    ttsService.resume();
  }, []);

  const toggle = useCallback(() => {
    ttsService.toggle();
  }, []);

  const speak = useCallback(async (text: string) => {
    await ttsService.speak(text);
  }, []);

  return {
    status,
    isPlaying: status === 'playing' || status === 'synthesizing',
    isPaused: status === 'paused',
    stop,
    pause,
    resume,
    toggle,
    speak,
  };
}
