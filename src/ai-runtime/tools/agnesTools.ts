/**
 * Agnes AI Tools — 多模态工具集
 *
 * 注册为 AITool 供 Agnes 2.0 Flash 通过 tool_choice 调用。
 * 支持：文生图、图片编辑、文生视频、图生视频、漫画管线。
 *
 * 工具设计原则：
 * - 每个工具独立可用，也可被 Agent 编排组合
 * - inputSchema 使用 JSON Schema 格式
 * - execute 返回结构化结果，包含媒体 URL
 */

import type { AITool, AIToolInput, AIToolResult } from '@/ai-runtime'

// ========================================
// Tool 1: generate_image — 文生图
// ========================================

const generateImageTool: AITool = {
  name: 'generate_image',
  description: '使用 Agnes Image 2.1 Flash 根据文字描述生成高质量图像。支持多种风格、自定义尺寸。',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '图像描述提示词。格式：[主体] + [场景/环境] + [风格] + [光照] + [构图] + [质量要求]。推荐使用中文或英文详细描述。',
      },
      size: {
        type: 'string',
        description: '输出图像尺寸，如 1024x768、768x1024、1024x1024。默认 1024x768。',
      },
    },
    required: ['prompt'],
  },
  execute: async (input: AIToolInput): Promise<AIToolResult> => {
    // 此工具的执行需要 Engine Session 上下文（API key 等）
    // 实际执行由 AgnesMultiModalSession 在 tool_choice 流程中处理
    // 这里返回一个标记，表示需要 Engine 层处理
    return {
      success: true,
      data: {
        _toolName: 'generate_image',
        _requiresEngine: true,
        prompt: input.prompt,
        size: input.size || '1024x768',
      },
    }
  },
}

// ========================================
// Tool 2: edit_image — 图生图 / 图片编辑
// ========================================

const editImageTool: AITool = {
  name: 'edit_image',
  description: '使用 Agnes Image 2.1 Flash 对已有图像进行编辑或风格转换。可修改特定元素、改变风格、替换背景，同时保留原始构图。',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '编辑指令。清楚说明要改变什么以及需要保留什么。例如："将场景转换为雨夜赛博朋克风格，保留原始建筑结构"。',
      },
      image_url: {
        type: 'string',
        description: '输入图像的 URL 地址。',
      },
    },
    required: ['prompt', 'image_url'],
  },
  execute: async (input: AIToolInput): Promise<AIToolResult> => {
    return {
      success: true,
      data: {
        _toolName: 'edit_image',
        _requiresEngine: true,
        prompt: input.prompt,
        imageUrl: input.image_url,
      },
    }
  },
}

// ========================================
// Tool 3: generate_video — 文生视频
// ========================================

const generateVideoTool: AITool = {
  name: 'generate_video',
  description: '使用 Agnes Video V2.0 根据文字描述生成视频。异步任务模式，需要轮询获取结果。推荐结构：[主体] + [动作] + [场景] + [镜头移动] + [灯光] + [风格]。',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '视频描述提示词。包含主体、动作、环境、灯光、相机运动和风格。',
      },
      duration: {
        type: 'string',
        description: '视频时长预设：short(~3s), medium(~5s), long(~7s), extended(~10s), max(~18s)。默认 medium。',
        enum: ['short', 'medium', 'long', 'extended', 'max'],
      },
      width: {
        type: 'number',
        description: '视频宽度（像素），默认 1152。',
      },
      height: {
        type: 'number',
        description: '视频高度（像素），默认 768。',
      },
    },
    required: ['prompt'],
  },
  execute: async (input: AIToolInput): Promise<AIToolResult> => {
    return {
      success: true,
      data: {
        _toolName: 'generate_video',
        _requiresEngine: true,
        prompt: input.prompt,
        duration: input.duration || 'medium',
        width: input.width || 1152,
        height: input.height || 768,
      },
    }
  },
}

// ========================================
// Tool 4: image_to_video — 图生视频
// ========================================

const imageToVideoTool: AITool = {
  name: 'image_to_video',
  description: '使用 Agnes Video V2.0 将静态图像动画化为视频。可对单图赋予微妙的动态效果（呼吸感、风吹、光影变化等），或多图间平滑过渡。',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '动画指令。描述希望图像中哪些元素动起来，保持哪些不变。例如："通过微妙的呼吸动作、头发在风中轻轻移动来为角色赋予动画效果"。',
      },
      image_url: {
        type: 'string',
        description: '输入图像的 URL 地址。',
      },
      keyframe_mode: {
        type: 'boolean',
        description: '是否为关键帧模式（多图间平滑过渡）。如果是，image_url 应为 JSON 数组。默认 false。',
      },
    },
    required: ['prompt', 'image_url'],
  },
  execute: async (input: AIToolInput): Promise<AIToolResult> => {
    return {
      success: true,
      data: {
        _toolName: 'image_to_video',
        _requiresEngine: true,
        prompt: input.prompt,
        imageUrl: input.image_url,
        keyframeMode: input.keyframe_mode || false,
      },
    }
  },
}

// ========================================
// Tool 5: start_comic_pipeline — 漫画/漫剧管线
// ========================================

const startComicPipelineTool: AITool = {
  name: 'start_comic_pipeline',
  description: '启动漫画/漫剧自动生成管线。输入故事想法，自动完成：剧本创作 → 角色设计 → 分镜绘制 → 漫剧动效 → 合成输出。适用于快速原型、故事板、漫画创作。',
  inputSchema: {
    type: 'object',
    properties: {
      story_idea: {
        type: 'string',
        description: '故事创作想法。可以是一句话梗概，也可以是详细的剧情描述。例如："一个年轻程序员发现自己写的代码能让现实世界中的物体凭空出现"。',
      },
      comic_style: {
        type: 'string',
        description: '漫画风格。',
        enum: ['japanese_manga', 'american_comic', 'korean_webtoon', 'chinese_manhua', 'european_bd', 'realistic_cinematic'],
      },
      output_format: {
        type: 'string',
        description: '输出格式：comic=仅漫画, motion_comic=仅漫剧, both=漫画+漫剧。默认 both。',
        enum: ['comic', 'motion_comic', 'both'],
      },
      panels_per_page: {
        type: 'number',
        description: '每页分镜数，默认 4。',
      },
    },
    required: ['story_idea'],
  },
  execute: async (input: AIToolInput): Promise<AIToolResult> => {
    return {
      success: true,
      data: {
        _toolName: 'start_comic_pipeline',
        _requiresEngine: true,
        storyIdea: input.story_idea,
        comicStyle: input.comic_style || 'japanese_manga',
        outputFormat: input.output_format || 'both',
        panelsPerPage: input.panels_per_page || 4,
      },
    }
  },
}

// ========================================
// Tool 集合导出
// ========================================

/** 所有 Agnes 多模态工具 */
export const agnesTools: AITool[] = [
  generateImageTool,
  editImageTool,
  generateVideoTool,
  imageToVideoTool,
  startComicPipelineTool,
]

/** 工具名称列表（用于快速查找） */
export const AGNES_TOOL_NAMES = agnesTools.map(t => t.name)

/** 按名称获取工具 */
export function getAgnesTool(name: string): AITool | undefined {
  return agnesTools.find(t => t.name === name)
}
