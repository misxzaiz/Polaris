/** Sky 前端 WS 事件路由 v2 — 分区增量更新 */

import type { SkyEvent } from './types.ts';
import type { SkyWs } from './api.ts';
import {
  findAssistantByStream, addFormBlock, resolveForm,
  openWindow, closeWindow, addSystemBlock, lastPendingAssistant, getState, notify,
} from './state.ts';
import { patchStreamBubble, markTopbarDirty } from './render/index.ts';

export function wireEvents(ws: SkyWs): void {
  ws.onEvent = (e: SkyEvent) => handleEvent(e);
}

function handleEvent(e: SkyEvent): void {
  const sid = e.stream_id;
  switch (e.type) {
    case 'stream.chunk': {
      if (!sid) return;
      const b = findAssistantByStream(sid) ?? lastPendingAssistant();
      if (!b) return;
      b.text = (b.text ?? '') + (e.data as string);
      patchStreamBubble(b.id); // 增量 patch,不触发全量 rerender
      break;
    }
    case 'stream.reasoning': {
      if (!sid) return;
      const b = findAssistantByStream(sid) ?? lastPendingAssistant();
      if (!b) return;
      b.reasoning = (b.reasoning ?? '') + (e.data as string);
      // 思考链不每字渲染(折叠态),省 DOM 开销
      break;
    }
    case 'stream.tool': {
      if (!sid) return;
      const b = findAssistantByStream(sid) ?? lastPendingAssistant();
      if (!b) return;
      const d = e.data as { name: string; args?: unknown };
      b.toolCalls = [...(b.toolCalls ?? []), { name: d.name, args: d.args }];
      notify(); // 工具调用需要更新折叠条
      break;
    }
    case 'stream.toolResult': {
      if (!sid) return;
      const b = findAssistantByStream(sid);
      if (!b || !b.toolCalls?.length) break;
      const d = e.data as { name: string; result: { ok: boolean; data?: unknown; error?: string } };
      b.toolCalls[b.toolCalls.length - 1].result = d.result;
      notify();
      break;
    }
    case 'stream.end': {
      if (!sid) return;
      const b = findAssistantByStream(sid);
      if (b) { b.done = true; patchStreamBubble(b.id); }
      break;
    }
    case 'form': {
      const d = e.data as Parameters<typeof addFormBlock>[0];
      if (d?.formId) addFormBlock(d);
      break;
    }
    case 'form-answered': {
      const d = e.data as { formId: string; ok: boolean; receipt: string };
      if (d?.formId) resolveForm(d.formId, d.ok, d.receipt, false);
      break;
    }
    case 'form-skipped': {
      const d = e.data as { formId: string; receipt: string };
      if (d?.formId) resolveForm(d.formId, false, d.receipt, true);
      break;
    }
    case 'ui.window': {
      const d = e.data as { action: 'open' | 'close'; id: string; title?: string;
        html?: string; css?: string; js?: string; width?: number; height?: number };
      if (d.action === 'close') closeWindow(d.id);
      else if (d.action === 'open' && d.id) {
        openWindow({ id: d.id, title: d.title ?? '', html: d.html ?? '', css: d.css ?? '', js: d.js ?? '', width: d.width, height: d.height });
      }
      break;
    }
    case 'shell.notify': {
      const d = e.data as { text?: string };
      if (d?.text) addSystemBlock(d.text);
      break;
    }
    default:
      break;
  }
}
