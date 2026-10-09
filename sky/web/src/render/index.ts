/** Sky 前端渲染器 v2 — 分区增量渲染
 *
 * 4 个独立分区:topbar / stream / composer / overlay
 * 各区只更新自己,不互扰。流式 chunk 直接 patch bubble,不触发全量重建。
 */

import type { SkyState, Block } from '../state.ts';
import { getState, subscribe, notify } from '../state.ts';
import { renderMarkdown, escapeHtml } from './markdown.ts';
import { dispatchApi } from '../api.ts';
import type { SkyWs } from '../api.ts';
import type { FormField, WindowState } from '../types.ts';
import DOMPurify from 'dompurify';

let ws: SkyWs | null = null;
// 各分区 DOM 引用(创建后不重建)
let topbarEl: HTMLElement | null = null;
let streamEl: HTMLElement | null = null;
let colEl: HTMLElement | null = null;
let composerEl: HTMLElement | null = null;
let overlayEl: HTMLElement | null = null;
let inputEl: HTMLTextAreaElement | null = null;

// 对话流增量:记录已渲染的 block id → DOM 节点
const renderedBlocks = new Map<string, HTMLElement>();
let topbarDirty = true;

export function initRenderer(w: SkyWs, root: HTMLElement): void {
  ws = w;
  // 构建 4 个分区骨架(只建一次)
  root.innerHTML = '';
  topbarEl = document.createElement('div'); topbarEl.className = 'topbar';
  const river = document.createElement('div'); river.className = 'river';
  streamEl = document.createElement('div'); streamEl.className = 'stream';
  colEl = document.createElement('div'); colEl.className = 'col';
  streamEl.appendChild(colEl);
  river.appendChild(streamEl);
  composerEl = buildComposer();
  river.appendChild(composerEl);
  overlayEl = document.createElement('div'); overlayEl.className = 'overlay';
  root.appendChild(topbarEl);
  root.appendChild(river);
  root.appendChild(overlayEl);

  // 绑定一次性事件(composer / topbar / overlay 委托)
  bindStaticEvents();

  // 订阅 state 变更 → 增量更新
  subscribe(onStateChange);
  // 初始渲染
  onStateChange();
  // 滚动锚点
  initScroll();
}

// ─── 分区 1: topbar(仅状态变化时更新) ───────────────────────────────────────

function updateTopbar(s: SkyState): void {
  if (!topbarEl || !topbarDirty) return;
  topbarDirty = false;
  topbarEl.innerHTML = `
    <span class="dot ${s.connected ? 'on' : ''}"></span>
    <span class="status">${statusText(s)}</span>
    <div class="spacer"></div>
    <button class="pill" data-act="token">⚙</button>
    <button class="pill" data-act="windows">🧭</button>`;
}

function statusText(s: SkyState): string {
  if (!s.connected) return '断线重连中…';
  if (s.authRequired && !s.authed) return '需认证';
  return '在线';
}

// ─── 分区 2: stream(只追加新 block,已有 patch) ──────────────────────────────

function updateStream(s: SkyState): void {
  if (!colEl) return;
  // 空状态
  if (s.blocks.length === 0) {
    if (!colEl.querySelector('.empty-hint')) {
      colEl.innerHTML = '<div class="empty-hint"><div class="big">✦</div><div class="small">对 Sky 说点什么…<br>AI 会帮你读写文件、渲染界面、管理一切</div></div>';
    }
    return;
  }
  // 移除空状态
  const hint = colEl.querySelector('.empty-hint');
  if (hint) hint.remove();

  // 只追加新 block,不重建已有的
  for (const b of s.blocks) {
    if (renderedBlocks.has(b.id)) {
      patchBlock(b); // 增量更新已有 block
    } else {
      const node = renderBlock(b);
      colEl.appendChild(node);
      renderedBlocks.set(b.id, node);
    }
  }
  // 自动滚动
  autoScroll();
}

function patchBlock(b: Block): void {
  const node = renderedBlocks.get(b.id);
  if (!node) return;
  if (b.kind === 'assistant') {
    const bubble = node.querySelector('.bubble');
    if (bubble) {
      const live = !b.done ? '<span class="cursor">▋</span>' : '';
      bubble.innerHTML = renderMarkdown(b.text ?? '') + live;
    }
    // 工具调用折叠条
    if (b.toolCalls?.length) {
      let fold = node.querySelector('.tools-fold');
      if (!fold) {
        fold = document.createElement('div');
        fold.className = 'fold tools-fold';
        fold.innerHTML = `<span class="chev">▶</span><span>${b.toolCalls.length} 次工具调用</span>`;
        fold.addEventListener('click', () => fold?.classList.toggle('open'));
        node.querySelector('.body')?.appendChild(fold);
      }
      const label = fold.querySelector('span:last-child');
      if (label) label.textContent = `${b.toolCalls.length} 次工具调用`;
    }
  } else if (b.kind === 'form') {
    const done = b.formStatus === 'answered' || b.formStatus === 'skipped';
    if (done) {
      node.classList.add('done');
      const actions = node.querySelector('.actions');
      if (actions) actions.innerHTML = `<span class="donebadge">${b.formStatus === 'skipped' ? '已跳过' : '✓ 已完成'}</span>`;
    }
    if (b.receipt && !node.querySelector('.receipt')) {
      const r = document.createElement('div');
      r.className = 'receipt';
      r.textContent = b.receipt;
      node.appendChild(r);
    }
  }
}

function renderBlock(b: Block): HTMLElement {
  const node = document.createElement('div');
  node.setAttribute('data-block-id', b.id);
  switch (b.kind) {
    case 'user':
      node.className = 'msg user';
      node.innerHTML = `<div class="avatar user">我</div><div class="body"><div class="bubble">${escapeHtml(b.text ?? '')}</div></div>`;
      break;
    case 'assistant':
      node.className = 'msg ai';
      const live = !b.done ? '<span class="cursor">▋</span>' : '';
      node.innerHTML = `<div class="avatar ai">✦</div><div class="body"><div class="bubble">${renderMarkdown(b.text ?? '')}${live}</div></div>`;
      break;
    case 'form':
      node.className = `formcard ${b.formStatus === 'answered' || b.formStatus === 'skipped' ? 'done' : ''}`;
      node.innerHTML = renderFormInner(b);
      break;
    case 'system':
      node.className = 'msg system';
      node.innerHTML = `<div class="body"><div class="bubble sys">${escapeHtml(b.text ?? '')}</div></div>`;
      break;
  }
  return node;
}

function renderFormInner(b: Block): string {
  const f = b.form!;
  const done = b.formStatus === 'answered' || b.formStatus === 'skipped';
  const rows = (f.fields ?? []).map((field: FormField) => renderField(field, f.read)).join('');
  return `<h4>${escapeHtml(f.title || '表单')}</h4><div class="frows">${rows}</div>` +
    `<div class="actions"><span class="donebadge">${b.formStatus === 'skipped' ? '已跳过' : '✓ 已完成'}</span>` +
    (done ? '' : `<button class="btn small" data-skip="${b.id}">跳过</button><button class="btn primary small" data-sub="${b.id}">提交</button>`) +
    `</div>`;
}

function renderField(field: FormField, read?: string): string {
  const name = escapeHtml(field.name);
  const label = escapeHtml(field.label ?? field.name);
  const ty = field.type ?? 'string';
  if (ty === 'select') {
    const opts = (field.options ?? []).map(o => `<option>${escapeHtml(o)}</option>`).join('');
    return `<div class="frow"><label>${label}</label><select data-n="${name}">${opts}</select></div>`;
  }
  if (ty === 'textarea') return `<div class="frow"><label>${label}</label><textarea data-n="${name}"></textarea></div>`;
  if (ty === 'secret') return `<div class="frow"><label>${label}</label><input data-n="${name}" type="password" autocomplete="off"></div>`;
  if (ty === 'boolean') return `<div class="frow"><label>${label}</label><input data-n="${name}" type="checkbox"></div>`;
  if (ty === 'number') return `<div class="frow"><label>${label}</label><input data-n="${name}" type="number"></div>`;
  return `<div class="frow"><label>${label}</label><input data-n="${name}" type="text"></div>`;
}

// ─── 分区 3: composer(创建后不重建) ─────────────────────────────────────────

function buildComposer(): HTMLElement {
  const c = document.createElement('div');
  c.className = 'composer';
  c.innerHTML = `<div class="wrap">
    <textarea id="input" rows="1" placeholder="对 Sky 说点什么…"></textarea>
    <button class="send" id="btn-send">➤</button>
  </div>`;
  return c;
}

// ─── 分区 4: overlay(浮窗 + sheet + toast,独立层) ──────────────────────────

function updateOverlay(s: SkyState): void {
  if (!overlayEl) return;
  // 浮窗:增量同步(不重建已有)
  const existing = new Set<string>();
  for (const w of s.windows) {
    existing.add(w.id);
    let node = overlayEl.querySelector(`[data-win-id="${w.id}"]`);
    if (!node) {
      node = buildFloater(w);
      overlayEl.appendChild(node);
    }
  }
  // 移除已关闭的
  overlayEl.querySelectorAll('[data-win-id]').forEach(n => {
    if (!existing.has(n.getAttribute('data-win-id')!)) n.remove();
  });

  // token sheet(仅在没有时创建)
  if (!overlayEl.querySelector('.sheet')) {
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.innerHTML = `<div class="sheetcard">
      <h3>基础配置</h3>
      <div class="frow"><label>baseUrl</label><input id="c-base" placeholder="https://api.example.com/v1"></div>
      <div class="frow"><label>apiKey</label><input id="c-key" type="password" autocomplete="off" placeholder="sk-…"></div>
      <div class="frow"><label>model</label><input id="c-model" placeholder="gpt-4o-mini"></div>
      <div class="actions"><button class="btn" data-act="cfg-close">取消</button><button class="btn primary" data-act="cfg-save">保存</button></div>
    </div>`;
    overlayEl.appendChild(sheet);
  }

  // toast(仅创建一次)
  if (!overlayEl.querySelector('#toast')) {
    const t = document.createElement('div'); t.id = 'toast';
    overlayEl.appendChild(t);
  }
}

function buildFloater(w: WindowState): HTMLElement {
  const node = document.createElement('div');
  node.className = 'floater';
  node.setAttribute('data-win-id', w.id);
  node.innerHTML = `<div class="fh"><span class="title">${escapeHtml(w.title)}</span><span class="grow"></span><button class="close" data-win-close="${w.id}">✕</button></div><div class="fc" id="fc-${w.id}"></div>`;
  const body = node.querySelector(`#fc-${w.id}`) as HTMLElement;
  body.innerHTML = DOMPurify.sanitize(w.html);
  // 作用域 CSS
  if (w.css) {
    const style = document.createElement('style');
    style.textContent = `#fc-${w.id} { ${w.css} }`;
    document.head.appendChild(style);
  }
  // 拖拽(桌面)
  const fh = node.querySelector('.fh') as HTMLElement;
  let dragging = false, ox = 0, oy = 0;
  fh.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).classList.contains('close')) return;
    dragging = true;
    const rect = node.getBoundingClientRect();
    ox = e.clientX - rect.left; oy = e.clientY - rect.top;
    node.style.position = 'fixed';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    node.style.left = (e.clientX - ox) + 'px';
    node.style.top = (e.clientY - oy) + 'px';
    node.style.right = 'auto';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
  // js 沙箱
  if (w.js) {
    try {
      const fn = new Function('root', '__sky', w.js);
      fn(body, {
        dispatch: (cap: string, params: unknown) => dispatchApi(cap, params, getState().token),
        close: () => { import('../state.ts').then(m => m.closeWindow(w.id)); },
        toast: (t: string) => showToast(t),
      });
    } catch { /* js 失败不挂 */ }
  }
  return node;
}

// ─── state 变更 → 分区更新 ─────────────────────────────────────────────────

function onStateChange(): void {
  const s = getState();
  updateTopbar(s);
  updateStream(s);
  updateOverlay(s);
}

/** 流式 chunk 专用增量 patch(不走全量 onStateChange) */
export function patchStreamBubble(blockId: string): void {
  const s = getState();
  const b = s.blocks.find(x => x.id === blockId);
  if (!b || b.kind !== 'assistant') return;
  const node = renderedBlocks.get(blockId);
  if (!node) return;
  const bubble = node.querySelector('.bubble');
  if (!bubble) return;
  const live = !b.done ? '<span class="cursor">▋</span>' : '';
  bubble.innerHTML = renderMarkdown(b.text ?? '') + live;
  autoScroll();
}

// ─── 一次性事件绑定(委托) ──────────────────────────────────────────────────

function bindStaticEvents(): void {
  // composer:发送 + 自适应
  inputEl = document.getElementById('input') as HTMLTextAreaElement;
  document.getElementById('btn-send')?.addEventListener('click', sendInput);
  inputEl?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendInput(); }
  });
  inputEl?.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
  });

  // overlay 事件委托(浮窗关闭 / sheet / 表单提交)
  overlayEl?.addEventListener('click', (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    // 浮窗关闭
    const closeBtn = t.closest('[data-win-close]');
    if (closeBtn) {
      const id = closeBtn.getAttribute('data-win-close')!;
      import('../state.ts').then(m => m.closeWindow(id));
      return;
    }
    // token 设置
    if (t.closest('[data-act="token"]')) { openSheet(); return; }
    if (t.closest('[data-act="windows"]')) {
      if (getState().windows.length === 0) showToast('暂无浮窗');
      return;
    }
    if (t.closest('[data-act="cfg-close"]')) { overlayEl?.querySelector('.sheet')?.classList.remove('open'); return; }
    if (t.closest('[data-act="cfg-save"]')) { saveConfig(); return; }
    // 表单提交
    const sub = t.closest('[data-sub]');
    if (sub) { submitForm(sub.getAttribute('data-sub')!); return; }
    const skip = t.closest('[data-skip]');
    if (skip) { skipForm(skip.getAttribute('data-skip')!); return; }
  });

  // topbar 委托
  topbarEl?.addEventListener('click', (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-act="token"]')) openSheet();
    else if (t.closest('[data-act="windows"]')) {
      if (getState().windows.length === 0) showToast('暂无浮窗');
    }
  });
}

// ─── 业务动作 ─────────────────────────────────────────────────────────────────

async function openSheet(): Promise<void> {
  overlayEl?.querySelector('.sheet')?.classList.add('open');
  const r = await dispatchApi('cap.config', { action: 'get' }, getState().token);
  if (!r.ok) return;
  const cfg = (r.data as { ai?: { baseUrl?: string; apiKey?: string; model?: string } })?.ai ?? {};
  const base = overlayEl?.querySelector('#c-base') as HTMLInputElement;
  const key = overlayEl?.querySelector('#c-key') as HTMLInputElement;
  const model = overlayEl?.querySelector('#c-model') as HTMLInputElement;
  if (base && cfg.baseUrl) base.value = cfg.baseUrl;
  if (key && cfg.apiKey) key.value = cfg.apiKey;
  if (model && cfg.model) model.value = cfg.model;
}

async function saveConfig(): Promise<void> {
  const base = (overlayEl?.querySelector('#c-base') as HTMLInputElement).value;
  const key = (overlayEl?.querySelector('#c-key') as HTMLInputElement).value;
  const model = (overlayEl?.querySelector('#c-model') as HTMLInputElement).value;
  const r = await dispatchApi('cap.config', { action: 'patch', value: { ai: { baseUrl: base, apiKey: key, model } } }, getState().token);
  overlayEl?.querySelector('.sheet')?.classList.remove('open');
  showToast(r.ok ? '✓ 已保存' : (r.error ?? '保存失败'));
}

async function submitForm(formId: string): Promise<void> {
  const card = overlayEl?.querySelector(`[data-sub="${formId}"]`)?.closest('.formcard')
    || colEl?.querySelector(`[data-sub="${formId}"]`)?.closest('.formcard');
  if (!card) return;
  const values: Record<string, unknown> = {};
  card.querySelectorAll('[data-n]').forEach(inp => {
    const el2 = inp as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const n = el2.dataset.n!;
    if (el2 instanceof HTMLInputElement && el2.type === 'checkbox') values[n] = el2.checked;
    else values[n] = el2.value;
  });
  const r = await dispatchApi('cap.form', { action: 'submit', formId, values }, getState().token);
  if (!r.ok) showToast(r.error ?? '提交失败');
}

async function skipForm(formId: string): Promise<void> {
  const r = await dispatchApi('cap.form', { action: 'skip', formId }, getState().token);
  if (!r.ok) showToast(r.error ?? '跳过失败');
}

async function sendInput(): Promise<void> {
  if (!inputEl) return;
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  const { addUserBlock, addAssistantBlock, addSystemBlock, setBlockStreamId, setConnection } = await import('../state.ts');
  addUserBlock(text);
  if (!ws || !getState().connected) {
    setConnection(false);
    showToast('未连接 WS');
    return;
  }
  // 创建占位 assistant block
  const block = addAssistantBlock(undefined);
  // 30s 超时 guard
  const timeoutId = setTimeout(() => {
    if (!block.done && !block.text) {
      block.done = true;
      block.text = '⏱ 回复超时';
      notify();
    }
  }, 30000);
  const reqId = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  ws.expectReply(reqId, (reply) => {
    clearTimeout(timeoutId);
    if (reply.ok) {
      const data = reply.data as { streamId?: string };
      if (data?.streamId) setBlockStreamId(block.id, data.streamId);
    } else {
      block.done = true;
      addSystemBlock(reply.error ?? 'AI 请求失败');
    }
  });
  ws.sendDispatch(reqId, 'cap.ai.chat', { messages: [{ role: 'user', content: text }], stream: true }, true);
}

// ─── 工具 ───────────────────────────────────────────────────────────────────

function showToast(msg: string): void {
  let t = overlayEl?.querySelector('#toast') as HTMLElement | null;
  if (!t) { t = document.createElement('div'); t.id = 'toast'; overlayEl?.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout((t as any)._timer);
  (t as any)._timer = setTimeout(() => t?.classList.remove('show'), 2400);
}

// 滚动锚点
let followBottom = true;
function initScroll(): void {
  streamEl?.addEventListener('scroll', () => {
    if (!streamEl) return;
    const dist = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight;
    followBottom = dist < 80;
  });
}
function autoScroll(): void {
  if (followBottom && streamEl) streamEl.scrollTop = streamEl.scrollHeight;
}

// topbar 呼出(桌面 hover + 触摸点击顶部)
export function initTopbarHover(): void {
  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (e.clientY <= 4) document.body.classList.add('hoverTop');
    else if (e.clientY > 44) document.body.classList.remove('hoverTop');
  });
}

// 通知 topbar 需要更新
export function markTopbarDirty(): void { topbarDirty = true; }
