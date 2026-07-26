import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentStore, type AgentCatalogEntry } from './agentStore';
import type { CustomAgent } from '@/services/tauri/agentCorpusService';

vi.mock('@/services/tauri/agentCorpusService', () => ({
  getRosters: vi.fn().mockResolvedValue([]),
  listCustomAgents: vi.fn().mockResolvedValue([
    { slug: 'frontend-dev', name: '前端开发者', description: 'React/Vue UI 实现', emoji: '🖥️', systemPrompt: '', filePath: '', tools: [] },
    { slug: 'xiaohongshu-operator', name: '小红书运营专家', description: '种草笔记创作', emoji: '📕', systemPrompt: '', filePath: '', tools: [] },
    { slug: 'evidence-collector', name: '证据收集官', description: 'QA 验收验证', emoji: '🧪', systemPrompt: '', filePath: '', tools: [] },
  ] satisfies CustomAgent[]),
  saveCustomAgent: vi.fn().mockResolvedValue('/path'),
  deleteCustomAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/transport', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

describe('agentStore', () => {
  beforeEach(() => {
    useAgentStore.setState({
      catalog: [],
      loading: false,
      loaded: false,
      error: null,
      search: '',
      division: null,
    });
  });

  it('load() sets loaded flag (catalog derived from customAgents via loadCustomAgents)', async () => {
    await useAgentStore.getState().load();
    const s = useAgentStore.getState();
    expect(s.loaded).toBe(true);
  });

  it('loadCustomAgents populates catalog (derived view) and customAgents', async () => {
    await useAgentStore.getState().loadCustomAgents('/proj');
    const s = useAgentStore.getState();
    expect(s.customAgents).toHaveLength(3);
    expect(s.catalog).toHaveLength(3);
    // 派生条目 division 为 'custom'
    expect(s.catalog.every((c: AgentCatalogEntry) => c.division === 'custom')).toBe(true);
  });

  it('filters by search (name/slug/description) on derived catalog', async () => {
    await useAgentStore.getState().loadCustomAgents('/proj');

    useAgentStore.getState().setSearch('种草');
    expect(useAgentStore.getState().filtered()).toHaveLength(1);

    useAgentStore.getState().setSearch('EVIDENCE');
    expect(useAgentStore.getState().filtered().map((a) => a.slug)).toEqual([
      'evidence-collector',
    ]);

    useAgentStore.getState().setSearch('不存在的专家');
    expect(useAgentStore.getState().filtered()).toHaveLength(0);
  });
});
