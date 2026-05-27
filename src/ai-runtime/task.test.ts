import { describe, it, expect } from 'vitest'
import { createTask } from './task'

describe('createTask', () => {
  it('应该创建基本任务', () => {
    const task = createTask('chat', { prompt: 'hello' })

    expect(task.kind).toBe('chat')
    expect(task.input.prompt).toBe('hello')
    expect(task.id).toBeDefined()
    expect(task.id.length).toBe(36) // UUID 格式
  })

  it('应该使用提供的 ID', () => {
    const task = createTask('chat', { prompt: 'hello' }, { id: 'custom-id' })

    expect(task.id).toBe('custom-id')
  })

  it('应该使用提供的 engineId', () => {
    const task = createTask('chat', { prompt: 'hello' }, { engineId: 'codex' })

    expect(task.engineId).toBe('codex')
  })

  it('应该支持所有任务类型', () => {
    const kinds = ['chat', 'refactor', 'analyze', 'generate'] as const

    for (const kind of kinds) {
      const task = createTask(kind, { prompt: 'test' })
      expect(task.kind).toBe(kind)
    }
  })

  it('应该包含文件列表', () => {
    const task = createTask('chat', {
      prompt: 'hello',
      files: ['file1.ts', 'file2.ts'],
    })

    expect(task.input.files).toEqual(['file1.ts', 'file2.ts'])
  })

  it('应该包含额外参数', () => {
    const task = createTask('chat', {
      prompt: 'hello',
      extra: { custom: 'data' },
    })

    expect(task.input.extra).toEqual({ custom: 'data' })
  })

  it('应该生成唯一的 ID', () => {
    const task1 = createTask('chat', { prompt: 'hello' })
    const task2 = createTask('chat', { prompt: 'hello' })

    expect(task1.id).not.toBe(task2.id)
  })
})
