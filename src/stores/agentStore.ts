/**
 * Agency Agents catalog 状态管理(P1-3)
 *
 * 数据源:`agent_corpus_catalog` / `agent_corpus_divisions` 命令(P0-5/M0 产物),
 * 不经 discover_agents 拼装。搜索/部门筛选为纯前端内存过滤(267 条量级)。
 */

import { create } from 'zustand';
import {
  getAgentCatalog,
  getCorpusStatus,
  installCorpus,
  getRosters,
  listCustomAgents,
  saveCustomAgent,
  deleteCustomAgent,
  type AgentCatalogEntry,
  type CorpusStatus,
  type CustomAgent,
  type RosterDef,
} from '@/services/tauri/agentCorpusService';
import { invoke } from '@/services/transport';
import type { DivisionMap } from '@/types/agent';
import { createLogger } from '@/utils/logger';

const log = createLogger('AgentStore');

interface SimpleAiAgentItem {
  slug: string;
  name: string;
  description: string;
  emoji: string | null;
  division: string | null;
}

interface AgentState {
  catalog: AgentCatalogEntry[];
  divisions: DivisionMap;
  status: CorpusStatus | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;

  /** SimpleAI 引擎可用 agent(项目级 + 全局 corpus 两级,P1-6) */
  simpleAiAgents: SimpleAiAgentItem[];

  /** 专家团场景(rosters.json) */
  rosters: RosterDef[];
  /** 项目级自定义专家 */
  customAgents: CustomAgent[];

  /** 正在安装/重装 corpus */
  installing: boolean;
  /** 最近一次安装错误(供 UI 诊断展示) */
  installError: string | null;

  /** 筛选状态 */
  search: string;
  division: string | null;

  load: () => Promise<void>;
  /** 一键安装/重装 corpus,完成后刷新 catalog/status。返回成功与否。 */
  reinstall: () => Promise<boolean>;
  loadSimpleAiAgents: (workDir: string) => Promise<void>;
  loadRosters: () => Promise<void>;
  loadCustomAgents: (workDir: string) => Promise<void>;
  saveCustom: (params: {
    workDir: string;
    slug: string;
    name: string;
    description: string;
    emoji: string;
    systemPrompt: string;
    tools?: string[];
  }) => Promise<void>;
  deleteCustom: (workDir: string, slug: string) => Promise<void>;
  setSearch: (q: string) => void;
  setDivision: (d: string | null) => void;
  /** 应用当前筛选后的列表 */
  filtered: () => AgentCatalogEntry[];
}

export const useAgentStore = create<AgentState>()((set, get) => ({
  catalog: [],
  divisions: {},
  status: null,
  loading: false,
  loaded: false,
  error: null,
  simpleAiAgents: [],
  rosters: [],
  customAgents: [],
  installing: false,
  installError: null,
  search: '',
  division: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const [catalog, divisionsRaw, status] = await Promise.all([
        getAgentCatalog(),
        invoke<{ divisions: DivisionMap }>('agent_corpus_divisions'),
        getCorpusStatus().catch(() => null),
      ]);
      set({
        catalog,
        divisions: divisionsRaw?.divisions ?? {},
        status,
        loading: false,
        loaded: true,
      });
    } catch (err) {
      log.warn('Agent catalog load failed', { error: String(err) });
      set({ loading: false, error: String(err) });
    }
  },

  reinstall: async () => {
    if (get().installing) return false;
    set({ installing: true, installError: null });
    try {
      await installCorpus();
      // 安装完成后刷新 catalog 与 status(catalog 从资源目录读,status 反映安装结果)
      const [catalog, status] = await Promise.all([
        getAgentCatalog().catch(() => [] as AgentCatalogEntry[]),
        getCorpusStatus().catch(() => null),
      ]);
      set({ catalog, status, installing: false, loaded: true });
      return true;
    } catch (err) {
      const msg = String(err);
      log.warn('Agent corpus install failed', { error: msg });
      set({ installing: false, installError: msg });
      return false;
    }
  },

  loadSimpleAiAgents: async (workDir) => {
    try {
      const agents = await invoke<SimpleAiAgentItem[]>('simple_ai_list_agents', { workDir });
      set({ simpleAiAgents: agents });
    } catch (err) {
      log.warn('SimpleAI agent list load failed', { error: String(err) });
    }
  },

  loadRosters: async () => {
    try {
      set({ rosters: await getRosters() });
    } catch (err) {
      log.warn('Rosters load failed', { error: String(err) });
    }
  },

  loadCustomAgents: async (workDir) => {
    try {
      set({ customAgents: await listCustomAgents(workDir) });
    } catch (err) {
      log.warn('Custom agents load failed', { error: String(err) });
    }
  },

  saveCustom: async (params) => {
    await saveCustomAgent(params);
    await get().loadCustomAgents(params.workDir);
  },

  deleteCustom: async (workDir, slug) => {
    await deleteCustomAgent(workDir, slug);
    await get().loadCustomAgents(workDir);
  },

  setSearch: (search) => set({ search }),
  setDivision: (division) => set({ division }),

  filtered: () => {
    const { catalog, search, division } = get();
    const q = search.trim().toLowerCase();
    return catalog.filter(
      (a) =>
        (!division || a.division === division) &&
        (!q ||
          a.name.toLowerCase().includes(q) ||
          a.slug.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q)),
    );
  },
}));
