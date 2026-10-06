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

/**
 * 聊天渲染配置 — 用户/AI 可经 cap.ui.chat 热调整消息布局.
 * 持久化在 UIState.chat, 重启保留.
 */
export interface ChatConfig {
  /** 用户消息最大宽度 (px 或 %), 默认 '85%' */
  userMaxWidth: string;
  /** 助手消息最大宽度, 默认 '100%' (左对齐, 不限宽更易读) */
  assistantMaxWidth: string;
  /** 工具块默认折叠状态: true=只显示摘要行, false=全展开 */
  toolCollapsed: boolean;
  /** 工具结果 JSON 折叠后显示前 N 字符摘要 */
  toolSummaryLen: number;
  /** 是否启用基础 Markdown 渲染 (代码块/行内代码/粗体) */
  markdownEnabled: boolean;
  /** 消息间距 px */
  messageGap: string;
  /** 工具块样式: 'inline' | 'card' | 'sidebar' (预览仅 inline/card) */
  toolStyle: 'inline' | 'card' | 'sidebar';
  /** 字号 px */
  fontSize: number;
  /** 工具调用显示完整参数 (false=截断摘要) */
  toolShowFullArgs: boolean;
  /** 连续工具块折叠阈值: 超过此数才折叠 (对齐 Polaris collapseThreshold=5) */
  toolCollapseThreshold: number;
  /** 折叠前最多显示的工具块数 (对齐 Polaris maxVisibleBlocks=4) */
  toolMaxVisible: number;
  /** 流式结束后自动折叠本轮所有工具块 (true=只留最终文本, false=保持原状) */
  autoCollapseOnEnd: boolean;
}

export interface UIState {
  theme: ThemeTokens;
  layout: LayoutRegion;
  components: UIComponent[];
  styles: UIStyleRule[];
  chat: ChatConfig;
  /** 结构基线版本 (迁移用, 不参与渲染) */
  _v?: number;
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
  // 顺序 = 桌面 grid 的列顺序 (render() 据此派生 --desktop-cols)
  children: [
    { id: 'sessions', type: 'side', props: { width: '230px' } },
    { id: 'sidebar', type: 'side', props: { width: '240px' } },
    { id: 'main', type: 'main' },
    { id: 'right', type: 'side', props: { width: '280px' } },
  ],
};

export const DEFAULT_COMPONENTS: UIComponent[] = [
  { id: 'caps-list', type: 'caps-list', mountPoint: 'sidebar', props: {} },
  { id: 'chat', type: 'chat', mountPoint: 'main', props: {} },
  { id: 'config', type: 'config', mountPoint: 'right', props: {} },
];

export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  userMaxWidth: '85%',
  assistantMaxWidth: '100%',
  toolCollapsed: true,
  toolSummaryLen: 120,
  markdownEnabled: true,
  messageGap: '10px',
  toolStyle: 'card',
  fontSize: 15,
  toolShowFullArgs: false,
  toolCollapseThreshold: 5,
  toolMaxVisible: 4,
  autoCollapseOnEnd: true,
};

export const DEFAULT_UI_STATE: UIState = {
  theme: DEFAULT_THEME,
  layout: DEFAULT_LAYOUT,
  components: DEFAULT_COMPONENTS,
  styles: [],
  chat: DEFAULT_CHAT_CONFIG,
};

// ============================================================================
// 持久化 (经 cap.kv domain=ui)
// ============================================================================

let _state: UIState = structuredClone(DEFAULT_UI_STATE);
let _emit: ((state: UIState) => void) | null = null;
let _initialized = false;

// 结构基线版本. 修改 DEFAULT_LAYOUT / DEFAULT_COMPONENTS 时必须 +1,
// 否则旧持久化数据会让前端页面数与 layout 栏数错位.
const STATE_VERSION = 2;

// 栏的规范顺序, 必须与 shell.ts 里 .sky-page 的 DOM 顺序一致 (grid 按 DOM 顺序排列).
const REGION_ORDER: Array<{ id: string; type: LayoutRegion['type']; width: string | null }> = [
  { id: 'sessions', type: 'side', width: '230px' },
  { id: 'sidebar', type: 'side', width: '240px' },
  { id: 'main', type: 'main', width: null },
  { id: 'right', type: 'side', width: '280px' },
];

// 恢复后的结构修正: layout 与 components 是前端渲染的真相源, 二者必须自洽.
function normalizeState(state: UIState): void {
  state.layout = state.layout ?? structuredClone(DEFAULT_LAYOUT);
  const children = state.layout.children ?? [];
  const have = new Set(children.map(r => r.id));
  // 缺的栏按规范顺序补到末尾 (不重排已有项, 保留 AI 自定义的布局)
  for (const spec of REGION_ORDER) {
    if (have.has(spec.id)) continue;
    children.push({ id: spec.id, type: spec.type, props: spec.width ? { width: spec.width } : {} });
    have.add(spec.id);
  }
  // 内置组件落到固定挂载点, 避免 AI 把 config 挪进 sidebar
  const builtins: Record<string, string> = {
    'caps-list': 'sidebar', chat: 'main', config: 'right',
  };
  for (const c of state.components) {
    const want = builtins[c.id];
    if (want && c.mountPoint !== want) c.mountPoint = want;
  }
}

export function initUiState(): void {
  if (_initialized) return;
  _initialized = true;
  // 从 kv 读
  try {
    const row = db.prepare('SELECT value FROM kv WHERE domain=? AND key=?').get('ui', 'state') as { value: string } | undefined;
    if (row) {
      const saved = JSON.parse(row.value) as Partial<UIState> & { _v?: number };
      const restored: UIState = {
        theme: { ...DEFAULT_THEME, ...saved.theme },
        layout: saved.layout ?? structuredClone(DEFAULT_LAYOUT),
        components: saved.components ?? structuredClone(DEFAULT_COMPONENTS),
        styles: saved.styles ?? [],
        chat: { ...DEFAULT_CHAT_CONFIG, ...(saved.chat ?? {}) },
      };
      if ((saved as { _v?: number })._v === STATE_VERSION) {
        _state = restored;
      } else {
        // 结构可能已变: layout 用新版基线, 其余保留用户自定义
        _state = { ...restored, layout: structuredClone(DEFAULT_LAYOUT) };
        _state._v = STATE_VERSION;
        console.log('[ui] state restored with version upgrade (-> v' + STATE_VERSION + ')');
      }
      normalizeState(_state);
      persist();
    } else {
      _state = structuredClone(DEFAULT_UI_STATE);
      _state._v = STATE_VERSION;
      normalizeState(_state);
      persist();
    }
  } catch {
    _state = structuredClone(DEFAULT_UI_STATE);
    _state._v = STATE_VERSION;
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
    chat: patch.chat ? { ..._state.chat, ...patch.chat } : _state.chat,
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
