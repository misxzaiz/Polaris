/**
 * 模型 Profile 类型定义
 *
 * Model Profile 允许将 Claude Code CLI 或 Codex CLI 的请求路由到
 * 第三方代理端点，从而使用非官方模型。
 *
 * Claude 使用 --settings 临时文件 + 环境变量覆盖。
 * Codex 使用 model_provider 配置，要求端点兼容 Responses API。
 *
 * 当 wireApi 为 'openai-chat-completions' 时，Polaris 内嵌代理会透明地
 * 将 Claude CLI 的 Anthropic Messages 请求转换为 OpenAI Chat Completions
 * 格式发送给上游端点，再将响应转换回 Anthropic 格式返回给 CLI。
 */

/** Wire API 协议格式 */
export type WireApi = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses'

/**
 * 认证方式 — 决定 API 密钥注入到哪个鉴权字段。
 * - 'auth_token'：注入为 ANTHROPIC_AUTH_TOKEN（Bearer，默认，等价历史行为）
 * - 'api_key'：注入为 ANTHROPIC_API_KEY（x-api-key）
 * - 'custom_env'：注入为用户指定的环境变量名（见 apiKeyEnvName）
 * - 'none'：本地模型 / 无需鉴权
 */
export type AuthType = 'auth_token' | 'api_key' | 'custom_env' | 'none'

/** Profile 适用的引擎
 * - 'claude': 仅适用于 Claude Code 引擎
 * - 'codex': 仅适用于 Codex CLI 引擎
 * - 'both': 同时适用于两个引擎
 */
export type ProfileTargetEngine = 'claude' | 'codex' | 'both'

/** 供应商分类 — 决定预设引导和提示文案
 * - 'official': 官方直连（Anthropic / OpenAI）
 * - 'cn_official': 国内官方直连（火山引擎、百度等）
 * - 'aggregator': API 聚合/转售平台（OpenRouter、SiliconFlow 等）
 * - 'third_party': 第三方供应商
 * - 'custom': 用户自定义端点
 */
export type ProfileCategory =
  | 'official'
  | 'cn_official'
  | 'aggregator'
  | 'third_party'
  | 'custom'

/** 模型 Profile — 描述一个第三方模型端点配置 */
export interface ModelProfile {
  /** 唯一 ID */
  id: string
  /** 人可读名称，如 "DeepSeek V4 Pro" */
  name: string
  /** API 端点 URL */
  baseUrl: string
  /** API 密钥 */
  apiKey: string
  /** 目标模型名称（发给代理端点的模型标识） */
  model: string
  /** 是否为当前激活 Profile */
  active: boolean
  /**
   * Wire API 协议格式。
   * - 'anthropic-messages'（默认）：端点兼容 Anthropic Messages API
   * - 'openai-chat-completions'：端点兼容 OpenAI Chat Completions API，
   *   Polaris 内嵌代理负责格式转换
   */
  wireApi?: WireApi
  /**
   * 适用的引擎。
   * - 'claude': 仅适用于 Claude Code
   * - 'codex': 仅适用于 Codex CLI
   * - 'both': 同时适用于两个引擎
   */
  targetEngine?: ProfileTargetEngine
  /**
   * 供应商分类，决定预设引导和提示文案。
   */
  category?: ProfileCategory
  /** 可选：Profile 描述 */
  description?: string
  /**
   * 认证方式。缺省按 'auth_token' 处理（旧 Profile 兼容），参见 resolveAuthType()。
   */
  authType?: AuthType
  /** authType='custom_env' 时使用的环境变量名（如 OPENAI_API_KEY） */
  apiKeyEnvName?: string
  /** 自定义请求头（连接测试与内嵌代理转发时附加） */
  customHeaders?: Record<string, string>
  /** 注入 CLI 子进程的额外环境变量 */
  customEnv?: Record<string, string>
  /** 上次从端点拉取的模型列表（仅前端 UI 缓存用） */
  fetchedModels?: string[]
  /** 创建时间 (ISO 8601) */
  createdAt?: string
  /** 最后更新时间 (ISO 8601) */
  updatedAt?: string
}

/** 创建 Profile 的参数（不含自动生成的字段） */
export interface CreateModelProfileParams {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  wireApi?: WireApi
  targetEngine?: ProfileTargetEngine
  category?: ProfileCategory
  description?: string
  authType?: AuthType
  apiKeyEnvName?: string
  customHeaders?: Record<string, string>
  customEnv?: Record<string, string>
}

/** 更新 Profile 的参数 */
export interface UpdateModelProfileParams {
  id: string
  name?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  wireApi?: WireApi
  targetEngine?: ProfileTargetEngine
  category?: ProfileCategory
  description?: string
  authType?: AuthType
  apiKeyEnvName?: string
  customHeaders?: Record<string, string>
  customEnv?: Record<string, string>
}

/** 默认 Profile 列表（示例/引导用） */
export const PRESET_MODEL_PROFILES: ModelProfile[] = []

/**
 * 常用供应商预设配置（用于快速创建 Profile）
 * 每个 preset 仅包含模板信息，用户需手动输入 API Key
 */
export interface ProviderPreset {
  /** 供应商显示名称 */
  name: string
  /** 供应商图标名 */
  icon?: string
  /** 默认 category */
  category: ProfileCategory
  /** 默认 targetEngine */
  defaultTargetEngine: ProfileTargetEngine
  /** 默认 wireApi */
  defaultWireApi: WireApi
  /** 常用模型列表（用户可快速选择） */
  commonModels: string[]
  /** 常用 base URL 端点 */
  baseUrls: string[]
  /** 说明文案 */
  description: string
  /** 官网 URL */
  websiteUrl?: string
}

/** 常用供应商预设列表 */
export const COMMON_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    name: 'SiliconFlow (硅基流动)',
    icon: 'silicon',
    category: 'aggregator',
    defaultTargetEngine: 'both',
    defaultWireApi: 'anthropic-messages',
    commonModels: ['glm-4', 'deepseek-v3', 'Qwen-2.5-72B'],
    baseUrls: ['https://api.siliconflow.cn'],
    description: '国内主流 AI API 聚合平台，支持 glm、qwen、deepseek 等多种模型',
    websiteUrl: 'https://siliconflow.cn',
  },
  {
    name: 'OpenRouter',
    icon: 'openrouter',
    category: 'aggregator',
    defaultTargetEngine: 'both',
    defaultWireApi: 'openai-chat-completions',
    commonModels: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o'],
    baseUrls: ['https://openrouter.ai/api/v1'],
    description: '跨模型 API 网关，支持 Anthropic / OpenAI / Google 等 100+ 模型',
    websiteUrl: 'https://openrouter.ai',
  },
  {
    name: '火山引擎 (Volcengine)',
    icon: 'volcengine',
    category: 'cn_official',
    defaultTargetEngine: 'both',
    defaultWireApi: 'anthropic-messages',
    commonModels: ['glm-4', 'Yi-Lightning', 'Qwen-Max'],
    baseUrls: ['https://ark.cn-beijing.volces.com/api/v3'],
    description: '字节跳动旗下云平台，支持多种开源模型的托管推理',
    websiteUrl: 'https://www.volcengine.com',
  },
  {
    name: 'Together AI',
    icon: 'together',
    category: 'aggregator',
    defaultTargetEngine: 'both',
    defaultWireApi: 'openai-chat-completions',
    commonModels: ['meta-llama/Llama-3-70b-chat-hf'],
    baseUrls: ['https://api.together.xyz/v1'],
    description: '开源模型 API 平台，提供 Llama、Mistral 等热门模型',
    websiteUrl: 'https://www.together.ai',
  },
  {
    name: '自定义端点',
    icon: 'custom',
    category: 'custom',
    defaultTargetEngine: 'both',
    defaultWireApi: 'anthropic-messages',
    commonModels: [],
    baseUrls: [],
    description: '手动输入任意兼容端点',
  },
]

/** 生成 Profile ID */
export function generateProfileId(): string {
  return `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 判断 Profile 是否适用于指定引擎 */
export function isProfileForEngine(profile: ModelProfile, engine: 'claude' | 'codex'): boolean {
  return profile.targetEngine === 'both' || profile.targetEngine === engine
}

/** 获取 Profile 的 category 显示名称 */
export function getCategoryLabel(category?: ProfileCategory): string {
  const labels: Record<ProfileCategory, string> = {
    official: '官方',
    cn_official: '国内官方',
    aggregator: '聚合平台',
    third_party: '第三方',
    custom: '自定义',
  }
  return category ? (labels[category] || category) : ''
}

/**
 * 解析 Profile 的有效认证方式。
 * 旧 Profile 未设置 authType 时回退到 'auth_token'（保持历史行为：注入 ANTHROPIC_AUTH_TOKEN）。
 */
export function resolveAuthType(profile: Pick<ModelProfile, 'authType'>): AuthType {
  return profile.authType ?? 'auth_token'
}
