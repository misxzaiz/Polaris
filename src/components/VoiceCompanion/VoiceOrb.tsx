/**
 * VoiceOrb - 语音伙伴律动光球
 *
 * 随对话阶段变色与律动（纯 CSS 动画，轻量）：
 *   listening 蓝色 + 扩散环 / thinking 琥珀 + 旋转 / speaking 绿色 + 脉动 / idle 柔和呼吸 / error 红
 *
 * Phase 2 可接入 AudioContext 分析真实音量驱动律动幅度。
 */

import { clsx } from 'clsx';
import { Loader2, Mic } from 'lucide-react';
import type { VoicePhase } from '@/types/voiceCompanion';

interface VoiceOrbProps {
  phase: VoicePhase;
  size?: number;
}

export function VoiceOrb({ phase, size = 180 }: VoiceOrbProps) {
  const listening = phase === 'listening';
  const speaking = phase === 'speaking';
  const thinking = phase === 'thinking';
  const error = phase === 'error';
  const core = Math.round(size * 0.72);

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      {/* 聆听：向外扩散的同心环 */}
      {listening && (
        <>
          <span className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />
          <span
            className="absolute rounded-full bg-primary/15 animate-ping"
            style={{ inset: size * 0.1, animationDelay: '0.5s' }}
          />
        </>
      )}

      {/* 说话：柔和脉动光晕 */}
      {speaking && <span className="absolute inset-0 rounded-full bg-emerald-500/25 animate-pulse" />}

      {/* 核心球体 */}
      <div
        className={clsx(
          'relative rounded-full flex items-center justify-center shadow-2xl bg-gradient-to-br transition-all duration-500',
          error
            ? 'from-red-500 to-red-700'
            : speaking
              ? 'from-emerald-400 to-teal-600 animate-pulse'
              : listening
                ? 'from-sky-400 to-blue-600'
                : thinking
                  ? 'from-amber-400 to-orange-600'
                  : 'from-primary/70 to-blue-700/70 animate-pulse',
        )}
        style={{ width: core, height: core }}
      >
        {thinking ? (
          <Loader2 className="text-white/90 animate-spin" size={core * 0.32} />
        ) : (
          <Mic className="text-white/90" size={core * 0.3} />
        )}
      </div>
    </div>
  );
}
