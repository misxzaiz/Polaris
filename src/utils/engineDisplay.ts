import type { EngineId } from '../types';

export function normalizeEngineId(engineId?: string | null): EngineId {
  return engineId === 'codex' ? 'codex' : 'claude-code';
}

export function getEngineDisplayName(engineId?: string | null): string {
  return normalizeEngineId(engineId) === 'codex' ? 'Codex' : 'Claude';
}

export function getEngineFullName(engineId?: string | null): string {
  return normalizeEngineId(engineId) === 'codex' ? 'OpenAI Codex' : 'Claude Code';
}
