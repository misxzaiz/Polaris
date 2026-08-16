/**
 * Git 行号区 Diff 标记（gutter）+ 行内高亮（CM6 扩展）
 *
 * 在编辑器行号区左侧显示 added / modified / deleted 小竖条，
 * 并对改动行做行内装饰（背景高亮）。
 *
 * 数据源：gitEditorService#getFileGitState（后端 git2 + computeDiff）
 * 通过 editorExtensionRegistry 注入（Phase 0-1）。
 *
 * 性能设计：
 * - 状态缓存：git status 1.5s TTL + blame 60s TTL（见 gitEditorService）
 * - 文档变更时仅重算当前文件 diff（computeDiff 复杂度 O(edit)）
 * - 同文件仅首次打开全量拉取，后续复用缓存
 */

import {
  EditorView,
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { StateEffect, type Extension } from '@codemirror/state'
import { createLogger } from '@/utils/logger'
import {
  getFileGitState,
} from '@/services/gitEditorService'

const log = createLogger('GitGutter')

/** 当前编辑器文件的 git 上下文 */
export interface GitFileContext {
  filePath?: string
  workspacePath?: string
}

/** 每行变更级别 */
export type GutterLineStatus = 'added' | 'modified' | 'deleted' | 'unchanged'

/** 携带新装饰集的 StateEffect，从异步加载结果 dispatch 回 ViewPlugin */
const setDecorations = StateEffect.define<DecorationSet>()

/** 行标记装饰 */
const addedMarker = Decoration.line({ attributes: { class: 'git-gutter-added' } })
const modifiedMarker = Decoration.line({ attributes: { class: 'git-gutter-modified' } })
const deletedMarker = Decoration.line({ attributes: { class: 'git-gutter-deleted' } })

/**
 * 从 diff lines 计算每行状态。
 *
 * @param wtLines 工作区 diff 行（vs worktree）
 * @param idxLines 暂存 diff 行（vs index）
 * @param docLineCount 文档总行数
 */
export function computeLineStatuses(
  wtLines: ReadonlyArray<{ type: string; newLineNumber: number | null }> | null,
  idxLines: ReadonlyArray<{ type: string; newLineNumber: number | null }> | null,
  docLineCount: number,
): GutterLineStatus[] {
  const statuses: GutterLineStatus[] = new Array<GutterLineStatus>(docLineCount).fill('unchanged')
  if (!wtLines && !idxLines) return statuses

  const apply = (lines: ReadonlyArray<{ type: string; newLineNumber: number | null }> | null, fromIndex: boolean) => {
    if (!lines) return
    for (const line of lines) {
      if (line.newLineNumber == null) continue
      const idx = line.newLineNumber - 1
      if (idx < 0 || idx >= statuses.length) continue

      const t = line.type
      let next: GutterLineStatus
      if (t === 'added') next = 'added'
      else if (t === 'removed') next = 'deleted'
      else next = 'unchanged'

      // 暂存区（index）优先级高于工作区
      if (fromIndex) {
        if (next !== 'unchanged') statuses[idx] = next
      } else if (statuses[idx] === 'unchanged') {
        statuses[idx] = next
      }
    }
  }

  apply(idxLines, true)
  apply(wtLines, false)
  return statuses
}

/** 由行状态数组构建 DecorationSet */
function buildDecorations(view: EditorView, statuses: GutterLineStatus[]): DecorationSet {
  const ranges: import('@codemirror/state').Range<Decoration>[] = []
  for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i]
    if (status === 'unchanged') continue
    const line = view.state.doc.line(i + 1)
    const dec = status === 'added'
      ? addedMarker
      : status === 'deleted'
        ? deletedMarker
        : modifiedMarker
    ranges.push(dec.range(line.from))
  }
  return Decoration.set(ranges, true)
}

/** ViewPlugin：异步拉取当前文件 git 状态 → 构建/更新装饰 */
function createGitGutterPlugin(getContext: () => GitFileContext) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none
      private loadToken = 0
      private loading = false
      private lastFileKey = ''

      constructor(view: EditorView) {
        this.scheduleLoad(view)
      }

      update(update: ViewUpdate) {
        // 处理装饰更新 effect
        for (const tr of update.transactions) {
          for (const e of tr.effects) {
            if (e.is(setDecorations)) {
              this.decorations = e.value
            }
          }
        }

        const currentKey = GitFileContextKey(getContext())
        if (currentKey !== this.lastFileKey) {
          this.lastFileKey = currentKey
          if (currentKey) this.scheduleLoad(update.view)
        } else if (update.docChanged) {
          // 内容变化：重算当前文件 diff（轻量）
          this.scheduleLoad(update.view)
        }
      }

      async scheduleLoad(view: EditorView) {
        const ctx = getContext()
        if (!ctx.filePath || !ctx.workspacePath || this.loading) return
        this.loading = true
        const token = ++this.loadToken

        try {
          const currentContent = view.state.doc.toString()
          const state = await getFileGitState(ctx.filePath, ctx.workspacePath, currentContent)

          if (token !== this.loadToken) return

          const statuses = computeLineStatuses(
            state.worktreeDiff?.lines ?? null,
            state.indexDiff?.lines ?? null,
            view.state.doc.lines,
          )
          const next = buildDecorations(view, statuses)

          // 仅当有变更时才 dispatch，避免无谓更新
          if (next.size !== this.decorations.size) {
            view.dispatch({ effects: [setDecorations.of(next)] })
          }
        } catch (err) {
          log.debug('git gutter load failed', { err: String(err) })
        } finally {
          this.loading = false
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  )
}

/** 上下文键（工作区+路径） */
function GitFileContextKey(ctx: GitFileContext): string {
  return ctx.filePath ? `${ctx.workspacePath}|${ctx.filePath}` : ''
}

/**
 * 创建 git gutter 扩展。
 *
 * @param getContext 返回当前编辑器文件上下文（随 editorExtensionRegistry 注入时包装一次）
 */
export function gitGutterExtension(getContext: () => GitFileContext): Extension {
  return [
    createGitGutterPlugin(getContext),
    EditorView.theme({
      // 行号区竖条
      '.cm-gutters .git-gutter-added': {
        borderLeft: '3px solid var(--git-gutter-added, #3fb950)',
      },
      '.cm-gutters .git-gutter-modified': {
        borderLeft: '3px solid var(--git-gutter-modified, #d29922)',
      },
      '.cm-gutters .git-gutter-deleted': {
        borderLeft: '3px solid var(--git-gutter-deleted, #f85149)',
      },
      // 行内背景高亮
      '.cm-line.git-gutter-added': {
        backgroundColor: 'var(--git-added-bg, rgba(63,185,80,0.08))',
      },
      '.cm-line.git-gutter-modified': {
        backgroundColor: 'var(--git-modified-bg, rgba(210,153,34,0.08))',
      },
      '.cm-line.git-gutter-deleted': {
        backgroundColor: 'var(--git-deleted-bg, rgba(248,81,73,0.06))',
        '&::after': {
          content: '" "',
          position: 'absolute',
          left: '0',
          right: '0',
          height: '1px',
          background: 'var(--git-gutter-deleted, #f85149)',
          opacity: '0.3',
        },
      },
    }),
  ]
}