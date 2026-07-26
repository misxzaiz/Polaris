import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import {
  Smartphone,
  ChevronDown,
  ExternalLink,
  RefreshCw,
  FlipHorizontal,
  Scaling,
} from 'lucide-react'
import { useDeviceStore } from '@/plugins/app-preview/stores/deviceStore'
import { PhoneFrame } from '@/plugins/app-preview/components/PhoneFrame'
import { PreviewContent } from '@/plugins/app-preview/components/PreviewContent'
import { DeviceSelector } from '@/plugins/app-preview/components/DeviceSelector'
import { computeScale } from '@/plugins/app-preview/utils/deviceStyle'

import type { ComponentType } from 'react'

interface AppPreviewPanelProps {
  /** 插件标识（由插件系统注入，可忽略） */
  pluginId?: string
  /** 发送到聊天回调（由插件系统注入，可忽略） */
  onSendToChat?: (message: string) => void | Promise<void>
}

/**
 * AppPreviewPanel — 手机 App 预览主面板
 *
 * 功能：
 * 1. 手机外壳预览（带仿真的设备大小、刘海、Home Indicator）
 * 2. 多设备切换（iPhone / Android / 自定义）
 * 3. URL 输入框 + 刷新
 * 4. 旋转（横竖屏切换）
 * 5. 缩放控制
 * 6. 页面加载指示器
 *
 * 架构：
 *   左侧主体区：PhoneFrame → PreviewContent (iframe)
 *   右侧面板（可折叠）：DeviceSelector 设备选择
 */
export const AppPreviewPanel: ComponentType<AppPreviewPanelProps & { pluginId: string }> = function AppPreviewPanel() {
  const {
    device: currentDevice,
    selectDevice,
    scale,
    setScale,
    autoScale,
    toggleAutoScale,
  } = useDeviceStore()

  // 状态
  const [url, setUrl] = useState('http://localhost:5173')
  const [currentSrc, setCurrentSrc] = useState('')
  const [isRotated, setIsRotated] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [showDeviceSelector, setShowDeviceSelector] = useState(true)
  const [previewContainerSize, setPreviewContainerSize] = useState<{ w: number; h: number } | null>(null)

  const previewContainerRef = useRef<HTMLDivElement>(null)
  const phoneFrameRef = useRef<HTMLDivElement>(null)

  // 监听预览容器尺寸变化
  useEffect(() => {
    const el = previewContainerRef.current
    if (!el) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { inlineSize, blockSize } = entry.borderBoxSize[0]
        setPreviewContainerSize({ w: inlineSize, h: blockSize })
      }
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 计算实际缩放值
  const effectiveScale = useMemo(() => {
    if (!autoScale || !previewContainerSize || !currentDevice) return scale

    const computed = computeScale(
      currentDevice,
      previewContainerSize.w,
      previewContainerSize.h,
    )
    // 确保最小值可见
    return Math.max(0.25, computed)
  }, [autoScale, scale, previewContainerSize, currentDevice])

  // 真正的设备尺寸（考虑旋转）
  const deviceWidth = isRotated ? (currentDevice?.height ?? 0) : (currentDevice?.width ?? 0)
  const deviceHeight = isRotated ? (currentDevice?.width ?? 0) : (currentDevice?.height ?? 0)

  // 处理导航
  const handleNavigate = useCallback(() => {
    if (!url.trim()) return

    // 补全 URL
    let targetUrl = url.trim()
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = `http://${targetUrl}`
    }

    setIsLoading(true)
    setCurrentSrc(targetUrl)
  }, [url])

  // 处理刷新
  const handleRefresh = useCallback(() => {
    setIsLoading(true)
    setCurrentSrc((prev) => prev ? `${prev}${prev.includes('?') ? '&' : '?'}_t=${Date.now()}` : prev)
  }, [])

  // 处理键盘快捷键
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNavigate()
    }
  }, [handleNavigate])

  // 启动时自动导航
  useEffect(() => {
    if (url && !currentSrc) {
      handleNavigate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="app-preview flex h-full min-h-0">
      {/* 左侧主预览区 */}
      <div className="app-preview__main flex flex-col flex-1 min-w-0 min-h-0">
        {/* 顶部工具栏 */}
        <div className="app-preview__toolbar">
          {/* URL 栏 */}
          <div className="app-preview__url-bar">
            <div className="app-preview__url-input-wrapper">
              <input
                className="app-preview__url-input"
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入 URL 或 localhost:5173..."
              />
              <button
                className="app-preview__toolbar-btn app-preview__toolbar-btn--go"
                onClick={handleNavigate}
                title="导航到 URL"
              >
                <ExternalLink size={14} />
              </button>
            </div>
          </div>

          {/* 工具栏按钮组 */}
          <div className="app-preview__toolbar-actions">
            {/* 刷新 */}
            <button
              className="app-preview__toolbar-btn"
              onClick={handleRefresh}
              title="刷新"
              disabled={!currentSrc}
            >
              <RefreshCw size={14} className={clsx(isLoading && 'animate-spin')} />
            </button>

            {/* 旋转 */}
            <button
              className="app-preview__toolbar-btn"
              onClick={() => setIsRotated((v) => !v)}
              title={isRotated ? '竖屏' : '横屏'}
            >
              <FlipHorizontal size={14} className={clsx(isRotated && 'rotate-90')} />
            </button>

            {/* 缩放控制 */}
            {!autoScale && (
              <div className="app-preview__zoom-controls">
                <button
                  className="app-preview__toolbar-btn"
                  onClick={() => setScale(scale - 0.1)}
                  disabled={scale <= 0.25}
                >
                  −
                </button>
                <span className="app-preview__zoom-value">{Math.round(scale * 100)}%</span>
                <button
                  className="app-preview__toolbar-btn"
                  onClick={() => setScale(scale + 0.1)}
                  disabled={scale >= 2}
                >
                  +
                </button>
              </div>
            )}

            {/* 自适应缩放 */}
            <button
              className={clsx('app-preview__toolbar-btn', autoScale && 'active')}
              onClick={toggleAutoScale}
              title="自适应缩放"
            >
              <Scaling size={14} />
            </button>

            {/* 设备选择切换 */}
            <button
              className={clsx('app-preview__toolbar-btn', 'app-preview__toolbar-btn--device', showDeviceSelector && 'active')}
              onClick={() => setShowDeviceSelector((v) => !v)}
              title="切换设备选择面板"
            >
              <Smartphone size={14} />
              <span className="app-preview__device-name">
                {currentDevice?.name || '设备'}
              </span>
              <ChevronDown size={12} />
            </button>
          </div>
        </div>

        {/* 预览内容区 */}
        <div
          ref={previewContainerRef}
          className="app-preview__preview-area"
        >
          <div className="app-preview__phone-wrapper">
            <div ref={phoneFrameRef} className="app-preview__phone-frame-container">
              <PhoneFrame
                device={{
                  ...currentDevice!,
                  width: deviceWidth,
                  height: deviceHeight,
                }}
                dprText={`@${currentDevice?.devicePixelRatio}x`}
                scale={effectiveScale}
                showHomeIndicator={currentDevice?.group === 'iphone'}
              >
                <PreviewContent src={currentSrc || undefined} />
              </PhoneFrame>
            </div>
          </div>
        </div>
      </div>

      {/* 右侧设备选择面板 */}
      {showDeviceSelector && (
        <div className="app-preview__sidebar">
          <div className="app-preview__sidebar-title">
            <Smartphone size={14} />
            设备选择
          </div>
          <DeviceSelector
            current={currentDevice!}
            onSelect={(d) => selectDevice(d.id)}
            showGroupTabs
          />
        </div>
      )}

      <style>{AppPreviewStyles}</style>
    </div>
  )
}

const AppPreviewStyles = `
  .app-preview {
    background: var(--bg-canvas, #0f0f13);
    color: rgba(255, 255, 255, 0.85);
  }

  /* 顶部工具栏 */
  .app-preview__toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
    flex-shrink: 0;
  }

  .app-preview__url-bar {
    flex: 1;
    min-width: 0;
  }

  .app-preview__url-input-wrapper {
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 2px 2px 2px 10px;
    transition: border-color 0.15s;
  }

  .app-preview__url-input-wrapper:focus-within {
    border-color: var(--c-primary, #60A5FA);
  }

  .app-preview__url-input {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    outline: none;
    color: rgba(255, 255, 255, 0.85);
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    height: 28px;
  }

  .app-preview__url-input::placeholder {
    color: rgba(255, 255, 255, 0.3);
  }

  .app-preview__toolbar-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .app-preview__toolbar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    transition: all 0.15s;
  }

  .app-preview__toolbar-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.9);
  }

  .app-preview__toolbar-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .app-preview__toolbar-btn.active {
    background: rgba(96, 165, 250, 0.15);
    color: var(--c-primary, #60A5FA);
  }

  .app-preview__toolbar-btn--go {
    background: var(--c-primary, #60A5FA);
    color: #fff;
    width: 28px;
    height: 28px;
  }

  .app-preview__toolbar-btn--go:hover {
    opacity: 0.9;
  }

  .app-preview__toolbar-btn--device {
    gap: 4px;
    width: auto;
    padding: 0 10px;
  }

  .app-preview__device-name {
    font-size: 11px;
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .app-preview__zoom-controls {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .app-preview__zoom-value {
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    color: rgba(255, 255, 255, 0.5);
    min-width: 36px;
    text-align: center;
  }

  /* 预览区 */
  .app-preview__preview-area {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 24px;
    background: repeating-conic-gradient(
      rgba(255,255,255,0.03) 0% 25%,
      transparent 0% 50%
    ) 0 0 / 20px 20px;
  }

  .app-preview__phone-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
  }

  .app-preview__phone-frame-container {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* 右侧设备选择面板 */
  .app-preview__sidebar {
    width: 200px;
    flex-shrink: 0;
    border-left: 1px solid rgba(255, 255, 255, 0.08);
    padding: 12px;
    overflow-y: auto;
    background: rgba(255, 255, 255, 0.02);
  }

  .app-preview__sidebar-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.7);
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  /* 动画 */
  @keyframes preview-spin {
    to { transform: rotate(360deg); }
  }
`