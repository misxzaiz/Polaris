/**
 * Polaris 角色组件（可爱版）
 *
 * 基于 polaris-commander 的北极星机器人，可爱化改造：
 * - 柔和渐变色彩（粉蓝系）
 * - 圆润大头 + 大眼睛
 * - 夸张腮红 + Q 版嘴巴
 * - 去除 glitch/代码等赛博朋克元素
 * - 增加萌系装饰（小星星、浮动爱心、柔光）
 */

import { memo, useMemo } from 'react'
import type { CharacterExpression } from './expressions'
import {
  MOUTH_PATHS,
  LEFT_EYE_STYLES,
  RIGHT_EYE_STYLES,
  BLUSH_OPACITY,
  ANTENNA_ANIMATION,
} from './expressions'

export interface PolarisCharacterProps {
  expression: CharacterExpression
  size?: number
  mouthOpen?: number
  className?: string
}

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

  const mouthPath = useMemo(() => {
    if (mouthOpen !== undefined && mouthOpen > 0) {
      const openFactor = Math.max(0, Math.min(1, mouthOpen))
      const y = Math.round(318 + openFactor * 30)
      return `M228,${y} Q256,${y + 25 * openFactor} 284,${y}`
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
        {/* 柔和的身体渐变：粉蓝系 */}
        <linearGradient id="char-body" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: '#a5d8ff' }} />
          <stop offset="50%" style={{ stopColor: '#b197fc' }} />
          <stop offset="100%" style={{ stopColor: '#d0bfff' }} />
        </linearGradient>

        {/* 星星眼睛渐变：温暖金黄 */}
        <linearGradient id="char-star" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: '#ffe066' }} />
          <stop offset="50%" style={{ stopColor: '#fff3bf' }} />
          <stop offset="100%" style={{ stopColor: '#ffd43b' }} />
        </linearGradient>

        {/* 耳机渐变：柔和粉紫 */}
        <linearGradient id="char-hp" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style={{ stopColor: '#da77f2' }} />
          <stop offset="50%" style={{ stopColor: '#f783ac' }} />
          <stop offset="100%" style={{ stopColor: '#da77f2' }} />
        </linearGradient>

        {/* 天线球渐变：柔蓝 */}
        <radialGradient id="char-antenna" cx="40%" cy="40%">
          <stop offset="0%" style={{ stopColor: '#a5d8ff' }} />
          <stop offset="100%" style={{ stopColor: '#4dabf7' }} />
        </radialGradient>

        {/* 背景渐变：柔和深色但温暖 */}
        <radialGradient id="char-bg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" style={{ stopColor: '#2b2d42' }} />
          <stop offset="60%" style={{ stopColor: '#1a1a2e' }} />
          <stop offset="100%" style={{ stopColor: '#12121a' }} />
        </radialGradient>

        {/* 柔光滤镜 */}
        <filter id="char-softGlow">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        <filter id="char-starGlow">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* 腮红模糊 */}
        <filter id="char-blushBlur">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>

      {/* ===== 背景 ===== */}
      <circle cx="256" cy="256" r="250" fill="url(#char-bg)" stroke="#3d3d5c" strokeWidth="2.5" />

      {/* 背景小星星（可爱散布） */}
      <circle cx="90" cy="95" r="3" fill="#ffe066" opacity="0.5">
        <animate attributeName="opacity" values="0.5;0.2;0.5" dur="3s" repeatCount="indefinite" />
      </circle>
      <circle cx="415" cy="78" r="2.5" fill="#a5d8ff" opacity="0.45">
        <animate attributeName="opacity" values="0.45;0.15;0.45" dur="4s" repeatCount="indefinite" />
      </circle>
      <circle cx="440" cy="190" r="2" fill="#da77f2" opacity="0.35">
        <animate attributeName="opacity" values="0.35;0.1;0.35" dur="3.5s" repeatCount="indefinite" />
      </circle>
      <circle cx="72" cy="380" r="2.5" fill="#ffe066" opacity="0.4">
        <animate attributeName="opacity" values="0.4;0.15;0.4" dur="2.8s" repeatCount="indefinite" />
      </circle>
      <circle cx="400" cy="420" r="2" fill="#a5d8ff" opacity="0.35">
        <animate attributeName="opacity" values="0.35;0.1;0.35" dur="3.2s" repeatCount="indefinite" />
      </circle>
      {/* 四角小星星装饰 */}
      <path d="M160,85 L162,80 L164,85 L169,83 L164,85 L166,90 L164,87 L162,90 L160,87 L155,83 Z" fill="#ffe066" opacity="0.3">
        <animate attributeName="opacity" values="0.3;0.1;0.3" dur="4s" repeatCount="indefinite" />
      </path>
      <path d="M350,440 L352,435 L354,440 L359,438 L354,440 L356,445 L354,442 L352,445 L350,442 L345,438 Z" fill="#da77f2" opacity="0.25">
        <animate attributeName="opacity" values="0.25;0.08;0.25" dur="3.5s" repeatCount="indefinite" />
      </path>

      {/* ===== 耳机 ===== */}
      {/* 头带 — 圆弧更柔和 */}
      <path
        d="M140,195 Q140,110 256,90 Q372,110 372,195"
        stroke="url(#char-hp)"
        strokeWidth="14"
        fill="none"
        strokeLinecap="round"
        filter="url(#char-softGlow)"
      />

      {/* 左耳机 — 更圆润 */}
      <ellipse cx="128" cy="225" rx="40" ry="48" fill="#252540" stroke="url(#char-hp)" strokeWidth="3.5" filter="url(#char-softGlow)" />
      <ellipse cx="128" cy="225" rx="30" ry="38" fill="#2f2f50" />
      <ellipse cx="128" cy="225" rx="20" ry="26" fill="#252540" />
      {/* 耳机内部柔光 */}
      <ellipse cx="128" cy="225" rx="14" ry="18" fill="#da77f2" opacity="0.15" />
      {/* 信号波纹 */}
      <path className="character-headphone-wave" d="M92,208 Q102,202 108,212" stroke="#f783ac" strokeWidth="1.8" fill="none" opacity="0.5" />
      <path className="character-headphone-wave" d="M86,218 Q100,210 108,222" stroke="#f783ac" strokeWidth="1.5" fill="none" opacity="0.3" />

      {/* 右耳机 */}
      <ellipse cx="384" cy="225" rx="40" ry="48" fill="#252540" stroke="url(#char-hp)" strokeWidth="3.5" filter="url(#char-softGlow)" />
      <ellipse cx="384" cy="225" rx="30" ry="38" fill="#2f2f50" />
      <ellipse cx="384" cy="225" rx="20" ry="26" fill="#252540" />
      <ellipse cx="384" cy="225" rx="14" ry="18" fill="#da77f2" opacity="0.15" />
      <path className="character-headphone-wave" d="M420,208 Q410,202 404,212" stroke="#f783ac" strokeWidth="1.8" fill="none" opacity="0.5" />
      <path className="character-headphone-wave" d="M426,218 Q412,210 404,222" stroke="#f783ac" strokeWidth="1.5" fill="none" opacity="0.3" />

      {/* ===== 头部主体 — 更圆更Q ===== */}
      <ellipse cx="256" cy="265" rx="108" ry="98" fill="url(#char-body)" />

      {/* 头部大高光 — 玻璃质感 */}
      <ellipse cx="228" cy="210" rx="55" ry="32" fill="rgba(255,255,255,0.2)" />
      <ellipse cx="220" cy="208" rx="30" ry="15" fill="rgba(255,255,255,0.12)" />

      {/* 面板分隔线 — 柔和弧线 */}
      <path d="M175,310 Q256,335 337,310" stroke="rgba(255,255,255,0.15)" strokeWidth="2" fill="none" />

      {/* ===== 左眼 — 北极星（放大，圆润化） ===== */}
      <g
        className="character-eye-left"
        filter="url(#char-starGlow)"
        style={{
          opacity: leftEye.opacity,
          transform: `translate(${leftEye.translateX}px, ${leftEye.translateY}px) scale(${leftEye.scale})`,
          transformOrigin: '218px 255px',
          animation: leftEye.animation,
        }}
      >
        {/* 星星本体（更大更圆润） */}
        <polygon
          points="22,0 27,14 42,14 30,24 35,40 22,30 9,40 14,24 2,14 17,14"
          fill="url(#char-star)"
        />
        {/* 中心高光 */}
        <circle cx="22" cy="20" r="5" fill="rgba(255,255,255,0.6)" />
        {/* 星芒（短一些更可爱） */}
        <line x1="22" y1="-6" x2="22" y2="-12" stroke="#ffe066" strokeWidth="2" strokeLinecap="round" />
        <line x1="22" y1="46" x2="22" y2="52" stroke="#ffe066" strokeWidth="2" strokeLinecap="round" />
        <line x1="-6" y1="20" x2="-12" y2="20" stroke="#ffe066" strokeWidth="2" strokeLinecap="round" />
        <line x1="50" y1="20" x2="56" y2="20" stroke="#ffe066" strokeWidth="2" strokeLinecap="round" />
        <line x1="-3" y1="-3" x2="-9" y2="-9" stroke="#ffe066" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="47" y1="-3" x2="53" y2="-9" stroke="#ffe066" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="-3" y1="43" x2="-9" y2="49" stroke="#ffe066" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="47" y1="43" x2="53" y2="49" stroke="#ffe066" strokeWidth="1.5" strokeLinecap="round" />
      </g>

      {/* ===== 右眼 — 北极星 ===== */}
      <g
        className="character-eye-right"
        filter="url(#char-starGlow)"
        style={{
          opacity: rightEye.opacity,
          transform: `translate(${rightEye.translateX}px, ${rightEye.translateY}px) scale(${rightEye.scale})`,
          transformOrigin: '312px 255px',
          animation: rightEye.animation,
        }}
      >
        <polygon
          points="22,0 27,14 42,14 30,24 35,40 22,30 9,40 14,24 2,14 17,14"
          fill="url(#char-star)"
        />
        <circle cx="22" cy="20" r="5" fill="rgba(255,255,255,0.6)" />
        <line x1="22" y1="-6" x2="22" y2="-12" stroke="#ffe066" strokeWidth="2" strokeLinecap="round" />
        <line x1="22" y1="46" x2="22" y2="52" stroke="#ffe066" strokeWidth="2" strokeLinecap="round" />
        <line x1="-6" y1="20" x2="-12" y2="20" stroke="#ffe066" strokeWidth="2" strokeLinecap="round" />
        <line x1="50" y1="20" x2="56" y2="20" stroke="#ffe066" strokeWidth="2" strokeLinecap="round" />
        <line x1="-3" y1="-3" x2="-9" y2="-9" stroke="#ffe066" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="47" y1="-3" x2="53" y2="-9" stroke="#ffe066" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="-3" y1="43" x2="-9" y2="49" stroke="#ffe066" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="47" y1="43" x2="53" y2="49" stroke="#ffe066" strokeWidth="1.5" strokeLinecap="round" />
      </g>

      {/* ===== 嘴巴 — Q 版圆润 ===== */}
      <path
        className="character-mouth"
        d={mouthPath}
        stroke="#4a3f6b"
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
      />

      {/* ===== 腮红 — 更大更柔和（模糊扩散） ===== */}
      <ellipse
        className="character-blush-left"
        cx="168"
        cy="290"
        rx="18"
        ry="10"
        fill="#f783ac"
        opacity={blushOpacity}
        filter="url(#char-blushBlur)"
        style={{ transition: 'opacity 0.4s ease' }}
      />
      <ellipse
        className="character-blush-right"
        cx="344"
        cy="290"
        rx="18"
        ry="10"
        fill="#f783ac"
        opacity={blushOpacity}
        filter="url(#char-blushBlur)"
        style={{ transition: 'opacity 0.4s ease' }}
      />

      {/* ===== 天线 — 更细更萌 ===== */}
      <line x1="256" y1="170" x2="256" y2="118" stroke="url(#char-body)" strokeWidth="6" strokeLinecap="round" />
      {/* 天线球 — 更大，带径向渐变 */}
      <circle
        className="character-antenna-tip"
        cx="256"
        cy="108"
        r="18"
        fill="url(#char-antenna)"
        filter="url(#char-softGlow)"
        style={{ animation: antennaAnim }}
      />
      {/* 天线球高光 */}
      <circle cx="251" cy="103" r="6" fill="rgba(255,255,255,0.5)" />
      <circle cx="249" cy="101" r="3" fill="rgba(255,255,255,0.3)" />

      {/* ===== 可爱装饰：浮动小星星 ===== */}
      <g opacity="0.5">
        {/* 左侧小星星 */}
        <path d="M145,155 L147,149 L149,155 L155,153 L149,155 L151,161 L149,158 L147,161 L145,158 L139,153 Z" fill="#ffe066">
          <animateTransform attributeName="transform" type="rotate" values="0 147 155;15 147 155;0 147 155" dur="6s" repeatCount="indefinite" />
        </path>
        {/* 右侧小星星 */}
        <path d="M365,140 L367,134 L369,140 L375,138 L369,140 L371,146 L369,143 L367,146 L365,143 L359,138 Z" fill="#a5d8ff">
          <animateTransform attributeName="transform" type="rotate" values="0 367 140;-12 367 140;0 367 140" dur="5s" repeatCount="indefinite" />
        </path>
      </g>

      {/* ===== 柔和能量环 — 虚线圆点，更萌 ===== */}
      <ellipse
        className="character-energy-ring"
        cx="256"
        cy="265"
        rx="120"
        ry="110"
        fill="none"
        stroke="rgba(165,216,255,0.15)"
        strokeWidth="1.5"
        strokeDasharray="4,8"
        style={{ animation: 'energy-ring-rotate 20s linear infinite', transformOrigin: '256px 265px' }}
      />
    </svg>
  )
})
