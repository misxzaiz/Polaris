import { describe, it, expect, beforeEach } from 'vitest'
import { useDiagnosticsStore, type DiagnosticItem } from './diagnosticsStore'

function createDiagnostic(overrides: Partial<DiagnosticItem> = {}): DiagnosticItem {
  return {
    severity: 1,
    message: 'Test error',
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 10 },
    },
    ...overrides,
  }
}

describe('diagnosticsStore', () => {
  beforeEach(() => {
    useDiagnosticsStore.getState().clearAll()
  })

  describe('set', () => {
    it('应该设置文件的诊断信息', () => {
      const diagnostics = [createDiagnostic()]
      useDiagnosticsStore.getState().set('file:///test.ts', diagnostics)

      const { byUri } = useDiagnosticsStore.getState()
      expect(byUri.get('file:///test.ts')).toEqual(diagnostics)
    })

    it('应该更新版本号', () => {
      const { version: initialVersion } = useDiagnosticsStore.getState()
      useDiagnosticsStore.getState().set('file:///test.ts', [createDiagnostic()])

      const { version } = useDiagnosticsStore.getState()
      expect(version).toBe(initialVersion + 1)
    })

    it('应该删除空诊断列表的文件', () => {
      useDiagnosticsStore.getState().set('file:///test.ts', [createDiagnostic()])
      useDiagnosticsStore.getState().set('file:///test.ts', [])

      const { byUri } = useDiagnosticsStore.getState()
      expect(byUri.has('file:///test.ts')).toBe(false)
    })

    it('应该更新汇总计数', () => {
      useDiagnosticsStore.getState().set('file:///test.ts', [
        createDiagnostic({ severity: 1 }),
        createDiagnostic({ severity: 2 }),
      ])

      const { summary } = useDiagnosticsStore.getState()
      expect(summary.errors).toBe(1)
      expect(summary.warnings).toBe(1)
    })
  })

  describe('clear', () => {
    it('应该清除指定文件的诊断', () => {
      useDiagnosticsStore.getState().set('file:///test.ts', [createDiagnostic()])
      useDiagnosticsStore.getState().clear('file:///test.ts')

      const { byUri } = useDiagnosticsStore.getState()
      expect(byUri.has('file:///test.ts')).toBe(false)
    })

    it('不应该更新版本号当文件不存在', () => {
      const { version: initialVersion } = useDiagnosticsStore.getState()
      useDiagnosticsStore.getState().clear('file:///nonexistent.ts')

      const { version } = useDiagnosticsStore.getState()
      expect(version).toBe(initialVersion)
    })
  })

  describe('clearAll', () => {
    it('应该清除所有诊断', () => {
      useDiagnosticsStore.getState().set('file:///test1.ts', [createDiagnostic()])
      useDiagnosticsStore.getState().set('file:///test2.ts', [createDiagnostic()])
      useDiagnosticsStore.getState().clearAll()

      const { byUri, summary } = useDiagnosticsStore.getState()
      expect(byUri.size).toBe(0)
      expect(summary).toEqual({ errors: 0, warnings: 0, infos: 0, hints: 0 })
    })
  })

  describe('flat', () => {
    it('应该返回所有诊断的扁平列表', () => {
      const diag1 = createDiagnostic({ message: 'Error 1' })
      const diag2 = createDiagnostic({ message: 'Error 2' })

      useDiagnosticsStore.getState().set('file:///test1.ts', [diag1])
      useDiagnosticsStore.getState().set('file:///test2.ts', [diag2])

      const result = useDiagnosticsStore.getState().flat()
      expect(result).toHaveLength(2)
      expect(result).toContainEqual({ uri: 'file:///test1.ts', item: diag1 })
      expect(result).toContainEqual({ uri: 'file:///test2.ts', item: diag2 })
    })

    it('应该返回空列表当没有诊断', () => {
      const result = useDiagnosticsStore.getState().flat()
      expect(result).toHaveLength(0)
    })
  })

  describe('summary 计算', () => {
    it('应该正确计算不同严重性的诊断数量', () => {
      useDiagnosticsStore.getState().set('file:///test.ts', [
        createDiagnostic({ severity: 1 }),
        createDiagnostic({ severity: 1 }),
        createDiagnostic({ severity: 2 }),
        createDiagnostic({ severity: 3 }),
        createDiagnostic({ severity: 4 }),
      ])

      const { summary } = useDiagnosticsStore.getState()
      expect(summary.errors).toBe(2)
      expect(summary.warnings).toBe(1)
      expect(summary.infos).toBe(1)
      expect(summary.hints).toBe(1)
    })

    it('应该将未知严重性计为错误', () => {
      useDiagnosticsStore.getState().set('file:///test.ts', [
        createDiagnostic({ severity: undefined }),
        createDiagnostic({ severity: 99 }),
      ])

      const { summary } = useDiagnosticsStore.getState()
      expect(summary.errors).toBe(2)
    })

    it('应该跨文件汇总', () => {
      useDiagnosticsStore.getState().set('file:///test1.ts', [
        createDiagnostic({ severity: 1 }),
      ])
      useDiagnosticsStore.getState().set('file:///test2.ts', [
        createDiagnostic({ severity: 2 }),
      ])

      const { summary } = useDiagnosticsStore.getState()
      expect(summary.errors).toBe(1)
      expect(summary.warnings).toBe(1)
    })
  })
})
