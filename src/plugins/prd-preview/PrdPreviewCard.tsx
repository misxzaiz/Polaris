/**
 * PRD 预览 MCP 卡片渲染器
 *
 * 接 PluginChatCardProps，从 data（MCP tool result 的 structuredContent，
 * 即 PreviewArtifact 对象）提取字段，复用 ArtifactPreviewRenderer 的完整 UI
 * （iframe 沙箱预览、全屏、下载、源码查看等）。
 *
 * data 字段（camelCase，与 Rust 端 PreviewArtifact 对齐）：
 *   artifactType / previewId / title / contentType / sourcePath / html /
 *   createdAt / version / versionLabel / requirementId? / description?
 */

import { memo, useMemo } from 'react'
import type { PluginChatCardProps } from '@/plugin-system/types'
import type { ArtifactPreviewBlock } from '@/types'
import { ArtifactPreviewRenderer } from '@/components/Chat/chatBlocks/ArtifactPreviewRenderer'

interface PreviewArtifactData {
  artifactType?: string
  previewId?: string
  title?: string
  contentType?: string
  sourcePath?: string
  html?: string
  createdAt?: string
  version?: number
  versionLabel?: string
  requirementId?: string
  description?: string
}

function isPreviewArtifact(data: unknown): data is PreviewArtifactData {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as PreviewArtifactData).html === 'string' &&
    typeof (data as PreviewArtifactData).previewId === 'string'
  )
}

export const PrdPreviewCard = memo(function PrdPreviewCard(props: PluginChatCardProps) {
  const artifactBlock = useMemo<ArtifactPreviewBlock | null>(() => {
    if (!isPreviewArtifact(props.data)) return null
    const d = props.data
    return {
      type: 'artifact_preview',
      previewId: d.previewId!,
      title: d.title?.trim() ? d.title : 'PRD Prototype',
      contentType: 'html',
      html: d.html!,
      sourcePath: d.sourcePath,
      createdAt: d.createdAt,
      version: typeof d.version === 'number' ? d.version : undefined,
      versionLabel: d.versionLabel,
      requirementId: d.requirementId,
      description: d.description,
    }
  }, [props.data])

  if (!artifactBlock) {
    // data 结构不符合预期时回落到兜底渲染（由 PluginCardHost 的 fallback 处理）
    return (
      <div className="my-2 rounded-lg border border-border bg-background-elevated px-3 py-2 text-xs text-text-secondary">
        PRD 预览数据解析失败（{props.toolName}）
      </div>
    )
  }

  return <ArtifactPreviewRenderer block={artifactBlock} />
})
