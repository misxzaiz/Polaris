/**
 * UI State — 前端响应式状态模型
 *
 * 整个 UI 由一个 JSON 对象描述, AI 改状态 → WS 推 ui.update → 前端重渲染.
 *
 * 四层:
 * - theme: 设计 token (colors/spacing/typography/shadows/radii)
 * - layout: 区域树 (grid 结构)
 * - components: 组件列表 (id + type + props + mountPoint)
 * - styles: 注入的 CSS 规则 (id + selector + properties)
 *
 * 持久化: 经 cap.kv(domain=ui) 存储, 重启保留.
 */

import type { Value } from '../../contracts.ts';
import { db } from '../../storage.ts';

// ============================================================================
// 类型
// ============================================================================

export interface ThemeTokens {
  colors: Record<string, string>;
  spacing: Record<string, string>;
  typography: Record<string, string>;
  shadows: Record<string, string>;
  radii: Record<string, string>;
}

export interface LayoutRegion {
  id: string;
  type: 'panel' | 'main' | 'side' | 'header' | 'footer';
  children?: LayoutRegion[];
  props?: Record<string, unknown>;
}

export interface UIComponent {
  id: string;
  type: string;              // 'chat' | 'caps-list' | 'config' | 'custom' | ...
  mountPoint: string;        // region id
  props: Record<string, unknown>;
}

export interface UIStyleRule {
  id: string;
  selector: string;
  properties: Record<string, string>;
}

export interface UIState {
  theme: ThemeTokens;
  layout: LayoutRegion;
  components: UIComponent[];
  styles: UIStyleRule[];
}

// ============================================================================
// 默认主题 + 布局
// ============================================================================

export const DEFAULT_THEME: ThemeTokens = {
  colors: {
    bg: '#0d1117',
    bgElevated: '#161b22',
    bgInput: '#0d1117',
    border: '#21262d',
    text: '#c9d1d9',
    textMuted: '#8b949e',
    primary: '#1f6feb',
    success: '#238636',
    warning: '#f0883e',
    danger: '#f85149',
    accent: '#58a6ff',
  },
  spacing: {
    xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px',
  },
  typography: {
    font: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: 'ui-monospace, "Cascadia Code", monospace',
    size: '14px',
    sizeSm: '12px',
    sizeLg: '16px',
    lineHeight: '1.5',
  },
  shadows: {
    sm: '0 1px 2px rgba(0,0,0,0.3)',
    md: '0 3px 8px rgba(0,0,0,0.4)',
  },
  radii: {
    sm: '4px', md: '6px', lg: '8px',
  },
};

export const DEFAULT_LAYOUT: LayoutRegion = {
  id: 'root',
  type: 'main',
  children: [
    { id: 'sidebar', type: 'side', props: { width: '240px' } },
    { id: 'main', type: 'main' },
    { id: 'right', type: 'side', props: { width: '320px' } },
  ],
};

export const DEFAULT_COMPONENTS: UIComponent[] = [
  { id: 'caps-list', type: 'caps-list', mountPoint: 'sidebar', props: {} },
  { id: 'chat', type: 'chat', mountPoint: 'main', props: {} },
  { id: 'config', type: 'config', mountPoint: 'right', props: {} },
];

export const DEFAULT_UI_STATE: UIState = {
  theme: DEFAULT_THEME,
  layout: DEFAULT_LAYOUT,
  components: DEFAULT_COMPONENTS,
  styles: [],
};

// ============================================================================
// 持久化 (经 cap.kv domain=ui)
// ============================================================================

let _state: UIState = structuredClone(DEFAULT_UI_STATE);
let _emit: ((state: UIState) => void) | null = null;
let _initialized = false;

export function initUiState(): void {
  if (_initialized) return;
  _initialized = true;
  // 从 kv 读
  try {
    const row = db.prepare('SELECT value FROM kv WHERE domain=? AND key=?').get('ui', 'state') as { value: string } | undefined;
    if (row) {
      const saved = JSON.parse(row.value) as Partial<UIState>;
      _state = {
        theme: { ...DEFAULT_THEME, ...saved.theme },
        layout: saved.layout ?? DEFAULT_LAYOUT,
        components: saved.components ?? DEFAULT_COMPONENTS,
        styles: saved.styles ?? [],
      };
      console.log('[ui] state restored from storage');
    } else {
      _state = structuredClone(DEFAULT_UI_STATE);
    }
  } catch {
    _state = structuredClone(DEFAULT_UI_STATE);
  }
}

export function getUiState(): UIState {
  return _state;
}

export function setUiState(state: UIState): void {
  _state = state;
  persist();
  if (_emit) _emit(_state);
}

export function patchUiState(patch: Partial<UIState>): UIState {
  _state = {
    theme: patch.theme ?? _state.theme,
    layout: patch.layout ?? _state.layout,
    components: patch.components ?? _state.components,
    styles: patch.styles ?? _state.styles,
  };
  persist();
  if (_emit) _emit(_state);
  return _state;
}

export function setUiEmitter(fn: (state: UIState) => void): void {
  _emit = fn;
}

function persist(): void {
  try {
    db.prepare('INSERT OR REPLACE INTO kv(domain, key, value, updated_at) VALUES(?, ?, ?, ?)')
      .run('ui', 'state', JSON.stringify(_state), Date.now());
  } catch (e) {
    console.error('[ui] persist failed:', e);
  }
}

// ============================================================================
// 快照 (cap.ui.snapshot 用)
// ============================================================================

interface Snapshot {
  id: string;
  ts: number;
  state: UIState;
  label?: string;
}

const snapshots = new Map<string, Snapshot>();

export function saveSnapshot(label?: string): string {
  const id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  snapshots.set(id, { id, ts: Date.now(), state: structuredClone(_state), label });
  return id;
}

export function restoreSnapshot(id: string): boolean {
  const snap = snapshots.get(id);
  if (!snap) return false;
  _state = structuredClone(snap.state);
  persist();
  if (_emit) _emit(_state);
  return true;
}

export function listSnapshots(): Array<{ id: string; ts: number; label?: string }> {
  return [...snapshots.values()].map(s => ({ id: s.id, ts: s.ts, label: s.label }));
}

export function diffSnapshots(idA: string, idB: string): { hasA: boolean; hasB: boolean; diff: string } {
  const a = snapshots.get(idA);
  const b = snapshots.get(idB);
  if (!a || !b) return { hasA: !!a, hasB: !!b, diff: 'snapshot not found' };
  // 简化 diff: JSON 长度对比
  const sa = JSON.stringify(a.state);
  const sb = JSON.stringify(b.state);
  return { hasA: true, hasB: true, diff: sa === sb ? 'identical' : `differ (a:${sa.length}b vs b:${sb.length}b)` };
}
