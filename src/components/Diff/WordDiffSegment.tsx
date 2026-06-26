/**
 * 词级差异渲染组件
 *
 * 对比两行文本，精确高亮修改的词/字符
 * 使用 diff 库的 diffChars 函数进行字符级对比
 */

import { useMemo } from 'react'
import { diffWordsWithSpace } from 'diff'
import { highlightCode } from '@/utils/syntaxHighlight'

interface WordDiffSegmentProps {
  /** 旧版本文本 */
  oldText: string
  /** 新版本文本 */
  newText: string
  /** highlight.js 语言名称 */
  language?: string
  /**
   * 行类型
   * - context/added/removed/empty：整行渲染（语法高亮或空行）
   * - changed：split 视图中的「修改行对」，按词级 diff 高亮差异部分
   */
  type: 'context' | 'added' | 'removed' | 'empty' | 'changed'
  /** 是否为 split 视图的右侧 */
  isRight?: boolean
}

interface WordSegment {
  text: string
  type: 'same' | 'added' | 'removed'
}

/**
 * 计算词级差异
 */
function computeWordDiff(oldText: string, newText: string): {
  oldSegments: WordSegment[]
  newSegments: WordSegment[]
} {
  // 按词（含空白）切分对比，相比字符级对比噪声更小、更接近 IDE 体验
  const changes = diffWordsWithSpace(oldText, newText)

  const oldSegments: WordSegment[] = []
  const newSegments: WordSegment[] = []

  for (const change of changes) {
    if (change.added) {
      newSegments.push({ text: change.value, type: 'added' })
    } else if (change.removed) {
      oldSegments.push({ text: change.value, type: 'removed' })
    } else {
      oldSegments.push({ text: change.value, type: 'same' })
      newSegments.push({ text: change.value, type: 'same' })
    }
  }

  return { oldSegments, newSegments }
}

/**
 * 获取差异段的 CSS 类名
 */
function getSegmentClassName(type: 'same' | 'added' | 'removed'): string {
  switch (type) {
    case 'added':
      return 'diff-word-added'
    case 'removed':
      return 'diff-word-removed'
    default:
      return ''
  }
}

/**
 * 渲染带语法高亮的差异段
 */
function renderHighlightedSegments(
  segments: WordSegment[],
  language: string,
): React.ReactNode[] {
  return segments.map((segment, idx) => {
    const className = getSegmentClassName(segment.type)

    if (segment.type === 'same' && language) {
      // 对相同部分应用语法高亮
      const highlighted = highlightCode(segment.text, language)
      return (
        <span
          key={idx}
          className={className}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      )
    }

    return (
      <span key={idx} className={className}>
        {segment.text}
      </span>
    )
  })
}

/**
 * 词级差异渲染组件
 *
 * 当 type 为 'context' 时，直接渲染语法高亮的文本
 * 当 type 为 'added' 或 'removed' 时，直接渲染对应文本
 * 当 oldText 和 newText 都有时，进行词级差异对比
 */
export function WordDiffSegment({
  oldText,
  newText,
  language,
  type,
  isRight = false,
}: WordDiffSegmentProps) {
  // 计算词级差异（仅 changed 行对需要）
  const { oldSegments, newSegments } = useMemo(() => {
    if (type !== 'changed') {
      return { oldSegments: [], newSegments: [] }
    }
    return computeWordDiff(oldText, newText)
  }, [oldText, newText, type])

  // context 行：直接渲染语法高亮
  if (type === 'context') {
    if (language) {
      const highlighted = highlightCode(oldText, language)
      return (
        <span
          className="whitespace-pre"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      )
    }
    return <span className="whitespace-pre">{oldText || '\u00A0'}</span>
  }

  // 纯新增行
  if (type === 'added') {
    if (language) {
      const highlighted = highlightCode(newText, language)
      return (
        <span
          className="whitespace-pre"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      )
    }
    return <span className="whitespace-pre">{newText || '\u00A0'}</span>
  }

  // 纯删除行
  if (type === 'removed') {
    if (language) {
      const highlighted = highlightCode(oldText, language)
      return (
        <span
          className="whitespace-pre"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      )
    }
    return <span className="whitespace-pre">{oldText || '\u00A0'}</span>
  }

  // 空行
  if (type === 'empty') {
    return <span className="whitespace-pre">{'\u00A0'}</span>
  }

  // 词级差异对比（split 视图中 changed 行对）
  const segments = isRight ? newSegments : oldSegments
  return (
    <span className="whitespace-pre">
      {renderHighlightedSegments(segments, language ?? '')}
    </span>
  )
}
