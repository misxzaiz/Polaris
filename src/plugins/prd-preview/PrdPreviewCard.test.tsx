/**
 * PrdPreviewCard — 投影 hydration 渲染分支测试
 *
 * 方案：plans/prd-preview-ux-optimization.md 线 1。
 * 覆盖四条分支：完整 artifact 直渲染 / 投影 data hydrate 成功直出预览 /
 * 读文件失败退通知兜底 / 内容判据不过（空/无标签）退通知兜底。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('@/services/tauri/fileService', () => ({
  getFileContent: vi.fn(),
}))
vi.mock('@/services/tauri/windowService', () => ({
  openInDefaultApp: vi.fn(),
  setFullscreen: vi.fn(),
  isFullscreen: vi.fn(() => Promise.resolve(false)),
  onFullscreenChange: vi.fn(() => () => {}),
}))
vi.mock('@/services/tauri/chatService', () => ({ respondPluginCard: vi.fn() }))
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: vi.fn() }))
vi.mock('@/stores/fileEditorStore', () => ({
  useFileEditorStore: (selector: (s: { openFile: () => void }) => () => void) =>
    selector({ openFile: vi.fn() }),
}))

import { PrdPreviewCard } from '../../plugins/prd-preview/PrdPreviewCard'
import { getFileContent } from '@/services/tauri/fileService'

const mockGetFileContent = vi.mocked(getFileContent)

// ArtifactPreviewRenderer 内部经 useContainerWidth 使用 ResizeObserver 测量容器宽度，
// jsdom 无该 API → 按仓库惯例（ArtifactPreviewRenderer.test.tsx）stub 一个无操作实现
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

const fullArtifact = {
  artifactType: 'polaris.preview',
  previewId: 'p-full',
  title: '完整预览',
  contentType: 'html',
  html: '<html><body>hello</body></html>',
  sourcePath: 'D:\\w\\.polaris\\previews\\p-full\\index.html',
  createdAt: '2026-10-17T00:00:00Z',
  version: 1,
}

const HYDRATE_HTML = '<html><body>hydrated</body></html>'

beforeEach(() => {
  mockGetFileContent.mockReset()
})

describe('PrdPreviewCard 渲染分支', () => {
  it('完整 artifact（html+previewId）→ 直接渲染，不触发读文件', () => {
    render(
      <PrdPreviewCard
        pluginId="polaris.prd-preview"
        cardId="preview-card"
        toolName="execute"
        mode="result"
        status="ready"
        data={fullArtifact}
      />
    )
    const frames = document.querySelectorAll('iframe')
    expect(frames.length).toBeGreaterThan(0)
    expect(mockGetFileContent).not.toHaveBeenCalled()
  })

  it('投影 data（无 html）→ hydration 成功直出 iframe', async () => {
    mockGetFileContent.mockResolvedValue(HYDRATE_HTML)
    render(
      <PrdPreviewCard
        pluginId="polaris.prd-preview"
        cardId="preview-card"
        toolName="execute"
        mode="result"
        status="ready"
        data={{
          previewId: 'p-h1',
          title: '投影预览',
          sourcePath: 'D:\\w\\.polaris\\previews\\p-h1\\index.html',
          versionLabel: 'v2',
        }}
      />
    )
    await waitFor(() => {
      expect(document.querySelector('iframe[srcdoc*="hydrated"]')).toBeTruthy()
    })
    expect(mockGetFileContent).toHaveBeenCalledWith('D:\\w\\.polaris\\previews\\p-h1\\index.html')
  })

  it('读文件失败 → 退回「预览已生成 + 打开源码」通知', async () => {
    mockGetFileContent.mockRejectedValue(new Error('not found'))
    render(
      <PrdPreviewCard
        pluginId="polaris.prd-preview"
        cardId="preview-card"
        toolName="execute"
        mode="result"
        status="ready"
        data={{
          previewId: 'p-h2',
          title: '丢文件预览',
          sourcePath: 'D:\\w\\.polaris\\previews\\p-h2\\index.html',
        }}
      />
    )
    await waitFor(() => {
      expect(screen.getByText(/预览已生成/)).toBeTruthy()
      expect(screen.getByText(/丢文件预览/)).toBeTruthy()
    })
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('读到空内容/无标签 → 同样退回通知兜底', async () => {
    mockGetFileContent.mockResolvedValue('   ')
    render(
      <PrdPreviewCard
        pluginId="polaris.prd-preview"
        cardId="preview-card"
        toolName="execute"
        mode="result"
        status="ready"
        data={{
          previewId: 'p-h3',
          sourcePath: 'D:\\w\\.polaris\\previews\\p-h3\\index.html',
        }}
      />
    )
    await waitFor(() => {
      expect(screen.getByText(/预览已生成/)).toBeTruthy()
    })
  })
})

describe('PluginChatCardProps 兼容', () => {
  it('props.data 结构完全不合预期 → 解析失败兜底文案', () => {
    render(
      <PrdPreviewCard
        pluginId="polaris.prd-preview"
        cardId="preview-card"
        toolName="execute"
        mode="result"
        status="ready"
        data={'非对象错误文本'}
      />
    )
    expect(screen.getByText(/PRD 预览数据解析失败/)).toBeTruthy()
  })
})
