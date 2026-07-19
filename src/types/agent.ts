/**
 * Agency Agents 类型定义(P1-3)
 */

export type { AgentCatalogEntry, CorpusStatus } from '@/services/tauri/agentCorpusService';

export interface DivisionMeta {
  label: string;
  icon: string;
  color: string;
}

export type DivisionMap = Record<string, DivisionMeta>;
