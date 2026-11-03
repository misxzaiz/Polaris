/**
 * Overlay 展示层组件（拆分自 OverlayApp.tsx）。
 * 纯展示，零业务逻辑。
 * 规格：plans/pet-overlay-r2-spec.md §4.1
 */
import React from 'react'

/** 透明窗口上可见的状态条。 */
export function StatusPill({ text, tone }: { text: string; tone: 'info' | 'error' }) {
  return (
    <div style={{
      position: 'absolute', left: '50%', bottom: 26, transform: 'translateX(-50%)',
      maxWidth: '92%', boxSizing: 'border-box',
      background: 'rgba(8, 15, 30, 0.88)', color: tone === 'error' ? '#ffb86b' : '#9fd0ff',
      border: `1px solid ${tone === 'error' ? '#f0883e' : '#2b4a7a'}`,
      borderRadius: 8, padding: '6px 10px', fontSize: 12, lineHeight: 1.5,
      textAlign: 'center', whiteSpace: 'pre-wrap', zIndex: 30,
    }}>{text}</div>
  )
}

/** React 18 中 effect 抛错会 unmount 整棵树且无 UI——必须用边界兜住并显示出来。 */
export class OverlayErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: string | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { err: null }
  }
  static getDerivedStateFromError(e: unknown) {
    return { err: String((e && (e as Error).message) ? (e as Error).message : e).slice(0, 300) }
  }
  render() {
    if (this.state.err) return <StatusPill tone="error" text={`悬浮窗内部错误：${this.state.err}`} />
    return this.props.children
  }
}
