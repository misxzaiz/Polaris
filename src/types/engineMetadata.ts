/**
 * 引擎元数据类型定义
 *
 * 对应 Rust 侧 `ai::traits` 中的：
 * - EngineMetadata（引擎元数据）
 * - EngineDistribution（分发方式）
 * - EngineCapabilities（能力标志位）
 * - EnvKeyMapping（环境变量 key 映射）
 * - PlatformBinary（平台二进制下载信息）
 *
 * 这些类型由后端引擎实例通过 `AIEngine::metadata()` trait 方法提供，
 * 前端设置页面据此动态渲染引擎信息，无需硬编码引擎列表。
 */

import type { EngineId } from './config'

// ============================================================================
// EngineDistribution — 引擎分发方式
// ============================================================================

/** 平台二进制下载信息 */
export interface PlatformBinary {
  /** 平台标识（"windows-x86_64" / "darwin-aarch64" / "linux-x86_64"） */
  platform: string
  /** 下载 URL */
  url: string
}

/** 引擎分发方式（tagged union，对应 Rust serde(tag = "type")） */
export type EngineDistribution =
  | {
      type: 'package-runner'
      /** 包规格，如 "@anthropic-ai/claude-code" */
      package: string
      /** 入口命令 */
      cmd: string
      /** 启动参数 */
      args: string[]
      /** 最小运行时版本要求 */
      runtimeMinVersion?: string
    }
  | {
      type: 'binary'
      /** 版本号 */
      version: string
      /** 命令名（PATH 中可执行文件） */
      cmd: string
      /** 启动参数 */
      args: string[]
      /** 各平台下载 URL */
      platforms: PlatformBinary[]
    }
  | {
      type: 'builtin'
    }
  | {
      type: 'custom-path'
      /** CLI 路径 */
      path: string
      /** 路径是否有效 */
      available: boolean
    }

// ============================================================================
// EngineCapabilities — 引擎能力标志位
// ============================================================================

export interface EngineCapabilities {
  /** 是否支持工具调用（bash / 文件操作 等） */
  tools: boolean
  /** 是否支持图片输入（多模态） */
  imageInput: boolean
  /** 是否支持流式输出 */
  streaming: boolean
  /** 是否支持中断正在运行的会话 */
  interrupt: boolean
  /** 是否支持续接历史会话 */
  resume: boolean
  /** 是否支持 stdin 交互输入 */
  stdinInput: boolean
  /** 是否支持 fork 会话 */
  forkSession: boolean
}

// ============================================================================
// EnvKeyMapping — 环境变量 key 映射
// ============================================================================

export interface EnvKeyMapping {
  /** API 端点 URL 变量名（如 "ANTHROPIC_BASE_URL"） */
  baseUrl: string
  /** API 密钥变量名（如 "ANTHROPIC_AUTH_TOKEN"） */
  apiKey: string
  /** 模型变量名（如 "ANTHROPIC_MODEL"） */
  model: string
}

// ============================================================================
// EngineMetadata — 引擎元数据
// ============================================================================

/** 引擎元数据（对应 Rust EngineMetadata） */
export interface EngineMetadata {
  id: EngineId
  name: string
  description?: string
  distribution: EngineDistribution
  capabilities: EngineCapabilities
  envKeys: EnvKeyMapping
  /** 是否支持通过 model_provider 切换 API 端点 */
  supportsModelProvider: boolean
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 获取分发方式的显示名称 */
export function getDistributionLabel(dist: EngineDistribution): string {
  switch (dist.type) {
    case 'package-runner':
      return `npx ${dist.package}`
    case 'binary':
      return `${dist.cmd} v${dist.version}`
    case 'builtin':
      return '内置引擎'
    case 'custom-path':
      return dist.available ? dist.path : '未检测到'
  }
}

/** 获取分发方式的版本信息 */
export function getDistributionVersion(dist: EngineDistribution): string | undefined {
  switch (dist.type) {
    case 'package-runner':
    case 'binary':
      // binary 有 version 字段，package-runner 需要额外提取
      return 'version' in dist ? (dist as { version: string }).version : undefined
    case 'builtin':
    case 'custom-path':
      return undefined
  }
}

/** 引擎能力列表的人类可读标签 */
export function getCapabilityLabels(caps: EngineCapabilities): string[] {
  const labels: string[] = []
  if (caps.tools) labels.push('工具调用')
  if (caps.imageInput) labels.push('图片输入')
  if (caps.streaming) labels.push('流式输出')
  if (caps.interrupt) labels.push('中断')
  if (caps.resume) labels.push('续接会话')
  if (caps.stdinInput) labels.push('交互输入')
  if (caps.forkSession) labels.push('会话分支')
  return labels
}
