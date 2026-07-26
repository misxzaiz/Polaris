/**
 * 专家/专家团相关 Tauri 命令
 *
 * 内置 corpus 已移除(2026-07):专家只来自项目级 `.polaris/agents/`,专家团存于
 * `<DataRoot>/agents/rosters-user.json`。AI 可经 MCP(save_agent/save_roster/list_agents)
 * 自助维护,无需人工操作 UI。
 */

import { invoke } from '@/services/transport';

// ============================================================================
// 专家团(roster)与自定义专家
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
  tools: string[];
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
  tools?: string[];
}): Promise<string> {
  return invoke<string>('custom_agent_save', params);
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
// NEXUS pipeline 进度
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
