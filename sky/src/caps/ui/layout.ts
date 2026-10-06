/**
 * cap.ui.layout — 布局结构(AI 改区域树)
 *
 * 动作: get/set/add/remove/move
 * 操作 UIState.layout (区域树)
 */

import type { Capability, Value } from '../../contracts.ts';
import { getUiState, setUiState, type LayoutRegion } from './state.ts';

export const uiLayoutCap: Capability = {
  id: 'cap.ui.layout',
  description: 'UI layout tree. Actions: get/set/add/remove/move. Restructure regions.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set', 'add', 'remove', 'move'] },
      layout: { type: 'object', description: 'Full LayoutRegion (for set)' },
      region: { type: 'object', description: 'LayoutRegion to add' },
      regionId: { type: 'string', description: 'Region id (for remove/move)' },
      parentId: { type: 'string', description: 'Parent region id (for add/move)' },
      index: { type: 'number', description: 'Position index (for move)' },
    },
    required: ['action'],
  },
  async invoke(params: Value) {
    const p = params as {
      action: 'get' | 'set' | 'add' | 'remove' | 'move';
      layout?: LayoutRegion; region?: LayoutRegion;
      regionId?: string; parentId?: string; index?: number;
    };
    const state = getUiState();
    switch (p.action) {
      case 'get':
        return { ok: true, layout: state.layout };
      case 'set':
        if (!p.layout) throw new Error('layout required for set');
        setUiState({ ...state, layout: p.layout });
        return { ok: true, applied: 'set' };
      case 'add': {
        if (!p.region) throw new Error('region required for add');
        if (!p.parentId) throw new Error('parentId required for add');
        const newLayout = addRegion(state.layout, p.parentId, p.region);
        if (!newLayout) return { ok: false, error: 'parent not found' };
        setUiState({ ...state, layout: newLayout });
        return { ok: true, added: p.region.id, parent: p.parentId };
      }
      case 'remove': {
        if (!p.regionId) throw new Error('regionId required for remove');
        if (p.regionId === 'root') return { ok: false, error: 'cannot remove root' };
        const newLayout = removeRegion(state.layout, p.regionId);
        if (!newLayout) return { ok: false, error: 'region not found' };
        setUiState({ ...state, layout: newLayout });
        return { ok: true, removed: p.regionId };
      }
      case 'move': {
        if (!p.regionId || !p.parentId) throw new Error('regionId + parentId required for move');
        const region = findRegion(state.layout, p.regionId);
        if (!region) return { ok: false, error: 'region not found' };
        const without = removeRegion(state.layout, p.regionId);
        if (!without) return { ok: false, error: 'remove failed' };
        const newLayout = addRegion(without, p.parentId, region);
        if (!newLayout) return { ok: false, error: 'target parent not found' };
        setUiState({ ...state, layout: newLayout });
        return { ok: true, moved: p.regionId, to: p.parentId };
      }
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};

function findRegion(node: LayoutRegion, id: string): LayoutRegion | null {
  if (node.id === id) return node;
  if (!node.children) return null;
  for (const c of node.children) {
    const found = findRegion(c, id);
    if (found) return found;
  }
  return null;
}

function addRegion(node: LayoutRegion, parentId: string, region: LayoutRegion): LayoutRegion | null {
  if (node.id === parentId) {
    return { ...node, children: [...(node.children ?? []), region] };
  }
  if (!node.children) return null;
  const newChildren: LayoutRegion[] = [];
  let added = false;
  for (const c of node.children) {
    const result = addRegion(c, parentId, region);
    if (result) { newChildren.push(result); added = true; }
    else newChildren.push(c);
  }
  return added ? { ...node, children: newChildren } : null;
}

function removeRegion(node: LayoutRegion, id: string): LayoutRegion | null {
  if (node.id === id) return null; // 根节点不会到这里(调用方已挡)
  if (!node.children) return node;
  const newChildren = node.children
    .map(c => removeRegion(c, id))
    .filter((c): c is LayoutRegion => c !== null);
  return { ...node, children: newChildren };
}
