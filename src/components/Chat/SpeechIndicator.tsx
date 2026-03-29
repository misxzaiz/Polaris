/**
 * 语音输入状态指示器
 */

import { useTranslation } from 'react-i18next';
import type { SpeechRecognitionStatus, SpeechRecognitionError } from '../../types/speech';
import { IconMic, IconMicOff } from '../Common/Icons';

interface SpeechIndicatorProps {
  status: SpeechRecognitionStatus;
  interimTranscript?: string;
  error?: SpeechRecognitionError | null;
  className?: string;
}

export function SpeechIndicator({
  status,
  interimTranscript = '',
  error,
  className = '',
}: SpeechIndicatorProps) {
  const { t } = useTranslation('chat');

  if (status === 'idle' && !error) {
    return null;
  }

  return (
    <div
      className={`
        flex items-center gap-2 px-3 py-2 rounded-lg
        ${status === 'listening' ? 'bg-primary/10 border border-primary/30' : ''}
        ${status === 'error' ? 'bg-red-500/10 border border-red-500/30' : ''}
        ${status === 'processing' ? 'bg-yellow-500/10 border border-yellow-500/30' : ''}
        ${className}
      `}
    >
      {/* 状态图标 */}
      <div className="flex items-center gap-2">
        {status === 'listening' && (
          <>
            <IconMic size={16} className="text-primary animate-pulse" />
            <span className="text-sm text-primary">
              {t('speech.listening', '正在听...')}
            </span>
          </>
        )}

        {status === 'processing' && (
          <>
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-text-secondary">
              {t('speech.processing', '处理中...')}
            </span>
          </>
        )}

        {status === 'error' && error && (
          <>
            <IconMicOff size={16} className="text-red-500" />
            <span className="text-sm text-red-500">
              {error.message || t('speech.error', '识别失败')}
            </span>
          </>
        )}
      </div>

      {/* 临时识别结果显示 */}
      {status === 'listening' && interimTranscript && (
        <div className="flex-1 text-sm text-text-secondary italic">
          "{interimTranscript}"
        </div>
      )}
    </div>
  );
}
