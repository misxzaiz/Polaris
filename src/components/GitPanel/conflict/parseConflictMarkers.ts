/**
 * 冲突标记解析（P3：per-hunk 控件地基）
 *
 * 输入 `GitConflictEntry` 的 base/ours/theirs 三文本，做行级 3-way 归并对齐，产出：
 * - `regions`: 全部按 base 顺序的区域（common / ours-only / theirs-only / conflict）
 * - `conflicts`: 仅冲突块（双方同改且不同），每块携带 ours/theirs/base 行，供 per-hunk 控件消费
 *
 * 语义对齐 VS Code Merge Editor：
 * - common          三方相同 → 保留 base
 * - ours-only       仅 ours 改 → 非冲突，Apply All Non-Conflicting 自动取 ours
 * - theirs-only     仅 theirs 改 → 非冲突，自动取 theirs
 * - conflict        双方同 base 位置都改且不同 → 需用户决策（Accept Ours / Accept Theirs / 手动编辑）
 *
 * 归一依据：对 base→ours、base→theirs 分别求行级 diff（diffArrays），成对消费
 * removed+added 得到「base 区间 → 对应侧区间」的变更段，再按 base 行号归并。
 * 纯函数，无 I/O，便于单测。
 */

import { diffArrays } from 'diff'

/** 区域类型 */
export type MergeRegionKind = 'common' | 'ours' | 'theirs' | 'conflict'

/** 单个区域（按 base 顺序） */
export interface MergeRegion {
  kind: MergeRegionKind
  /** base 起止行号（半开区间；纯插入区域的 baseStart===baseEnd） */
  baseStart: number
  baseEnd: number
  /** 区域内容行（common/ours/theirs 取对应版本；conflict 为 ours 行作默认预览） */
  lines: string[]
  /** 仅 conflict：决策侧内容（ours/theirs/base），buildResult 按 resolutions 选取 */
  oursLines?: string[]
  theirsLines?: string[]
  baseLines?: string[]
}

/** 单个冲突块（per-hunk 控件消费） */
export interface ConflictHunk {
  id: number
  /** base 起止行号（半开区间） */
  baseStart: number
  baseEnd: number
  /** 冲突块在最终结果文件里的行区间（导航/行号展示） */
  startLine: number
  endLine: number
  oursLines: string[]
  theirsLines: string[]
  baseLines: string[]
}

/** 解析结果 */
export interface ConflictParseResult {
  regions: MergeRegion[]
  conflicts: ConflictHunk[]
}

/** 变更段（base 区间 → 对应侧区间） */
interface ChangeSegment {
  baseStart: number
  baseEnd: number
  sideStart: number
  sideEnd: number
}

/** diffArrays 的变更块 */
interface ArrayChange {
  value: string[]
  added?: boolean
  removed?: boolean
}

/** 冲突决策 */
export type ConflictResolution = 'ours' | 'theirs' | 'base'

/**
 * 行级 3-way 归并。
 *
 * 实现：两遍 diff（base↔ours、base↔theirs），各自得到按 base 顺序的变更段，
 * 再按 base 行号归并成 regions。ours/theirs 的消费行数用游标推进，尾部新增
 * 在 base 结束后收尾。
 */
export function parseConflictMarkers(
  base: string | null,
  ours: string | null,
  theirs: string | null,
): ConflictParseResult {
  const baseLines = splitLines(base)
  const oursLines = splitLines(ours)
  const theirsLines = splitLines(theirs)

  const oursSegments = diffAgainstBase(baseLines, oursLines)
  const theirsSegments = diffAgainstBase(baseLines, theirsLines)

  let i = 0 // base 游标
  let pO = 0
  let pT = 0
  let oursEmitted = 0 // ours 侧已排进 region 的行数
  let theirsEmitted = 0
  const regions: MergeRegion[] = []
  const conflicts: ConflictHunk[] = []
  let hunkId = 0
  let fileLine = 0 // 最终结果文件行号（区域拼接累计）

  while (i < baseLines.length) {
    const segO = oursSegments[pO]
    const segT = theirsSegments[pT]
    const nextO = segO?.baseStart ?? baseLines.length
    const nextT = segT?.baseStart ?? baseLines.length

    // 公共段：双方在此区间都无变更
    const commonEnd = Math.min(nextO, nextT)
    if (commonEnd > i) {
      pushRegion(regions, 'common', i, commonEnd, baseLines.slice(i, commonEnd), undefined)
      fileLine += commonEnd - i
      oursEmitted += commonEnd - i
      theirsEmitted += commonEnd - i
      i = commonEnd
      continue
    }

    // 至少一方在 i 有变更段
    const hasO = segO && segO.baseStart === i
    const hasT = segT && segT.baseStart === i
    const segEnd = Math.max(hasO ? segO.baseEnd : i, hasT ? segT.baseEnd : i)

    const oursSide = hasO ? oursLines.slice(segO.sideStart, segO.sideEnd) : []
    const theirsSide = hasT ? theirsLines.slice(segT.sideStart, segT.sideEnd) : []
    // 该侧「有变更段」= 触及此 base 段（改动、删除、或纯插入零宽）
    const oursTouched = hasO
    const theirsTouched = hasT
    // 该侧实际产出行（新增/改动内容行，删除/未变为 0）
    const oursChanged = hasO && segO.sideEnd > segO.sideStart
    const theirsChanged = hasT && segT.sideEnd > segT.sideStart

    if (oursTouched && theirsTouched) {
      // 双方都触及此 base 段
      if (oursChanged && theirsChanged && !sameLines(oursSide, theirsSide)) {
        // 真冲突：双方同位置不同改
        regions.push({
          kind: 'conflict',
          baseStart: i,
          baseEnd: segEnd,
          lines: oursSide,
          oursLines: oursSide,
          theirsLines: theirsSide,
          baseLines: baseLines.slice(i, segEnd),
        })
        conflicts.push({
          id: hunkId++,
          baseStart: i,
          baseEnd: segEnd,
          startLine: fileLine,
          endLine: fileLine + Math.max(oursSide.length, theirsSide.length),
          oursLines: [...oursSide],
          theirsLines: [...theirsSide],
          baseLines: baseLines.slice(i, segEnd),
        })
        fileLine += Math.max(oursSide.length, theirsSide.length)
        oursEmitted += oursSide.length
        theirsEmitted += theirsSide.length
      } else {
        // 双方改得一致 / 单侧为纯删除 / 重叠但无实质差异 → 采用有内容的一侧；全空则删
        const take = oursChanged ? oursSide : theirsChanged ? theirsSide : []
        const kind: MergeRegionKind = oursChanged === theirsChanged
          ? 'common'
          : oursChanged ? 'ours' : 'theirs'
        pushRegion(regions, kind, i, segEnd, take, undefined)
        fileLine += take.length
        oursEmitted += oursChanged ? take.length : segEnd - i
        theirsEmitted += theirsChanged ? take.length : segEnd - i
      }
    } else if (oursTouched) {
      // 仅 ours 触及：ours 改动或删除
      pushRegion(regions, 'ours', i, segEnd, oursSide, undefined)
      fileLine += oursSide.length
      oursEmitted += oursSide.length
      theirsEmitted += segEnd - i
    } else if (theirsTouched) {
      // 仅 theirs 触及：theirs 改动或删除
      pushRegion(regions, 'theirs', i, segEnd, theirsSide, undefined)
      fileLine += theirsSide.length
      theirsEmitted += theirsSide.length
      oursEmitted += segEnd - i
    } else {
      // 双方都未触及（理论不可达）——保留 base 并推进，防死循环
      pushRegion(regions, 'common', i, segEnd, baseLines.slice(i, segEnd), undefined)
      fileLine += segEnd - i
      oursEmitted += segEnd - i
      theirsEmitted += segEnd - i
    }

    if (hasO) pO++
    if (hasT) pT++
    i = segEnd === i ? i + 1 : segEnd // 零宽段兜底推进
  }

  // base 结束后：ours/theirs 尾部新增（消费计数基于「已排进 region 的行数」）
  const tailO = oursLines.slice(oursEmitted)
  const tailT = theirsLines.slice(theirsEmitted)
  if (tailO.length > 0 || tailT.length > 0) {
    if (tailO.length > 0 && tailT.length > 0 && !sameLines(tailO, tailT)) {
      regions.push({
        kind: 'conflict',
        baseStart: baseLines.length,
        baseEnd: baseLines.length,
        lines: tailO,
        oursLines: tailO,
        theirsLines: tailT,
        baseLines: [],
      })
      conflicts.push({
        id: hunkId++,
        baseStart: baseLines.length,
        baseEnd: baseLines.length,
        startLine: fileLine,
        endLine: fileLine + Math.max(tailO.length, tailT.length),
        oursLines: [...tailO],
        theirsLines: [...tailT],
        baseLines: [],
      })
    } else if (tailO.length > 0 && tailT.length > 0) {
      pushRegion(regions, 'common', baseLines.length, baseLines.length, tailO, undefined)
    } else if (tailO.length > 0) {
      pushRegion(regions, 'ours', baseLines.length, baseLines.length, tailO, undefined)
    } else {
      pushRegion(regions, 'theirs', baseLines.length, baseLines.length, tailT, undefined)
    }
  }

  return { regions, conflicts }
}

/**
 * base 相对一方的变更段。
 *
 * diffArrays 输出的 chunk 流中，替换段为 removed chunk 紧跟 added chunk，
 * 纯添加为独立 added chunk（base 零宽锚在当前位置），纯删除为独立 removed chunk。
 * 成对消费，产出按 baseStart 排序的变更段。
 */
function diffAgainstBase(baseLines: string[], targetLines: string[]): ChangeSegment[] {
  const chunks = diffArrays(baseLines, targetLines) as ArrayChange[]
  const segments: ChangeSegment[] = []
  let b = 0 // base 游标
  let t = 0 // target 游标
  let pendingRemoved: { baseStart: number; baseEnd: number } | null = null

  for (const chunk of chunks) {
    const len = chunk.value.length
    if (chunk.removed) {
      pendingRemoved = { baseStart: b, baseEnd: b + len }
      b += len
    } else if (chunk.added) {
      if (pendingRemoved) {
        segments.push({
          baseStart: pendingRemoved.baseStart,
          baseEnd: pendingRemoved.baseEnd,
          sideStart: t,
          sideEnd: t + len,
        })
        pendingRemoved = null
      } else {
        // 纯添加：base 零宽锚在当前位置
        segments.push({ baseStart: b, baseEnd: b, sideStart: t, sideEnd: t + len })
      }
      t += len
    } else {
      // unchanged：若 pendingRemoved 残留（removed 后无 added），为纯删除段
      if (pendingRemoved) {
        segments.push({
          baseStart: pendingRemoved.baseStart,
          baseEnd: pendingRemoved.baseEnd,
          sideStart: t,
          sideEnd: t,
        })
        pendingRemoved = null
      }
      b += len
      t += len
    }
  }
  if (pendingRemoved) {
    segments.push({
      baseStart: pendingRemoved.baseStart,
      baseEnd: pendingRemoved.baseEnd,
      sideStart: t,
      sideEnd: t,
    })
  }

  return segments
}

/** 行切分（null → 空数组；去掉末尾空串，统一「最后一行不带 \n」语义） */
function splitLines(text: string | null): string[] {
  if (text == null) return []
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false
  return true
}

function pushRegion(
  regions: MergeRegion[],
  kind: MergeRegionKind,
  baseStart: number,
  baseEnd: number,
  lines: string[],
  _extra: unknown,
): void {
  regions.push({ kind, baseStart, baseEnd, lines })
}

/**
 * 按 resolutions 构建最终 result（region 拼接）。
 *
 * @param regions parseConflictMarkers 输出的全部区域
 * @param resolutions 冲突块决策：conflicts 下标 → 'ours' | 'theirs' | 'base'
 *                    未决策的 conflict 块默认取 ours（应用后用户可再编辑文件）
 */
export function buildResult(
  regions: MergeRegion[],
  resolutions: Record<number, ConflictResolution>,
): string {
  let result = ''
  let conflictIdx = 0
  for (const region of regions) {
    if (region.kind === 'conflict') {
      const side = resolutions[conflictIdx] ?? 'ours'
      const picked = side === 'theirs' ? (region.theirsLines ?? region.lines)
        : side === 'base' ? (region.baseLines ?? [])
        : region.lines
      conflictIdx++
      if (picked.length > 0) result += picked.join('\n') + '\n'
    } else {
      if (region.lines.length > 0) result += region.lines.join('\n') + '\n'
    }
  }
  return result
}

/** 供组件使用：给定 base 三文本解析出的 conflict 数组长度（未解决冲突数） */
export function countUnresolved(resolutions: Record<number, ConflictResolution>, total: number): number {
  let unresolved = 0
  for (let id = 0; id < total; id++) {
    if (!resolutions[id]) unresolved++
  }
  return unresolved
}
