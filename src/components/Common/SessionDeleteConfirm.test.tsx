/**
 * SessionDeleteConfirm 单元测试（U1 · ux-layout-r2：会话删除二次确认）
 *
 * 根因背景：sessionStoreManager.deleteSession 不可逆（内存 store + 磁盘 JSONL
 * + 后端消息库一并删除），此前三个入口零确认直调。本组件是唯一确认壳。
 *
 * 断言策略（同 ConfirmDialog.test.tsx 的既有约定）：heading/buttons 文案依赖
 * 全局 i18next mock（src/test/setup.ts 返回 key 本身），因此断言使用 key 串
 * （如 'deleteSessionConfirm.confirm'）与回调调用，不依赖真实翻译资源。
 *
 * 退场动画说明：ConfirmDialog.test.tsx 注释称「依赖真实 transitionend，
 * jsdom 不派发」——该注释已过时：useTransitionState 现以 setTimeout 触发
 * onExited（src/hooks/useTransitionState.ts:63-76）。但实测 waitFor 依赖
 * 真实定时器存在竞态（入场 180ms 定时器把 phase 掀回 open 的时间序不定，
 * 实测同一机制下 confirm 通过、cancel 假失败），故确认/取消两条退场路径
 * 统一用 fake timers + act 确定性驱动，不依赖真实时钟。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionDeleteConfirm } from './SessionDeleteConfirm'

// ─── 可控 mock 状态（vi.mock 提升作用域） ───
const mocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  isStreaming: false,
  /** 目标会话的元数据 status（idle/running/waiting/background-running/error） */
  metadataStatus: 'idle' as string,
}))

vi.mock('@/stores/conversationStore/sessionStoreManager', () => ({
  useSessionManagerActions: () => ({ deleteSession: mocks.deleteSession }),
  useSessionMetadataList: () => [
    { id: 's1', title: '测试会话', status: mocks.metadataStatus },
  ],
}))

vi.mock('@/stores/conversationStore/useActiveSession', () => ({
  useSessionStreaming: () => mocks.isStreaming,
}))

const onCancel = vi.fn()

function renderConfirm() {
  return render(
    <SessionDeleteConfirm
      target={{ sessionId: 's1', title: '测试会话' }}
      onCancel={onCancel}
    />,
  )
}

const confirmBtn = () => screen.getByText('deleteSessionConfirm.confirm')
const cancelBtn = () => screen.getByText('buttons.cancel')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isStreaming = false
  mocks.metadataStatus = 'idle'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionDeleteConfirm — 会话删除二次确认（U1）', () => {
  it('target=null → 不渲染任何内容', () => {
    const { container } = render(
      <SessionDeleteConfirm target={null} onCancel={onCancel} />,
    )
    expect(container.firstChild).toBeNull()
    expect(mocks.deleteSession).not.toHaveBeenCalled()
  })

  it('打开弹窗 → 仅渲染确认框，尚未删除', () => {
    renderConfirm()
    expect(confirmBtn()).toBeTruthy()
    expect(mocks.deleteSession).not.toHaveBeenCalled()
  })

  it('取消 → 退场结束后只关弹窗，不调用删除', () => {
    vi.useFakeTimers()
    renderConfirm()
    fireEvent.click(cancelBtn())
    // 一次推进入场+退场两个 180ms 定时器（fake timers 按排定顺序确定性触发）
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(onCancel).toHaveBeenCalled()
    expect(mocks.deleteSession).not.toHaveBeenCalled()
  })

  it('确认 → 退场动画（180ms setTimeout）结束后调用 deleteSession(sessionId)', () => {
    vi.useFakeTimers()
    renderConfirm()
    fireEvent.click(confirmBtn())
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(mocks.deleteSession).toHaveBeenCalledWith('s1')
    expect(onCancel).toHaveBeenCalled()
  })

  it('会话流式中（isStreaming）→ 正文追加「正在运行」警告', () => {
    mocks.isStreaming = true
    renderConfirm()
    expect(document.body.textContent).toContain(
      'deleteSessionConfirm.runningWarning',
    )
  })

  it('元数据 status=running（非流式）→ 同样追加运行警告', () => {
    mocks.metadataStatus = 'running'
    renderConfirm()
    expect(document.body.textContent).toContain(
      'deleteSessionConfirm.runningWarning',
    )
  })

  it('元数据 status=background-running → 追加运行警告', () => {
    mocks.metadataStatus = 'background-running'
    renderConfirm()
    expect(document.body.textContent).toContain(
      'deleteSessionConfirm.runningWarning',
    )
  })

  it('空闲会话 → 正文不含运行警告', () => {
    renderConfirm()
    expect(document.body.textContent).not.toContain(
      'deleteSessionConfirm.runningWarning',
    )
  })
})
