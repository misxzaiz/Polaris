/**
 * cap.ui.window — AI 悬浮窗管理
 *
 * AI 在对话里渲染"页面"的窗口形态:
 * - open {title, width?, height?, html, css?, js?} → {id}; 经 EventBus 推
 *   ui.window 事件, Shell 按断点呈现: ≤640px 底部抽屉(sheet) / 桌面悬浮窗
 * - close {id} / list
 *
 * js 与 cap.ui.component 同一 __sky 沙箱 (dispatch/close/toast 可用)。
 * 窗口是临时态 (不持久化, 刷新即关) — 原型边界, 持久化在路线图。
 */

import type { Capability, Value } from '../../contracts.ts';
import type { EventBus } from '../../server/eventbus.ts';

export function createUiWindowCap(bus: EventBus): Capability {
  return {
    id: 'cap.ui.window',
    description: 'Floating window for AI-rendered pages. Actions: open/close. ' +
      'open {title, html, css?, js?, width?, height?} → {id}. Shell renders desktop floating window / ' +
      'mobile bottom sheet automatically. js runs in __sky sandbox ({dispatch, close, toast}). ' +
      'Use for: file trees, previews, forms, dashboards — anything bigger than an inline chat card.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'close'] },
        title: { type: 'string', description: 'open: window title' },
        html: { type: 'string', description: 'open: window body HTML' },
        css: { type: 'string', description: 'open: scoped CSS' },
        js: { type: 'string', description: 'open: js executed with __sky={dispatch,close,toast}' },
        width: { type: 'number', description: 'open: desktop width px, default 420' },
        height: { type: 'number', description: 'open: desktop height px, default 480' },
        id: { type: 'string', description: 'close: window id' },
      },
      required: ['action'],
    },
    async invoke(params: Value) {
      const p = params as {
        action: 'open' | 'close';
        title?: string; html?: string; css?: string; js?: string;
        width?: number; height?: number; id?: string;
      };
      switch (p.action) {
        case 'open': {
          if (!p.title || typeof p.title !== 'string') throw new Error('title required for open');
          if (typeof p.html !== 'string') throw new Error('html required for open');
          const id = 'win-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
          bus.emit({
            type: 'ui.window',
            data: { action: 'open', id, title: p.title.slice(0, 60), width: p.width, height: p.height, html: p.html, css: p.css ?? '', js: p.js ?? '' },
            ts: Date.now(),
          });
          return { ok: true, id };
        }
        case 'close': {
          if (!p.id) throw new Error('id required for close');
          bus.emit({ type: 'ui.window', data: { action: 'close', id: p.id }, ts: Date.now() });
          return { ok: true, closed: p.id };
        }
        default:
          throw new Error(`unknown action: ${(p as { action: string }).action}`);
      }
    },
  };
}
