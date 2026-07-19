import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentStore } from './agentStore';
import type { AgentCatalogEntry } from '@/types/agent';

vi.mock('@/services/tauri/agentCorpusService', () => ({
  getAgentCatalog: vi.fn().mockResolvedValue([
    { slug: 'engineering-frontend-developer', name: '前端开发者', description: 'React/Vue UI 实现', emoji: '🖥️', color: 'cyan', division: 'engineering' },
    { slug: 'marketing-xiaohongshu-operator', name: '小红书运营专家', description: '种草笔记创作', emoji: '📕', color: '#FF2442', division: 'marketing' },
    { slug: 'testing-evidence-collector', name: '证据收集官', description: 'QA 验收验证', emoji: '🧪', color: 'amber', division: 'testing' },
  ] satisfies AgentCatalogEntry[]),
  getCorpusStatus: vi.fn().mockResolvedValue({
    installedVersion: 1,
    bundledVersion: 1,
    installedCount: 3,
    bundledCount: 3,
    installDir: '/data/agents',
  }),
}));

vi.mock('@/services/transport', () => ({
  invoke: vi.fn().mockResolvedValue({
    divisions: { engineering: { label: 'Engineering', icon: 'Code', color: '#3B82F6' } },
  }),
}));

describe('agentStore', () => {
  beforeEach(() => {
    useAgentStore.setState({
      catalog: [],
      divisions: {},
      status: null,
      loading: false,
      loaded: false,
      error: null,
      search: '',
      division: null,
    });
  });

  it('loads catalog, divisions and status', async () => {
    await useAgentStore.getState().load();
    const s = useAgentStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.catalog).toHaveLength(3);
    expect(s.divisions.engineering.label).toBe('Engineering');
    expect(s.status?.installedCount).toBe(3);
  });

  it('filters by division and search (name/slug/description)', async () => {
    await useAgentStore.getState().load();

    useAgentStore.getState().setDivision('marketing');
    expect(useAgentStore.getState().filtered().map((a) => a.slug)).toEqual([
      'marketing-xiaohongshu-operator',
    ]);

    useAgentStore.getState().setDivision(null);
    useAgentStore.getState().setSearch('种草');
    expect(useAgentStore.getState().filtered()).toHaveLength(1);

    useAgentStore.getState().setSearch('EVIDENCE');
    expect(useAgentStore.getState().filtered().map((a) => a.slug)).toEqual([
      'testing-evidence-collector',
    ]);

    useAgentStore.getState().setSearch('不存在的专家');
    expect(useAgentStore.getState().filtered()).toHaveLength(0);
  });
});
