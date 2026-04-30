import type { Config, EngineId, HealthStatus } from '../types';
import { normalizeEngineId, getEngineFullName } from './engineDisplay';

export interface SelectedEngineHealth {
  engineId: EngineId;
  name: string;
  command: 'claude' | 'codex';
  cliPath: string;
  available: boolean;
  version?: string;
}

export function getSelectedEngineHealth(
  config: Config | null | undefined,
  health: HealthStatus | null | undefined,
): SelectedEngineHealth {
  const engineId = normalizeEngineId(config?.defaultEngine);

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

  return {
    engineId,
    name: getEngineFullName(engineId),
    command: 'claude',
    cliPath: config?.claudeCode?.cliPath || 'claude',
    available: health?.claudeAvailable ?? false,
    version: health?.claudeVersion,
  };
}
