/**
 * 语音识别 Hook
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { speechService } from '../services/speechService';
import type {
  SpeechRecognitionStatus,
  SpeechRecognitionError,
  SpeechConfig,
  VoiceCommand
} from '../types/speech';
import { DEFAULT_SPEECH_CONFIG, checkVoiceCommand } from '../types/speech';
import { createLogger } from '../utils/logger';

const log = createLogger('useSpeechRecognition');

export interface UseSpeechRecognitionOptions {
  /** 是否自动将识别结果追加到现有文本 */
  appendMode?: boolean;
  /** 识别完成后的回调 */
  onResult?: (transcript: string) => void;
  /** 错误回调 */
  onError?: (error: SpeechRecognitionError) => void;
  /** 语音命令回调 */
  onCommand?: (command: VoiceCommand) => void;
  /** 语音配置 */
  config?: Partial<SpeechConfig>;
}

export interface UseSpeechRecognitionReturn {
  /** 当前状态 */
  status: SpeechRecognitionStatus;
  /** 临时识别结果（未确认） */
  interimTranscript: string;
  /** 最终识别结果 */
  finalTranscript: string;
  /** 是否支持语音识别 */
  isSupported: boolean;
  /** 错误信息 */
  error: SpeechRecognitionError | null;
  /** 开始识别 */
  start: () => void;
  /** 停止识别 */
  stop: () => void;
  /** 切换识别状态 */
  toggle: () => void;
  /** 清空结果 */
  clear: () => void;
  /** 是否正在识别 */
  isListening: boolean;
}

export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions = {}
): UseSpeechRecognitionReturn {
  const { appendMode = false, onResult, onError, onCommand, config: configProp } = options;

  const [status, setStatus] = useState<SpeechRecognitionStatus>('idle');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [error, setError] = useState<SpeechRecognitionError | null>(null);

  const isSupported = speechService.supported;
  const isListening = status === 'listening';

  // 使用 ref 保存回调，避免重复注册
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  const onCommandRef = useRef(onCommand);

  useEffect(() => {
    onResultRef.current = onResult;
    onErrorRef.current = onError;
    onCommandRef.current = onCommand;
  }, [onResult, onError, onCommand]);

  // 初始化服务
  useEffect(() => {
    if (!isSupported) return;

    // 设置回调
    speechService.setCallbacks({
      onStatusChange: (newStatus) => {
        setStatus(newStatus);
        if (newStatus === 'idle') {
          setInterimTranscript('');
        }
      },
      onResult: (transcript, isFinal) => {
        if (isFinal) {
          // 检查是否是语音命令（仅最终结果）
          const command = checkVoiceCommand(transcript);
          if (command) {
            log.info('检测到语音命令:', { command });
            onCommandRef.current?.(command);
            return; // 命令不填入输入框
          }

          setFinalTranscript(prev =>
            appendMode ? prev + transcript : transcript
          );
          onResultRef.current?.(transcript);
        } else {
          setInterimTranscript(transcript);
        }
      },
      onError: (err) => {
        setError(err);
        onErrorRef.current?.(err);
      }
    });

    return () => {
      // 不销毁服务，保持单例
    };
  }, [isSupported, appendMode]);

  // 应用配置变化
  useEffect(() => {
    if (isSupported) {
      speechService.setConfig({
        ...DEFAULT_SPEECH_CONFIG,
        ...configProp
      });
    }
  }, [configProp, isSupported]);

  const start = useCallback(() => {
    if (!isSupported) {
      log.warn('语音识别不可用');
      return;
    }

    setError(null);
    setInterimTranscript('');
    speechService.start();
  }, [isSupported]);

  const stop = useCallback(() => {
    speechService.stop();
  }, []);

  const toggle = useCallback(() => {
    if (isListening) {
      stop();
    } else {
      start();
    }
  }, [isListening, start, stop]);

  const clear = useCallback(() => {
    setFinalTranscript('');
    setInterimTranscript('');
    setError(null);
  }, []);

  return {
    status,
    interimTranscript,
    finalTranscript,
    isSupported,
    error,
    start,
    stop,
    toggle,
    clear,
    isListening,
  };
}
