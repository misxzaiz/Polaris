/**
 * cap.ui.snapshot — UI 状态快照(演进回滚)
 *
 * 动作: save/restore/list/diff/clear
 * 保存当前 UIState, 出错可回滚
 */

import type { Capability, Value } from '../../contracts.ts';
import { saveSnapshot, restoreSnapshot, listSnapshots, diffSnapshots } from './state.ts';

export const uiSnapshotCap: Capability = {
  id: 'cap.ui.snapshot',
  description: 'UI state snapshots for evolution rollback. Actions: save/restore/list/diff/clear.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['save', 'restore', 'list', 'diff', 'clear'] },
      label: { type: 'string', description: 'Snapshot label (for save)' },
      id: { type: 'string', description: 'Snapshot id (for restore)' },
      idA: { type: 'string', description: 'First snapshot id (for diff)' },
      idB: { type: 'string', description: 'Second snapshot id (for diff)' },
    },
    required: ['action'],
  },
  async invoke(params: Value) {
    const p = params as {
      action: 'save' | 'restore' | 'list' | 'diff' | 'clear';
      label?: string; id?: string; idA?: string; idB?: string;
    };
    switch (p.action) {
      case 'save': {
        const id = saveSnapshot(p.label);
        return { ok: true, id, saved: true };
      }
      case 'restore': {
        if (!p.id) throw new Error('id required for restore');
        const ok = restoreSnapshot(p.id);
        return { ok, restored: ok };
      }
      case 'list':
        return { ok: true, snapshots: listSnapshots() };
      case 'diff': {
        if (!p.idA || !p.idB) throw new Error('idA + idB required for diff');
        return { ok: true, ...diffSnapshots(p.idA, p.idB) };
      }
      case 'clear':
        // 简化: 清空需逐个删 (snapshot 模块未导出 clearAll, 这里返回提示)
        return { ok: false, error: 'clear not yet implemented, use restore to rollback' };
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};
