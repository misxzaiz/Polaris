/**
 * ThinkingOrb - 等待 AI 回复时的 Polaris 旋转图标组件
 *
 * 在消息发送后、首 token 到达前的 PENDING 状态显示，
 * 使用与应用顶部一致的 Polaris 品牌旋转动画（双圈反向旋转 + 中心光晕），
 * 下方展示文案轮播（连接中 → 思考中 → 生成中）。
 *
 * 设计原则：
 * - 挂载即渲染，零帧延迟
 * - 使用 inline style 控制 opacity，避免 <style> 标签动态更新不可靠
 * - 复用全局 keyframes：polaris-spin / polaris-spin-rev / polaris-glow
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

  // 紧凑模式尺寸缩小（与 ConnectingOverlay / TopMenuBar 一致）
  const iconSize = compact ? 28 : 48
  const outerBorder = compact ? 2 : 3
  const innerInset = compact ? 3 : 5
  const innerBorder = compact ? 1.5 : 2
  const glowSize = compact ? 2 : 3

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 16px',
        gap: '14px',
        userSelect: 'none',
        opacity: isPending ? 1 : 0,
        transition: 'opacity 0.25s ease-in-out',
      }}
      role="presentation"
      aria-hidden="true"
    >
      {/* Polaris 品牌旋转图标：双圈反向旋转 + 中心光晕 */}
      <div
        style={{
          position: 'relative',
          flexShrink: 0,
          width: iconSize,
          height: iconSize,
        }}
      >
        {/* 背景圈 */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: `${outerBorder}px solid var(--border-subtle, rgba(255,255,255,0.1))`,
          }}
        />
        {/* 主旋转弧（蓝紫渐变）— 与 ConnectingOverlay 一致 */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: `${outerBorder}px solid transparent`,
            borderTopColor: 'var(--orb-color-outer, #3b82f6)',
            borderRightColor: 'var(--orb-color-accent, #818cf8)',
            animation: 'polaris-spin 1.2s cubic-bezier(0.4, 0, 0.2, 1) infinite',
            willChange: 'transform',
          }}
        />
        {/* 内圈反向旋转 — 与 ConnectingOverlay 一致：bottom + left 弧线 */}
        <div
          style={{
            position: 'absolute',
            inset: innerInset,
            borderRadius: '50%',
            border: `${innerBorder}px solid transparent`,
            borderBottomColor: 'var(--orb-color-inner, rgba(59,130,246,0.3))',
            borderLeftColor: 'var(--orb-color-inner-accent, rgba(129,140,248,0.3))',
            animation: 'polaris-spin-rev 2s linear infinite',
            willChange: 'transform',
          }}
        />
        {/* 中心光晕 */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: glowSize,
            height: glowSize,
            marginTop: -glowSize / 2,
            marginLeft: -glowSize / 2,
            borderRadius: '50%',
            backgroundColor: 'var(--orb-color-outer, #3b82f6)',
            animation: 'polaris-glow 1.5s ease-in-out infinite',
          }}
        />
      </div>

      {/* 文案区域 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
        <span style={{ fontSize: '14px', fontWeight: 600, color: '#e0e0e0' }}>
          {t('thinkingOrb.title', { name: displayName })}
        </span>
        <span style={{ fontSize: '12px', color: '#888' }}>
          {phaseMessage}
        </span>
      </div>
    </div>
  )
})