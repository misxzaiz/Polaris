import { forwardRef, useImperativeHandle } from 'react'
import type { DevicePreset } from '@/plugins/app-preview/constants/devices'

export interface PhoneFrameProps {
  /** 当前选中的设备预设 */
  device: DevicePreset
  /** 设备像素比文本（显示在底部） */
  dprText?: string
  /** 是否显示底部 Home Indicator（iOS 风格横条） */
  showHomeIndicator?: boolean
  /** 整体缩放比例（基于预览容器自适应计算，默认 1） */
  scale?: number
  /** 内容渲染函数 */
  children: React.ReactNode
}

export interface PhoneFrameRef {
  /** 获取当前缩放值 */
  getScale: () => number
}

/**
 * 手机外壳组件（PhoneFrame）
 *
 * 渲染一个带边框的手机外框，内部内容通过 `transform: scale` 自适应缩放。
 *
 * 结构：
 *   ┌──────────────────────┐  ← shell（固定尺寸）
 *   │ ┌──────────────────┐ │
 *   │ │  ┌────────────┐  │ │  ← previewBox（CSS 变量驱动尺寸）
 *   │ │  │  ┌──────┐  │  │ │  ← content（transform: scale 缩放）
 *   │ │  │  │内容  │  │  │ │
 *   │ │  │  └──────┘  │  │ │
 *   │ │  └────────────┘  │ │
 *   │ │    Home Indicator │ │
 *   │ └──────────────────┘ │
 *   └──────────────────────┘
 *
 * CSS 变量语义：
 *   --phone-frame-scale：外层预览区相对 device 像素的比例（内容放大方向）
 *   --phone-frame-scale-inverted：--phone-frame-scale 的倒数（内容缩小方向）
 *   最终 content.scale = --phone-frame-scale × --phone-frame-scale-inverted = 1（视觉正确）
 */
export const PhoneFrame = forwardRef<PhoneFrameRef, PhoneFrameProps>(function PhoneFrame(
  { device, dprText, showHomeIndicator = true, scale: customScale = 1, children },
  ref,
) {
  useImperativeHandle(ref, () => ({
    getScale: () => customScale,
  }), [customScale])

  const hasNotch = device.hasNotch

  return (
    <div className="phone-frame"
      style={{
        '--pf-width': `${device.width}px`,
        '--pf-height': `${device.height}px`,
        '--pf-scale': customScale,
      } as React.CSSProperties}>
      <div className="phone-frame__shell">
        {/* 顶部状态栏 / 刘海 */}
        {hasNotch && (
          <div className="phone-frame__notch" />
        )}

        {/* 预览内容容器 */}
        <div className="phone-frame__preview">
          {children}

          {/* 底部 Home Indicator（iOS 风格横条） */}
          {showHomeIndicator && (
            <div className="phone-frame__home-indicator" />
          )}
        </div>

        {/* 设备信息标签（底部居中） */}
        <div className="phone-frame__label">
          {device.name}
          {dprText && <span className="phone-frame__dpr">{dprText}</span>}
        </div>
      </div>

      <style>{PhoneFrameStyles}</style>
    </div>
  )
})

const PhoneFrameStyles = `
  .phone-frame {
    --pf-width: 390px;
    --pf-height: 844px;
    --pf-radius: 40px;
    --pf-border-width: 10px;
    --pf-border-color: rgba(255, 255, 255, 0.15);
    --pf-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
    --pf-bg: #1a1a1f;
    --pf-scale: 1;
    width: calc(var(--pf-width) * var(--pf-scale));
    height: calc(var(--pf-height) * var(--pf-scale));
  }

  .phone-frame__shell {
    position: relative;
    width: calc(var(--pf-width) + var(--pf-border-width) * 2);
    height: calc(var(--pf-height) + var(--pf-border-width) * 2);
    border-radius: var(--pf-radius);
    border: var(--pf-border-width) solid var(--pf-border-color);
    background: var(--pf-bg);
    box-shadow: var(--pf-shadow);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transform: scale(var(--pf-scale));
    transform-origin: top left;
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

  /* 预览内容区 */
  .phone-frame__preview {
    flex: 1;
    min-height: 0;
    position: relative;
    background: #fff;
    overflow: hidden;
    transform: scale(calc(1 / var(--pf-scale)));
    transform-origin: top left;
    width: var(--pf-width);
    height: var(--pf-height);
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
    bottom: 4px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 10px;
    color: rgba(255, 255, 255, 0.35);
    white-space: nowrap;
    pointer-events: none;
    display: flex;
    align-items: center;
    gap: 4px;
    z-index: 10;
  }

  .phone-frame__dpr {
    color: rgba(255, 255, 255, 0.2);
  }
`
