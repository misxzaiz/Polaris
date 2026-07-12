/**
 * Split（并排）视图的行数据模型与构建逻辑
 *
 * 将线性的 DiffLine[] 转换为左右并排的 SplitDiffRow[]：
 * - context 行：左右相同
 * - 连续的 removed + added 块：按行配对（同一行视为「修改行对」，用于词级高亮）
 * - 纯新增 / 纯删除：另一侧以 empty 占位
 */

import type { DiffLine } from '@/services/diffService'

export type SplitSideType = 'context' | 'added' | 'removed' | 'empty' | 'folded'

export interface SplitDiffRow {
  oldLineNumber: number | null
  newLineNumber: number | null
  oldContent: string
  newContent: string
  oldType: SplitSideType
  newType: SplitSideType
}

/** 折叠提示行（上下文省略），以 ⋯ 包裹 */
export const isFoldedLine = (line: DiffLine) =>
  line.content.startsWith('⋯') && line.content.endsWith('⋯')

/** 判断一个 split 行是否为「修改行对」（两侧分别为删除/新增，需词级高亮） */
export const isChangedRow = (row: SplitDiffRow) =>
  row.oldType === 'removed' && row.newType === 'added'

export function buildSplitRows(lines: DiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (isFoldedLine(line)) {
      rows.push({
        oldLineNumber: null,
        newLineNumber: null,
        oldContent: line.content,
        newContent: line.content,
        oldType: 'folded',
        newType: 'folded',
      })
      index++
      continue
    }

    if (line.type === 'context') {
      rows.push({
        oldLineNumber: line.oldLineNumber,
        newLineNumber: line.newLineNumber,
        oldContent: line.content,
        newContent: line.content,
        oldType: 'context',
        newType: 'context',
      })
      index++
      continue
    }

    if (line.type === 'removed') {
      const removedLines: DiffLine[] = []
      const addedLines: DiffLine[] = []

      while (index < lines.length && lines[index].type === 'removed') {
        removedLines.push(lines[index])
        index++
      }
      while (index < lines.length && lines[index].type === 'added') {
        addedLines.push(lines[index])
        index++
      }

      const rowCount = Math.max(removedLines.length, addedLines.length)
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        const oldLine = removedLines[rowIndex]
        const newLine = addedLines[rowIndex]
        rows.push({
          oldLineNumber: oldLine?.oldLineNumber ?? null,
          newLineNumber: newLine?.newLineNumber ?? null,
          oldContent: oldLine?.content ?? '',
          newContent: newLine?.content ?? '',
          oldType: oldLine ? 'removed' : 'empty',
          newType: newLine ? 'added' : 'empty',
        })
      }
      continue
    }

    const addedLines: DiffLine[] = []
    while (index < lines.length && lines[index].type === 'added') {
      addedLines.push(lines[index])
      index++
    }

    for (const addedLine of addedLines) {
      rows.push({
        oldLineNumber: null,
        newLineNumber: addedLine.newLineNumber,
        oldContent: '',
        newContent: addedLine.content,
        oldType: 'empty',
        newType: 'added',
      })
    }
  }

  return rows
}
