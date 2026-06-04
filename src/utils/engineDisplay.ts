import type { EngineId } from '@/types';

const VALID_ENGINE_IDS: EngineId[] = ['claude-code', 'codex', 'agnes'];

export function normalizeEngineId(engineId?: string | null): EngineId {
  return engineId && (VALID_ENGINE_IDS as string[]).includes(engineId)
    ? (engineId as EngineId)
    : 'claude-code';
}

export function getEngineDisplayName(engineId?: string | null): string {
  const id = normalizeEngineId(engineId);
  if (id === 'codex') return 'Codex';
  if (id === 'agnes') return 'Agnes';
  return 'Claude';
}

export function getEngineFullName(engineId?: string | null): string {
  const id = normalizeEngineId(engineId);
  if (id === 'codex') return 'OpenAI Codex';
  if (id === 'agnes') return 'Agnes Multi-Modal';
  return 'Claude Code';
}
