import { describe, expect, it } from 'vitest';
import {
  parseAgentSlashCommand,
  rewriteDispatchPromptWithAgent,
} from './agentSlashCommand';
import type { AgentCatalogEntry } from '@/types/agent';

const CATALOG: AgentCatalogEntry[] = [
  {
    slug: 'engineering-frontend-developer',
    name: '前端开发者',
    description: 'React/Vue UI 实现',
    emoji: '🖥️',
    color: 'cyan',
    division: 'engineering',
  },
];

describe('parseAgentSlashCommand', () => {
  it('parses slug and bare command', () => {
    expect(parseAgentSlashCommand('/agent engineering-frontend-developer')).toEqual({
      slug: 'engineering-frontend-developer',
    });
    expect(parseAgentSlashCommand('/agent')).toEqual({ slug: null });
    expect(parseAgentSlashCommand('/agent   ')).toEqual({ slug: null });
  });

  it('rejects non-command and boundary violations', () => {
    expect(parseAgentSlashCommand('hello /agent x')).toBeNull();
    expect(parseAgentSlashCommand('/agents')).toBeNull();
    expect(parseAgentSlashCommand('/agentx foo')).toBeNull();
  });
});

describe('rewriteDispatchPromptWithAgent', () => {
  it('returns slug + pure task when first token is a known slug', () => {
    const r = rewriteDispatchPromptWithAgent(
      'engineering-frontend-developer 实现结算页表单',
      CATALOG,
      'D:/data/agents',
    );
    expect(r).not.toBeNull();
    expect(r!.slug).toBe('engineering-frontend-developer');
    // prompt 仅保留任务文本,不再内联人格/文件路径(由后端注入 system prompt)
    expect(r!.prompt).toBe('实现结算页表单');
    expect(r!.prompt).not.toContain('corpus/');
    expect(r!.title).toContain('前端开发者');
  });

  it('works without installDir (corpus slug still returned for backend injection)', () => {
    const r = rewriteDispatchPromptWithAgent(
      'engineering-frontend-developer 做点事',
      CATALOG,
      null,
    );
    expect(r!.slug).toBe('engineering-frontend-developer');
    expect(r!.prompt).toBe('做点事');
    expect(r!.systemPrompt).toBeUndefined();
  });

  it('passes through custom agent systemPrompt', () => {
    const r = rewriteDispatchPromptWithAgent(
      'my-custom-agent 干活',
      [{ slug: 'my-custom-agent', name: '自定义', description: 'd', systemPrompt: '你是自定义专家' }],
      null,
    );
    expect(r!.systemPrompt).toBe('你是自定义专家');
  });

  it('returns null for unknown slug or missing task', () => {
    expect(rewriteDispatchPromptWithAgent('unknown-slug 做事', CATALOG, null)).toBeNull();
    expect(
      rewriteDispatchPromptWithAgent('engineering-frontend-developer', CATALOG, null),
    ).toBeNull();
    expect(rewriteDispatchPromptWithAgent('修个 bug 就行', CATALOG, null)).toBeNull();
  });
});

import { parseNexusSlashCommand } from './agentSlashCommand';

describe('parseNexusSlashCommand', () => {
  it('parses scenario and goal', () => {
    expect(parseNexusSlashCommand('/nexus startup-mvp 做一个记账 App')).toEqual({
      scenario: 'startup-mvp',
      goal: '做一个记账 App',
    });
  });
  it('empty goal and non-command', () => {
    expect(parseNexusSlashCommand('/nexus startup-mvp')).toEqual({ scenario: 'startup-mvp', goal: '' });
    expect(parseNexusSlashCommand('/nexusx a b')).toBeNull();
    expect(parseNexusSlashCommand('hello')).toBeNull();
  });
});
