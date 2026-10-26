/**
 * PRD 预览 MCP 卡片渲染器
 *
 * 接 PluginChatCardProps，从 data（MCP tool result 的解析产物，
 * 即 PreviewArtifact 对象）提取字段，复用 ArtifactPreviewRenderer 的完整 UI
 * （iframe 沙箱预览、全屏、下载、源码查看等）。
 *
 * data 字段（camelCase，与 Rust 端 PreviewArtifact 对齐）：
 *   artifactType / previewId / title / contentType / sourcePath / html /
 *   createdAt / version / versionLabel / requirementId? / description?
 *
 * 渲染分支（plans/prd-preview-ux-optimization.md 线 1）：
 * 1. data 含完整 html → 直接渲染预览（simpleai structuredContent / Code Mode 裸 return）。
 * 2. data 缺 html 但有 previewId/sourcePath（模型 return 投影字段）→ HydratingPreview
 *    自升级：读回落盘的 index.html 补齐 html，0 交互直出 iframe —— 用户不感知两种形态差异。
 * 3. hydration 失败（文件被删等）→ 退回「预览已生成 + 打开源码」通知兜底。
 */

import { memo, useMemo, useCallback, useEffect, useState } from 'react'
import { clsx } from 'clsx'
import { useFileEditorStore } from '@/stores/fileEditorStore'
import type { PluginChatCardProps } from '@/plugin-system/types'
import type { ArtifactPreviewBlock } from '@/types'
import { ArtifactPreviewRenderer } from '@/components/Chat/chatBlocks/ArtifactPreviewRenderer'
import { buildArtifactBlockFromData, useArtifactVersions } from '@/components/Chat/chatBlocks/artifactVersions'
import { getFileContent } from '@/services/tauri/fileService'

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

export const PrdPreviewCard = memo(function PrdPreviewCard(props: PluginChatCardProps) {
  const artifactBlock = useMemo<ArtifactPreviewBlock | null>(
    () => buildArtifactBlockFromData(props.data),
    [props.data]
  )
  // 会话级版本组（SessionMessagesView Provider 下发）：≥2 版时渲染器出版本 pills
  const versions = useArtifactVersions(artifactBlock?.requirementId)

  if (!artifactBlock) {
    // data 不含完整 html：判定为退化形态（模型 return 了投影 / data 缺字段）。
    // 区分「生成成功但缺正文」与「彻底解析失败」，前者给出可操作出口而非报错文案。
    const partial = props.data as PreviewArtifactData | null
    if (partial && typeof partial === 'object' && (partial.previewId || partial.sourcePath)) {
      return (
        <HydratingPreview
          previewId={partial.previewId}
          sourcePath={partial.sourcePath}
          title={partial.title}
          versionLabel={partial.versionLabel}
          version={typeof partial.version === 'number' ? partial.version : undefined}
          createdAt={partial.createdAt}
          requirementId={partial.requirementId}
          description={partial.description}
        />
      )
    }
    return (
      <div className="my-2 rounded-lg border border-border bg-background-elevated px-3 py-2 text-xs text-text-secondary">
        PRD 预览数据解析失败（{props.toolName}）
      </div>
    )
  }

  return <ArtifactPreviewRenderer block={artifactBlock} versions={versions ?? undefined} />
})

/**
 * 投影形态自升级：data 缺 html 但预览已落盘（previewId+sourcePath 必在）。
 * mount 时静默读回 index.html 补齐 html —— 展示层 hydration，不回写
 * store/JSONL（单一写入路径仍是 eventHandler）。失败路径静默退回通知兜底。
 */
function HydratingPreview({
  previewId,
  sourcePath,
  title,
  versionLabel,
  version,
  createdAt,
  requirementId,
  description,
}: {
  previewId?: string
  sourcePath?: string
  title?: string
  versionLabel?: string
  version?: number
  createdAt?: string
  requirementId?: string
  description?: string
}) {
  const [state, setState] = useState<'checking' | 'ready' | 'notice'>('checking')
  const [block, setBlock] = useState<ArtifactPreviewBlock | null>(null)
  // 投影升级成功后同样接入会话级版本组（≥2 版时渲染器出版本 pills）
  const versions = useArtifactVersions(requirementId)

  useEffect(() => {
    let cancelled = false
    setBlock(null)
    setState('checking')
    // previewId 缺失时从 sourcePath 目录名兜底取（previews/<uuid>/index.html）
    let resolvedPreviewId = previewId
    if (!resolvedPreviewId && sourcePath) {
      const parts = sourcePath.split(/[/\\]/)
      resolvedPreviewId = parts[parts.length - 2]
    }
    if (!sourcePath || !resolvedPreviewId) {
      setState('notice')
      return
    }
    // 闭包内 TS 窄化失效，捕获到局部常量避免 non-null assertion
    const finalPreviewId: string = resolvedPreviewId
    getFileContent(sourcePath)
      .then((html) => {
        if (cancelled) return
        // 最小完整性判据：非空且含标签字符，避免误读二进制/空文件渲染成空白页
        if (typeof html === 'string' && html.length > 0 && html.includes('<')) {
          setBlock({
            type: 'artifact_preview',
            previewId: finalPreviewId,
            title: title?.trim() ? title : 'PRD Prototype',
            contentType: 'html',
            html,
            sourcePath,
            createdAt,
            version,
            versionLabel,
            requirementId,
            description,
          })
          setState('ready')
        } else {
          setState('notice')
        }
      })
      .catch(() => {
        if (!cancelled) setState('notice')
      })
    return () => {
      cancelled = true
    }
  }, [previewId, sourcePath, title, versionLabel, version, createdAt, requirementId, description])

  if (state === 'checking') {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-border bg-background-elevated px-3 py-2">
        <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span className="text-xs text-text-muted">加载预览…</span>
      </div>
    )
  }

  if (state === 'ready' && block) {
    return <ArtifactPreviewRenderer block={block} versions={versions ?? undefined} />
  }

  return (
    <PreviewGeneratedNotice
      previewId={previewId}
      sourcePath={sourcePath}
      title={title}
      versionLabel={versionLabel}
    />
  )
}

/**
 * 兜底提示：MCP 调用成功（有 previewId / sourcePath 落盘）但 html 不可得
 * （文件被删 / 读取失败等场景）。保留「打开源码」出口。
 */
function PreviewGeneratedNotice({ previewId, sourcePath, title, versionLabel }: {
  previewId?: string
  sourcePath?: string
  title?: string
  versionLabel?: string
}) {
  const openFile = useFileEditorStore((s) => s.openFile)
  const handleOpen = useCallback(() => {
    if (sourcePath) openFile(sourcePath, sourcePath.split(/[/\\]/).pop() || sourcePath)
  }, [openFile, sourcePath])
  return (
    <div className="my-2 flex items-center gap-2 rounded-lg border border-border bg-background-elevated px-3 py-2 text-xs">
      <span className="text-green-500">✅</span>
      <span className="text-text-secondary">
        预览已生成{title ? `：${title}` : ''}{versionLabel ? ` · ${versionLabel}` : ''}
        {previewId ? `（${previewId.slice(0, 8)}…）` : ''}
      </span>
      {sourcePath ? (
        <button
          type="button"
          onClick={handleOpen}
          className={clsx('ml-auto shrink-0 rounded-md border border-border px-2 py-1', 'text-text-secondary hover:text-primary hover:border-primary transition-colors')}
        >
          打开源码
        </button>
      ) : null}
    </div>
  )
}
