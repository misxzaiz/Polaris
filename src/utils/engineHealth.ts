import type { Config, EngineId, HealthStatus } from '@/types';
import { normalizeEngineId, getEngineFullName } from './engineDisplay';

export interface SelectedEngineHealth {
  engineId: EngineId;
  name: string;
  command: 'claude' | 'codex' | 'simple-ai';
  cliPath: string;
  available: boolean;
  version?: string;
}

export function getSelectedEngineHealth(
  config: Config | null | undefined,
  health: HealthStatus | null | undefined,
  engineOverride?: string | null,
): SelectedEngineHealth {
  const engineId = normalizeEngineId(engineOverride ?? config?.defaultEngine);

  if (engineId === 'codex') {
    return {
      engineId,
      name: getEngineFullName(engineId),
      command: 'codex',
      cliPath: config?.codexCode?.cliPath || 'codex',
      available: health?.codexAvailable ?? false,
      version: health?.codexVersion,
    };
  }

  if (engineId === 'simple-ai') {
    // SimpleAI 可用性取决于是否配置了模型 Profile
    const hasProfile = (config?.modelProfiles ?? []).some(
      p => p.baseUrl && p.apiKey && p.model,
    );
    return {
      engineId,
      name: getEngineFullName(engineId),
      command: 'simple-ai',
      cliPath: '',
      available: hasProfile,
      version: undefined,
    };
  }

  // agnes 和 claude-code 默认走 Claude 路径
  return {
    engineId,
    name: getEngineFullName(engineId),
    command: 'claude',
    cliPath: config?.claudeCode?.cliPath || 'claude',
    available: engineId === 'agnes' ? true : (health?.claudeAvailable ?? false),
    version: health?.claudeVersion,
  };
}

export function hasAnyEngineAvailable(
  health: HealthStatus | null | undefined,
  config?: Config | null,
): boolean {
  // SimpleAI 也算可用（只要有 profile 配置）
  const hasSimpleAI = (config?.modelProfiles ?? []).some(
    p => p.baseUrl && p.apiKey && p.model,
  );
  return Boolean(health?.claudeAvailable || health?.codexAvailable || hasSimpleAI);
}
