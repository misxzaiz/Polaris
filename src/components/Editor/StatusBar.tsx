/**
 * 编辑器状态栏组件
 *
 * 显示在编辑器底部，展示语言、光标位置、编码、缩进方式等信息
 */

import { useEffect, useState } from 'react'
import { useFileEditorStore } from '@/stores/fileEditorStore'
import type { EditorView } from '@codemirror/view'

interface StatusBarProps {
  className?: string
}

/** 获取语言显示名称 */
function getLanguageDisplayName(language: string): string {
  const names: Record<string, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    json: 'JSON',
    html: 'HTML',
    css: 'CSS',
    markdown: 'Markdown',
    python: 'Python',
    java: 'Java',
    rust: 'Rust',
    go: 'Go',
    sql: 'SQL',
    xml: 'XML',
    c: 'C',
    cpp: 'C++',
    text: 'Plain Text',
    yaml: 'YAML',
    toml: 'TOML',
    shell: 'Shell',
  }
  return names[language] || language.toUpperCase()
}

export function StatusBar({ className = '' }: StatusBarProps) {
  const currentFile = useFileEditorStore((state) => state.currentFile)
  const [cursorInfo, setCursorInfo] = useState({ line: 1, col: 1 })

  // 监听 CM6 编辑器的光标位置变化
  useEffect(() => {
    if (!currentFile) return

    // 查找编辑器 DOM 获取 EditorView
    const editorEl = document.querySelector('.cm-editor')
    if (!editorEl) return

    const view = (editorEl as HTMLElement & { cmView?: { view?: EditorView } }).cmView?.view
    if (!view) return

    const updateCursor = () => {
      const pos = view.state.selection.main.head
      const line = view.state.doc.lineAt(pos)
      setCursorInfo({
        line: line.number,
        col: pos - line.from + 1,
      })
    }

    updateCursor()

    // 监听光标变化
    view.dom.addEventListener('click', updateCursor)
    view.dom.addEventListener('keyup', updateCursor)

    return () => {
      view.dom.removeEventListener('click', updateCursor)
      view.dom.removeEventListener('keyup', updateCursor)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- currentFile?.path change only
  }, [currentFile?.path])

  if (!currentFile) return null

  const langName = getLanguageDisplayName(currentFile.language)

  return (
    <div
      className={`flex items-center justify-between px-3 py-1 text-xs
        bg-background-elevated border-t border-border-subtle shrink-0 select-none ${className}`}
    >
      {/* 左侧：语言信息 */}
      <div className="flex items-center gap-3">
        <span className="text-text-primary">{langName}</span>
      </div>

      {/* 右侧：位置和编码信息 */}
      <div className="flex items-center gap-3">
        <span className="text-text-tertiary">
          行 {cursorInfo.line}, 列 {cursorInfo.col}
        </span>
        <span className="text-text-tertiary">UTF-8</span>
        <span className="text-text-tertiary">Spaces: 2</span>
        <span className="text-text-tertiary">LF</span>
      </div>
    </div>
  )
}
