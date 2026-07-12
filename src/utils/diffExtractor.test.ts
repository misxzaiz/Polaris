import { describe, it, expect } from 'vitest'
import { isEditTool, isWriteTool, extractEditDiff, extractWriteInfo } from './diffExtractor'
import type { ToolCallBlock } from '@/types/chat'

function createToolCallBlock(overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return {
    id: 'test-id',
    type: 'tool_call',
    name: 'Edit',
    input: {},
    status: 'completed',
    ...overrides,
  } as ToolCallBlock
}

describe('isEditTool', () => {
  it('应该识别 Edit 工具', () => {
    expect(isEditTool('Edit')).toBe(true)
    expect(isEditTool('edit')).toBe(true)
    expect(isEditTool('EDIT')).toBe(true)
  })

  it('应该识别 str_replace_editor 工具', () => {
    expect(isEditTool('str_replace_editor')).toBe(true)
    expect(isEditTool('str_replace')).toBe(true)
  })

  it('应该拒绝非编辑工具', () => {
    expect(isEditTool('Read')).toBe(false)
    expect(isEditTool('Write')).toBe(false)
    expect(isEditTool('Bash')).toBe(false)
  })
})

describe('isWriteTool', () => {
  it('应该识别 Write 工具', () => {
    expect(isWriteTool('Write')).toBe(true)
    expect(isWriteTool('write')).toBe(true)
    expect(isWriteTool('WRITE')).toBe(true)
  })

  it('应该识别 write_file 工具', () => {
    expect(isWriteTool('write_file')).toBe(true)
    // isWriteTool 只检查小写形式，所以 WriteFile 不会被识别
    expect(isWriteTool('WriteFile')).toBe(false)
  })

  it('应该识别 create_file 工具', () => {
    expect(isWriteTool('create_file')).toBe(true)
    expect(isWriteTool('create')).toBe(true)
  })

  it('应该拒绝非写入工具', () => {
    expect(isWriteTool('Read')).toBe(false)
    expect(isWriteTool('Edit')).toBe(false)
    expect(isWriteTool('Bash')).toBe(false)
  })
})

describe('extractEditDiff', () => {
  it('应该从 Edit 工具提取 diff 数据', () => {
    const block = createToolCallBlock({
      name: 'Edit',
      input: {
        file_path: '/src/test.ts',
        old_string: 'old content',
        new_string: 'new content',
      },
    })

    const result = extractEditDiff(block)
    expect(result).toEqual({
      filePath: '/src/test.ts',
      oldContent: 'old content',
      newContent: 'new content',
    })
  })

  it('应该支持 path 命名', () => {
    const block = createToolCallBlock({
      name: 'Edit',
      input: {
        path: '/src/test.ts',
        old_string: 'old',
        new_string: 'new',
      },
    })

    const result = extractEditDiff(block)
    expect(result?.filePath).toBe('/src/test.ts')
  })

  it('应该支持 old_str/new_str 命名', () => {
    const block = createToolCallBlock({
      name: 'Edit',
      input: {
        file_path: '/src/test.ts',
        old_str: 'old',
        new_str: 'new',
      },
    })

    const result = extractEditDiff(block)
    expect(result?.oldContent).toBe('old')
    expect(result?.newContent).toBe('new')
  })

  it('应该返回 null 当不是编辑工具', () => {
    const block = createToolCallBlock({ name: 'Read' })
    expect(extractEditDiff(block)).toBeNull()
  })

  it('应该返回 null 当缺少必需字段', () => {
    const block = createToolCallBlock({
      name: 'Edit',
      input: { file_path: '/src/test.ts' },
    })
    expect(extractEditDiff(block)).toBeNull()
  })
})

describe('extractWriteInfo', () => {
  it('应该从 Write 工具提取信息', () => {
    const block = createToolCallBlock({
      name: 'Write',
      input: {
        path: '/src/test.ts',
        content: 'file content',
      },
    })

    const result = extractWriteInfo(block)
    expect(result).toEqual({
      filePath: '/src/test.ts',
      newContent: 'file content',
    })
  })

  it('应该支持 file_path 命名', () => {
    const block = createToolCallBlock({
      name: 'Write',
      input: {
        file_path: '/src/test.ts',
        content: 'content',
      },
    })

    const result = extractWriteInfo(block)
    expect(result?.filePath).toBe('/src/test.ts')
  })

  it('应该返回 null 当不是写入工具', () => {
    const block = createToolCallBlock({ name: 'Read' })
    expect(extractWriteInfo(block)).toBeNull()
  })

  it('应该返回 null 当缺少必需字段', () => {
    const block = createToolCallBlock({
      name: 'Write',
      input: { path: '/src/test.ts' },
    })
    expect(extractWriteInfo(block)).toBeNull()
  })
})
