/**
 * Split 双栏滚动联动
 *
 * 每侧由「行号列(仅纵向，不横滑) + 代码列(横向+纵向)」组成，共 4 个滚动元素：
 * - 垂直：用户滚动任一代码列时，另一代码列与两个行号列同步 scrollTop，保证逐行对齐。
 * - 水平：两个代码列 scrollLeft 联动（左右滑动联动）；行号列不参与横向。
 *
 * 行号列设为 overflow-hidden，仅由代码列驱动其 scrollTop（程序化设置仍生效）。
 */

import { useEffect } from 'react'

export function useSplitScrollSync(
  leftCode: HTMLElement | null,
  rightCode: HTMLElement | null,
  leftGutter: HTMLElement | null,
  rightGutter: HTMLElement | null,
) {
  useEffect(() => {
    if (!leftCode || !rightCode) return

    let locked = false
    const make = (src: HTMLElement, otherCode: HTMLElement) => () => {
      if (locked) return
      locked = true
      const top = src.scrollTop
      const left = src.scrollLeft
      otherCode.scrollTop = top
      otherCode.scrollLeft = left // 水平联动
      if (leftGutter) leftGutter.scrollTop = top
      if (rightGutter) rightGutter.scrollTop = top
      requestAnimationFrame(() => {
        locked = false
      })
    }
    const onLeft = make(leftCode, rightCode)
    const onRight = make(rightCode, leftCode)
    leftCode.addEventListener('scroll', onLeft, { passive: true })
    rightCode.addEventListener('scroll', onRight, { passive: true })
    return () => {
      leftCode.removeEventListener('scroll', onLeft)
      rightCode.removeEventListener('scroll', onRight)
    }
  }, [leftCode, rightCode, leftGutter, rightGutter])
}
