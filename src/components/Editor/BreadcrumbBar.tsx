/**
 * BreadcrumbBar - 编辑器面包屑路径导航
 *
 * 显示当前编辑文件的完整路径，支持点击路径段查看同目录文件。
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Folder, FileText, FileCode, FileJson, Image, File } from 'lucide-react'
import { useFileEditorStore } from '@/stores/fileEditorStore'
import { useFileExplorerStore } from '@/stores/fileExplorerStore'
import { useTabStore } from '@/stores/tabStore'
import { readDirectory } from '@/services/tauri'
import type { FileInfo } from '@/types/fileExplorer'

/** 语言显示名称映射 */
const LANGUAGE_DISPLAY: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  typescriptreact: 'TypeScript React',
  javascriptreact: 'JavaScript React',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  cpp: 'C++',
  c: 'C',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  markdown: 'Markdown',
  yaml: 'YAML',
  xml: 'XML',
  sql: 'SQL',
  shell: 'Shell',
  text: 'Plain Text',
}

/** 隐藏滚动条样式 */
const HIDDEN_SCROLLBAR_STYLE: React.CSSProperties = { scrollbarWidth: 'none' }

/** 根据扩展名获取文件图标 */
function getItemIcon(item: FileInfo) {
  if (item.is_dir) {
    return <Folder className="w-3.5 h-3.5 text-blue-400" />
  }
  const ext = item.name.split('.').pop()?.toLowerCase() || ''
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'kt', 'cs', 'cpp', 'c', 'h', 'rb', 'php', 'swift', 'sh'].includes(ext)) {
    return <FileCode className="w-3.5 h-3.5 text-blue-300" />
  }
  if (['json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env'].includes(ext)) {
    return <FileJson className="w-3.5 h-3.5 text-yellow-300" />
  }
  if (['md', 'txt'].includes(ext)) {
    return <FileText className="w-3.5 h-3.5 text-blue-300" />
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) {
    return <Image className="w-3.5 h-3.5 text-purple-400" />
  }
  return <File className="w-3.5 h-3.5 text-text-muted" />
}

/** 路径段 */
interface PathSegment {
  name: string
  fullPath: string
  isLast: boolean
}

/**
 * 将绝对路径解析为相对路径段
 */
function parsePathSegments(filePath: string, workspacePath: string): PathSegment[] {
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedWorkspace = workspacePath.replace(/\\/g, '/').replace(/\/$/, '')

  let relativePath: string
  if (normalizedFile.startsWith(normalizedWorkspace + '/')) {
    relativePath = normalizedFile.slice(normalizedWorkspace.length + 1)
  } else {
    relativePath = normalizedFile.split('/').pop() || normalizedFile
  }

  const parts = relativePath.split('/')
  return parts.map((name, index) => ({
    name,
    fullPath: normalizedWorkspace + '/' + parts.slice(0, index + 1).join('/'),
    isLast: index === parts.length - 1,
  }))
}

/**
 * 面包屑下拉菜单组件
 */
function BreadcrumbDropdown({
  directoryPath,
  currentFilePath,
  onSelectFile,
  onClose,
}: {
  directoryPath: string
  currentFilePath: string
  onSelectFile: (filePath: string, fileName: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('fileExplorer')
  const [items, setItems] = useState<FileInfo[]>([])
  const [loading, setLoading] = useState(true)
  const ref = useRef<HTMLDivElement>(null)

  // 加载目录内容
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    readDirectory(directoryPath)
      .then((result: unknown) => {
        if (cancelled) return
        const files = result as FileInfo[]
        files.sort((a, b) => {
          if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        setItems(files)
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [directoryPath])

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  const currentFileName = currentFilePath.replace(/\\/g, '/').split('/').pop()

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-1 bg-background-elevated border border-border rounded-lg shadow-lg py-1 min-w-[180px] max-h-[300px] overflow-y-auto z-50"
    >
      {loading ? (
        <div className="px-3 py-2 text-xs text-text-tertiary">
          {t('breadcrumb.loading', { defaultValue: '加载中...' })}
        </div>
      ) : items.length === 0 ? (
        <div className="px-3 py-2 text-xs text-text-tertiary">
          {t('breadcrumb.emptyDirectory', { defaultValue: '空目录' })}
        </div>
      ) : (
        items.map((item) => {
          const isCurrent = !item.is_dir && item.name === currentFileName
          return (
            <button
              key={item.path}
              onClick={() => {
                if (!item.is_dir) {
                  onSelectFile(item.path, item.name)
                }
                onClose()
              }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                isCurrent
                  ? 'bg-primary/10 text-primary'
                  : 'text-text-secondary hover:bg-background-hover hover:text-text-primary'
              }`}
            >
              {getItemIcon(item)}
              <span className="flex-1 truncate">{item.name}</span>
              {item.is_dir && <ChevronRight className="w-3 h-3 text-text-tertiary" />}
            </button>
          )
        })
      )}
    </div>
  )
}

/**
 * BreadcrumbBar 主组件
 */
export function BreadcrumbBar() {
  const currentFile = useFileEditorStore((s) => s.currentFile)
  const openFile = useFileEditorStore((s) => s.openFile)
  const workspacePath = useFileExplorerStore((s) => s.current_path)
  const activeTab = useTabStore((s) => s.getActiveTab())

  const [openDropdown, setOpenDropdown] = useState<string | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const segments = useMemo(() => {
    if (!currentFile?.path || !workspacePath) return []
    return parsePathSegments(currentFile.path, workspacePath)
  }, [currentFile?.path, workspacePath])

  // 点击外部关闭下拉
  useEffect(() => {
    if (!openDropdown) return
    const handleClickOutside = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenDropdown(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [openDropdown])

  const handleSelectFile = useCallback(
    async (filePath: string, fileName: string) => {
      await openFile(filePath, fileName)
      setOpenDropdown(null)
    },
    [openFile]
  )

  const handleToggleDropdown = useCallback((fullPath: string) => {
    setOpenDropdown((prev) => (prev === fullPath ? null : fullPath))
  }, [])

  // 没有文件或非 editor 类型不显示
  if (!currentFile || !activeTab || activeTab.type !== 'editor') {
    return null
  }

  const languageDisplay = LANGUAGE_DISPLAY[currentFile.language] || currentFile.language

  return (
    <div
      ref={barRef}
      className="flex items-center h-7 px-3 bg-background-surface border-b border-border-subtle overflow-x-auto shrink-0"
      style={HIDDEN_SCROLLBAR_STYLE}
    >
      {segments.map((segment, index) => (
        <span key={segment.fullPath} className="flex items-center shrink-0">
          {index > 0 && (
            <ChevronRight className="w-3 h-3 text-text-tertiary mx-0.5 shrink-0" />
          )}
          {segment.isLast ? (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-text-primary font-medium">
              {currentFile.isModified && (
                <span className="w-1.5 h-1.5 rounded-full bg-warning" />
              )}
              <span>{segment.name}</span>
            </span>
          ) : (
            <button
              onClick={() => handleToggleDropdown(segment.fullPath)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors relative"
            >
              <Folder className="w-3 h-3 opacity-60" />
              <span>{segment.name}</span>
              {openDropdown === segment.fullPath && currentFile.path && (
                <BreadcrumbDropdown
                  directoryPath={segment.fullPath}
                  currentFilePath={currentFile.path}
                  onSelectFile={handleSelectFile}
                  onClose={() => setOpenDropdown(null)}
                />
              )}
            </button>
          )}
        </span>
      ))}

      {languageDisplay && (
        <span className="ml-auto text-[11px] text-text-tertiary shrink-0 pl-2">
          {languageDisplay}
        </span>
      )}
    </div>
  )
}
