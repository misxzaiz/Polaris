import { describe, expect, it } from 'vitest'
import { createConversationStore } from './createConversationStore'
import type { StoreDeps } from './types'

function createDeps(): StoreDeps {
  return {
    getConfig: () => ({ defaultEngine: 'codex' }),
    getWorkspace: () => null,
    getContextWorkspaceIds: () => [],
    getAllWorkspaces: () => [],
    getEventRouter: () => ({}) as StoreDeps['getEventRouter'] extends () => infer T ? T : never,
    contextId: 'test-context',
  }
}

function createStore() {
  return createConversationStore('session-optimize-test', createDeps())
}

describe('promptOptimize 版本栈', () => {
  it('首轮优化：原文入栈为 v1，结果入栈为 v2 并写回草稿', () => {
    const store = createStore()
    store.getState().updateInputDraft({ text: '原始提示词', attachments: [] })

    store.getState().beginPromptOptimize('原始提示词', { engineId: 'claude-code', optimizeSessionId: 'opt-1' })
    expect(store.getState().promptOptimize.status).toBe('running')
    expect(store.getState().promptOptimize.history).toHaveLength(1)
    expect(store.getState().promptOptimize.history[0]).toMatchObject({ text: '原始提示词', origin: 'original' })

    store.getState().completePromptOptimize('优化后的提示词')
    const po = store.getState().promptOptimize
    expect(po.status).toBe('idle')
    expect(po.history).toHaveLength(2)
    expect(po.history[1]).toMatchObject({ text: '优化后的提示词', origin: 'optimized', engineId: 'claude-code' })
    expect(po.cursor).toBe(1)
    expect(store.getState().inputDraft.text).toBe('优化后的提示词')
  })

  it('回滚/重做：cursor 移动并同步草稿；redo 越界为 no-op', () => {
    const store = createStore()
    store.getState().updateInputDraft({ text: 'v1', attachments: [] })
    store.getState().beginPromptOptimize('v1', { engineId: 'codex', optimizeSessionId: 'opt-1' })
    store.getState().completePromptOptimize('v2')

    store.getState().undoPromptOptimize()
    expect(store.getState().promptOptimize.cursor).toBe(0)
    expect(store.getState().inputDraft.text).toBe('v1')

    store.getState().redoPromptOptimize()
    expect(store.getState().promptOptimize.cursor).toBe(1)
    expect(store.getState().inputDraft.text).toBe('v2')

    // 已在栈顶，redo 越界 no-op
    store.getState().redoPromptOptimize()
    expect(store.getState().promptOptimize.cursor).toBe(1)
  })

  it('完成时输入被手改：不覆盖草稿，转 ready 待应用；应用时手改文本先入栈', () => {
    const store = createStore()
    store.getState().updateInputDraft({ text: '原文', attachments: [] })
    store.getState().beginPromptOptimize('原文', { engineId: 'mimo', optimizeSessionId: 'opt-1' })

    // 优化期间用户手改输入
    store.getState().updateInputDraft({ text: '手改后的原文', attachments: [] })

    store.getState().completePromptOptimize('优化结果')
    let po = store.getState().promptOptimize
    expect(po.status).toBe('ready')
    expect(po.pendingResult).toBe('优化结果')
    // 草稿未被覆盖
    expect(store.getState().inputDraft.text).toBe('手改后的原文')

    store.getState().applyPendingPromptOptimize()
    po = store.getState().promptOptimize
    expect(po.status).toBe('idle')
    // 栈：原文 → 手改（保留可回滚） → 优化结果
    expect(po.history.map((v) => v.text)).toEqual(['原文', '手改后的原文', '优化结果'])
    expect(po.history[1].origin).toBe('edited')
    expect(store.getState().inputDraft.text).toBe('优化结果')
  })

  it('回滚后手改再优化：截断 redo 分支，手改文本入栈为新版本', () => {
    const store = createStore()
    store.getState().updateInputDraft({ text: 'v1', attachments: [] })
    store.getState().beginPromptOptimize('v1', { engineId: 'simple-ai', optimizeSessionId: 'opt-1' })
    store.getState().completePromptOptimize('v2')

    // 回滚到 v1 后手改，再次优化
    store.getState().undoPromptOptimize()
    store.getState().updateInputDraft({ text: 'v1-手改', attachments: [] })
    store.getState().beginPromptOptimize('v1-手改', { engineId: 'simple-ai', optimizeSessionId: 'opt-2' })

    let po = store.getState().promptOptimize
    // v2 的 redo 分支被截断，手改文本入栈
    expect(po.history.map((v) => v.text)).toEqual(['v1', 'v1-手改'])

    store.getState().completePromptOptimize('v3')
    po = store.getState().promptOptimize
    expect(po.history.map((v) => v.text)).toEqual(['v1', 'v1-手改', 'v3'])
    expect(po.cursor).toBe(2)
  })

  it('undo 时未入栈的手改先入栈，redo 可回到手改文本', () => {
    const store = createStore()
    store.getState().updateInputDraft({ text: 'v1', attachments: [] })
    store.getState().beginPromptOptimize('v1', { engineId: 'claude-code', optimizeSessionId: 'opt-1' })
    store.getState().completePromptOptimize('v2')

    // 手改 v2 后直接 undo
    store.getState().updateInputDraft({ text: 'v2-手改', attachments: [] })
    store.getState().undoPromptOptimize()

    const po = store.getState().promptOptimize
    expect(po.history.map((v) => v.text)).toEqual(['v1', 'v2', 'v2-手改'])
    // undo 一步：从手改版本回到 v2
    expect(po.cursor).toBe(1)
    expect(store.getState().inputDraft.text).toBe('v2')

    store.getState().redoPromptOptimize()
    expect(store.getState().inputDraft.text).toBe('v2-手改')
  })

  it('手改后 redo 为 no-op（防覆盖）；失败/取消保留版本栈；reset 清空', () => {
    const store = createStore()
    store.getState().updateInputDraft({ text: 'v1', attachments: [] })
    store.getState().beginPromptOptimize('v1', { engineId: 'codex', optimizeSessionId: 'opt-1' })
    store.getState().completePromptOptimize('v2')
    store.getState().undoPromptOptimize()

    // 回滚到 v1 后手改，redo 会覆盖手改 → no-op
    store.getState().updateInputDraft({ text: 'v1-手改', attachments: [] })
    store.getState().redoPromptOptimize()
    expect(store.getState().inputDraft.text).toBe('v1-手改')
    expect(store.getState().promptOptimize.cursor).toBe(0)

    // 失败：状态回 idle，栈保留
    store.getState().beginPromptOptimize('v1-手改', { engineId: 'codex', optimizeSessionId: 'opt-2' })
    store.getState().failPromptOptimize('boom')
    let po = store.getState().promptOptimize
    expect(po.status).toBe('idle')
    expect(po.error).toBe('boom')
    expect(po.history.length).toBeGreaterThan(0)

    // reset：全部清空
    store.getState().resetPromptOptimize()
    po = store.getState().promptOptimize
    expect(po.history).toHaveLength(0)
    expect(po.cursor).toBe(-1)
    expect(po.error).toBeNull()
  })

  it('completePromptOptimize 空结果转错误；running 之外调用为 no-op', () => {
    const store = createStore()
    store.getState().updateInputDraft({ text: 'v1', attachments: [] })

    // 未 begin 直接 complete → no-op
    store.getState().completePromptOptimize('孤儿结果')
    expect(store.getState().promptOptimize.history).toHaveLength(0)

    store.getState().beginPromptOptimize('v1', { engineId: 'mimo', optimizeSessionId: 'opt-1' })
    store.getState().completePromptOptimize('   ')
    const po = store.getState().promptOptimize
    expect(po.status).toBe('idle')
    expect(po.error).toBeTruthy()
    // 原文版本仍在栈中
    expect(po.history.map((v) => v.text)).toEqual(['v1'])
  })
})
