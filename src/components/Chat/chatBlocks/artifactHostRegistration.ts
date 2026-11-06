/**
 * artifact 宿主桥注册模块（动态加载）
 *
 * 被 plugin-system/hostBridge.ensureArtifactHostRegistered() 动态 import，
 * 把通用 artifact 渲染核心挂到 window.__POLARIS_HOST_ARTIFACT__——插件卡片
 * 经 polaris-host/artifact shim 消费（plugin-ui-contribution-spec [S-1]）。
 * 单独成模块的原因：本模块整体进一个懒 chunk，只有插件真的用到该桥时才
 * 加载，不占启动包（mermaid 泄漏教训）。
 */

import { ArtifactPreviewRenderer } from './ArtifactPreviewRenderer'
import {
  buildArtifactBlockFromData,
  normalizeArtifactLikeBlock,
  useArtifactVersions,
  useIsSupersededArtifactVersion,
} from './artifactVersions'
import { getFileContent } from '@/services/tauri/fileService'
import { useFileEditorStore } from '@/stores/fileEditorStore'

export interface ArtifactHostBridge {
  /** 完整预览渲染器（iframe 沙箱/全屏/版本 pills/源码查看） */
  ArtifactPreviewRenderer: typeof ArtifactPreviewRenderer
  /** MCP 工具 data（PreviewArtifact 对象）→ 渲染用 ArtifactPreviewBlock */
  buildArtifactBlockFromData: typeof buildArtifactBlockFromData
  /** artifact 形态归一化（plugin_card/artifact_preview 双形态共用） */
  normalizeArtifactLikeBlock: typeof normalizeArtifactLikeBlock
  /** 版本组订阅（requirementId 关联的多版本） */
  useArtifactVersions: typeof useArtifactVersions
  useIsSupersededArtifactVersion: typeof useIsSupersededArtifactVersion
  /** 读取落盘产物 html（hydration：marker 缺 html 时回落读 .polaris/previews 文件） */
  readArtifactHtml: (sourcePath: string) => Promise<string>
  /** 在宿主编辑器打开源码文件（插件卡片「查看源码」动作用） */
  openArtifactSource: (sourcePath: string) => void
}

export function registerArtifactHost(): void {
  const bridge: ArtifactHostBridge = {
    ArtifactPreviewRenderer,
    buildArtifactBlockFromData,
    normalizeArtifactLikeBlock,
    useArtifactVersions,
    useIsSupersededArtifactVersion,
    readArtifactHtml: (sourcePath) => getFileContent(sourcePath),
    openArtifactSource: (sourcePath) => {
      const base = sourcePath.split(/[/\\]/).pop() || sourcePath
      useFileEditorStore.getState().openFile(sourcePath, base)
    },
  }
  ;(window as unknown as Record<string, unknown>).__POLARIS_HOST_ARTIFACT__ = bridge
}

declare global {
  // eslint-disable-next-line no-var
  var __POLARIS_HOST_ARTIFACT__: ArtifactHostBridge | undefined
}
