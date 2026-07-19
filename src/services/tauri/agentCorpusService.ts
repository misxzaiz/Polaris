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
