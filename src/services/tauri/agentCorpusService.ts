/**
 * 专家/专家团相关 Tauri 命令
 *
 * 专家全局存储(2026-07):专家存于 `<DataRoot>/agents/<slug>.md`,专家团存于
 * `<DataRoot>/agents/rosters-user.json`,与其他设置统一。AI 可经 MCP
 * (save_agent/save_roster/list_agents) 自助维护,无需人工操作 UI。
 */

import { invoke } from '@/services/transport';

/** K-R5 批E3：agent_corpus_* 命令删除，统一走 cap.meta 总线 */
async function metaDispatch<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await invoke<{ msgId: string; ok: boolean; result: T; error: string | null }>('router_dispatch', {
    req: { target: 'cap.meta', payload: { action, ...payload } },
  });
  if (!res.ok) throw new Error(res.error || ('cap.meta ' + action + ' 失败'));
  return res.result;
}

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
  return metaDispatch('roster_save', params);
}

export async function deleteUserRoster(slug: string): Promise<void> {
  return metaDispatch('roster_delete', { slug });
}

export async function getRosters(): Promise<RosterDef[]> {
  const raw = await metaDispatch<{ rosters: RosterDef[] }>('agent_rosters');
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

export async function listCustomAgents(): Promise<CustomAgent[]> {
  return metaDispatch<CustomAgent[]>('agent_custom_list');
}

export async function saveCustomAgent(params: {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  systemPrompt: string;
  tools?: string[];
}): Promise<string> {
  return metaDispatch<string>('agent_custom_save', params);
}

export async function deleteCustomAgent(slug: string): Promise<void> {
  return metaDispatch('agent_custom_delete', { slug });
}

// NEXUS pipeline 封装（startRoster/resolveEscalation/dispatchLaterGroup/listPipelines）
// 已随专家画廊移除（2026-11）：唯一消费者是画廊面板；/nexus 斜杠命令经
// chatCommandRouter 直调 transportInvoke('nexus_start_roster')，不经本文件。
// 后端 nexus 命令与 ask_listener 派发链保留（基础设施）。
