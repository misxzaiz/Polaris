/** Sky 前端状态 — 极简,无框架。模块级单例 + 订阅 */

import type { FormHold, StreamState, WindowState } from './types.ts';

export interface Block {
  id: string;
  kind: 'user' | 'assistant' | 'form' | 'system';
  text?: string;           // assistant / user 的文本(assistant 流式累积)
  reasoning?: string;      // 思考链(折叠)
  toolCalls?: StreamState['toolCalls'];
  form?: FormHold;          // kind=form 时的 hold
  formStatus?: 'pending' | 'answered' | 'skipped';
  receipt?: string;         // 表单回执
  streamId?: string;       // 关联流(assistant 流式中)
  done?: boolean;           // 流式结束
}

export interface SkyState {
  blocks: Block[];
  windows: WindowState[];        // 打开的浮窗
  connected: boolean;
  authRequired: boolean;
  authed: boolean;
  token: string;
}

const state: SkyState = {
  blocks: [],
  windows: [],
  connected: false,
  authRequired: false,
  authed: false,
  token: localStorage.getItem('sky.token') || '',
};

const listeners = new Set<() => void>();

export function getState(): SkyState { return state; }
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notify(): void { for (const fn of listeners) fn(); }

// Mutators ───────────────────────────────────────────────────────────────────

let blockSeq = 0;
export function nextId(prefix = 'b'): string { return `${prefix}-${++blockSeq}`; }

export function addUserBlock(text: string): Block {
  const b: Block = { id: nextId('u'), kind: 'user', text, done: true };
  state.blocks.push(b);
  notify();
  return b;
}

export function addAssistantBlock(streamId?: string): Block {
  const b: Block = { id: nextId('a'), kind: 'assistant', text: '', reasoning: '', toolCalls: [], streamId, done: false };
  state.blocks.push(b);
  notify();
  return b;
}

/** 给已存在的 block 赋 streamId(reply 到达后调用,解决竞态) */
export function setBlockStreamId(blockId: string, streamId: string): void {
  const b = state.blocks.find(x => x.id === blockId);
  if (b) { b.streamId = streamId; notify(); }
}

/** 取最后一个未完成的 assistant block(用于 chunk 到达时兜底) */
export function lastPendingAssistant(): Block | undefined {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const b = state.blocks[i];
    if (b.kind === 'assistant' && !b.done) return b;
  }
  return undefined;
}

export function findAssistantByStream(streamId: string): Block | undefined {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const b = state.blocks[i];
    if (b.kind === 'assistant' && b.streamId === streamId) return b;
  }
  return undefined;
}

export function addFormBlock(hold: FormHold): Block {
  const b: Block = { id: hold.formId, kind: 'form', form: hold, formStatus: 'pending' };
  state.blocks.push(b);
  notify();
  return b;
}

export function resolveForm(formId: string, ok: boolean, receipt: string, skipped = false): void {
  const b = state.blocks.find(x => x.id === formId && x.kind === 'form');
  if (!b) return;
  b.formStatus = skipped ? 'skipped' : 'answered';
  b.receipt = receipt;
  notify();
}

export function addSystemBlock(text: string): Block {
  const b: Block = { id: nextId('s'), kind: 'system', text, done: true };
  state.blocks.push(b);
  notify();
  return b;
}

export function openWindow(w: WindowState): void {
  const idx = state.windows.findIndex(x => x.id === w.id);
  if (idx >= 0) state.windows[idx] = w;
  else state.windows.push(w);
  notify();
}

export function closeWindow(id: string): void {
  state.windows = state.windows.filter(w => w.id !== id);
  notify();
}

export function setConnection(connected: boolean): void {
  state.connected = connected;
  notify();
}

export function setAuth(authRequired: boolean, authed: boolean): void {
  state.authRequired = authRequired;
  state.authed = authed;
  notify();
}

export function setToken(token: string): void {
  state.token = token;
  if (token) localStorage.setItem('sky.token', token);
  else localStorage.removeItem('sky.token');
  notify();
}
