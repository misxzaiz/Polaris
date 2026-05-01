/**
 * 模型 Profile 类型定义
 *
 * Model Profile 允许将 Claude Code CLI 或 Codex CLI 的请求路由到
 * 第三方代理端点，从而使用非官方模型。
 *
 * Claude 使用 --settings 临时文件 + 环境变量覆盖。
 * Codex 使用 model_provider 配置，要求端点兼容 Responses API。
 */

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
  description?: string
}

/** 更新 Profile 的参数 */
export interface UpdateModelProfileParams {
  id: string
  name?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  description?: string
}

/** 默认 Profile 列表（示例/引导用） */
export const PRESET_MODEL_PROFILES: ModelProfile[] = []

/** 生成 Profile ID */
export function generateProfileId(): string {
  return `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
