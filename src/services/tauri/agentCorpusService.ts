/**
 * Agency Agents corpus 相关 Tauri 命令(P1-0)
 */

import { invoke } from '@/services/transport';

export interface CorpusStatus {
  installedVersion: number | null;
  bundledVersion: number;
  installedCount: number;
  bundledCount: number;
  installDir: string;
}

export interface AgentCatalogEntry {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  division: string;
}

export async function getCorpusStatus(): Promise<CorpusStatus> {
  return invoke<CorpusStatus>('agent_corpus_status');
}

export async function installCorpus(): Promise<CorpusStatus> {
  return invoke<CorpusStatus>('agent_corpus_install');
}

export async function uninstallCorpus(): Promise<void> {
  return invoke('agent_corpus_uninstall');
}

export async function getAgentCatalog(): Promise<AgentCatalogEntry[]> {
  return invoke<AgentCatalogEntry[]>('agent_corpus_catalog');
}

/**
 * 启动期自动安装/升级(幂等):未安装或内置版本更新时执行 install。
 * 失败静默(warn 由调用方记录),不阻塞启动。
 */
export async function ensureCorpusInstalled(): Promise<CorpusStatus | null> {
  const status = await getCorpusStatus();
  if (status.installedVersion === null || status.bundledVersion > status.installedVersion) {
    return installCorpus();
  }
  return status;
}

// ============================================================================
// 专家团(roster)与自定义专家(P3 体验优化)
// ============================================================================

export interface RosterGroup {
  group: string;
  activation: string;
  members: string[];
}

export interface RosterDef {
  slug: string;
  title: string;
  mode: string;
  duration: string;
  summary: string;
  groups: RosterGroup[];
  /** 用户自建 roster 标记 */
  custom?: boolean;
}

export async function saveUserRoster(params: {
  slug: string;
  title: string;
  summary: string;
  members: string[];
}): Promise<void> {
  return invoke('user_roster_save', params);
}

export async function deleteUserRoster(slug: string): Promise<void> {
  return invoke('user_roster_delete', { slug });
}

export async function getRosters(): Promise<RosterDef[]> {
  const raw = await invoke<{ rosters: RosterDef[] }>('agent_corpus_rosters');
  return raw?.rosters ?? [];
}

export interface CustomAgent {
  slug: string;
  name: string;
  description: string;
  emoji: string | null;
  systemPrompt: string;
  filePath: string;
}

export async function listCustomAgents(workDir: string): Promise<CustomAgent[]> {
  return invoke<CustomAgent[]>('custom_agent_list', { workDir });
}

export async function saveCustomAgent(params: {
  workDir: string;
  slug: string;
  name: string;
  description: string;
  emoji: string;
  systemPrompt: string;
}): Promise<string> {
  return invoke<string>('custom_agent_save', params);
}

export async function readCorpusAgent(slug: string): Promise<string> {
  return invoke<string>('agent_corpus_read', { slug });
}

export async function deleteCustomAgent(workDir: string, slug: string): Promise<void> {
  return invoke('custom_agent_delete', { workDir, slug });
}

export interface RosterStartResult {
  rosterId: string;
  scenario: string;
  waves: string[][];
  dispatchedNow: string[];
}

export async function startRoster(params: {
  scenario: string;
  goal: string;
  sourceSessionId?: string;
  workDir?: string;
  mode?: 'sprint' | 'micro';
}): Promise<RosterStartResult> {
  return invoke<RosterStartResult>('nexus_start_roster', params);
}

// ============================================================================
// NEXUS pipeline 进度(U1-1)
// ============================================================================

export interface PipelineMember {
  slug: string;
  status: 'pending' | 'dispatching' | 'running' | 'completed' | 'failed';
  dispatchId?: string;
  verdictStatus?: string;
}

export interface PipelineEscalation {
  qaSlug: string;
  devSlug: string;
  attempts: number;
  resolution: 'pending' | 'accepted' | 'failed';
}

export interface PipelineLaterGroup {
  activation: string;
  members: string[];
}

export interface RosterPipeline {
  id: string;
  scenario: string;
  goal: string;
  sourceSessionId: string;
  workDir?: string;
  waves: string[][];
  currentWave: number;
  members: Record<string, PipelineMember>;
  memberSummaries: Record<string, string>;
  fixAttempts?: Record<string, number>;
  loopState?: { devSlug: string; qaSlug: string; phase: 'fixing' | 'reverifying' };
  escalations?: PipelineEscalation[];
  laterGroups?: PipelineLaterGroup[];
  dispatchedGroups?: string[];
  mode?: string;
  finalReport?: string;
  status: 'running' | 'completed';
  createdAt: number;
}

export async function resolveEscalation(rosterId: string, qaSlug: string, action: 'accept' | 'fail'): Promise<void> {
  return invoke('nexus_resolve_escalation', { rosterId, qaSlug, action });
}

export async function dispatchLaterGroup(rosterId: string, activation: string): Promise<string[]> {
  return invoke<string[]>('nexus_dispatch_group', { rosterId, activation });
}

export async function listPipelines(): Promise<RosterPipeline[]> {
  return invoke<RosterPipeline[]>('nexus_list_pipelines');
}
