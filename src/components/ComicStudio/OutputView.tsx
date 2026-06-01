/**
 * OutputView — 产出物视图
 *
 * 列出管线生成的最终产物：剧本、角色图、分镜图、动画等。
 */

import {
  FileText,
  ImageIcon,
  Video,
  Download,
  ExternalLink,
  PackageOpen,
} from 'lucide-react'
import { useComicStudioStore } from '@/stores/comicStudioStore'
import type { PipelineArtifact } from '@/engines/agnes/comic-pipeline'

const TYPE_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  image: ImageIcon,
  video: Video,
  document: FileText,
}

const TYPE_LABELS: Record<string, string> = {
  image: '图片',
  video: '视频',
  document: '文档',
}

function ArtifactRow({ artifact }: { artifact: PipelineArtifact }) {
  const Icon = TYPE_ICONS[artifact.type] || FileText

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 border border-border rounded-md bg-background-surface hover:bg-background-hover transition-colors">
      {/* 类型图标 */}
      <div className="p-1.5 rounded bg-background-elevated">
        <Icon size={16} className="text-text-secondary" />
      </div>

      {/* 标签 */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text-primary truncate">{artifact.label}</p>
        <p className="text-xs text-text-tertiary">{TYPE_LABELS[artifact.type] || artifact.type}</p>
      </div>

      {/* 操作按钮 */}
      {artifact.url && (
        <div className="flex items-center gap-1">
          <a
            href={artifact.url}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-background-elevated transition-colors"
            title="在新窗口打开"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <a
            href={artifact.url}
            download
            className="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-background-elevated transition-colors"
            title="下载"
          >
            <Download className="w-3.5 h-3.5" />
          </a>
        </div>
      )}
    </div>
  )
}

export function OutputView() {
  const artifacts = useComicStudioStore((s) => s.artifacts)
  const script = useComicStudioStore((s) => s.script)
  const pipelineStatus = useComicStudioStore((s) => s.pipelineStatus)

  // 按类型分组统计
  const typeStats = artifacts.reduce<Record<string, number>>((acc, a) => {
    acc[a.type] = (acc[a.type] || 0) + 1
    return acc
  }, {})

  if (pipelineStatus !== 'completed' && artifacts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary gap-3">
        <PackageOpen className="w-12 h-12 text-text-tertiary" />
        <p className="text-sm">暂无产出</p>
        <p className="text-xs text-text-tertiary">
          管线完成后产物将显示在此处
        </p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* 状态横幅 */}
      {pipelineStatus === 'completed' && (
        <div className="px-4 py-3 bg-green-500/10 border border-green-500/20 rounded-md">
          <p className="text-sm text-green-400 font-medium">管线完成</p>
          <p className="text-xs text-green-400/70 mt-0.5">
            共生成 {artifacts.length} 个产物
          </p>
        </div>
      )}

      {/* 统计概览 */}
      {Object.keys(typeStats).length > 0 && (
        <div className="flex gap-3 flex-wrap">
          {Object.entries(typeStats).map(([type, count]) => {
            const Icon = TYPE_ICONS[type] || FileText
            return (
              <div
                key={type}
                className="flex items-center gap-2 px-3 py-2 bg-background-surface border border-border rounded-md"
              >
                <Icon size={14} className="text-text-secondary" />
                <span className="text-sm text-text-primary">{count}</span>
                <span className="text-xs text-text-tertiary">
                  {TYPE_LABELS[type] || type}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* 剧本摘要 */}
      {script && (
        <div className="border border-border rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-background-surface border-b border-border">
            <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
              <FileText size={14} className="text-text-secondary" />
              剧本：{script.title}
            </h3>
          </div>
          <div className="px-3 py-2 text-xs text-text-secondary">
            {script.synopsis && (
              <p className="line-clamp-2">{script.synopsis}</p>
            )}
            <p className="text-text-tertiary mt-1">
              {script.characters?.length || 0} 个角色 · {script.pages?.length || 0} 页分镜
            </p>
          </div>
        </div>
      )}

      {/* 产物列表 */}
      {artifacts.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide px-1">
            全部产物
          </h4>
          {artifacts.map((artifact, idx) => (
            <ArtifactRow key={idx} artifact={artifact} />
          ))}
        </div>
      )}
    </div>
  )
}
