/**
 * VoiceOrb - 语音伙伴呼吸光球（v3）
 *
 * 三层结构：外圈呼吸光晕(halo) + 呼吸描边环(ring) + 核心渐变球(core 含内高光)。
 * 全部色彩走主题语义 token（primary/warning/success/danger），主题切换自动跟随：
 *   standby 低饱和主色呼吸 / listening 主色+涟漪 / thinking warning+旋转弧
 *   / speaking success+音量律动条 / cooldown 进度环 / error danger
 *
 * speaking 阶段由 `volume`（AudioContext 实测 0-1）驱动核心缩放律动；
 * cooldown 阶段由 `cooldownProgress`（0-1）驱动 conic 进度环。
 * 点击光球 = 打断/唤醒（由父级 onClick 编排）。
 */

import { clsx } from 'clsx';
import { Loader2, Mic } from 'lucide-react';
import type { VoicePhase } from '@/types/voiceCompanion';

interface VoiceOrbProps {
  phase: VoicePhase;
  size?: number;
  /** 实时音量（0-1），speaking 阶段驱动核心律动 */
  volume?: number;
  /** 冷却进度（0-1），cooldown 阶段显示恢复倒计时环 */
  cooldownProgress?: number;
  /** 点击光球（speaking/thinking=打断，standby=唤醒） */
  onClick?: () => void;
}

/** 各阶段的层级样式（halo 光晕 / ring 描边 / core 渐变 / 阴影） */
const PHASE_STYLE: Record<VoicePhase, { halo: string; ring: string; core: string; shadow: string }> = {
  idle: {
    halo: 'bg-primary/20',
    ring: 'border-primary/20',
    core: 'from-primary/50 to-primary/25',
    shadow: 'shadow-[0_18px_60px_-12px_rgb(var(--c-primary)/0.35)]',
  },
  standby: {
    halo: 'bg-primary/20',
    ring: 'border-primary/20',
    core: 'from-primary/50 to-primary/25',
    shadow: 'shadow-[0_18px_60px_-12px_rgb(var(--c-primary)/0.35)]',
  },
  listening: {
    halo: 'bg-primary/40',
    ring: 'border-primary/40',
    core: 'from-primary-400 to-primary-700',
    shadow: 'shadow-[0_18px_60px_-12px_rgb(var(--c-primary)/0.55)]',
  },
  thinking: {
    halo: 'bg-warning/35',
    ring: 'border-warning/40',
    core: 'from-warning to-warning/55',
    shadow: 'shadow-[0_18px_60px_-12px_rgb(var(--c-status-warning)/0.45)]',
  },
  speaking: {
    halo: 'bg-success/40',
    ring: 'border-success/40',
    core: 'from-success to-success/55',
    shadow: 'shadow-[0_18px_60px_-12px_rgb(var(--c-status-success)/0.5)]',
  },
  cooldown: {
    halo: 'bg-primary/30',
    ring: 'border-primary/30',
    core: 'from-primary/70 to-primary/40',
    shadow: 'shadow-[0_18px_60px_-12px_rgb(var(--c-primary)/0.4)]',
  },
  error: {
    halo: 'bg-danger/40',
    ring: 'border-danger/45',
    core: 'from-danger to-danger/55',
    shadow: 'shadow-[0_18px_60px_-12px_rgb(var(--c-status-danger)/0.5)]',
  },
};

/** 说话音量律动条（5 根，错相） */
function VolumeBars({ height }: { height: number }) {
  const bars = [0.4, 0.75, 1, 0.6, 0.35];
  return (
    <div className="flex items-center gap-[5px]" style={{ height }}>
      {bars.map((h, i) => (
        <span
          key={i}
          className="w-[4.5px] rounded-full bg-white/90 animate-voice-bar"
          style={{ height: height * h, animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

export function VoiceOrb({ phase, size = 190, volume = 0, cooldownProgress = 0, onClick }: VoiceOrbProps) {
  const style = PHASE_STYLE[phase];
  const listening = phase === 'listening';
  const speaking = phase === 'speaking';
  const thinking = phase === 'thinking';
  const cooldown = phase === 'cooldown';
  const core = Math.round(size * 0.72);
  // speaking：音量驱动核心缩放（与外层呼吸动画分层，互不覆盖）
  const volumeScale = speaking ? 1 + Math.min(1, Math.max(0, volume)) * 0.08 : 1;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="语音光球"
      className="relative flex items-center justify-center bg-transparent border-none outline-none cursor-pointer group"
      style={{ width: size, height: size }}
    >
      {/* 聆听：向外扩散的涟漪环 */}
      {listening && (
        <>
          <span className="absolute inset-0 rounded-full border-[1.5px] border-primary/50 animate-voice-ripple" />
          <span
            className="absolute inset-0 rounded-full border-[1.5px] border-primary/40 animate-voice-ripple"
            style={{ animationDelay: '1.3s' }}
          />
        </>
      )}

      {/* 思考：旋转弧 */}
      {thinking && (
        <span className="absolute -inset-2.5 rounded-full border-2 border-transparent border-t-warning/80 animate-spin [animation-duration:1.6s]" />
      )}

      {/* 冷却：conic 恢复进度环 */}
      {cooldown && (
        <span
          className="absolute -inset-1.5 rounded-full"
          style={{
            background: `conic-gradient(rgb(var(--c-primary) / 0.8) ${cooldownProgress * 100}%, transparent 0)`,
          }}
        >
          <span className="absolute inset-[3px] rounded-full" style={{ backgroundColor: 'rgb(var(--c-bg-base))' }} />
        </span>
      )}

      {/* 外圈呼吸光晕 */}
      <span
        className={clsx('absolute -inset-6 rounded-full blur-2xl transition-colors duration-500 animate-breathe', style.halo)}
      />
      {/* 呼吸描边环 */}
      <span
        className={clsx('absolute inset-0 rounded-full border-[1.5px] transition-colors duration-500 animate-breathe', style.ring)}
      />

      {/* 核心球体：外层呼吸 + 内层音量律动（嵌套 transform 分层叠加） */}
      <span
        className={clsx('relative block', !speaking && 'animate-breathe-core')}
        style={{ width: core, height: core }}
      >
        <span
          className={clsx(
            'absolute inset-0 rounded-full flex items-center justify-center',
            'bg-gradient-to-br transition-[background,box-shadow,transform] duration-500',
            'group-active:scale-95',
            style.core,
            style.shadow,
          )}
          style={{ transform: `scale(${volumeScale})`, transitionDuration: speaking ? '110ms' : '500ms' }}
        >
          {/* 内高光 */}
          <span className="absolute top-[12%] left-[16%] w-[34%] h-[22%] rounded-full bg-white/30 blur-[7px]" />

          {thinking ? (
            <Loader2 className="text-white/90 animate-spin" size={core * 0.32} />
          ) : speaking ? (
            <VolumeBars height={core * 0.3} />
          ) : (
            <Mic className={clsx('text-white/90', cooldown && 'opacity-50')} size={core * 0.3} />
          )}
        </span>
      </span>
    </button>
  );
}
