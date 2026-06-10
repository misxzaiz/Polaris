/**
 * VoiceCompanionOverlay - 语音伙伴全屏通话界面（v2）
 *
 * 沉浸式「打电话」：中央律动光球 + 状态/字幕 + 小白回复，
 * 底部主操作（随阶段）+ 静音 + 挂断，顶部模式切换（陪伴/干活）。
 *
 * 入口已移至 ChatStatusBar；本组件 !isOpen 时返回 null。
 * 编排逻辑全在 useVoiceCompanion（连续聆听 + 唤醒 + 命令 + 软全双工防回声）。
 */

import { clsx } from 'clsx';
import { Mic, Square, Send, PhoneOff, Volume2, VolumeX } from 'lucide-react';
import { useVoiceCompanion } from '@/hooks/useVoiceCompanion';
import { useVoiceCompanionStore } from '@/stores/voiceCompanionStore';
import { VoiceOrb } from './VoiceOrb';
import { COMPANION_IDENTITY, type VoiceCompanionMode, type VoicePhase } from '@/types/voiceCompanion';

/** 主操作按钮随阶段的图标与文案 */
function mainAction(phase: VoicePhase, hasBuffer: boolean): { Icon: typeof Mic; label: string } {
  switch (phase) {
    case 'standby':
      return { Icon: Mic, label: '唤醒' };
    case 'listening':
      return hasBuffer ? { Icon: Send, label: '发送' } : { Icon: Mic, label: '待命' };
    case 'thinking':
      return { Icon: Square, label: '打断' };
    case 'speaking':
      return { Icon: Square, label: '打断' };
    default:
      return { Icon: Mic, label: '开始' };
  }
}

/** 阶段状态文案 */
function statusText(phase: VoicePhase, transcript: string, errorMessage: string | null): string {
  switch (phase) {
    case 'standby':
      return '喊一声「小白」，我就来～';
    case 'listening':
      return transcript || '在听你说…';
    case 'thinking':
      return '小白在想…';
    case 'speaking':
      return '小白正在说…（喊「小白」可打断）';
    case 'error':
      return errorMessage || '出了点小问题，再试一次吧';
    default:
      return '准备好了';
  }
}

export function VoiceCompanionOverlay() {
  const {
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
  } = useVoiceCompanion();

  const setMode = useVoiceCompanionStore((s) => s.setMode);

  if (!isOpen) return null;

  const { Icon: MainIcon, label: mainLabel } = mainAction(phase, !!transcript);
  const status = statusText(phase, transcript, errorMessage);

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-gradient-to-b from-background to-background-elevated/95 backdrop-blur-xl">
      {/* 顶部：身份 + 模式切换 */}
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <div className="text-base font-semibold text-text-primary">{COMPANION_IDENTITY.name}</div>
          <div className="text-xs text-text-tertiary">{COMPANION_IDENTITY.tagline}</div>
        </div>

        <div className="flex items-center gap-1 p-1 bg-surface rounded-full border border-border">
          {(['companion', 'work'] as VoiceCompanionMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={clsx(
                'px-3 py-1 rounded-full text-xs font-medium transition-colors',
                config.mode === m ? 'bg-primary text-white' : 'text-text-tertiary hover:text-text-primary',
              )}
            >
              {m === 'companion' ? '陪伴' : '干活'}
            </button>
          ))}
        </div>
      </div>

      {/* 中央：光球 + 状态 + 字幕 */}
      <div className="flex-1 flex flex-col items-center justify-center gap-8 px-6">
        {isSupported ? (
          <>
            <VoiceOrb phase={phase} />

            <div className="text-center max-w-lg space-y-3">
              <div
                className={clsx(
                  'text-lg font-medium transition-colors',
                  phase === 'error' ? 'text-red-400' : 'text-text-primary',
                )}
              >
                {status}
              </div>

              {lastReply && (phase === 'speaking' || phase === 'listening' || phase === 'standby') && (
                <div className="text-sm text-text-secondary leading-relaxed line-clamp-4">{lastReply}</div>
              )}

              {lastUserText && phase === 'thinking' && (
                <div className="text-sm text-text-tertiary italic">「{lastUserText}」</div>
              )}
            </div>
          </>
        ) : (
          <div className="text-center text-text-secondary max-w-md">
            当前环境不支持语音识别。请确认使用的是支持 Web Speech 的内核，并已授予麦克风权限。
          </div>
        )}
      </div>

      {/* 命令提示 */}
      {isSupported && (
        <div className="text-center text-xs text-text-muted pb-3">
          试试说：「发送」·「清空」·「中断」 — 喊「小白」随时唤醒或打断
        </div>
      )}

      {/* 底部：静音 / 主按钮 / 挂断 */}
      <div className="flex items-center justify-center gap-8 pb-12 pt-2">
        <button
          onClick={toggleMute}
          disabled={!isSupported}
          className={clsx(
            'flex items-center justify-center w-12 h-12 rounded-full transition-colors disabled:opacity-40',
            muted ? 'bg-surface text-red-400' : 'bg-surface text-text-secondary hover:text-text-primary',
          )}
          title={muted ? '取消静音' : '静音'}
        >
          {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
        </button>

        <button
          onClick={handleMainAction}
          disabled={!isSupported || muted}
          className={clsx(
            'flex flex-col items-center justify-center w-20 h-20 rounded-full shadow-lg transition-all disabled:opacity-40',
            phase === 'listening'
              ? 'bg-sky-500 text-white scale-105'
              : phase === 'speaking' || phase === 'thinking'
                ? 'bg-amber-500 text-white'
                : 'bg-primary text-white hover:bg-primary/90',
          )}
        >
          <MainIcon size={26} />
          <span className="text-[10px] mt-0.5">{mainLabel}</span>
        </button>

        <button
          onClick={hangup}
          className="flex items-center justify-center w-12 h-12 rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors"
          title="结束通话"
        >
          <PhoneOff size={20} />
        </button>
      </div>
    </div>
  );
}
