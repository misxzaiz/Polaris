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
export type WireApi = 'anthropic-messages' | 'openai-chat-completions'

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
  /** 可选：Profile 描述 */
  description?: string
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
  description?: string
}

/** 更新 Profile 的参数 */
export interface UpdateModelProfileParams {
  id: string
  name?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  wireApi?: WireApi
  description?: string
}

/** 默认 Profile 列表（示例/引导用） */
export const PRESET_MODEL_PROFILES: ModelProfile[] = []

/** 生成 Profile ID */
export function generateProfileId(): string {
  return `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
