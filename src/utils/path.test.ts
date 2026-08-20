import { describe, expect, it } from 'vitest'
import {
  getFileNameFromPath,
  isAbsolutePath,
  resolveWorkspacePath,
} from './path'

describe('path utilities', () => {
  it('detects absolute paths across platforms', () => {
    expect(isAbsolutePath('C:/repo/src/App.tsx')).toBe(true)
    expect(isAbsolutePath('C:\\repo\\src\\App.tsx')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\file.ts')).toBe(true)
    expect(isAbsolutePath('/repo/src/App.tsx')).toBe(true)
    expect(isAbsolutePath('src/App.tsx')).toBe(false)
  })

  it('extracts file names from Windows and Unix paths', () => {
    expect(getFileNameFromPath('src/App.tsx')).toBe('App.tsx')
    expect(getFileNameFromPath('src\\components\\GitPanel\\HistoryTab.tsx')).toBe('HistoryTab.tsx')
    expect(getFileNameFromPath('README.md')).toBe('README.md')
  })

  it('resolves relative Git paths against a workspace path', () => {
    expect(resolveWorkspacePath('D:/repo', 'src/App.tsx')).toBe('D:/repo/src/App.tsx')
    expect(resolveWorkspacePath('D:\\repo', 'src/App.tsx')).toBe('D:\\repo\\src\\App.tsx')
    expect(resolveWorkspacePath('D:\\repo\\', '\\src\\App.tsx')).toBe('D:\\repo\\src\\App.tsx')
  })

  it('leaves absolute paths untouched', () => {
    expect(resolveWorkspacePath('D:/repo', 'C:/other/file.ts')).toBe('C:/other/file.ts')
    expect(resolveWorkspacePath('D:/repo', '/tmp/file.ts')).toBe('/tmp/file.ts')
  })
})
