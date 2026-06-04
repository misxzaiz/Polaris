import { describe, expect, it } from 'vitest'
import { createConversationStore } from './createConversationStore'
import type { AIEvent } from '../../ai-runtime'
import type { StoreDeps } from './types'

function createDeps(): StoreDeps {
  return {
    getConfig: () => ({ defaultEngine: 'agnes' }),
    getWorkspace: () => null,
    getContextWorkspaceIds: () => [],
    getAllWorkspaces: () => [],
    getEventRouter: () => ({}) as StoreDeps['getEventRouter'] extends () => infer T ? T : never,
    contextId: 'test-context',
  }
}

/**
 * 验证主聊天 Agnes 文生图的事件 → 内联 MediaBlock 路径：
 * handleAIEvent(image_*) → appendMediaBlock / updateMediaBlock → currentMessage.blocks。
 */
describe('conversation media block (Agnes 文生图内联)', () => {
  it('image_generation_start 创建 generating 状态的 media block 并记录 mediaBlockMap', () => {
    const store = createConversationStore('session-media-1', createDeps())

    store.getState().handleAIEvent({
      type: 'image_generation_start',
      sessionId: 'agnes-session',
      taskId: 'img-1',
      prompt: 'a shiba inu wearing sunglasses, cyberpunk neon',
      size: '1024x768',
      isImageEdit: false,
    } satisfies AIEvent)

    const blocks = store.getState().currentMessage?.blocks
    expect(blocks?.[0]).toMatchObject({
      type: 'media',
      id: 'img-1',
      mediaType: 'image',
      status: 'generating',
      prompt: 'a shiba inu wearing sunglasses, cyberpunk neon',
      progress: 0,
    })
    expect(store.getState().mediaBlockMap.get('img-1')).toBe(0)
  })

  it('image_generation_progress 更新进度但保持 generating', () => {
    const store = createConversationStore('session-media-2', createDeps())
    const emit = store.getState().handleAIEvent

    emit({
      type: 'image_generation_start',
      sessionId: 's',
      taskId: 'img-1',
      prompt: 'p',
      size: '1024x768',
      isImageEdit: false,
    } satisfies AIEvent)
    emit({
      type: 'image_generation_progress',
      sessionId: 's',
      taskId: 'img-1',
      progress: 50,
    } satisfies AIEvent)

    expect(store.getState().currentMessage?.blocks?.[0]).toMatchObject({
      type: 'media',
      status: 'generating',
      progress: 50,
    })
  })

  it('image_generated 将 media block 标记为 completed 并写入 url/size/completedAt', () => {
    const store = createConversationStore('session-media-3', createDeps())
    const emit = store.getState().handleAIEvent

    emit({
      type: 'image_generation_start',
      sessionId: 's',
      taskId: 'img-1',
      prompt: 'p',
      size: '1024x768',
      isImageEdit: false,
    } satisfies AIEvent)
    emit({
      type: 'image_generated',
      sessionId: 's',
      taskId: 'img-1',
      imageUrl: 'https://cdn.example.com/img.png',
      prompt: 'p',
      size: '1024x768',
    } satisfies AIEvent)

    const block = store.getState().currentMessage?.blocks?.[0]
    expect(block).toMatchObject({
      type: 'media',
      status: 'completed',
      url: 'https://cdn.example.com/img.png',
      size: '1024x768',
    })
    expect((block as { completedAt?: string }).completedAt).toBeTruthy()
  })

  it('image_generation_error 将 media block 标记为 failed 并写入错误', () => {
    const store = createConversationStore('session-media-4', createDeps())
    const emit = store.getState().handleAIEvent

    emit({
      type: 'image_generation_start',
      sessionId: 's',
      taskId: 'img-1',
      prompt: 'p',
      size: '1024x768',
      isImageEdit: false,
    } satisfies AIEvent)
    emit({
      type: 'image_generation_error',
      sessionId: 's',
      taskId: 'img-1',
      error: 'Failed to fetch (CORS)',
    } satisfies AIEvent)

    expect(store.getState().currentMessage?.blocks?.[0]).toMatchObject({
      type: 'media',
      status: 'failed',
      error: 'Failed to fetch (CORS)',
    })
  })

  it('并发多个 media block 时按 taskId 精确定位更新，互不影响', () => {
    const store = createConversationStore('session-media-5', createDeps())
    const emit = store.getState().handleAIEvent

    emit({
      type: 'image_generation_start',
      sessionId: 's',
      taskId: 'img-a',
      prompt: 'A',
      size: '1024x768',
      isImageEdit: false,
    } satisfies AIEvent)
    emit({
      type: 'image_generation_start',
      sessionId: 's',
      taskId: 'img-b',
      prompt: 'B',
      size: '1024x768',
      isImageEdit: false,
    } satisfies AIEvent)

    // 仅完成 img-b
    emit({
      type: 'image_generated',
      sessionId: 's',
      taskId: 'img-b',
      imageUrl: 'https://cdn.example.com/b.png',
      prompt: 'B',
      size: '1024x768',
    } satisfies AIEvent)

    const blocks = store.getState().currentMessage?.blocks
    expect(blocks?.[0]).toMatchObject({ type: 'media', id: 'img-a', status: 'generating' })
    expect(blocks?.[1]).toMatchObject({
      type: 'media',
      id: 'img-b',
      status: 'completed',
      url: 'https://cdn.example.com/b.png',
    })
  })
})
