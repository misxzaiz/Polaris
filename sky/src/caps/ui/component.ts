/**
 * cap.ui.component — 组件层(AI 增/删/改 UI 组件, 含自定义 HTML 挂载)
 *
 * 动作: list/get/add/update/remove/mount/schema
 * 操作 UIState.components 数组
 */

import type { Capability, Value } from '../../contracts.ts';
import { getUiState, setUiState, type UIComponent } from './state.ts';

// 内置组件类型 schema (供 AI 了解 props)
const SCHEMAS: Record<string, Record<string, unknown>> = {
  'caps-list': { props: {} },
  'chat': { props: { sessionId: 'string' } },
  'config': { props: {} },
  // custom: AI 注入的组件.
  //   html — 静态 HTML 骨架
  //   css  — 组件私有 CSS, 会被自动作用域限定在组件容器内
  //   js   — 组件脚本, 形如 (root, __sky) => {...}. root 是组件根元素.
  //          __sky 提供: dispatch(capId, params) / state() / on(fn) / page() / switchPage(id) / addMsg(cls, text)
  //   更新 props 后自动热生效, 无需重启.
  'custom': {
    props: { html: 'string', css: 'string?', js: 'string? (function body, ctx: (root, __sky))' },
    runtime: {
      '__sky.dispatch': '(capId, params) => Promise<data>',
      '__sky.state': '() => UIState snapshot',
      '__sky.on': '(fn) => unsubscribe()',
      '__sky.page': '() => active page id',
      '__sky.switchPage': '(id) => void',
      '__sky.addMsg': '(cls, text) => void',
    },
  },
  'audit-panel': { props: { limit: 'number?' } },
  'message': { props: { text: 'string', role: 'string?' } },
};

// mountPoint → 目标页面 (AI 决定组件落在哪一栏)
export const MOUNT_POINTS: Record<string, string> = {
  sidebar: 'page-sessions', sessions: 'page-sessions',
  main: 'page-chat', chat: 'page-chat', top: 'page-chat', bottom: 'page-chat',
  right: 'page-settings', caps: 'page-caps', settings: 'page-settings',
};

export const uiComponentCap: Capability = {
  id: 'cap.ui.component',
  description: 'UI components. Actions: list/get/add/update/remove/mount/schema. AI can add custom HTML.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'add', 'update', 'remove', 'mount', 'schema'] },
      id: { type: 'string', description: 'Component id' },
      component: { type: 'object', description: 'UIComponent (for add)' },
      props: { type: 'object', description: 'Props patch (for update)' },
      type: { type: 'string', description: 'Component type (for add/schema)' },
      mountPoint: { type: 'string', description: 'Region id to mount in (for add/mount)' },
      html: { type: 'string', description: 'HTML for mount (custom)' },
      css: { type: 'string', description: 'CSS for mount (custom)' },
    },
    required: ['action'],
  },
  async invoke(params: Value) {
    const p = params as {
      action: 'list' | 'get' | 'add' | 'update' | 'remove' | 'mount' | 'schema';
      id?: string; component?: UIComponent; props?: Record<string, unknown>;
      type?: string; mountPoint?: string; html?: string; css?: string;
    };
    const state = getUiState();
    switch (p.action) {
      case 'list':
        return { ok: true, components: state.components };
      case 'get': {
        if (!p.id) throw new Error('id required for get');
        const c = state.components.find(c => c.id === p.id);
        if (!c) return { ok: false, notFound: true };
        return { ok: true, component: c };
      }
      case 'add': {
        if (!p.component) throw new Error('component required for add');
        if (state.components.some(c => c.id === p.component!.id)) {
          return { ok: false, error: `component already exists: ${p.component.id}` };
        }
        setUiState({ ...state, components: [...state.components, p.component] });
        return { ok: true, added: p.component.id };
      }
      case 'update': {
        if (!p.id || !p.props) throw new Error('id + props required for update');
        let updated = false;
        const newComps = state.components.map(c => {
          if (c.id === p.id) { updated = true; return { ...c, props: { ...c.props, ...p.props } }; }
          return c;
        });
        if (!updated) return { ok: false, error: 'component not found' };
        setUiState({ ...state, components: newComps });
        return { ok: true, updated: p.id };
      }
      case 'remove': {
        if (!p.id) throw new Error('id required for remove');
        const before = state.components.length;
        setUiState({ ...state, components: state.components.filter(c => c.id !== p.id) });
        return { ok: true, removed: before - state.components.length + 1 > 0 ? 1 : 0 };
      }
      case 'mount': {
        // 挂载自定义 HTML 片段
        if (!p.id || !p.html) throw new Error('id + html required for mount');
        if (!p.mountPoint) throw new Error('mountPoint required for mount');
        const comp: UIComponent = {
          id: p.id, type: 'custom', mountPoint: p.mountPoint,
          props: { html: p.html, css: p.css ?? '' },
        };
        if (state.components.some(c => c.id === p.id)) {
          const newComps = state.components.map(c => c.id === p.id ? comp : c);
          setUiState({ ...state, components: newComps });
          return { ok: true, mounted: p.id, mode: 'replace' };
        }
        setUiState({ ...state, components: [...state.components, comp] });
        return { ok: true, mounted: p.id, mode: 'add' };
      }
      case 'schema': {
        if (p.type) {
          return {
            ok: true, type: p.type,
            schema: SCHEMAS[p.type] ?? { unknown: true },
            mountPoints: MOUNT_POINTS,
          };
        }
        return { ok: true, types: Object.keys(SCHEMAS), schemas: SCHEMAS, mountPoints: MOUNT_POINTS };
      }
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};
