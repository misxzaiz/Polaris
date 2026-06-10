/**
 * VoiceCompanionOverlay - 语音伙伴全屏通话界面（v3）
 *
 * 沉浸式「打电话」：不透明 aurora 背景 + 中央呼吸光球 + 双向字幕气泡
 * + 毛玻璃控制条（静音/主操作/挂断）+ 顶部模式切换（陪伴/干活）。
 *
 * 视觉规范：
 *   - 背景显式 rgb(var(--c-bg-base))（不复合 --window-opacity），全屏完整遮盖底层；
 *   - 全部色彩走主题语义 token，主题切换自动跟随；
 *   - aurora 双光斑 22s/28s 错相漂移，光球 5.6s 呼吸（见 tailwind.config 动画）。
 *
 * 交互：点击光球/空格 = 打断或唤醒；ESC = 挂断。
 * 编排逻辑全在 useVoiceCompanion（半双工回声治理 + 唤醒 + 命令）。
 */

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Mic, Square, Send, PhoneOff, Volume2, VolumeX, RotateCcw } from 'lucide-react';
import { useVoiceCompanion } from '@/hooks/useVoiceCompanion';
import { useTtsVolume } from '@/hooks/useTtsVolume';
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
    case 'speaking':
    case 'cooldown':
      return { Icon: Square, label: '打断' };
    case 'error':
      return { Icon: RotateCcw, label: '重试' };
    default:
      return { Icon: Mic, label: '开始' };
  }
}

/** 阶段主状态文案 */
function statusText(phase: VoicePhase, transcript: string, errorMessage: string | null): string {
  switch (phase) {
    case 'standby':
      return '喊一声「小白」，我就来～';
    case 'listening':
      return transcript || '在听你说…';
    case 'thinking':
      return '小白在想…';
    case 'speaking':
      return '小白正在说…';
    case 'cooldown':
      return '稍等，让回声散一散…';
    case 'error':
      return errorMessage || '出了点小问题，再试一次吧';
    default:
      return '准备好了';
  }
}

/** 阶段副状态文案（操作引导） */
function statusSubText(phase: VoicePhase, fullDuplex: boolean, autoSend: boolean): string {
  switch (phase) {
    case 'standby':
      return '待命中 · 只认唤醒词，旁人聊天不上屏';
    case 'listening':
      return autoSend
        ? '停顿片刻自动发送 · 说「发送」立即发出'
        : '说「发送」或点击下方发送按钮发出';
    case 'thinking':
      return '点击光球可打断';
    case 'speaking':
      return fullDuplex ? '全双工 · 喊「小白」可打断' : '🎤 识别已暂停（防回声） · 点击光球打断';
    case 'cooldown':
      return '即将恢复聆听 · 直接说话不会丢字';
    default:
      return '';
  }
}

/** 冷却进度（0-1），驱动光球恢复倒计时环 */
function useCooldownProgress(active: boolean, durationMs: number): number {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!active) {
      setProgress(0);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const v = Math.min(1, (now - start) / Math.max(1, durationMs));
      setProgress(v);
      if (v < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, durationMs]);
  return progress;
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
    handleOrbClick,
    toggleMute,
    hangup,
  } = useVoiceCompanion();

  const setMode = useVoiceCompanionStore((s) => s.setMode);
  const volume = useTtsVolume(isOpen && phase === 'speaking');
  const cooldownProgress = useCooldownProgress(isOpen && phase === 'cooldown', config.echoCooldownMs);

  // 键盘可达：ESC 挂断；空格 打断/唤醒（聆听中不抢，避免误触发送）
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        hangup();
      } else if (e.key === ' ' && phase !== 'listening') {
        e.preventDefault();
        handleOrbClick();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, phase, hangup, handleOrbClick]);

  if (!isOpen) return null;

  const { Icon: MainIcon, label: mainLabel } = mainAction(phase, !!transcript);
  const status = statusText(phase, transcript, errorMessage);
  const statusSub = statusSubText(phase, config.fullDuplex, config.autoSend);

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col overflow-hidden"
      style={{ backgroundColor: 'rgb(var(--c-bg-base))' }} // 显式不透明，不复合 --window-opacity
    >
      {/* aurora 光斑：双层错相漂移，阶段微调色相 */}
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        <div
          className={clsx(
            'absolute -top-[15%] -left-[10%] w-[70%] h-[70%] rounded-full blur-[90px] opacity-50',
            'transition-colors duration-700 animate-aurora-drift-1',
            phase === 'thinking' ? 'bg-warning/25'
              : phase === 'speaking' ? 'bg-success/25'
                : phase === 'error' ? 'bg-danger/25'
                  : 'bg-primary/30',
          )}
        />
        <div className="absolute -bottom-[20%] -right-[10%] w-[70%] h-[70%] rounded-full blur-[90px] opacity-40 bg-primary/20 animate-aurora-drift-2" />
      </div>

      {/* 顶部：身份 + 模式切换 */}
      <div className="relative flex items-center justify-between px-6 py-4">
        <div>
          <div className="text-base font-semibold text-text-primary">{COMPANION_IDENTITY.name}</div>
          <div className="text-xs text-text-tertiary">{COMPANION_IDENTITY.tagline}</div>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[rgb(var(--c-bg-surface))] rounded-full border border-border">
          {(['companion', 'work'] as VoiceCompanionMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={clsx(
                'px-3 py-1 rounded-full text-xs font-medium transition-colors',
                config.mode === m ? 'bg-primary text-on-primary' : 'text-text-tertiary hover:text-text-primary',
              )}
            >
              {m === 'companion' ? '陪伴' : '干活'}
            </button>
          ))}
        </div>
      </div>

      {/* 中央：光球 + 状态 + 字幕气泡 */}
      <div className="relative flex-1 flex flex-col items-center justify-center gap-7 px-6 min-h-0">
        {isSupported ? (
          <>
            <VoiceOrb
              phase={phase}
              volume={volume}
              cooldownProgress={cooldownProgress}
              onClick={handleOrbClick}
            />

            <div className="text-center max-w-lg space-y-1.5">
              <div
                className={clsx(
                  'text-lg font-medium transition-colors duration-300',
                  phase === 'error' ? 'text-danger' : 'text-text-primary',
                )}
              >
                {status}
              </div>
              {statusSub && <div className="text-xs text-text-tertiary">{statusSub}</div>}
            </div>

            {/* 字幕气泡：用户右 / 小白左，可滚动 */}
            {(lastUserText || lastReply) && (
              <div className="w-full max-w-xl flex flex-col gap-2.5 max-h-44 overflow-y-auto px-2">
                {lastUserText && (
                  <div className="self-end max-w-[82%] px-3.5 py-2 rounded-2xl rounded-br-md bg-primary text-on-primary text-[13.5px] leading-relaxed">
                    {lastUserText}
                  </div>
                )}
                {lastReply && (
                  <div className="self-start max-w-[82%] px-3.5 py-2 rounded-2xl rounded-bl-md bg-[rgb(var(--c-bg-surface))] border border-border text-text-primary text-[13.5px] leading-relaxed">
                    {lastReply}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="text-center text-text-secondary max-w-md">
            当前环境不支持语音识别。请确认使用的是支持 Web Speech 的内核，并已授予麦克风权限。
          </div>
        )}
      </div>

      {/* 命令提示 */}
      {isSupported && (
        <div className="relative text-center text-xs text-text-muted pb-3">
          试试说：「发送」·「清空」·「中断」 — 待命时喊「小白」唤醒 · ESC 挂断
        </div>
      )}

      {/* 底部：毛玻璃控制条（静音 / 主按钮 / 挂断） */}
      <div className="relative flex items-center justify-center pb-10 pt-2">
        <div className="flex items-center gap-8 px-8 py-3.5 rounded-full bg-[rgb(var(--c-bg-elevated)/0.6)] backdrop-blur-xl border border-border">
          <button
            onClick={toggleMute}
            disabled={!isSupported}
            className={clsx(
              'flex items-center justify-center w-12 h-12 rounded-full transition-colors disabled:opacity-40',
              'bg-[rgb(var(--c-bg-surface))] border border-border',
              muted ? 'text-danger' : 'text-text-secondary hover:text-text-primary',
            )}
            title={muted ? '取消静音' : '静音'}
          >
            {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
          </button>

          <button
            onClick={handleMainAction}
            disabled={!isSupported || muted}
            className={clsx(
              'relative flex flex-col items-center justify-center w-[72px] h-[72px] rounded-full transition-all duration-300 disabled:opacity-40',
              'text-on-primary shadow-glow',
              phase === 'listening'
                ? 'bg-primary scale-105'
                : phase === 'speaking' || phase === 'thinking' || phase === 'cooldown'
                  ? 'bg-warning'
                  : phase === 'error'
                    ? 'bg-danger'
                    : 'bg-primary hover:bg-primary-hover',
            )}
          >
            {/* 呼吸外圈 */}
            <span className="absolute -inset-1.5 rounded-full border-[1.5px] border-primary/40 animate-breathe pointer-events-none" />
            <MainIcon size={25} />
            <span className="text-[10px] mt-0.5">{mainLabel}</span>
          </button>

          <button
            onClick={hangup}
            className="flex items-center justify-center w-12 h-12 rounded-full bg-danger text-on-primary hover:opacity-90 transition-opacity"
            title="结束通话 (ESC)"
          >
            <PhoneOff size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
