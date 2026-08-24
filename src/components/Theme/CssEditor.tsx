/**
 * CSS 编辑器 — 基于 CodeMirror 6，提供 CSS 语法高亮 + 变量补全
 *
 * 替代 ThemeEditor 中原有的纯 textarea，提升自定义 CSS 编辑体验。
 * 使用 @codemirror/lang-css 实现语法高亮与自动补全。
 */

import * as React from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection, rectangularSelection, crosshairCursor, } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentUnit,
} from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, autocompletion, CompletionContext } from '@codemirror/autocomplete'
import { css } from '@codemirror/lang-css'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'

interface CssEditorProps {
  value: string
  onChange: (value: string) => void
  onValidationError?: (error: string | null) => void
}

/**
 * 自定义 CSS 变量补全：检测 --c- 前缀时提供常用主题变量。
 */
function cssVariableCompletions(context: CompletionContext) {
  const word = context.matchBefore(/--c-[\w-]*/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  return {
    from: word.from,
    options: [
      { label: '--c-bg-base', detail: '基础背景色', type: 'keyword' },
      { label: '--c-bg-surface', detail: '表面背景色', type: 'keyword' },
      { label: '--c-bg-elevated', detail: '凸起背景色', type: 'keyword' },
      { label: '--c-bg-hover', detail: '悬停背景色', type: 'keyword' },
      { label: '--c-bg-active', detail: '激活背景色', type: 'keyword' },
      { label: '--c-text-primary', detail: '主文字色', type: 'keyword' },
      { label: '--c-text-secondary', detail: '次要文字色', type: 'keyword' },
      { label: '--c-text-tertiary', detail: '三级文字色', type: 'keyword' },
      { label: '--c-text-muted', detail: '弱化文字色', type: 'keyword' },
      { label: '--c-text-on-primary', detail: '强调色上文字', type: 'keyword' },
      { label: '--c-primary', detail: '强调色', type: 'keyword' },
      { label: '--c-primary-hover', detail: '强调色悬停', type: 'keyword' },
      { label: '--c-primary-600', detail: '强调色深色', type: 'keyword' },
      { label: '--c-border', detail: '边框色', type: 'keyword' },
      { label: '--c-border-subtle', detail: '弱边框色', type: 'keyword' },
      { label: '--c-danger', detail: '危险色', type: 'keyword' },
      { label: '--c-success', detail: '成功色', type: 'keyword' },
      { label: '--c-warning', detail: '警告色', type: 'keyword' },
      { label: '--c-status-info', detail: '信息色', type: 'keyword' },
      { label: '--c-status-warning', detail: '状态警告色', type: 'keyword' },
      { label: '--c-status-success', detail: '状态成功色', type: 'keyword' },
      { label: '--c-status-error', detail: '状态错误色', type: 'keyword' },
      { label: '--c-accent', detail: '强调点缀色', type: 'keyword' },
      { label: '--c-scrollbar', detail: '滚动条色', type: 'keyword' },
      { label: '--c-canvas', detail: '画布色', type: 'keyword' },
      { label: '--c-overlay', detail: '覆盖层色', type: 'keyword' },
      { label: '--c-shadow', detail: '阴影色', type: 'keyword' },
      { label: '--c-tag-bg', detail: '标签背景色', type: 'keyword' },
      { label: '--font-sans', detail: '无衬线字体', type: 'keyword' },
      { label: '--font-mono', detail: '等宽字体', type: 'keyword' },
      { label: '--radius-sm', detail: '小圆角', type: 'keyword' },
      { label: '--radius-md', detail: '中圆角', type: 'keyword' },
      { label: '--radius-lg', detail: '大圆角', type: 'keyword' },
      { label: '--radius-xl', detail: '超大圆角', type: 'keyword' },
    ],
  }
}

export function CssEditor({ value, onChange }: CssEditorProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const viewRef = React.useRef<EditorView | null>(null)
  const onChangeRef = React.useRef(onChange)
  onChangeRef.current = onChange

  React.useEffect(() => {
    if (!containerRef.current) return

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const val = update.state.doc.toString()
        onChangeRef.current(val)
      }
    })

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightSpecialChars(),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        history(),
        keymap.of(defaultKeymap),
        keymap.of(historyKeymap),
        foldGutter(),
        keymap.of(foldKeymap),
        bracketMatching(),
        closeBrackets(),
        keymap.of(closeBracketsKeymap),
        indentOnInput(),
        indentUnit.of('  '),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        highlightSelectionMatches(),
        keymap.of(searchKeymap),
        css(),
        autocompletion({ override: [cssVariableCompletions] }),
        EditorView.theme({
          '&': {
            fontSize: '12px',
            fontFamily: 'var(--font-mono, monospace)',
            height: '12rem',
          },
          '&.cm-editor': {
            backgroundColor: 'var(--c-bg-base, #1e1e1e)',
            borderRadius: '8px',
            border: '1px solid var(--c-border, #333)',
          },
          '&.cm-focused': {
            outline: 'none',
            borderColor: 'var(--c-primary, #6b8cff)',
          },
          '.cm-scroller': {
            overflow: 'auto',
          },
          '.cm-content': {
            padding: '8px 12px',
            caretColor: 'var(--c-text-primary, #ddd)',
          },
          '.cm-cursor, .cm-dropCursor': {
            borderLeftColor: 'var(--c-text-primary, #ddd)',
          },
          '.cm-gutters': {
            backgroundColor: 'transparent',
            border: 'none',
            color: 'var(--c-text-muted, #666)',
          },
          '.cm-activeLineGutter': {
            backgroundColor: 'transparent',
          },
          '.cm-activeLine': {
            backgroundColor: 'transparent',
          },
          '.cm-selectionBackground, .cm-content ::selection': {
            backgroundColor: 'rgba(107, 140, 255, 0.2)',
          },
          '&.cm-focused .cm-selectionBackground, .cm-content ::selection': {
            backgroundColor: 'rgba(107, 140, 255, 0.3)',
          },
          '.cm-matchingBracket, .cm-nonmatchingBracket': {
            backgroundColor: 'rgba(107, 140, 255, 0.15)',
            outline: 'none',
          },
        }),
        updateListener,
      ],
    })

    const view = new EditorView({
      state,
      parent: containerRef.current,
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // 外部 value 更新时同步（仅当文档内容不同时，不破坏光标位置）
  React.useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      })
    }
  }, [value])

  return (
    <div
      ref={containerRef}
      className="overflow-hidden rounded-lg border border-border"
    />
  )
}