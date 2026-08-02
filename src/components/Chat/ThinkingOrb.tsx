/**
 * ThinkingOrb - 等待 AI 回复时的 Orb 动画组件
 *
 * 在消息发送后、首 token 到达前的 PENDING 状态显示，
 * 用旋转的同心环动画填充空白等待期，提升用户体验。
 *
 * 设计原则：
 * - 挂载即渲染，零帧延迟
 * - 使用 inline style 控制 opacity，避免 <style> 标签动态更新不可靠
 * - 三层同心环旋转（蓝色→紫色→蓝色渐变）
 * - 文案按时间轮播：连接中 → 思考中 → 生成中
 */

import { memo, useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

/** 文案轮播阶段 */
type OrbPhase = 'connecting' | 'thinking' | 'generating'

/** 各阶段的时间阈值（ms） */
const PHASE_THRESHOLDS = {
  connecting: 0,
  thinking: 800,
  generating: 3000,
} as const

/** 检查间隔 */
const TICK_INTERVAL = 400

export interface ThinkingOrbProps {
  /** 是否正在等待（PENDING 状态） */
  isPending: boolean
  /** 引擎名称 */
  engineName?: string
  /** 紧凑模式（多窗口格子） */
  compact?: boolean
  /** 外部传入的进度文案（覆盖自动轮播） */
  message?: string
}

const spinKeyframes = `
@keyframes orb-spin {
  to { transform: rotate(360deg); }
}
`

export const ThinkingOrb = memo(function ThinkingOrb({
  isPending,
  engineName,
  compact = false,
  message: externalMessage,
}: ThinkingOrbProps) {
  const { t } = useTranslation('chat')

  // 内部文案轮播阶段
  const [phase, setPhase] = useState<OrbPhase>('connecting')
  const startTimeRef = useRef<number>(0)

  // 重置计时器：每次 isPending 从 false→true 时重置
  const prevPendingRef = useRef(false)
  if (isPending && !prevPendingRef.current) {
    startTimeRef.current = Date.now()
    setPhase('connecting')
  }
  prevPendingRef.current = isPending

  // 文案轮播定时器
  useEffect(() => {
    if (!isPending) return

    const timer = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current
      if (elapsed >= PHASE_THRESHOLDS.generating) {
        setPhase('generating')
      } else if (elapsed >= PHASE_THRESHOLDS.thinking) {
        setPhase('thinking')
      }
    }, TICK_INTERVAL)

    return () => clearInterval(timer)
  }, [isPending])

  // 当前文案
  const phaseMessage = externalMessage ?? (() => {
    switch (phase) {
      case 'connecting': return t('thinkingOrb.connecting', '正在连接引擎…')
      case 'thinking': return t('thinkingOrb.thinking', 'AI 正在思考…')
      case 'generating': return t('thinkingOrb.generating', '还在生成中，请稍候…')
    }
  })()

  // 引擎名
  const displayName = engineName ?? 'AI'

  // 紧凑模式尺寸缩小
  const orbSize = compact ? 28 : 48
  const ringSizes = compact ? [28, 20, 14] : [48, 36, 24]
  const ringOffsets = compact ? [0, 4, 7] : [0, 6, 12]

  return (
    <>
      <style>{spinKeyframes}</style>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px 16px',
          gap: '16px',
          userSelect: 'none',
          opacity: isPending ? 1 : 0,
          transition: 'opacity 0.25s ease-in-out',
        }}
        role="presentation"
        aria-hidden="true"
      >
        <div
          style={{
            position: 'relative',
            flexShrink: 0,
            width: orbSize,
            height: orbSize,
          }}
        >
          {/* 外层环 */}
          <span
            style={{
              position: 'absolute',
              borderRadius: '50%',
              border: '2.5px solid transparent',
              borderTopColor: 'var(--orb-color-outer, #3b82f6)',
              animation: 'orb-spin 1s linear infinite',
              willChange: 'transform',
              width: ringSizes[0],
              height: ringSizes[0],
              top: ringOffsets[0],
              left: ringOffsets[0],
            }}
          />
          {/* 中层环（反向） */}
          <span
            style={{
              position: 'absolute',
              borderRadius: '50%',
              border: '2.5px solid transparent',
              borderTopColor: 'transparent',
              borderRightColor: 'var(--orb-color-middle, #8b5cf6)',
              animation: 'orb-spin 0.8s linear infinite reverse',
              willChange: 'transform',
              width: ringSizes[1],
              height: ringSizes[1],
              top: ringOffsets[1],
              left: ringOffsets[1],
            }}
          />
          {/* 内层环 */}
          <span
            style={{
              position: 'absolute',
              borderRadius: '50%',
              border: '2.5px solid transparent',
              borderTopColor: 'transparent',
              borderBottomColor: 'var(--orb-color-inner, #60a5fa)',
              animation: 'orb-spin 0.6s linear infinite',
              willChange: 'transform',
              width: ringSizes[2],
              height: ringSizes[2],
              top: ringOffsets[2],
              left: ringOffsets[2],
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
          <span style={{ fontSize: '14px', fontWeight: 600, color: '#e0e0e0' }}>
            {displayName} 正在思考
          </span>
          <span style={{ fontSize: '12px', color: '#888' }}>
            {phaseMessage}
          </span>
        </div>
      </div>
    </>
  )
})