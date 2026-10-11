/**
 * useWorkspaceSessionSync 派生逻辑单测 — 核心去重/派生的纯函数保护
 *
 * 覆盖 S3「UI 会话列表跨端同步」最后一环的关键约束：
 * 1. 本地会话优先，全部展示；
 * 2. 桶投影里「本地无 store 实例」的会话 → 构造为远端可恢复条目；
 * 3. 同 id 去重（已本地打开的会话绝不重复出现）；
 * 4. 远端条目 title/engine/status/时间字段透传。
 */

import { describe, it, expect } from 'vitest';
import { deriveRemoteSessions } from './useWorkspaceSessionSync';
import type { SessionMetadata } from '@/stores/conversationStore/types';

function meta(id: string, overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id,
    title: `会话 ${id}`,
    type: 'project',
    engineId: 'claude-code',
    workspaceId: 'ws-1',
    contextWorkspaceIds: [],
    status: 'idle',
    createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T01:00:00.000Z',
    ...overrides,
  };
}

describe('deriveRemoteSessions', () => {
  it('桶为空 → 返回空列表', () => {
    expect(deriveRemoteSessions(null, new Set(), [])).toEqual([]);
    expect(deriveRemoteSessions(undefined, new Set(), [])).toEqual([]);
    expect(deriveRemoteSessions(new Map(), new Set(), [])).toEqual([]);
  });

  it('桶投影中的会话全部为远端（本地无实例）→ 全部作为可恢复条目', () => {
    const bucket = new Map<string, SessionMetadata>([
      ['r1', meta('r1', { title: '远端会话A' })],
      ['r2', meta('r2', { title: '远端会话B' })],
    ]);
    const remote = deriveRemoteSessions(bucket, new Set(), []);
    expect(remote).toHaveLength(2);
    expect(remote.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(remote.every((r) => r.remote === true)).toBe(true);
    expect(remote[0].title).toBe('远端会话A');
  });

  it('本地已打开的会话（有 store 实例）→ 跳过，不产生重复条目', () => {
    const bucket = new Map<string, SessionMetadata>([
      ['local', meta('local')],
      ['remote', meta('remote', { title: '真远端' })],
    ]);
    const localStores = new Set(['local']);
    const remote = deriveRemoteSessions(bucket, localStores, []);
    expect(remote).toHaveLength(1);
    expect(remote[0].id).toBe('remote');
  });

  it('本地 sessionMetadata 已列出（无 store 但 localSessions 有）→ 跳过', () => {
    const bucket = new Map<string, SessionMetadata>([
      ['s1', meta('s1')],
      ['s2', meta('s2')],
    ]);
    const localSessions = [meta('s1')];
    const remote = deriveRemoteSessions(bucket, new Set(), localSessions);
    expect(remote).toHaveLength(1);
    expect(remote[0].id).toBe('s2');
  });

  it('元数据字段透传：engineId/status/updatedAt/workspaceId', () => {
    const bucket = new Map<string, SessionMetadata>([
      ['r1', meta('r1', { engineId: 'mimo', status: 'running', workspaceId: 'ws-9' })],
    ]);
    const [ref] = deriveRemoteSessions(bucket, new Set(), []);
    expect(ref.engineId).toBe('mimo');
    expect(ref.status).toBe('running');
    expect(ref.workspaceId).toBe('ws-9');
    expect(ref.updatedAt).toBe('2026-10-11T01:00:00.000Z');
  });

  it('无标题 → 默认占位「远端会话」', () => {
    const bucket = new Map<string, SessionMetadata>([['r1', meta('r1', { title: '' })]]);
    const [ref] = deriveRemoteSessions(bucket, new Set(), []);
    expect(ref.title).toBe('远端会话');
  });

  it('restore 后（本地出现实例）→ 远端条目消失（恢复闭环）', () => {
    const bucket = new Map<string, SessionMetadata>([['r1', meta('r1')]]);
    // 恢复前：r1 是远端
    expect(deriveRemoteSessions(bucket, new Set(), [])).toHaveLength(1);
    // 恢复后：localStores 有了 r1 → 不再是远端
    expect(deriveRemoteSessions(bucket, new Set(['r1']), [])).toHaveLength(0);
  });

  it('localStores 支持 Map<string, unknown>（sessionStoreManager.stores 实际类型）', () => {
    const bucket = new Map<string, SessionMetadata>([
      ['local', meta('local')],
      ['remote', meta('remote')],
    ]);
    const localStores = new Map<string, unknown>([
      ['local', {} as unknown],
    ]);
    const remote = deriveRemoteSessions(bucket, localStores, []);
    expect(remote).toHaveLength(1);
    expect(remote[0].id).toBe('remote');
  });

  it('本端视口 multiSessionIds 内的会话即使无 store 实例也不判为远端（本端历史视口去误判）', () => {
    const bucket = new Map<string, SessionMetadata>([
      ['view-only', meta('view-only')],      // 本端视口引用但无活跃 store
      ['true-remote', meta('true-remote')],  // 真·其他窗口
    ]);
    // 无 localStores、无 localSessions——仅 viewIds 排除了 view-only
    const remote = deriveRemoteSessions(
      bucket,
      new Set(),
      [],
      new Set(['view-only']),
    );
    expect(remote).toHaveLength(1);
    expect(remote[0].id).toBe('true-remote');
  });

  it('viewIds 支持普通数组形式（useMergedSessionList 传入 multiSessionIds）', () => {
    const bucket = new Map<string, SessionMetadata>([
      ['v-a', meta('v-a')],
      ['v-b', meta('v-b')],
    ]);
    const remote = deriveRemoteSessions(bucket, new Set(), [], ['v-a']);
    expect(remote).toHaveLength(1);
    expect(remote[0].id).toBe('v-b');
  });

  it('桶已认领（claimedIds）的会话即使无 store 实例也不判为远端', () => {
    const bucket = new Map<string, SessionMetadata>([
      ['claimed', meta('claimed')],
      ['remote', meta('remote')],
    ]);
    const remote = deriveRemoteSessions(
      bucket,
      new Set(),
      [],
      new Set(),
      new Set(['claimed']),
    );
    expect(remote).toHaveLength(1);
    expect(remote[0].id).toBe('remote');
  });
});
