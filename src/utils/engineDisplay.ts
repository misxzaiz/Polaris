import type { EngineId } from '@/types';

const VALID_ENGINE_IDS: EngineId[] = ['claude-code', 'codex', 'simple-ai', 'mimo'];

export function normalizeEngineId(engineId?: string | null): EngineId {
  return engineId && (VALID_ENGINE_IDS as string[]).includes(engineId)
    ? (engineId as EngineId)
    : 'claude-code';
}

export function getEngineDisplayName(engineId?: string | null): string {
  const id = normalizeEngineId(engineId);
  if (id === 'codex') return 'Codex';
  if (id === 'simple-ai') return 'Simple AI';
  if (id === 'mimo') return 'Mimo';
  return 'Claude';
}

export function getEngineFullName(engineId?: string | null): string {
  const id = normalizeEngineId(engineId);
  if (id === 'codex') return 'OpenAI Codex';
  if (id === 'simple-ai') return 'Simple AI';
  if (id === 'mimo') return 'Mimo Code';
  return 'Claude Code';
}
