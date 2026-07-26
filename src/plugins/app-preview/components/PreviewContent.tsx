import { useEffect, useRef, useState } from 'react'
import { Smartphone, Monitor } from 'lucide-react'

interface PreviewContentProps {
  /** 预览页 URL（如 http://localhost:5173） */
  src?: string
  /** 是否允许沙箱（true=开启 sandbox，隔离更严格） */
  sandbox?: boolean
}

/** 预览内容层：iframe 渲染目标页面，被 PhoneFrame 包裹并缩放 */
export function PreviewContent({ src, sandbox = true }: PreviewContentProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    iframe.addEventListener('load', () => setReady(true))
    return () => iframe.removeEventListener('load', () => setReady(true))
  }, [src])

  if (!src) {
    return <PreviewPlaceholder />
  }

  return (
    <div className="preview-content">
      <iframe
        ref={iframeRef}
        className="preview-content__iframe"
        src={src}
        sandbox={sandbox ? 'allow-scripts allow-same-origin allow-modals allow-popups' : undefined}
        title="App Preview"
        frameBorder="0"
        allow="accelerometer; gyroscope; payment"
        loading="lazy"
        onLoad={() => {
          setReady(true)
          setError(null)
        }}
        onError={() => setError('预览加载失败，请检查页面是否正常运行。')}
      />

      {!ready && !error && (
        <div className="preview-content__loading">
          <div className="preview-content__spinner" />
          <span>加载预览中...</span>
        </div>
      )}

      {error && (
        <div className="preview-content__error">
          <Smartphone size={24} className="opacity-50" />
          <span>{error}</span>
        </div>
      )}

      <style>{PreviewContentStyles}</style>
    </div>
  )
}

function PreviewPlaceholder() {
  return (
    <div className="preview-placeholder">
      <Monitor size={48} className="opacity-20" />
      <p>手机预览区</p>
      <p className="preview-placeholder__hint">在右侧设置目标页面 URL</p>
    </div>
  )
}

const PreviewContentStyles = `
  .preview-content {
    position: relative;
    width: 100%;
    height: 100%;
    background: #fff;
    overflow: hidden;
  }

  .preview-content__iframe {
    width: 100%;
    height: 100%;
    border: none;
    display: block;
  }

  .preview-content__loading {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: rgba(255, 255, 255, 0.9);
    color: #666;
    font-size: 13px;
  }

  .preview-content__spinner {
    width: 24px;
    height: 24px;
    border: 2px solid #ddd;
    border-top-color: #60A5FA;
    border-radius: 50%;
    animation: preview-spin 0.8s linear infinite;
  }

  @keyframes preview-spin {
    to { transform: rotate(360deg); }
  }

  .preview-content__error {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: rgba(255, 255, 255, 0.95);
    color: #c00;
    font-size: 13px;
  }

  .preview-placeholder {
    position: relative;
    width: 100%;
    height: 100%;
    background: linear-gradient(135deg, rgba(96,165,250,0.05), rgba(147,51,234,0.05));
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: rgba(0, 0, 0, 0.5);
    font-size: 14px;
  }

  .preview-placeholder__hint {
    font-size: 11px;
    color: rgba(0, 0, 0, 0.35);
    margin-top: 4px;
  }
`
