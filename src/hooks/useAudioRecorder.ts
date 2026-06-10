/**
 * 录音 Hook
 *
 * 基于 getUserMedia + MediaRecorder 录制麦克风音频，返回音频 Blob。
 * 用于语音伙伴的语音输入（录音 → 硅基流动 STT 转写）。
 *
 * 注意：Tauri WebView2 下首次调用 getUserMedia 可能需要麦克风权限；
 * 若被拒，需在 src-tauri 端处理 WebView 媒体权限回调。
 */

import { useState, useRef, useCallback } from 'react';
import { createLogger } from '@/utils/logger';

const log = createLogger('useAudioRecorder');

export interface UseAudioRecorderReturn {
  /** 是否正在录音 */
  isRecording: boolean;
  /** 错误信息 */
  error: string | null;
  /** 开始录音 */
  start: () => Promise<void>;
  /** 停止录音并返回音频 Blob（无有效音频时返回 null） */
  stop: () => Promise<Blob | null>;
  /** 取消录音（丢弃音频） */
  cancel: () => void;
}

/** 选择浏览器支持的录音 MIME 类型 */
function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = pickMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start();
      recorderRef.current = recorder;
      setIsRecording(true);
      log.debug('录音开始', { mimeType: recorder.mimeType });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      releaseStream();
      log.error('录音启动失败（可能是麦克风权限被拒）', e instanceof Error ? e : new Error(msg));
      throw e;
    }
  }, [releaseStream]);

  const stop = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        setIsRecording(false);
        resolve(null);
        return;
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        releaseStream();
        recorderRef.current = null;
        setIsRecording(false);
        log.debug('录音结束', { size: blob.size, type: blob.type });
        resolve(blob.size > 0 ? blob : null);
      };
      recorder.stop();
    });
  }, [releaseStream]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.stop();
    }
    releaseStream();
    recorderRef.current = null;
    chunksRef.current = [];
    setIsRecording(false);
  }, [releaseStream]);

  return { isRecording, error, start, stop, cancel };
}
