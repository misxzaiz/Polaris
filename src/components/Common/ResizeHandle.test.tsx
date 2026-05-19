/**
 * ResizeHandle 行为单测
 *
 * 锁定 4 种 (direction × position) 组合下,鼠标拖动 → onDrag(delta) 的符号语义:
 *
 *   direction='horizontal' + position='left':  手柄贴 panel 左边,
 *                                              鼠标右移 (delta=+) → onDrag(-) (面板收缩)
 *                                              鼠标左移 (delta=-) → onDrag(+) (面板扩张)
 *   direction='horizontal' + position='right': 手柄贴 panel 右边,
 *                                              鼠标右移 → onDrag(+),左移 → onDrag(-)
 *   direction='vertical'   + position='left':  手柄贴 panel 顶部,
 *                                              鼠标下移 → onDrag(-) (面板收缩),上移 → onDrag(+)
 *   direction='vertical'   + position='right': 手柄贴 panel 底部,
 *                                              鼠标下移 → onDrag(+),上移 → onDrag(-)
 *
 * 这些语义被 SlotPanel.tsx 的 HANDLE_POSITION 表强依赖,改动 ResizeHandle 须同步更新 SlotPanel.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, cleanup } from '@testing-library/react'
import { ResizeHandle } from './ResizeHandle'

interface CaseSpec {
  name: string
  direction: 'horizontal' | 'vertical'
  position: 'left' | 'right'
  /** 模拟鼠标从 (0,0) 移到这个坐标 */
  move: { x: number; y: number }
  /** 期望传给 onDrag 的 delta */
  expected: number
}

const CASES: CaseSpec[] = [
  // horizontal
  {
    name: 'horizontal + right: mouse right → positive delta (expand)',
    direction: 'horizontal',
    position: 'right',
    move: { x: 50, y: 0 },
    expected: 50,
  },
  {
    name: 'horizontal + right: mouse left → negative delta (shrink)',
    direction: 'horizontal',
    position: 'right',
    move: { x: -30, y: 0 },
    expected: -30,
  },
  {
    name: 'horizontal + left: mouse right → negative delta (shrink, handle on left)',
    direction: 'horizontal',
    position: 'left',
    move: { x: 50, y: 0 },
    expected: -50,
  },
  {
    name: 'horizontal + left: mouse left → positive delta (expand)',
    direction: 'horizontal',
    position: 'left',
    move: { x: -40, y: 0 },
    expected: 40,
  },
  // vertical
  {
    name: 'vertical + right: mouse down → positive delta (expand)',
    direction: 'vertical',
    position: 'right',
    move: { x: 0, y: 60 },
    expected: 60,
  },
  {
    name: 'vertical + right: mouse up → negative delta (shrink)',
    direction: 'vertical',
    position: 'right',
    move: { x: 0, y: -20 },
    expected: -20,
  },
  {
    name: 'vertical + left (top edge): mouse up → positive delta (expand)',
    direction: 'vertical',
    position: 'left',
    move: { x: 0, y: -45 },
    expected: 45,
  },
  {
    name: 'vertical + left (top edge): mouse down → negative delta (shrink)',
    direction: 'vertical',
    position: 'left',
    move: { x: 0, y: 30 },
    expected: -30,
  },
]

describe('ResizeHandle delta semantics', () => {
  afterEach(() => {
    cleanup()
    // 清理 ResizeHandle 设置在 body 上的全局样式 (防止测试间互相干扰)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  })

  for (const c of CASES) {
    it(c.name, () => {
      const onDrag = vi.fn()
      const { container } = render(
        <ResizeHandle direction={c.direction} position={c.position} onDrag={onDrag} />
      )
      const handle = container.firstChild as HTMLElement

      // mousedown 在 (0, 0)
      fireEvent.mouseDown(handle, { clientX: 0, clientY: 0 })
      // 全局 mousemove 触发 onDrag
      fireEvent.mouseMove(document, { clientX: c.move.x, clientY: c.move.y })

      expect(onDrag).toHaveBeenCalledTimes(1)
      expect(onDrag).toHaveBeenCalledWith(c.expected)

      // 释放鼠标
      fireEvent.mouseUp(document)
    })
  }

  it('does not fire onDrag when disabled', () => {
    const onDrag = vi.fn()
    const { container } = render(
      <ResizeHandle direction="horizontal" position="left" onDrag={onDrag} disabled />
    )
    const handle = container.firstChild as HTMLElement
    fireEvent.mouseDown(handle, { clientX: 0, clientY: 0 })
    fireEvent.mouseMove(document, { clientX: 100, clientY: 0 })
    expect(onDrag).not.toHaveBeenCalled()
  })

  it('calls onDragEnd after mouseup', () => {
    const onDrag = vi.fn()
    const onDragEnd = vi.fn()
    const { container } = render(
      <ResizeHandle
        direction="horizontal"
        position="right"
        onDrag={onDrag}
        onDragEnd={onDragEnd}
      />
    )
    const handle = container.firstChild as HTMLElement
    fireEvent.mouseDown(handle, { clientX: 0, clientY: 0 })
    fireEvent.mouseMove(document, { clientX: 10, clientY: 0 })
    fireEvent.mouseUp(document)
    expect(onDragEnd).toHaveBeenCalledTimes(1)
  })
})
