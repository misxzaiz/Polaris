/**
 * 专家/专家团状态管理
 *
 * 专家全局存储(2026-07):专家存于 `<DataRoot>/agents/<slug>.md`(由 AI 经 MCP
 * `save_agent` 自助维护),专家团存于 `<DataRoot>/agents/rosters-user.json`。
 * `catalog` 为 customAgents 的派生视图(供旧消费点兼容),搜索/筛选为纯前端内存过滤。
 */

import { create } from 'zustand';
import {
  getRosters,
  listCustomAgents,
  saveCustomAgent,
  deleteCustomAgent,
  type CustomAgent,
  type RosterDef,
} from '@/services/tauri/agentCorpusService';
import { invoke } from '@/services/transport';
import { createLogger } from '@/utils/logger';

const log = createLogger('AgentStore');

interface SimpleAiAgentItem {
  slug: string;
  name: string;
  description: string;
  emoji: string | null;
  division: string | null;
}

/** 派生 catalog 条目(从 customAgents 映射,兼容旧消费点) */
export interface AgentCatalogEntry {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  division: string;
}

interface AgentState {
  /** 派生 catalog(从 customAgents 映射) */
  catalog: AgentCatalogEntry[];
  loading: boolean;
  loaded: boolean;
  error: string | null;

  /** SimpleAI 引擎可用 agent(项目级) */
  simpleAiAgents: SimpleAiAgentItem[];

  /** 专家团场景(rosters-user.json) */
  rosters: RosterDef[];
  /** 项目级自定义专家 */
  customAgents: CustomAgent[];

  /** 筛选状态 */
  search: string;
  division: string | null;

  load: () => Promise<void>;
  loadSimpleAiAgents: () => Promise<void>;
  loadRosters: () => Promise<void>;
  loadCustomAgents: () => Promise<void>;
  saveCustom: (params: {
    slug: string;
    name: string;
    description: string;
    emoji: string;
    systemPrompt: string;
    tools?: string[];
  }) => Promise<void>;
  deleteCustom: (slug: string) => Promise<void>;
  setSearch: (q: string) => void;
  setDivision: (d: string | null) => void;
  /** 应用当前筛选后的列表 */
  filtered: () => AgentCatalogEntry[];
}

/** 把 CustomAgent 映射为派生 catalog 条目 */
function toCatalogEntry(c: CustomAgent): AgentCatalogEntry {
  return {
    slug: c.slug,
    name: c.name,
    description: c.description,
    emoji: c.emoji ?? '',
    color: '',
    division: 'custom',
  };
}

export const useAgentStore = create<AgentState>()((set, get) => ({
  catalog: [],
  loading: false,
  loaded: false,
  error: null,
  simpleAiAgents: [],
  rosters: [],
  customAgents: [],
  search: '',
  division: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    // 专家全局存储:启动即可加载,无需 workspace
    await get().loadCustomAgents();
    set({ loading: false, loaded: true });
  },

  loadSimpleAiAgents: async () => {
    try {
      const agents = await invoke<SimpleAiAgentItem[]>('simple_ai_list_agents');
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

  loadCustomAgents: async () => {
    try {
      const customAgents = await listCustomAgents();
      set({ customAgents, catalog: customAgents.map(toCatalogEntry), loaded: true });
    } catch (err) {
      log.warn('Custom agents load failed', { error: String(err) });
    }
  },

  saveCustom: async (params) => {
    await saveCustomAgent(params);
    await get().loadCustomAgents();
  },

  deleteCustom: async (slug) => {
    await deleteCustomAgent(slug);
    await get().loadCustomAgents();
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
