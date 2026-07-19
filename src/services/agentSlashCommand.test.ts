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
  it('rewrites when first token is a known slug', () => {
    const r = rewriteDispatchPromptWithAgent(
      'engineering-frontend-developer 实现结算页表单',
      CATALOG,
      'D:/data/agents',
    );
    expect(r).not.toBeNull();
    expect(r!.prompt).toContain('前端开发者');
    expect(r!.prompt).toContain('D:/data/agents/corpus/engineering-frontend-developer.md');
    expect(r!.prompt).toContain('实现结算页表单');
    expect(r!.title).toContain('前端开发者');
  });

  it('falls back to description when installDir unknown', () => {
    const r = rewriteDispatchPromptWithAgent(
      'engineering-frontend-developer 做点事',
      CATALOG,
      null,
    );
    expect(r!.prompt).toContain('React/Vue UI 实现');
    expect(r!.prompt).not.toContain('corpus/');
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
