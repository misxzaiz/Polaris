/**
 * Polaris 角色组件
 *
 * 基于 polaris-commander.svg 的内联 SVG 组件，通过 expression prop 控制表情。
 * 各可动部件通过 className 标记，由外部 CSS 驱动动画。
 */

import { memo, useMemo } from 'react'
import type { CharacterExpression } from './expressions'
import {
  MOUTH_PATHS,
  LEFT_EYE_STYLES,
  RIGHT_EYE_STYLES,
  BLUSH_OPACITY,
  ANTENNA_ANIMATION,
  ENERGY_RING_DURATION,
} from './expressions'

export interface PolarisCharacterProps {
  /** 当前表情 */
  expression: CharacterExpression
  /** 整体尺寸（宽高相同，正方形 viewBox） */
  size?: number
  /** 口型开合度 0~1，用于 TTS 驱动（覆盖 CSS 嘴部动画） */
  mouthOpen?: number
  /** 额外 className */
  className?: string
}

/**
 * Polaris 角色组件（内联 SVG）
 *
 * 基于 polaris-commander.svg 转换，各部件通过语义化 className 标记。
 * 表情由 expressions.ts 中的参数驱动，动画由 character.css 驱动。
 */
export const PolarisCharacter = memo(function PolarisCharacter({
  expression,
  size = 512,
  mouthOpen,
  className,
}: PolarisCharacterProps) {
  const leftEye = LEFT_EYE_STYLES[expression]
  const rightEye = RIGHT_EYE_STYLES[expression]
  const blushOpacity = BLUSH_OPACITY[expression]
  const antennaAnim = ANTENNA_ANIMATION[expression]
  const ringDuration = ENERGY_RING_DURATION[expression]

  // 嘴巴路径：如果有 mouthOpen 值，动态计算开口大小
  const mouthPath = useMemo(() => {
    if (mouthOpen !== undefined && mouthOpen > 0) {
      // 基于 speaking 路径，根据 mouthOpen 调整弧度
      const openFactor = Math.max(0, Math.min(1, mouthOpen))
      const y = Math.round(315 + openFactor * 35) // 315~350
      return `M220,${y} Q256,${y + 30 * openFactor} 292,${y}`
    }
    return MOUTH_PATHS[expression]
  }, [expression, mouthOpen])

  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={className}
      style={{ overflow: 'visible' }}
    >
      <defs>
        {/* 渐变定义 */}
        <linearGradient id="char-robotBody" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: '#00d4ff' }} />
          <stop offset="50%" style={{ stopColor: '#6366f1' }} />
          <stop offset="100%" style={{ stopColor: '#8b5cf6' }} />
        </linearGradient>

        <linearGradient id="char-starEye" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: '#ffd700' }} />
          <stop offset="50%" style={{ stopColor: '#ffec8b' }} />
          <stop offset="100%" style={{ stopColor: '#ffd700' }} />
        </linearGradient>

        <linearGradient id="char-headphone" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style={{ stopColor: '#ff00ff' }} />
          <stop offset="50%" style={{ stopColor: '#ff69b4' }} />
          <stop offset="100%" style={{ stopColor: '#ff00ff' }} />
        </linearGradient>

        {/* 发光滤镜 */}
        <filter id="char-glow">
          <feGaussianBlur stdDeviation="3" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        <filter id="char-strongGlow">
          <feGaussianBlur stdDeviation="6" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        <filter id="char-starGlow">
          <feGaussianBlur stdDeviation="4" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* 背景渐变 */}
        <radialGradient id="char-bg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" style={{ stopColor: '#1a1a2e' }} />
          <stop offset="70%" style={{ stopColor: '#0a0a0f' }} />
          <stop offset="100%" style={{ stopColor: '#050508' }} />
        </radialGradient>
      </defs>

      {/* 背景 */}
      <circle cx="256" cy="256" r="250" fill="url(#char-bg)" stroke="#2d2d4a" strokeWidth="3" />

      {/* 星星装饰 */}
      <circle cx="80" cy="100" r="2" fill="#ffd700" opacity="0.6" />
      <circle cx="420" cy="80" r="2" fill="#00d4ff" opacity="0.5" />
      <circle cx="450" cy="180" r="1.5" fill="#ff00ff" opacity="0.4" />
      <circle cx="60" cy="200" r="1.5" fill="#ffd700" opacity="0.4" />
      <circle cx="100" cy="400" r="2" fill="#00ffff" opacity="0.5" />
      <circle cx="400" cy="420" r="1.5" fill="#ffd700" opacity="0.4" />
      <circle cx="150" cy="80" r="1" fill="#ffffff" opacity="0.3" />
      <circle cx="350" cy="450" r="1" fill="#ffffff" opacity="0.3" />

      {/* 耳机头带 */}
      <path
        d="M130,180 Q130,100 256,80 Q382,100 382,180"
        stroke="url(#char-headphone)"
        strokeWidth="16"
        fill="none"
        strokeLinecap="round"
        filter="url(#char-glow)"
      />

      {/* 左耳机 */}
      <ellipse cx="120" cy="210" rx="45" ry="55" fill="#1a1a2e" stroke="url(#char-headphone)" strokeWidth="4" filter="url(#char-glow)" />
      <ellipse cx="120" cy="210" rx="35" ry="45" fill="#2d2d4a" />
      <ellipse cx="120" cy="210" rx="25" ry="32" fill="#1a1a2e" />
      {/* 耳机信号波纹 */}
      <path className="character-headphone-wave" d="M85,190 Q95,185 100,195" stroke="#ff00ff" strokeWidth="2" fill="none" opacity="0.6" />
      <path className="character-headphone-wave" d="M80,200 Q92,193 100,205" stroke="#ff00ff" strokeWidth="2" fill="none" opacity="0.4" />

      {/* 右耳机 */}
      <ellipse cx="392" cy="210" rx="45" ry="55" fill="#1a1a2e" stroke="url(#char-headphone)" strokeWidth="4" filter="url(#char-glow)" />
      <ellipse cx="392" cy="210" rx="35" ry="45" fill="#2d2d4a" />
      <ellipse cx="392" cy="210" rx="25" ry="32" fill="#1a1a2e" />
      {/* 耳机信号波纹 */}
      <path className="character-headphone-wave" d="M427,190 Q417,185 412,195" stroke="#ff00ff" strokeWidth="2" fill="none" opacity="0.6" />
      <path className="character-headphone-wave" d="M432,200 Q420,193 412,205" stroke="#ff00ff" strokeWidth="2" fill="none" opacity="0.4" />

      {/* 机器人头部主体 */}
      <ellipse cx="256" cy="260" rx="100" ry="90" fill="url(#char-robotBody)" />

      {/* 头部高光 */}
      <ellipse cx="230" cy="210" rx="50" ry="30" fill="rgba(255,255,255,0.15)" />

      {/* 面板分隔线 */}
      <path d="M170,300 Q256,330 342,300" stroke="#1a1a2e" strokeWidth="3" fill="none" opacity="0.3" />

      {/* 左眼 - 北极星 */}
      <g
        className="character-eye-left"
        filter="url(#char-starGlow)"
        style={{
          opacity: leftEye.opacity,
          transform: `translate(${leftEye.translateX}px, ${leftEye.translateY}px) scale(${leftEye.scale})`,
          transformOrigin: '220px 260px',
          animation: leftEye.animation,
        }}
      >
        <polygon points="20,0 25,15 40,15 28,25 33,40 20,30 7,40 12,25 0,15 15,15" fill="url(#char-starEye)" />
        <line x1="20" y1="-8" x2="20" y2="-15" stroke="#ffd700" strokeWidth="2" />
        <line x1="20" y1="48" x2="20" y2="55" stroke="#ffd700" strokeWidth="2" />
        <line x1="-8" y1="20" x2="-15" y2="20" stroke="#ffd700" strokeWidth="2" />
        <line x1="48" y1="20" x2="55" y2="20" stroke="#ffd700" strokeWidth="2" />
        <line x1="-5" y1="-5" x2="-12" y2="-12" stroke="#ffd700" strokeWidth="1.5" />
        <line x1="45" y1="-5" x2="52" y2="-12" stroke="#ffd700" strokeWidth="1.5" />
        <line x1="-5" y1="45" x2="-12" y2="52" stroke="#ffd700" strokeWidth="1.5" />
        <line x1="45" y1="45" x2="52" y2="52" stroke="#ffd700" strokeWidth="1.5" />
      </g>

      {/* 右眼 - 北极星 */}
      <g
        className="character-eye-right"
        filter="url(#char-starGlow)"
        style={{
          opacity: rightEye.opacity,
          transform: `translate(${rightEye.translateX}px, ${rightEye.translateY}px) scale(${rightEye.scale})`,
          transformOrigin: '312px 260px',
          animation: rightEye.animation,
        }}
      >
        <polygon points="20,0 25,15 40,15 28,25 33,40 20,30 7,40 12,25 0,15 15,15" fill="url(#char-starEye)" />
        <line x1="20" y1="-8" x2="20" y2="-15" stroke="#ffd700" strokeWidth="2" />
        <line x1="20" y1="48" x2="20" y2="55" stroke="#ffd700" strokeWidth="2" />
        <line x1="-8" y1="20" x2="-15" y2="20" stroke="#ffd700" strokeWidth="2" />
        <line x1="48" y1="20" x2="55" y2="20" stroke="#ffd700" strokeWidth="2" />
        <line x1="-5" y1="-5" x2="-12" y2="-12" stroke="#ffd700" strokeWidth="1.5" />
        <line x1="45" y1="-5" x2="52" y2="-12" stroke="#ffd700" strokeWidth="1.5" />
        <line x1="-5" y1="45" x2="-12" y2="52" stroke="#ffd700" strokeWidth="1.5" />
        <line x1="45" y1="45" x2="52" y2="52" stroke="#ffd700" strokeWidth="1.5" />
      </g>

      {/* 嘴巴 */}
      <path
        className="character-mouth"
        d={mouthPath}
        stroke="#1a1a2e"
        strokeWidth="5"
        fill="none"
        strokeLinecap="round"
      />

      {/* 脸颊装饰（腮红） */}
      <circle
        className="character-blush-left"
        cx="165"
        cy="280"
        r="8"
        fill="#ff69b4"
        opacity={blushOpacity}
        style={{ transition: 'opacity 0.3s ease' }}
      />
      <circle
        className="character-blush-right"
        cx="347"
        cy="280"
        r="8"
        fill="#ff69b4"
        opacity={blushOpacity}
        style={{ transition: 'opacity 0.3s ease' }}
      />

      {/* 天线 */}
      <line x1="256" y1="170" x2="256" y2="120" stroke="url(#char-robotBody)" strokeWidth="8" strokeLinecap="round" />
      <circle
        className="character-antenna-tip"
        cx="256"
        cy="110"
        r="15"
        fill="#00d4ff"
        filter="url(#char-strongGlow)"
        style={{ animation: antennaAnim }}
      />
      <circle cx="256" cy="110" r="8" fill="#ffffff" />

      {/* Glitch 装饰 */}
      <rect x="180" y="260" width="3" height="15" fill="#ff00ff" opacity="0.5" />
      <rect x="329" y="250" width="3" height="20" fill="#00ffff" opacity="0.5" />

      {/* 数据流装饰 */}
      <text x="140" y="380" fill="#00d4ff" fontSize="8" fontFamily="monospace" opacity="0.4">&gt;AI.exe</text>
      <text x="320" y="390" fill="#ff00ff" fontSize="8" fontFamily="monospace" opacity="0.4">v2.0.26</text>

      {/* 能量环 */}
      <ellipse
        className="character-energy-ring"
        cx="256"
        cy="260"
        rx="115"
        ry="105"
        fill="none"
        stroke="#00d4ff"
        strokeWidth="1"
        opacity="0.2"
        strokeDasharray="10,5"
        style={{ animation: `energy-ring-rotate ${ringDuration} linear infinite`, transformOrigin: '256px 260px' }}
      />
    </svg>
  )
})
