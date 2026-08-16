/**
 * Git 改动间导航（CM6 键盘扩展）
 *
 * Alt+Up / Alt+Down 在文件内的 git 改动行之间跳转。
 *
 * CM6 的 keymap Command 是同步函数，而 git 数据是异步获取的——因此这里
 * 采用「预载 + 同步读缓存」模式：
 * - 共享模块通过 startNavigation(editorState, getContext) 在文件打开/文档变化时异步预载改动行号
 * - keymap handler 同步读共享缓存，未就绪则返回 false（不拦截，下次按键生效）
 * - 数据与 gitGutter 一致（同一 gitEditorService 缓存）
 */

import { keymap, EditorView } from '@codemirror/view'
import type { Extension, EditorState } from '@codemirror/state'
import { Prec } from '@codemirror/state'
import type { GitFileContext } from '@/services/gitEditorService'
import { getFileGitState } from '@/services/gitEditorService'
import { createLogger } from '@/utils/logger'

const log = createLogger('GitChangeNavigator')

/** 已加载的改动行号缓存（key: filePath, value: sorted line numbers） */
const changeLinesCache = new Map<string, number[]>()

/** 当前正在预载的 fileKey 去重 */
let preloadingKey: string | null = null

/**
 * 预载当前文件的改动行号。在编辑器打开文件时调用一次。
 */
export function startNavigator(ctx: GitFileContext, _state?: EditorState): void {
  const key = ctx.filePath ? `${ctx.workspacePath}|${ctx.filePath}` : ''
  if (!key || changeLinesCache.has(key) || preloadingKey === key) return
  preloadingKey = key
  void (async () => {
    try {
      const git = ctx.filePath && ctx.workspacePath
        ? await getFileGitState(ctx.filePath, ctx.workspacePath)
        : null
      if (!git) return
      const lines = collectChangeLines(git.worktreeDiff?.lines ?? null, git.indexDiff?.lines ?? null)
      changeLinesCache.set(key, lines)
    } catch (err) {
      log.debug('navigator preload failed', { err: String(err) })
    } finally {
      preloadingKey = null
    }
  })()
}

/** 从 diff lines 直接收集当前文件的改动行号（新增行 + 删除相邻行） */
function collectChangeLines(
  wtLines: ReadonlyArray<{ type: string; newLineNumber: number | null }> | null,
  idxLines: ReadonlyArray<{ type: string; newLineNumber: number | null }> | null,
): number[] {
  const lines = new Set<number>()
  const collect = (ls: ReadonlyArray<{ type: string; newLineNumber: number | null }> | null) => {
    if (!ls) return
    for (const l of ls) {
      if (l.newLineNumber != null && (l.type === 'added' || l.type === 'removed')) {
        lines.add(l.newLineNumber)
      }
    }
  }
  collect(idxLines)
  collect(wtLines)
  return Array.from(lines).sort((a, b) => a - b)
}

function getChangeLines(ctx: GitFileContext): number[] {
  const key = ctx.filePath ? `${ctx.workspacePath}|${ctx.filePath}` : ''
  return key ? (changeLinesCache.get(key) ?? []) : []
}

function scrollToLine(view: EditorView, line: number): boolean {
  const doc = view.state.doc
  if (line < 1 || line > doc.lines) return false
  const lineInfo = doc.line(line)
  const pos = lineInfo.from
  view.dispatch({
    selection: { anchor: pos, head: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  })
  view.focus()
  return true
}

export function gitChangeNavigatorExtension(getContext: () => GitFileContext): Extension {
  return Prec.high(
    keymap.of([
      {
        key: 'Alt-Down',
        run: (view) => {
          const ctx = getContext()
          const lines = getChangeLines(ctx)
          if (lines.length === 0) return false
          const cursorLine = view.state.selection.main.head
            ? view.state.doc.lineAt(view.state.selection.main.head).number
            : 0
          const next = lines.find((n) => n > cursorLine) ?? lines[0]
          return scrollToLine(view, next)
        },
      },
      {
        key: 'Alt-Up',
        run: (view) => {
          const ctx = getContext()
          const lines = getChangeLines(ctx)
          if (lines.length === 0) return false
          const cursorLine = view.state.selection.main.head
            ? view.state.doc.lineAt(view.state.selection.main.head).number
            : 0
          const next = [...lines].reverse().find((n) => n < cursorLine) ?? lines[lines.length - 1]
          return scrollToLine(view, next)
        },
      },
    ]),
  )
}