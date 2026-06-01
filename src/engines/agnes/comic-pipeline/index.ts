/**
 * ComicPipeline — 漫画/漫剧编排引擎
 *
 * 完整管线：剧本生成 → 角色设计 → 分镜绘制 → 漫剧动效 → 合成输出
 *
 * @module engines/agnes/comic-pipeline
 */

export { ComicPipelineSession, DEFAULT_COMIC_PIPELINE_CONFIG } from './session'
export { createInitialState, calculateOverallProgress } from './pipeline-state'
export type { PipelineState } from './pipeline-state'

export {
  generateScript,
  extractScriptFromContent,
  designCharacters,
  generateStoryboards,
  generateAnimations,
} from './phases'

export type {
  ComicPipelineConfig,
  ComicStyle,
  PageLayout,
  OutputFormat,
  ComicScript,
  ScriptCharacter,
  ScriptPage,
  ScriptPanel,
  PanelDialogue,
  CharacterDesign,
  StoryboardPanel,
  AnimationClip,
  PipelineArtifact,
} from './types'

export { PIPELINE_PHASES, PHASE_LABELS } from './types'
