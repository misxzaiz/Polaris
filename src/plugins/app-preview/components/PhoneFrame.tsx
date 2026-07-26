import { forwardRef, useImperativeHandle } from 'react'
import type { DevicePreset } from '@/plugins/app-preview/constants/devices'

export interface PhoneFrameProps {
  /** 当前选中的设备预设 */
  device: DevicePreset
  /** 设备像素比文本（显示在底部） */
  dprText?: string
  /** 是否显示底部 Home Indicator（iOS 风格横条） */
  showHomeIndicator?: boolean
  /** 内容渲染函数 */
  children: React.ReactNode
}

export interface PhoneFrameRef {
  getScale: () => number
}

/**
 * PhoneFrame — 手机外壳组件
 *
 * 始终以原生设备像素尺寸渲染（如 390×844），缩放由父容器通过 `transform: scale` 控制。
 * 父容器传入 scale 时配合 transform-origin: top center 做居中缩放。
 */
export const PhoneFrame = forwardRef<PhoneFrameRef, PhoneFrameProps>(function PhoneFrame(
  { device, dprText, showHomeIndicator = true, children },
  ref,
) {
  useImperativeHandle(ref, () => ({
    getScale: () => 1,
  }), [])

  const hasNotch = device.hasNotch

  // 外壳尺寸 = 屏幕尺寸 + 左右边框
  const shellWidth = device.width + 20
  const shellHeight = device.height + 20

  return (
    <div
      className="phone-frame"
      style={{ width: shellWidth, height: shellHeight } as React.CSSProperties}
    >
      {/* 手机外壳 */}
      <div className="phone-frame__shell">
        {/* 顶部刘海 */}
        {hasNotch && <div className="phone-frame__notch" />}

        {/* 预览内容区 */}
        <div className="phone-frame__preview">
          {children}
        </div>

        {/* 底部 Home Indicator */}
        {showHomeIndicator && <div className="phone-frame__home-indicator" />}
      </div>

      {/* 设备信息标签 */}
      {dprText && (
        <div className="phone-frame__label">
          {device.name}
          <span className="phone-frame__dpr">{dprText}</span>
        </div>
      )}

      <style>{PhoneFrameStyles}</style>
    </div>
  )
})

const PhoneFrameStyles = `
  .phone-frame {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
  }

  .phone-frame__shell {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 40px;
    border: 10px solid rgba(255, 255, 255, 0.15);
    background: #1a1a1f;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* 顶部刘海 / Dynamic Island */
  .phone-frame__notch {
    position: absolute;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    width: 120px;
    height: 28px;
    border-radius: 20px;
    background: #000;
    z-index: 10;
  }

  .phone-frame__notch::after {
    content: '';
    position: absolute;
    top: 50%;
    right: 12px;
    transform: translateY(-50%);
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #1a1a2e;
    border: 1px solid #2a2a3e;
  }

  /* 预览内容区 — 白色背景，iframe 填满 */
  .phone-frame__preview {
    flex: 1;
    min-height: 0;
    position: relative;
    background: #fff;
    overflow: hidden;
  }

  /* 底部 Home Indicator（iOS 横条） */
  .phone-frame__home-indicator {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    width: 120px;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.4);
    z-index: 5;
  }

  /* 设备标签 */
  .phone-frame__label {
    position: absolute;
    bottom: -18px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 10px;
    color: rgba(255, 255, 255, 0.35);
    white-space: nowrap;
    pointer-events: none;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .phone-frame__dpr {
    color: rgba(255, 255, 255, 0.2);
  }
`