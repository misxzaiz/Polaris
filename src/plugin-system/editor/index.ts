/**
 * Git 编辑器扩展总装
 *
 * 把 gitGutter / gitBlameHover / gitChangeNavigator 绑定到当前编辑器上下文
 * （currentWorkspace + filePath），并注册到 editorExtensionRegistry。
 *
 * 编辑器上下文如何获得：
 * - filePath：Editor.tsx 的 filePath prop（CodeMirrorEditor 的 filePathRef）
 * - workspacePath：useWorkspaceStore.getState().getCurrentWorkspace()?.path
 *
 * 由于 editorExtensionRegistry.collectExtensions(filePath) 在编辑器创建时同步收集，
 * 而 workspace 从 store 读取是同步的，这里用一个「惰性上下文读取器」：
 * 每次 getContext 调用时才读当前 workspace + 当前文件，保证一致。
 */

import type { Extension } from '@codemirror/state'
import { editorExtensionRegistry, type EditorExtensionFactory } from '@/plugin-system/editorExtensionRegistry'
import { gitGutterExtension } from './gitGutter'
import { gitBlameHoverExtension } from './blameHover'
import { gitChangeNavigatorExtension, startNavigator } from './changeNavigator'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { GitFileContext } from '@/services/gitEditorService'

/**
 * 惰性上下文读取器：编辑器创建时调用一次，
 * 之后每次 gutter 刷新 / 悬停 / 导航时重新读取（可在文件切换后生效）。
 */
function createGitContextGetter(filePathAtCreation: string | undefined): () => GitFileContext {
  return () => {
    const workspace = useWorkspaceStore.getState().getCurrentWorkspace()
    return {
      filePath: filePathAtCreation,
      workspacePath: workspace?.path,
    }
  }
}

/**
 * 组装 Git 编辑器扩展。供 Editor.tsx 的 editorExtensionRegistry.collectExtensions 消费。
 * 返回一个扩展工厂：工厂接收当前 filePath，返回 []（无 repository）或扩展数组。
 */
export const gitEditorExtensionFactory: EditorExtensionFactory = (filePath) => {
  // 无文件路径时（无打开文件/新文件）不启用编辑器 git 集成
  if (!filePath) return []

  // 排除无 git 上下文的路径：DiffViewer/预览等特殊编辑器也可能用 CM（但 filePath 通常是文件）
  const ctxGetter = createGitContextGetter(filePath)

  // 预载改动行号（用于 Alt+Up/Down 导航）
  const ctx = ctxGetter()
  if (ctx.filePath && ctx.workspacePath) {
    startNavigator(ctx)
  }

  const extensions: Extension[] = [
    gitGutterExtension(ctxGetter),
    gitBlameHoverExtension(ctxGetter),
    gitChangeNavigatorExtension(ctxGetter),
  ]

  return extensions
}

/** 注册到编辑器扩展 registry（在 builtinPlugins 或 App 启动时调用一次） */
export function registerGitEditorExtensions(): void {
  editorExtensionRegistry.register('polaris.git-editor', gitEditorExtensionFactory, 'Git 编辑器集成（gutter/blame/导航）')
}