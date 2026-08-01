/**
 * ThinkingOrb - 等待 AI 回复时的 Orb 动画组件
 *
 * 在消息发送后、首 token 到达前的 PENDING 状态显示，
 * 用旋转的同心环动画填充空白等待期，提升用户体验。
 *
 * 设计：
 * - 三层同心环旋转（蓝色→紫色→蓝色渐变）
 * - 文案按时间轮播：连接中 → 思考中 → 生成中
 * - 淡入/淡出过渡动画
 * - 纯 CSS 内联 style 标签，无外部依赖
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

  // 退出动画状态
  const [exiting, setExiting] = useState(false)
  const [shouldRender, setShouldRender] = useState(false)

  // 当 isPending 变化时控制渲染和退出动画
  useEffect(() => {
    if (isPending) {
      setShouldRender(true)
      setExiting(false)
      startTimeRef.current = Date.now()
      setPhase('connecting')
    } else if (shouldRender) {
      // 触发退出动画
      setExiting(true)
      const timer = setTimeout(() => {
        setShouldRender(false)
        setExiting(false)
      }, 250)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [isPending, shouldRender])

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

  if (!shouldRender) return null

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
      {/* 内联 CSS 动画 — 与 ThinkingBlockRenderer 同样的方式注入 */}
      <style>{`
        @keyframes orb-spin {
          to { transform: rotate(360deg); }
        }
        @keyframes orb-fade-in {
          from { opacity: 0; transform: scale(0.9); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes orb-fade-out {
          from { opacity: 1; transform: scale(1); }
          to { opacity: 0; transform: scale(0.8); }
        }
        .thinking-orb-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 48px 16px;
          gap: 16px;
          animation: orb-fade-in 0.3s ease-out;
          user-select: none;
        }
        .thinking-orb-container.exit {
          animation: orb-fade-out 0.25s ease-in forwards;
        }
        .thinking-orb {
          position: relative;
          flex-shrink: 0;
        }
        .thinking-orb-ring {
          position: absolute;
          border-radius: 50%;
          border: 2.5px solid transparent;
          border-top-color: #3b82f6;
          animation: orb-spin 1s linear infinite;
          will-change: transform;
        }
        .thinking-orb-ring--reverse {
          border-top-color: transparent;
          border-right-color: #8b5cf6;
          animation: orb-spin 0.8s linear infinite reverse;
        }
        .thinking-orb-ring:nth-child(3) {
          border-top-color: transparent;
          border-bottom-color: #60a5fa;
          animation: orb-spin 0.6s linear infinite;
        }
        .thinking-orb-text {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
        }
        .thinking-orb-title {
          font-size: 14px;
          font-weight: 600;
          color: #e0e0e0;
        }
        .thinking-orb-message {
          font-size: 12px;
          color: #888;
        }
      `}</style>
      <div
        className={`thinking-orb-container${exiting ? ' exit' : ''}`}
        role="presentation"
        aria-hidden="true"
      >
        <div
          className="thinking-orb"
          style={{ width: orbSize, height: orbSize }}
        >
          <span
            className="thinking-orb-ring"
            style={{
              width: ringSizes[0],
              height: ringSizes[0],
              top: ringOffsets[0],
              left: ringOffsets[0],
            }}
          />
          <span
            className="thinking-orb-ring thinking-orb-ring--reverse"
            style={{
              width: ringSizes[1],
              height: ringSizes[1],
              top: ringOffsets[1],
              left: ringOffsets[1],
            }}
          />
          <span
            className="thinking-orb-ring"
            style={{
              width: ringSizes[2],
              height: ringSizes[2],
              top: ringOffsets[2],
              left: ringOffsets[2],
            }}
          />
        </div>

        <div className="thinking-orb-text">
          <span className="thinking-orb-title">
            {displayName} 正在思考
          </span>
          <span className="thinking-orb-message">
            {phaseMessage}
          </span>
        </div>
      </div>
    </>
  )
})
