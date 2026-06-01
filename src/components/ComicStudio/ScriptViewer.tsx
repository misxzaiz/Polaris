/**
 * ScriptViewer — 剧本查看器
 *
 * 展示生成的分集剧本：标题、梗概、角色列表、分页分镜描述。
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight, Users, BookOpen, Film } from 'lucide-react'
import { useComicStudioStore } from '@/stores/comicStudioStore'

/** 可折叠区块 */
function CollapsibleSection({
  title,
  icon: Icon,
  defaultOpen = true,
  children,
}: {
  title: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-background-surface hover:bg-background-hover transition-colors text-sm font-medium text-text-primary"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-text-tertiary" />
        ) : (
          <ChevronRight className="w-4 h-4 text-text-tertiary" />
        )}
        <Icon size={14} className="text-text-secondary" />
        {title}
      </button>
      {open && <div className="px-3 py-2 border-t border-border">{children}</div>}
    </div>
  )
}

export function ScriptViewer() {
  const script = useComicStudioStore((s) => s.script)

  if (!script) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary gap-3">
        <BookOpen className="w-12 h-12 text-text-tertiary" />
        <p className="text-sm">暂无剧本</p>
        <p className="text-xs text-text-tertiary">
          配置故事想法并启动管线以生成剧本
        </p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-3">
      {/* 标题与梗概 */}
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-text-primary mb-1">{script.title}</h2>
        {script.synopsis && (
          <p className="text-sm text-text-secondary leading-relaxed">{script.synopsis}</p>
        )}
      </div>

      {/* 角色列表 */}
      {script.characters && script.characters.length > 0 && (
        <CollapsibleSection title={`角色列表 (${script.characters.length})`} icon={Users}>
          <div className="space-y-2">
            {script.characters.map((char, idx) => (
              <div
                key={idx}
                className="p-2 bg-background-elevated rounded border border-border"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-text-primary">
                    {char.name}
                  </span>
                  {char.tags && char.tags.length > 0 && (
                    <span className="text-xs text-text-tertiary">
                      {char.tags.join(' · ')}
                    </span>
                  )}
                </div>
                {char.description && (
                  <p className="text-xs text-text-secondary">{char.description}</p>
                )}
                {char.personality && (
                  <p className="text-xs text-text-tertiary mt-1">
                    性格：{char.personality}
                  </p>
                )}
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* 分页分镜 */}
      {script.pages && script.pages.length > 0 && (
        <CollapsibleSection
          title={`分镜脚本 (${script.pages.length} 页)`}
          icon={Film}
        >
          <div className="space-y-3">
            {script.pages.map((page) => (
              <div
                key={page.pageNumber}
                className="border border-border rounded-md overflow-hidden"
              >
                <div className="px-3 py-1.5 bg-background-surface text-xs font-medium text-text-secondary">
                  第 {page.pageNumber} 页
                  {page.pageNotes && ` — ${page.pageNotes}`}
                </div>
                <div className="divide-y divide-border">
                  {page.panels.map((panel) => (
                    <div key={panel.panelNumber} className="p-3 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                          格 {panel.panelNumber}
                        </span>
                        {panel.cameraAngle && (
                          <span className="text-xs text-text-tertiary">
                            {panel.cameraAngle}
                          </span>
                        )}
                        {panel.mood && (
                          <span className="text-xs text-text-tertiary">
                            · {panel.mood}
                          </span>
                        )}
                      </div>

                      <p className="text-sm text-text-primary leading-relaxed">
                        <span className="text-text-secondary">场景：</span>
                        {panel.scene}
                      </p>

                      <p className="text-sm text-text-primary leading-relaxed">
                        <span className="text-text-secondary">动作：</span>
                        {panel.action}
                      </p>

                      {panel.effects && (
                        <p className="text-xs text-text-tertiary">
                          特效：{panel.effects}
                        </p>
                      )}

                      {panel.dialogue && panel.dialogue.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {panel.dialogue.map((d, di) => (
                            <p
                              key={di}
                              className="text-sm text-blue-300 bg-blue-500/5 px-2 py-0.5 rounded"
                            >
                              <span className="font-medium">{d.character}：</span>
                              {d.text}
                              {d.type && (
                                <span className="text-xs text-text-tertiary ml-1">
                                  ({d.type})
                                </span>
                              )}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* 空状态 */}
      {(!script.characters || script.characters.length === 0) &&
        (!script.pages || script.pages.length === 0) && (
          <div className="flex items-center justify-center py-8 text-xs text-text-tertiary">
            剧本内容为空
          </div>
        )}
    </div>
  )
}
