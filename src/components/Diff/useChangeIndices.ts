/**
 * 变更块索引计算
 *
 * 为 j/k 变更导航提供「变更块首行」索引：连续的新增/删除行合并为一个变更块，
 * 只取块首行的索引，避免逐行跳转。unified 与 split 两种视图分别基于各自的行数组计算。
 */

import { useMemo } from 'react'
import type { DiffLine } from '@/services/diffService'
import type { SplitDiffRow } from './splitRows'
import type { DiffViewMode } from './types'

/** 通用：把「是否变更行」的判定数组压缩为变更块首行索引 */
function collectBlockStartIndices(isChangeAt: (idx: number) => boolean, length: number): number[] {
  const indices: number[] = []
  let inBlock = false
  for (let idx = 0; idx < length; idx++) {
    if (isChangeAt(idx)) {
      if (!inBlock) {
        indices.push(idx)
        inBlock = true
      }
    } else {
      inBlock = false
    }
  }
  return indices
}

/**
 * 计算当前视图下的变更块首行索引。
 * 返回的索引对应当前视图实际渲染的行数组（unified → diff.lines，split → splitRows），
 * 可直接用于 Virtuoso scrollToIndex 或 data-row-index 定位。
 */
export function useChangeIndices(
  viewMode: DiffViewMode,
  lines: DiffLine[],
  splitRows: SplitDiffRow[],
): number[] {
  return useMemo(() => {
    if (viewMode === 'split') {
      return collectBlockStartIndices(
        (idx) => splitRows[idx].oldType === 'removed' || splitRows[idx].newType === 'added',
        splitRows.length,
      )
    }
    return collectBlockStartIndices(
      (idx) => lines[idx].type === 'added' || lines[idx].type === 'removed',
      lines.length,
    )
  }, [viewMode, lines, splitRows])
}
