/**
 * ComicPipeline — 漫画/漫剧编排管线 类型定义
 */

import type { PipelinePhase, PipelinePhaseInfo } from '@/ai-runtime'

// 重新导出 PipelinePhase
export type { PipelinePhase, PipelinePhaseInfo }

/** 管线配置 */
export interface ComicPipelineConfig {
  /** 漫画风格 */
  comicStyle: ComicStyle
  /** 页面布局 */
  pageLayout: PageLayout
  /** 每页分镜数 */
  panelsPerPage: number
  /** 输出格式 */
  outputFormat: OutputFormat
  /** 是否包含漫剧动画 */
  includeAnimation: boolean
  /** 视频每段时长（秒），仅在 includeAnimation 时有效 */
  animationDuration?: number
}

/** 漫画风格 */
export type ComicStyle =
  | 'japanese_manga'     // 日式少年漫画
  | 'american_comic'     // 美式超级英雄
  | 'korean_webtoon'     // 韩式条漫
  | 'chinese_manhua'     // 中式漫画
  | 'european_bd'        // 欧式漫画
  | 'realistic_cinematic' // 写实电影风格
  | 'custom'             // 自定义

/** 页面布局 */
export type PageLayout =
  | 'grid_2x2'    // 2×2 四格
  | 'grid_2x3'    // 2×3 六格
  | 'grid_3x3'    // 3×3 九格
  | 'manga_flow'  // 日漫式自由布局
  | 'webtoon_scroll' // 韩漫式竖排滚动
  | 'custom'

/** 输出格式 */
export type OutputFormat =
  | 'comic'          // 仅漫画
  | 'motion_comic'   // 仅漫剧
  | 'both'           // 漫画 + 漫剧

/** 剧本结构 */
export interface ComicScript {
  /** 标题 */
  title: string
  /** 副标题/标语 */
  tagline?: string
  /** 故事摘要 */
  synopsis: string
  /** 角色列表 */
  characters: ScriptCharacter[]
  /** 页面/分镜列表 */
  pages: ScriptPage[]
  /** 整体风格描述 */
  styleNotes?: string
}

/** 剧本角色 */
export interface ScriptCharacter {
  /** 角色名称 */
  name: string
  /** 角色描述 */
  description: string
  /** 外貌特征 */
  appearance: string
  /** 性格特点 */
  personality: string
  /** 角色在故事中的角色定位 */
  role: 'protagonist' | 'antagonist' | 'supporting' | 'cameo'
  /** 角色标签（年龄、性别等） */
  tags?: string[]
}

/** 剧本页面/分镜 */
export interface ScriptPage {
  /** 页码 */
  pageNumber: number
  /** 分镜列表 */
  panels: ScriptPanel[]
  /** 页面级注释 */
  pageNotes?: string
}

/** 剧本分镜 */
export interface ScriptPanel {
  /** 分镜序号 */
  panelNumber: number
  /** 场景描述 */
  scene: string
  /** 角色动作 */
  action: string
  /** 对话（多条） */
  dialogue: PanelDialogue[]
  /** 镜头角度 */
  cameraAngle?: string
  /** 情绪/氛围 */
  mood?: string
  /** 特效说明 */
  effects?: string
}

/** 分镜对话 */
export interface PanelDialogue {
  /** 说话角色 */
  character: string
  /** 对话内容 */
  text: string
  /** 对话类型 */
  type: 'speech' | 'thought' | 'narration' | 'sfx'
}

/** 角色设计结果 */
export interface CharacterDesign {
  /** 角色名称 */
  name: string
  /** 角色设定图 URL */
  designImageUrl: string
  /** 角色表情变体 */
  expressions?: Array<{
    emotion: string
    imageUrl: string
  }>
  /** 角色设计提示词 */
  designPrompt: string
}

/** 分镜图结果 */
export interface StoryboardPanel {
  /** 页码 */
  pageNumber: number
  /** 分镜号 */
  panelNumber: number
  /** 分镜图 URL */
  imageUrl: string
  /** 生成提示词 */
  prompt: string
  /** 对话文字叠加信息 */
  dialogueOverlay?: PanelDialogue[]
}

/** 漫剧动画片段 */
export interface AnimationClip {
  /** 分镜号 */
  panelNumber: number
  /** 动画视频 URL */
  videoUrl: string
  /** 时长（秒） */
  duration: number
  /** 起始分镜图 */
  sourceImageUrl: string
}

/** 管线产物 */
export interface PipelineArtifact {
  type: 'script' | 'image' | 'video' | 'document'
  label: string
  url: string
  metadata?: Record<string, unknown>
}

/** 管线阶段定义 */
export const PIPELINE_PHASES: PipelinePhase[] = [
  'script',
  'character',
  'storyboard',
  'animation',
  'finalize',
]

/** 阶段中文名映射 */
export const PHASE_LABELS: Record<PipelinePhase, string> = {
  script: '剧本生成',
  character: '角色设计',
  storyboard: '分镜绘制',
  animation: '漫剧动效',
  finalize: '合成输出',
}
