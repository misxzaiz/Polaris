/**
 * detachedWindowStore 单元测试.
 *
 * 覆盖:
 *   - detach / remove / 重复 detach 覆盖
 *   - bringToFront LRU
 *   - updatePosition / updateSize clamp 行为
 *   - isDetached 查询
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useDetachedWindowStore } from './detachedWindowStore'

describe('detachedWindowStore', () => {
  beforeEach(() => {
    useDetachedWindowStore.setState({ windows: [], nextZ: 100 })
  })

  it('detach adds a window with default position/size', () => {
    useDetachedWindowStore.getState().detach('git')
    const w = useDetachedWindowStore.getState().windows[0]
    expect(w.moduleId).toBe('git')
    expect(w.width).toBeGreaterThanOrEqual(240)
    expect(w.height).toBeGreaterThanOrEqual(180)
    expect(w.zIndex).toBeGreaterThan(100)
  })

  it('detach with opts respects given x/y/width/height (after clamp)', () => {
    useDetachedWindowStore.getState().detach('git', { x: 100, y: 50, width: 400, height: 300 })
    const w = useDetachedWindowStore.getState().windows[0]
    expect(w.width).toBe(400)
    expect(w.height).toBe(300)
  })

  it('re-detach same moduleId replaces previous', () => {
    useDetachedWindowStore.getState().detach('git', { x: 10, y: 10 })
    useDetachedWindowStore.getState().detach('git', { x: 200, y: 200 })
    const windows = useDetachedWindowStore.getState().windows
    expect(windows).toHaveLength(1)
    expect(windows[0].x).toBe(200)
  })

  it('detach clamps width to MIN_WIDTH (240)', () => {
    useDetachedWindowStore.getState().detach('git', { width: 100 })
    const w = useDetachedWindowStore.getState().windows[0]
    expect(w.width).toBe(240)
  })

  it('detach clamps height to MIN_HEIGHT (180)', () => {
    useDetachedWindowStore.getState().detach('git', { height: 50 })
    const w = useDetachedWindowStore.getState().windows[0]
    expect(w.height).toBe(180)
  })

  it('remove deletes the window', () => {
    useDetachedWindowStore.getState().detach('git')
    useDetachedWindowStore.getState().detach('todo')
    useDetachedWindowStore.getState().remove('git')
    const ids = useDetachedWindowStore.getState().windows.map((w) => w.moduleId)
    expect(ids).toEqual(['todo'])
  })

  it('updatePosition clamps y to non-negative', () => {
    useDetachedWindowStore.getState().detach('git')
    useDetachedWindowStore.getState().updatePosition('git', 100, -50)
    const w = useDetachedWindowStore.getState().windows[0]
    expect(w.y).toBeGreaterThanOrEqual(0)
  })

  it('updateSize respects min/max viewport', () => {
    useDetachedWindowStore.getState().detach('git')
    useDetachedWindowStore.getState().updateSize('git', 100, 100)
    const w = useDetachedWindowStore.getState().windows[0]
    expect(w.width).toBe(240)
    expect(w.height).toBe(180)
  })

  it('bringToFront increments zIndex above all others', () => {
    useDetachedWindowStore.getState().detach('git')
    useDetachedWindowStore.getState().detach('todo')
    useDetachedWindowStore.getState().detach('terminal')
    useDetachedWindowStore.getState().bringToFront('git')
    const git = useDetachedWindowStore.getState().windows.find((w) => w.moduleId === 'git')!
    const others = useDetachedWindowStore
      .getState()
      .windows.filter((w) => w.moduleId !== 'git')
    expect(others.every((w) => w.zIndex < git.zIndex)).toBe(true)
  })

  it('bringToFront on already-top is a no-op', () => {
    useDetachedWindowStore.getState().detach('git')
    const z1 = useDetachedWindowStore.getState().windows[0].zIndex
    useDetachedWindowStore.getState().bringToFront('git')
    const z2 = useDetachedWindowStore.getState().windows[0].zIndex
    expect(z2).toBe(z1)
  })

  it('isDetached returns true for currently detached module', () => {
    useDetachedWindowStore.getState().detach('git')
    expect(useDetachedWindowStore.getState().isDetached('git')).toBe(true)
    expect(useDetachedWindowStore.getState().isDetached('todo')).toBe(false)
  })

  it('isDetached returns false after remove', () => {
    useDetachedWindowStore.getState().detach('git')
    useDetachedWindowStore.getState().remove('git')
    expect(useDetachedWindowStore.getState().isDetached('git')).toBe(false)
  })
})
