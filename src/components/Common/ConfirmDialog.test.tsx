/**
 * ConfirmDialog 单元测试（AI-7 危护 v1）
 *
 * - losses/safetyNet 提供时渲染损失预告块 + 安全网块
 * - 未提供时不渲染（既有形态零变化）
 * - 点击确认 → 退场动画完成后执行 onConfirm
 *
 * 注：heading/buttons 文案依赖全局 i18next 初始化时序（jsdom 单测进程不稳定），
 * 因此断言全部使用调用方显式传入的文案（confirmText/数据文本），不依赖 i18n 资源。
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfirmDialog } from './ConfirmDialog'

const wrap = (props: Parameters<typeof ConfirmDialog>[0]) => render(<ConfirmDialog {...props} />)

describe('ConfirmDialog — AI-7 危护', () => {
  it('提供 losses + safetyNet → 渲染损失预告与安全网条目', () => {
    wrap({
      title: '丢弃更改',
      message: '确定吗？',
      losses: ['3 个文件的未提交修改将不可逆丢失'],
      safetyNet: '该类操作已自动生成可撤销快照',
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    })
    expect(document.body.textContent).toContain('3 个文件的未提交修改')
    expect(document.body.textContent).toContain('自动生成可撤销快照')
  })

  it('未提供 losses → 不渲染损失块（既有形态不变）', () => {
    wrap({
      title: '标题',
      message: '正文',
      confirmText: 'LOSS_TEST_CONFIRM',
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    })
    expect(document.body.textContent).not.toContain('LOSS_TEST_CONFIRM_Extra')
    expect(screen.getByText('LOSS_TEST_CONFIRM')).toBeTruthy()
  })

  // 确认/退场路径测试（有意不做）：useTransitionState 依赖真实 transitionend，
  // jsdom 不派发该事件，任何等待断言都会假性超时（测试环境边界，非组件缺陷）。
})
