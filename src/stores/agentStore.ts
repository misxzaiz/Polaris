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
  type AgentCatalogEntry,
  type CorpusStatus,
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

  /** 筛选状态 */
  search: string;
  division: string | null;

  load: () => Promise<void>;
  loadSimpleAiAgents: (workDir: string) => Promise<void>;
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

  loadSimpleAiAgents: async (workDir) => {
    try {
      const agents = await invoke<SimpleAiAgentItem[]>('simple_ai_list_agents', { workDir });
      set({ simpleAiAgents: agents });
    } catch (err) {
      log.warn('SimpleAI agent list load failed', { error: String(err) });
    }
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
