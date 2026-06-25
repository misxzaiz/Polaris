/**
 * 文件导航面板组件
 *
 * 在多文件 diff 视图中显示文件列表，支持文件切换和变更统计
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePlus, FileMinus, FileEdit, FileX } from 'lucide-react'
import type { GitDiffEntry, DiffChangeType } from '@/types/git'

interface FileNavigatorProps {
  /** 文件列表 */
  files: GitDiffEntry[]
  /** 当前选中的文件路径 */
  activeFilePath: string
  /** 文件选择回调 */
  onFileSelect: (filePath: string) => void
}

/**
 * 获取变更类型图标
 */
function ChangeTypeIcon({ type }: { type: DiffChangeType }) {
  switch (type) {
    case 'added':
      return <FilePlus size={14} className="text-green-500" />
    case 'deleted':
      return <FileMinus size={14} className="text-red-500" />
    case 'renamed':
      return <FileX size={14} className="text-yellow-500" />
    default:
      return <FileEdit size={14} className="text-blue-500" />
  }
}

/**
 * 获取变更类型标签样式
 */
function getChangeTypeBadgeClass(type: DiffChangeType): string {
  switch (type) {
    case 'added':
      return 'bg-green-500/15 text-green-500 border-green-500/20'
    case 'deleted':
      return 'bg-red-500/15 text-red-500 border-red-500/20'
    case 'renamed':
      return 'bg-yellow-500/15 text-yellow-500 border-yellow-500/20'
    default:
      return 'bg-blue-500/15 text-blue-500 border-blue-500/20'
  }
}

/**
 * 分割文件路径为目录和文件名
 */
function splitPath(filePath: string): { dir: string; name: string } {
  const normalized = filePath.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) {
    return { dir: '', name: filePath }
  }
  return {
    dir: normalized.slice(0, lastSlash + 1),
    name: normalized.slice(lastSlash + 1),
  }
}

/**
 * 文件导航面板组件
 */
export function FileNavigator({
  files,
  activeFilePath,
  onFileSelect,
}: FileNavigatorProps) {
  const { t } = useTranslation('git')

  // 计算总统计
  const stats = useMemo(() => {
    let totalAdd = 0
    let totalDel = 0
    for (const file of files) {
      totalAdd += file.additions ?? 0
      totalDel += file.deletions ?? 0
    }
    return { totalAdd, totalDel }
  }, [files])

  if (files.length <= 1) {
    return null
  }

  return (
    <div className="border-b border-border-subtle bg-background-elevated">
      {/* 头部 */}
      <div className="px-3 py-2 flex items-center justify-between text-xs">
        <span className="font-medium text-text-secondary">
          {t('diff.changedFiles', 'Changed Files')}
        </span>
        <span className="text-text-tertiary">
          <span className="text-green-500">+{stats.totalAdd}</span>
          {' '}
          <span className="text-red-500">-{stats.totalDel}</span>
          {' · '}
          {files.length} {t('diff.files', 'files')}
        </span>
      </div>

      {/* 文件列表 */}
      <div className="max-h-[200px] overflow-y-auto">
        {files.map((file) => {
          const { dir, name } = splitPath(file.file_path)
          const isActive = file.file_path === activeFilePath
          const additions = file.additions ?? 0
          const deletions = file.deletions ?? 0
          const total = additions + deletions

          return (
            <div
              key={file.file_path}
              className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors ${
                isActive
                  ? 'bg-primary/10 border-l-2 border-l-primary'
                  : 'border-l-2 border-l-transparent hover:bg-background-hover'
              }`}
              onClick={() => onFileSelect(file.file_path)}
            >
              <ChangeTypeIcon type={file.change_type} />

              <span className="flex-1 min-w-0 text-xs font-mono truncate">
                {dir && <span className="text-text-tertiary">{dir}</span>}
                <span className={isActive ? 'text-text-primary' : 'text-text-secondary'}>
                  {name}
                </span>
              </span>

              {/* 变更统计 */}
              <div className="flex items-center gap-1 text-[10px] font-mono shrink-0">
                {additions > 0 && (
                  <span className="text-green-500">+{additions}</span>
                )}
                {deletions > 0 && (
                  <span className="text-red-500">-{deletions}</span>
                )}
              </div>

              {/* 变更比例条 */}
              {total > 0 && (
                <div className="w-10 h-1 rounded-full bg-border overflow-hidden flex shrink-0">
                  <div
                    className="h-full bg-green-500"
                    style={{ width: `${(additions / total) * 100}%` }}
                  />
                  <div
                    className="h-full bg-red-500"
                    style={{ width: `${(deletions / total) * 100}%` }}
                  />
                </div>
              )}

              {/* 变更类型标签 */}
              <span
                className={`px-1.5 py-0.5 text-[9px] font-medium rounded border ${
                  getChangeTypeBadgeClass(file.change_type)
                }`}
              >
                {file.change_type === 'added' ? 'A' :
                 file.change_type === 'deleted' ? 'D' :
                 file.change_type === 'renamed' ? 'R' : 'M'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
