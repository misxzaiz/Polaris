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

/** Profile 适用的引擎（多选）
 * - 'claude': 适用于 Claude Code 引擎
 * - 'codex': 适用于 Codex CLI 引擎
 * - 'simple-ai': 适用于 Simple AI 引擎
 * - 'mimo': 适用于 Mimo 引擎
 *
 * 历史兼容：旧数据使用 `targetEngine?: ProfileTargetEngine` 单值字段，
 * 由 `resolveTargetEngines()` 做回退迁移，不再新增。
 */
export type ProfileTargetEngine = 'claude' | 'codex' | 'simple-ai' | 'mimo'

/** 全部可用引擎列表 — 用于「全选/取消全选」等场景 */
export const ALL_ENGINES: ProfileTargetEngine[] = ['claude', 'codex', 'simple-ai', 'mimo']

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

/**
 * 会话级「明确选择官方 API」的哨兵值。
 *
 * 写入 `SessionMetadata.modelProfileId` 时用它表达「用户主动选了官方端点」，
 * 与 `undefined`（从未设置 → 跟随全局默认）区分开。这样会话级「官方 API」
 * 覆盖才能优先于设置页激活的全局 Profile（否则会被静默回退，造成意外费用 / 答非所选）。
 *
 * 注意：该哨兵**绝不能透传到后端** —— 后端 apply_model_profile_options 会按 id 查找，
 * 查不到即中断请求。解析最终生效 Profile 时（resolveEffectiveProfileId）必须把它归一化为
 * `undefined`（= 不使用任何 Profile，走官方）。值以 `__` 包裹，保证不与 generateProfileId
 * 生成的 `profile_*` 真实 id 冲突。
 */
export const OFFICIAL_API_PROFILE = '__official_api__'

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
  /** 目标模型名称（默认模型，发给代理端点的模型标识） */
  model: string
  /** 该供应商可选模型列表；为空时回退到 model */
  modelOptions?: string[]
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
   * 适用的引擎（多选）。
   * - 空数组或未设置：适用于所有引擎
   * - 非空数组：仅适用于列出的引擎
   */
  targetEngines?: ProfileTargetEngine[]
  /** 历史兼容字段（仅用于读取旧数据，不再写入）。
 * 旧值可能为 'both' / 'all' / 'claude' / 'codex' / 'simple-ai'。
 * 由 `resolveTargetEngines()` 做回退迁移。
 * @deprecated 使用 `targetEngines` 替代
 */
  targetEngine?: string
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
  /**
   * 单次响应输出 token 上限（max_tokens）。仅 SimpleAI 引擎请求路径生效。
   * 留空：OpenAI Chat 协议不发该字段（供应商默认）；Anthropic/Responses 协议回退 8192。
   */
  maxTokens?: number
  /**
   * 上下文窗口（token），驱动 SimpleAI 压缩触发阈值（window × 0.75）。
   * 留空：custom_env SIMPLE_AI_CONTEXT_WINDOW（兼容）→ 默认 180,000。
   * ⚠️ 通过中转站/聚合代理时务必填写上游真实窗口（如 256K 代理填 262144）；
   * 否则压缩触发按 180K 估算，时机不对，压缩请求自身会被上游 400 拒绝。
   */
  contextWindow?: number
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
  modelOptions?: string[]
  wireApi?: WireApi
  targetEngines?: ProfileTargetEngine[]
  category?: ProfileCategory
  description?: string
  authType?: AuthType
  apiKeyEnvName?: string
  customHeaders?: Record<string, string>
  customEnv?: Record<string, string>
  maxTokens?: number
  contextWindow?: number
}

/** 更新 Profile 的参数 */
export interface UpdateModelProfileParams {
  id: string
  name?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  modelOptions?: string[]
  wireApi?: WireApi
  targetEngines?: ProfileTargetEngine[]
  category?: ProfileCategory
  description?: string
  authType?: AuthType
  apiKeyEnvName?: string
  customHeaders?: Record<string, string>
  customEnv?: Record<string, string>
  maxTokens?: number
  contextWindow?: number
}

/**
 * 连接测试结果（对应后端 ConnectionTestResult）
 *
 * 由 testModelProfileConnection 返回，用于在 UI 上区分失败原因：
 * 鉴权失败(401/403)、路径错误(404)、服务端错误(5xx)、网络不可达(status 缺失)。
 */
export interface ConnectionTestResult {
  /** 是否连通（HTTP 2xx 或 400 视为端点可达） */
  ok: boolean
  /** HTTP 状态码；网络层失败（无响应）时为 undefined */
  status?: number
  /** 失败详情：错误体摘要或网络错误信息；成功时为 undefined */
  detail?: string
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
  /** 默认适用引擎（空数组 = 全部引擎） */
  defaultTargetEngines: ProfileTargetEngine[]
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
    defaultTargetEngines: [],
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
    defaultTargetEngines: [],
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
    defaultTargetEngines: [],
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
    defaultTargetEngines: [],
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
    defaultTargetEngines: [],
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

/**
 * 解析 Profile 的适用引擎列表，兼容旧数据。
 *
 * 优先级：
 * 1. `targetEngines` 非空 → 直接返回
 * 2. 旧字段 `targetEngine`：
 *    - 'both' / 'all' / undefined → 返回 []（全选）
 *    - 单值 → 返回 [单值]
 * 3. 无旧字段 → 返回 []（全选）
 */
export function resolveTargetEngines(profile: {
  targetEngines?: ProfileTargetEngine[]
  targetEngine?: string
}): ProfileTargetEngine[] {
  if (profile.targetEngines && profile.targetEngines.length > 0) {
    return profile.targetEngines
  }
  const old = profile.targetEngine
  if (!old || old === 'both' || old === 'all') {
    return []
  }
  return [old as ProfileTargetEngine]
}

/** 判断 Profile 是否适用于指定引擎 */
export function isProfileForEngine(
  profile: ModelProfile,
  engine: 'claude' | 'codex' | 'simple-ai' | 'mimo',
): boolean {
  const engines = resolveTargetEngines(profile)
  // 空数组 = 全选 = 适用于所有引擎
  return engines.length === 0 || engines.includes(engine)
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
