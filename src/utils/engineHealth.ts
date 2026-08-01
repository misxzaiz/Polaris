/**
 * 引擎健康状态工具函数
 *
 * 从后端引擎元数据 + HealthStatus 获取引擎可用性信息。
 * 新增引擎时只需在后端 HealthStatus 中增加字段，前端自动识别。
 */

import type { Config, EngineId, HealthStatus } from '@/types'
import { normalizeEngineId, getEngineFullName } from './engineDisplay'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'

export interface SelectedEngineHealth {
  engineId: EngineId
  name: string
  /** health 字段前缀（如 "claude"、"codex"、"pi"） */
  healthPrefix: string
  /** CLI 命令名称（如 "claude"、"codex"、"pi"） */
  command: string
  cliPath: string
  available: boolean
  version?: string
}

/**
 * 从 HealthStatus 中获取指定引擎的可用性。
 * 根据引擎 ID 动态查找对应的 health 字段（如 pi → piAvailable / piVersion）。
 */
function resolveEngineHealthFromStatus(
  engineId: string,
  health: HealthStatus | null | undefined,
): { available: boolean; version?: string } {
  if (!health) return { available: false }

  // 根据引擎 ID 映射到 HealthStatus 字段名
  const fieldMap: Record<string, { available: string; version: string }> = {
    'claude-code': { available: 'claudeAvailable', version: 'claudeVersion' },
    codex: { available: 'codexAvailable', version: 'codexVersion' },
    pi: { available: 'piAvailable', version: 'piVersion' },
  }

  const fields = fieldMap[engineId]
  if (fields) {
    return {
      available: !!(health as any)[fields.available],
      version: (health as any)[fields.version],
    }
  }

  // 未知引擎（如 SimpleAI 内置引擎）默认不可用
  return { available: false }
}

export function getSelectedEngineHealth(
  config: Config | null | undefined,
  health: HealthStatus | null | undefined,
  engineOverride?: string | null,
): SelectedEngineHealth {
  const engineId = normalizeEngineId(engineOverride ?? config?.defaultEngine)

  // SimpleAI 内置引擎：可用性取决于是否配置了模型 Profile
  if (engineId === 'simple-ai') {
    const hasProfile = (config?.modelProfiles ?? []).some(
      p => p.baseUrl && p.apiKey && p.model,
    )
    return {
      engineId,
      name: getEngineFullName(engineId),
      healthPrefix: 'simple-ai',
      command: '',
      cliPath: '',
      available: hasProfile,
      version: undefined,
    }
  }

  const status = resolveEngineHealthFromStatus(engineId, health)

  // 获取 CLI 路径
  const cliConfig = config?.[engineId === 'claude-code' ? 'claudeCode' : engineId === 'codex' ? 'codexCode' : 'piCode' as keyof Config] as { cliPath?: string } | undefined
  const cliPath = cliConfig?.cliPath || ''

  // CLI 命令名映射
  const commandMap: Record<string, string> = {
    'claude-code': 'claude',
    codex: 'codex',
    pi: 'pi',
  }

  return {
    engineId,
    name: getEngineFullName(engineId),
    healthPrefix: engineId,
    command: commandMap[engineId] ?? engineId,
    cliPath,
    available: status.available,
    version: status.version,
  }
}

export function hasAnyEngineAvailable(
  health: HealthStatus | null | undefined,
  config?: Config | null,
): boolean {
  // 从元数据获取所有引擎 ID
  const metadatas = useEngineMetadataStore.getState().metadatas
  if (metadatas.length === 0) {
    // 兜底：静态列表
    const hasSimpleAI = (config?.modelProfiles ?? []).some(
      p => p.baseUrl && p.apiKey && p.model,
    )
    return Boolean(health?.claudeAvailable || health?.codexAvailable || health?.piAvailable || hasSimpleAI)
  }

  for (const meta of metadatas) {
    if (meta.id === 'simple-ai') {
      const hasProfile = (config?.modelProfiles ?? []).some(
        p => p.baseUrl && p.apiKey && p.model,
      )
      if (hasProfile) return true
    } else {
      const status = resolveEngineHealthFromStatus(meta.id, health)
      if (status.available) return true
    }
  }
  return false
}