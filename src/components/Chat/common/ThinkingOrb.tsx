/**
 * ThinkingOrb - 等待 AI 回复时的 Polaris 旋转图标组件
 *
 * 纯动画组件，无文字。在消息发送后、首 token 到达前的 PENDING 状态显示，
 * 使用与应用顶部一致的 Polaris 品牌旋转动画（双圈反向旋转 + 中心光晕）。
 *
 * 设计原则：
 * - 挂载即渲染，零帧延迟
 * - 使用 inline style 控制 opacity，避免 <style> 标签动态更新不可靠
 * - 复用全局 keyframes：polaris-spin / polaris-spin-rev / polaris-glow
 */

import { memo } from 'react'

export interface ThinkingOrbProps {
  /** 是否正在等待（PENDING 状态） */
  isPending: boolean
  /** 紧凑模式（多窗口格子） */
  compact?: boolean
}

export const ThinkingOrb = memo(function ThinkingOrb({
  isPending,
  compact = false,
}: ThinkingOrbProps) {
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
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
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
        {/* 主旋转弧（蓝紫渐变） */}
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
        {/* 内圈反向旋转 */}
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
    </div>
  )
})