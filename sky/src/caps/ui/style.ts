/**
 * cap.ui.style — 样式原子操作(AI 注入/改任意 CSS)
 *
 * 动作: get/set/patch/remove/inject/list/clear
 * 操作 UIState.styles 数组(每条 = selector + properties)
 */

import type { Capability, Value } from '../../contracts.ts';
import { getUiState, setUiState } from './state.ts';

let _idSeq = 0;
function newId(): string { return `style-${++_idSeq}-${Date.now().toString(36)}`; }

export const uiStyleCap: Capability = {
  id: 'cap.ui.style',
  description: 'UI style atoms. Inject/modify CSS rules. Actions: get/set/patch/remove/inject/list/clear.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set', 'patch', 'remove', 'inject', 'list', 'clear'] },
      selector: { type: 'string', description: 'CSS selector (for set/patch/get)' },
      properties: { type: 'object', description: 'CSS properties as {prop: value}' },
      ruleId: { type: 'string', description: 'Rule id (for remove)' },
      css: { type: 'string', description: 'Raw CSS text (for inject)' },
    },
    required: ['action'],
  },
  async invoke(params: Value) {
    const p = params as {
      action: 'get' | 'set' | 'patch' | 'remove' | 'inject' | 'list' | 'clear';
      selector?: string; properties?: Record<string, string>;
      ruleId?: string; css?: string;
    };
    const state = getUiState();
    switch (p.action) {
      case 'list':
        return { ok: true, rules: state.styles };
      case 'get': {
        if (!p.selector) throw new Error('selector required for get');
        const found = state.styles.filter(r => r.selector === p.selector);
        return { ok: true, rules: found };
      }
      case 'set': {
        if (!p.selector || !p.properties) throw new Error('selector + properties required for set');
        const others = state.styles.filter(r => r.selector !== p.selector);
        const newRules = [...others, { id: newId(), selector: p.selector, properties: p.properties }];
        setUiState({ ...state, styles: newRules });
        return { ok: true, applied: 1, selector: p.selector };
      }
      case 'patch': {
        if (!p.selector || !p.properties) throw new Error('selector + properties required for patch');
        let patched = 0;
        const newRules = state.styles.map(r => {
          if (r.selector === p.selector) {
            patched++;
            return { ...r, properties: { ...r.properties, ...p.properties } };
          }
          return r;
        });
        if (patched === 0) {
          newRules.push({ id: newId(), selector: p.selector, properties: p.properties });
          patched = 1;
        }
        setUiState({ ...state, styles: newRules });
        return { ok: true, patched, selector: p.selector };
      }
      case 'remove': {
        if (!p.ruleId && !p.selector) throw new Error('ruleId or selector required for remove');
        const before = state.styles.length;
        const newRules = state.styles.filter(r =>
          (p.ruleId && r.id !== p.ruleId) || (p.selector && r.selector !== p.selector));
        setUiState({ ...state, styles: newRules });
        return { ok: true, removed: before - newRules.length };
      }
      case 'inject': {
        if (!p.css) throw new Error('css required for inject');
        // 解析简单 CSS (selector { props }) — 不完美但够用
        const rules = parseSimpleCss(p.css);
        const newRules = [...state.styles, ...rules.map(r => ({ id: newId(), ...r }))];
        setUiState({ ...state, styles: newRules });
        return { ok: true, injected: rules.length };
      }
      case 'clear': {
        const before = state.styles.length;
        setUiState({ ...state, styles: [] });
        return { ok: true, cleared: before };
      }
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};

// 简单 CSS 解析: "selector { prop: value; }"
function parseSimpleCss(css: string): Array<{ selector: string; properties: Record<string, string> }> {
  const out: Array<{ selector: string; properties: Record<string, string> }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim();
    if (!selector) continue;
    const props: Record<string, string> = {};
    for (const decl of m[2].split(';')) {
      const idx = decl.indexOf(':');
      if (idx > 0) {
        const k = decl.slice(0, idx).trim();
        const v = decl.slice(idx + 1).trim();
        if (k) props[k] = v;
      }
    }
    if (Object.keys(props).length) out.push({ selector, properties: props });
  }
  return out;
}
