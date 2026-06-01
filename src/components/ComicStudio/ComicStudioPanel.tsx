/**
 * ComicStudioPanel — 漫画/漫剧工作室主面板
 *
 * 支持面板模式和全屏模式。
 * 全屏模式下以 overlay 覆盖整个应用窗口。
 */

import {
  Maximize2,
  Minimize2,
  Settings2,
  Play,
  Square,
} from 'lucide-react'
import { useComicStudioStore } from '@/stores/comicStudioStore'
import type { ComicStudioView } from '@/stores/comicStudioStore'
import { useComicPipeline } from '@/hooks/useComicPipeline'
import { PipelineProgress } from './PipelineProgress'
import { ScriptViewer } from './ScriptViewer'
import { CharacterGallery } from './CharacterGallery'
import { StoryboardGrid } from './StoryboardGrid'
import { AnimationPlayer } from './AnimationPlayer'
import { OutputView } from './OutputView'

const VIEW_TABS: { key: ComicStudioView; label: string }[] = [
  { key: 'script', label: '剧本' },
  { key: 'characters', label: '角色' },
  { key: 'storyboard', label: '分镜' },
  { key: 'animation', label: '动效' },
  { key: 'output', label: '产出' },
]

const COMIC_STYLES: { value: string; label: string }[] = [
  { value: 'japanese_manga', label: '日式漫画' },
  { value: 'american_comic', label: '美式漫画' },
  { value: 'korean_webtoon', label: '韩式条漫' },
  { value: 'chinese_manhua', label: '中式漫画' },
  { value: 'european_bd', label: '欧式BD' },
  { value: 'realistic_cinematic', label: '电影写实' },
]

const OUTPUT_FORMATS: { value: string; label: string }[] = [
  { value: 'both', label: '漫画+漫剧' },
  { value: 'comic', label: '仅漫画' },
  { value: 'motion_comic', label: '仅漫剧' },
]

/** 渲染活跃视图内容 */
function ActiveViewContent() {
  const activeView = useComicStudioStore((s) => s.activeView)

  switch (activeView) {
    case 'script':
      return <ScriptViewer />
    case 'characters':
      return <CharacterGallery />
    case 'storyboard':
      return <StoryboardGrid />
    case 'animation':
      return <AnimationPlayer />
    case 'output':
      return <OutputView />
    default:
      return (
        <div className="flex items-center justify-center h-full text-text-secondary">
          选择视图开始创作
        </div>
      )
  }
}

/** 配置面板 */
function ConfigPanel() {
  const config = useComicStudioStore((s) => s.config)
  const storyIdea = useComicStudioStore((s) => s.storyIdea)
  const updateConfig = useComicStudioStore((s) => s.updateConfig)
  const setStoryIdea = useComicStudioStore((s) => s.setStoryIdea)

  return (
    <div className="p-4 space-y-4 bg-background-surface border-b border-border">
      {/* 故事想法 */}
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1">
          故事想法
        </label>
        <textarea
          className="w-full px-3 py-2 bg-background-elevated border border-border rounded-md text-sm text-text-primary placeholder-text-tertiary resize-none focus:outline-none focus:ring-1 focus:ring-primary"
          rows={3}
          placeholder="输入你的故事创意，如：一个年轻程序员发现自己写的代码能让现实世界中的物体凭空出现..."
          value={storyIdea}
          onChange={(e) => setStoryIdea(e.target.value)}
        />
      </div>

      {/* 漫画风格 */}
      <div className="flex gap-4 flex-wrap">
        <div className="flex-1 min-w-[160px]">
          <label className="block text-sm font-medium text-text-secondary mb-1">
            漫画风格
          </label>
          <select
            className="w-full px-3 py-2 bg-background-elevated border border-border rounded-md text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            value={config.comicStyle}
            onChange={(e) => updateConfig({ comicStyle: e.target.value as never })}
          >
            {COMIC_STYLES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        {/* 输出格式 */}
        <div className="flex-1 min-w-[160px]">
          <label className="block text-sm font-medium text-text-secondary mb-1">
            输出格式
          </label>
          <select
            className="w-full px-3 py-2 bg-background-elevated border border-border rounded-md text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            value={config.outputFormat}
            onChange={(e) => updateConfig({ outputFormat: e.target.value as never })}
          >
            {OUTPUT_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>

        {/* 每页分镜数 */}
        <div className="w-[120px]">
          <label className="block text-sm font-medium text-text-secondary mb-1">
            分镜/页
          </label>
          <input
            type="number"
            className="w-full px-3 py-2 bg-background-elevated border border-border rounded-md text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            min={1}
            max={8}
            value={config.panelsPerPage}
            onChange={(e) => updateConfig({ panelsPerPage: Number(e.target.value) })}
          />
        </div>
      </div>

      {/* 动画选项 */}
      <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
        <input
          type="checkbox"
          className="rounded border-border bg-background-elevated text-primary focus:ring-primary"
          checked={config.includeAnimation}
          onChange={(e) => updateConfig({ includeAnimation: e.target.checked })}
        />
        包含漫剧动效
      </label>
    </div>
  )
}

/** 工具栏 */
function Toolbar({ isFullscreen, onStart }: { isFullscreen: boolean; onStart: () => void }) {
  const activeView = useComicStudioStore((s) => s.activeView)
  const setActiveView = useComicStudioStore((s) => s.setActiveView)
  const toggleDisplayMode = useComicStudioStore((s) => s.toggleDisplayMode)
  const showConfig = useComicStudioStore((s) => s.showConfig)
  const toggleConfig = useComicStudioStore((s) => s.toggleConfig)
  const isRunning = useComicStudioStore((s) => s.isRunning)
  const abortPipeline = useComicStudioStore((s) => s.abortPipeline)

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 bg-background-elevated border-b border-border shrink-0">
      {/* 视图切换标签 */}
      <div className="flex items-center gap-0.5 flex-1">
        {VIEW_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveView(tab.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              activeView === tab.key
                ? 'bg-primary/15 text-primary'
                : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 右侧操作按钮 */}
      <div className="flex items-center gap-1">
        {/* 配置切换 */}
        <button
          onClick={toggleConfig}
          className={`p-1.5 rounded transition-colors ${
            showConfig
              ? 'bg-primary/15 text-primary'
              : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
          }`}
          title="配置面板"
        >
          <Settings2 className="w-4 h-4" />
        </button>

        {/* 运行/停止 */}
        {isRunning ? (
          <button
            onClick={abortPipeline}
            className="p-1.5 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
            title="中止管线"
          >
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={onStart}
            className="p-1.5 rounded text-green-400 hover:text-green-300 hover:bg-green-500/10 transition-colors"
            title="启动管线"
          >
            <Play className="w-4 h-4" />
          </button>
        )}

        {/* 全屏切换 */}
        <button
          onClick={toggleDisplayMode}
          className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
          title={isFullscreen ? '退出全屏' : '全屏模式'}
        >
          {isFullscreen ? (
            <Minimize2 className="w-4 h-4" />
          ) : (
            <Maximize2 className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  )
}

/**
 * ComicStudioPanel — 主面板组件
 */
export function ComicStudioPanel() {
  const displayMode = useComicStudioStore((s) => s.displayMode)
  const showConfig = useComicStudioStore((s) => s.showConfig)
  const isRunning = useComicStudioStore((s) => s.isRunning)
  const pipelineStatus = useComicStudioStore((s) => s.pipelineStatus)
  const { run } = useComicPipeline()

  const isFullscreen = displayMode === 'fullscreen'

  const panelContent = (
    <div
      className={`flex flex-col h-full ${
        isFullscreen
          ? 'fixed inset-0 z-50 bg-background-primary'
          : 'bg-background-primary'
      }`}
    >
      {/* 工具栏 */}
      <Toolbar isFullscreen={isFullscreen} onStart={run} />

      {/* 管线进度条 (运行时显示) */}
      {(isRunning || pipelineStatus === 'completed' || pipelineStatus === 'failed') && (
        <PipelineProgress />
      )}

      {/* 配置面板 (可折叠) */}
      {showConfig && <ConfigPanel />}

      {/* 主内容区 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ActiveViewContent />
      </div>
    </div>
  )

  return panelContent
}
