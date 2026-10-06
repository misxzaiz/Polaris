/**
 * Web Shell — Mobile-First 响应式渲染器
 *
 * 手机优先 (<768px):
 * - 单栏全屏 + 底部 Tab (聊天/Caps/设置) + 顶栏
 * - safe-area (刘海/手势条) + visualViewport 软键盘适配
 * - 触摸目标 >= 44px, 输入 16px 防 iOS 自动缩放
 *
 * 桌面 (>=768px): 三栏 grid (自动, 同一份 UI State)
 *
 * AI 能力不变: cap.ui.* 改 UI State → WS ui.update → 热重渲染 (双端通用)
 */

export const SHELL_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0a0e27">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Sky · Capability OS</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; overscroll-behavior: none; }
  body {
    font: 16px/var(--sky-line-height, 1.5) var(--sky-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    background: var(--sky-bg, #0d1117); color: var(--sky-text, #c9d1d9);
    overflow: hidden;
    /* safe-area: 刘海/手势条 */
    --safe-top: env(safe-area-inset-top, 0px);
    --safe-bottom: env(safe-area-inset-bottom, 0px);
  }

  /* ============ 布局骨架 ============ */
  /* 手机: 顶栏 + 内容 + Tab栏 */
  #sky-root {
    display: flex; flex-direction: column; height: 100vh; height: 100dvh;
  }
  #sky-topbar {
    display: flex; align-items: center; gap: 8px;
    padding: calc(var(--safe-top) + 8px) 12px 8px;
    background: var(--sky-bg-elevated, #161b22);
    border-bottom: 1px solid var(--sky-border, #21262d);
    flex-shrink: 0;
  }
  #sky-topbar .title { font-weight: 600; font-size: 15px; flex: 1; }
  #sky-topbar .badge {
    font-size: 11px; color: var(--sky-text-muted, #8b949e);
    background: var(--sky-bg, #0d1117); padding: 2px 8px; border-radius: 10px;
  }
  #sky-content { flex: 1; overflow: hidden; position: relative; }
  .sky-page {
    position: absolute; inset: 0; overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: var(--sky-md, 16px);
    padding-bottom: calc(16px + var(--safe-bottom));
    display: none;
  }
  .sky-page.active { display: block; }
  #sky-tabbar {
    display: flex;
    background: var(--sky-bg-elevated, #161b22);
    border-top: 1px solid var(--sky-border, #21262d);
    padding-bottom: var(--safe-bottom);
    flex-shrink: 0;
  }
  .tab-btn {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 8px 0 6px; min-height: 48px;
    background: none; border: none; color: var(--sky-text-muted, #8b949e);
    font-size: 11px; cursor: pointer;
  }
  .tab-btn.active { color: var(--sky-accent, #58a6ff); }
  .tab-btn .icon { width: 20px; height: 20px; line-height: 1; display: block; }

  /* 桌面: 三栏 (Tab 栏隐藏, 页面全显) */
  @media (min-width: 768px) {
    #sky-tabbar, #sky-topbar { display: none; }
    #sky-content { display: grid; grid-template-columns: var(--desktop-cols, 260px 1fr 340px); }
    .sky-page { display: block; position: static; border-right: 1px solid var(--sky-border, #21262d); padding-top: var(--sky-md, 16px); }
    .sky-page:last-child { border-right: none; }
  }

  /* ============ 组件 ============ */
  h2 { font-size: 13px; text-transform: uppercase; color: var(--sky-text-muted, #8b949e); letter-spacing: 0.5px; margin-bottom: var(--sky-sm, 8px); }
  .cap-item {
    background: var(--sky-bg-elevated, #161b22);
    padding: 10px 12px; border-radius: var(--sky-md, 6px); margin-bottom: 8px;
    font-size: 13px;
  }
  .cap-id { color: var(--sky-accent, #58a6ff); font-family: var(--sky-mono, ui-monospace, monospace); font-size: 13px; }
  .cap-desc { color: var(--sky-text-muted, #8b949e); margin-top: 2px; font-size: 12px; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 8px; background: var(--sky-primary, #1f6feb); color: #fff; font-size: 10px; margin-left: 6px; }

  /* 聊天: 消息 */
  #page-chat { display: none; flex-direction: column; padding: 0 !important; }
  #page-chat.active { display: flex; }
  @media (min-width: 768px) { #page-chat { display: flex; } }
  #messages {
    flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch;
    padding: var(--sky-md, 16px);
    display: flex; flex-direction: column;
    gap: var(--chat-gap, 10px);
    font-size: var(--chat-fontsize, 15px);
  }
  .msg {
    padding: 10px 14px; border-radius: var(--sky-md, 6px);
    word-wrap: break-word; overflow-wrap: break-word; white-space: pre-wrap;
    line-height: 1.55;
    max-width: var(--msg-user-maxw, 85%);
  }
  .msg.user {
    background: var(--sky-primary, #1f6feb); color: #fff;
    margin-left: auto; border-bottom-right-radius: 3px;
  }
  .msg.assistant {
    background: var(--sky-bg-elevated, #161b22);
    color: var(--sky-text, #c9d1d9);
    border-bottom-left-radius: 3px;
    max-width: var(--msg-assistant-maxw, 100%);
    width: 100%;
  }
  /* Markdown 渲染 (assistant) */
  .msg.assistant code:not(pre code) {
    background: var(--sky-bg, #0d1117); padding: 1px 5px; border-radius: 3px;
    font-family: var(--sky-mono, monospace); font-size: 0.9em;
  }
  .msg.assistant pre {
    background: var(--sky-bg, #0d1117); padding: 10px 12px; border-radius: var(--sky-sm, 4px);
    overflow-x: auto; margin: 6px 0; border: 1px solid var(--sky-border, #21262d);
  }
  .msg.assistant pre code { font-family: var(--sky-mono, monospace); font-size: 0.88em; white-space: pre; }
  .msg.assistant strong { font-weight: 600; }
  .msg.assistant p { margin: 0; }
  .msg.assistant p + p { margin-top: 8px; }

  /* ============ 工具块 (调用 + 结果合并, 可折叠) — 对齐 Polaris 数值 ============ */
  /* 单块: w-full, margin 6px, radius 8px, border 1px rgba(255,255,255,.15), bg rgb(26,26,31) */
  .tool-block {
    border-left: 3px solid var(--sky-text-muted, #8b949e);
    background: var(--sky-bg, #0d1117);
    border-radius: 0 var(--sky-sm, 4px) var(--sky-sm, 4px) 0;
    margin: 6px 0;
    font-family: var(--sky-mono, monospace); font-size: 12px;
    overflow: hidden;
    transition: border-color .2s, background-color .2s;
  }
  .tool-block.running { border-left-color: var(--sky-warning, #f0883e); }
  .tool-block.ok { border-left-color: var(--sky-success, #238636); }
  .tool-block.err { border-left-color: var(--sky-danger, #f85149); }
  .tool-block.card {
    border: 1px solid var(--sky-border, #21262d); border-left-width: 3px;
    background: var(--sky-bg-elevated, #161b22);
    border-radius: 8px;
  }
  .tool-block.running.card { border-color: rgba(255,255,255,0.15); }
  /* 头部行: padding 6px 10px, gap 8px, 触控 min-height 36px (移动 44px) */
  .tool-head {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; cursor: pointer; user-select: none;
    color: var(--sky-text, #c9d1d9);
    font-size: 12px; line-height: 1.2;
    min-height: 36px;
  }
  .tool-head:hover { background: rgba(255,255,255,0.04); }
  .tool-head .tool-icon { flex-shrink: 0; color: var(--sky-text-muted, #8b949e); width: 14px; height: 14px; display: block; }
  .tool-block.running .tool-head .tool-icon { color: var(--sky-warning, #f0883e); animation: tool-spin 1s linear infinite; }
  .tool-block.ok .tool-head .tool-icon { color: var(--sky-success, #238636); }
  .tool-block.err .tool-head .tool-icon { color: var(--sky-danger, #f85149); }
  @keyframes tool-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
  .tool-head .tool-name { color: var(--sky-accent, #58a6ff); font-weight: 500; flex-shrink: 0; font-size: 12px; }
  .tool-head .tool-summary {
    color: var(--sky-text-muted, #8b949e); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; font-size: 12px;
  }
  .tool-head .tool-chev { flex-shrink: 0; color: var(--sky-text-muted, #8b949e); transition: transform .2s; width: 12px; height: 12px; display: block; }
  .tool-block.expanded .tool-chev { transform: rotate(90deg); }
  .tool-body {
    display: none; padding: 12px 16px; border-top: 1px solid var(--sky-border, #21262d);
    max-height: 320px; overflow-y: auto;
  }
  .tool-block.expanded .tool-body { display: block; }
  .tool-block.folded .tool-body { display: none; }
  .tool-block.folded.expanded .tool-body { display: block; }  /* 展开优先于 folded */
  .tool-block.folded .tool-chev { transform: rotate(0); }
  .tool-block.folded.expanded .tool-chev { transform: rotate(90deg); }
  .tool-body .tool-section {
    color: var(--sky-text-muted, #8b949e); font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; margin-top: 6px;
  }
  .tool-body .tool-section:first-child { margin-top: 0; }
  .tool-body .tool-json {
    white-space: pre-wrap; word-break: break-all; color: var(--sky-text, #c9d1d9);
  }
  .tool-body .tool-result-ok { color: var(--sky-success, #238636); }
  .tool-body .tool-result-err { color: var(--sky-danger, #f85149); }

  /* ============ 分组折叠: 连续工具块超阈值时折叠成"展开 N 个"按钮 ============ */
  .tool-group-more {
    display: flex; align-items: center; gap: 6px;
    margin: 6px 0; padding: 8px 12px;
    background: var(--sky-bg, #0d1117);
    border: 1px dashed var(--sky-border, #21262d);
    border-radius: 8px;
    cursor: pointer; user-select: none;
    color: var(--sky-text-muted, #8b949e); font-size: 12px;
    min-height: 36px;
    transition: background-color .15s, border-color .15s, color .15s;
  }
  .tool-group-more:hover {
    background: rgba(255,255,255,0.04);
    border-color: var(--sky-accent, #58a6ff);
    color: var(--sky-accent, #58a6ff);
  }
  .tool-group-more svg { width: 14px; height: 14px; flex-shrink: 0; }
  .tool-group-more .more-count {
    font-size: 10px; padding: 1px 6px; border-radius: 8px;
    background: var(--sky-bg-elevated, #161b22); color: var(--sky-text, #c9d1d9);
    margin-left: auto;
  }
  /* 折叠态隐藏的工具块 */
  .tool-block.folded-hidden { display: none; }
  .tool-group.expanded .tool-block.folded-hidden { display: block; }
  .tool-group.expanded .tool-group-more { display: none; }

  #input-bar {
    display: flex; gap: 8px;
    padding: 10px 12px calc(10px + var(--safe-bottom));
    border-top: 1px solid var(--sky-border, #21262d);
    background: var(--sky-bg-elevated, #161b22);
    flex-shrink: 0;
  }
  #input {
    flex: 1; background: var(--sky-bg-input, #0d1117);
    border: 1px solid var(--sky-border, #21262d); color: var(--sky-text, #c9d1d9);
    border-radius: 20px; padding: 10px 16px;
    font: inherit; font-size: 16px; /* 16px 防 iOS 聚焦缩放 */
    min-height: 44px;
  }
  #input:focus { outline: none; border-color: var(--sky-accent, #58a6ff); }
  #send-btn {
    background: var(--sky-success, #238636); color: #fff; border: none;
    border-radius: 20px; padding: 0 18px; min-height: 44px; min-width: 60px;
    cursor: pointer; font: inherit; font-size: 15px;
    display: flex; align-items: center; justify-content: center; gap: 6px;
  }
  #send-btn svg { width: 16px; height: 16px; }
  #send-btn:disabled { opacity: 0.5; }

  /* 设置面板 */
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; color: var(--sky-text-muted, #8b949e); margin-bottom: 4px; }
  .field input {
    width: 100%; background: var(--sky-bg-input, #0d1117);
    border: 1px solid var(--sky-border, #21262d); color: var(--sky-text, #c9d1d9);
    border-radius: var(--sky-sm, 4px); padding: 10px 12px;
    font: inherit; font-size: 16px; min-height: 44px;
  }
  .btn {
    background: var(--sky-primary, #1f6feb); color: #fff; border: none;
    border-radius: var(--sky-sm, 4px); padding: 10px 16px; min-height: 44px;
    cursor: pointer; font: inherit; font-size: 15px; width: 100%;
  }
  .btn.secondary { background: var(--sky-border, #21262d); color: var(--sky-text, #c9d1d9); }
  .status { font-size: 12px; color: var(--sky-text-muted, #8b949e); margin-top: 8px; min-height: 18px; }
  .status.ok { color: var(--sky-success, #238636); }
  .status.err { color: var(--sky-danger, #f85149); }
</style>
<style id="sky-dynamic"></style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="ic-caps" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>
  </symbol>
  <symbol id="ic-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </symbol>
  <symbol id="ic-settings" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </symbol>
  <symbol id="ic-tool" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
  </symbol>
  <symbol id="ic-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </symbol>
  <symbol id="ic-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </symbol>
  <symbol id="ic-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </symbol>
  <symbol id="ic-loader" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
    <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
    <line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
    <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
  </symbol>
  <symbol id="ic-send" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
  </symbol>
</svg>
<div id="sky-root">
  <div id="sky-topbar">
    <span class="title">Sky</span>
    <span class="badge" id="cap-badge">...</span>
  </div>
  <div id="sky-content">
    <div class="sky-page" id="page-caps"><div id="comp-caps-list"></div></div>
    <div class="sky-page" id="page-chat"><div id="comp-chat" style="display:flex;flex-direction:column;height:100%"></div></div>
    <div class="sky-page" id="page-settings"><div id="comp-config"></div></div>
  </div>
  <div id="sky-tabbar">
    <button class="tab-btn" data-page="page-caps"><svg class="icon"><use href="#ic-caps"/></svg>Caps</button>
    <button class="tab-btn active" data-page="page-chat"><svg class="icon"><use href="#ic-chat"/></svg>聊天</button>
    <button class="tab-btn" data-page="page-settings"><svg class="icon"><use href="#ic-settings"/></svg>设置</button>
  </div>
</div>

<script>
const $root = document.getElementById('sky-root');
const dynamicStyle = document.getElementById('sky-dynamic');
let ws = null;
let currentStreamId = null;
let currentMsgEl = null;
const pendingEvents = [];
const pendingDispatch = [];
let uiState = null;
let streamingNotifyShown = false;

// ---------------------------------------------------------------- Tab 切换 (手机)
document.getElementById('sky-tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  switchPage(btn.dataset.page);
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
});

function switchPage(id) {
  document.querySelectorAll('.sky-page').forEach(p => p.classList.toggle('active', p.id === id));
  if (id === 'page-chat') scrollMessages();
}

// ---------------------------------------------------------------- 键盘适配 (visualViewport)
const vv = window.visualViewport;
if (vv) {
  vv.addEventListener('resize', () => {
    // 键盘弹出: viewport 高度变小 → input-bar 上移
    // 用 dvh + 调整 content 高度
    document.getElementById('sky-content').style.height = vv.height + 'px';
    scrollMessages();
  });
  vv.addEventListener('scroll', scrollMessages);
}

function scrollMessages() {
  const m = document.getElementById('messages');
  if (m) m.scrollTop = m.scrollHeight;
}

// ---------------------------------------------------------------- WS
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = new URLSearchParams(location.search).get('token') || '';
  const url = proto + '://' + location.host + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');
  ws = new WebSocket(url);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'shell-register', caps: ['cap.ui.observe'] }));
    while (pendingDispatch.length) ws.send(JSON.stringify(pendingDispatch.shift()));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'event') handleEvent(msg.event);
    else if (msg.type === 'shell-invoke') handleShellInvoke(msg);
    else if (msg.type === 'reply') {
      const data = msg.reply?.result?.ok ? msg.reply.result.data : null;
      if (data && data.streamId) {
        currentStreamId = data.streamId;
        while (pendingEvents.length) handleEvent(pendingEvents.shift());
      } else if (!msg.reply?.result?.ok) {
        if (currentMsgEl && !currentMsgEl.textContent) {
          currentMsgEl.textContent = '错误: ' + (msg.reply?.result?.error || 'unknown');
        }
        const btn = document.getElementById('send-btn');
        if (btn) btn.disabled = false;
      }
    }
  };
  ws.onclose = () => setTimeout(connectWs, 1000);
}

// ---------------------------------------------------------------- Shell invoke (前端执行 cap)
async function handleShellInvoke(msg) {
  let result;
  try {
    if (msg.cap === 'cap.ui.observe') {
      result = await observeInvoke(msg.params || {});
    } else {
      result = { ok: false, error: 'cap not provided by shell: ' + msg.cap };
    }
  } catch (err) {
    result = { ok: false, error: String(err && err.message || err) };
  }
  ws.send(JSON.stringify({ type: 'shell-invoke-result', reqId: msg.reqId, result }));
}

async function observeInvoke(p) {
  if (p.action === 'screenshot') {
    const html = document.documentElement.outerHTML;
    return {
      ok: true, type: 'dom-snapshot',
      note: 'DOM snapshot (no pixel capture in preview)',
      size: html.length, dom: html.slice(0, 50000),
      viewport: { w: innerWidth, h: innerHeight },
      isMobile: matchMedia('(max-width: 767px)').matches,
      activePage: document.querySelector('.sky-page.active')?.id || null,
    };
  }
  if (p.action === 'inspect') {
    if (!p.selector) return { ok: false, error: 'selector required' };
    const el = document.querySelector(p.selector);
    if (!el) return { ok: false, error: 'element not found: ' + p.selector };
    const cs = getComputedStyle(el);
    const props = {};
    for (const k of ['display','position','width','height','color','backgroundColor','fontSize','fontWeight','margin','padding','border','borderRadius','overflow','flexDirection','gridTemplateColumns']) {
      props[k] = cs[k];
    }
    return { ok: true, selector: p.selector, tagName: el.tagName, text: (el.textContent||'').slice(0,200), computed: props, rect: el.getBoundingClientRect().toJSON() };
  }
  if (p.action === 'metrics') {
    return {
      ok: true,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      isMobile: matchMedia('(max-width: 767px)').matches,
      activePage: document.querySelector('.sky-page.active')?.id || null,
      keyboardHeight: vv ? Math.max(0, innerHeight - vv.height - vv.offsetTop) : 0,
      scrollY: scrollY,
      title: document.title,
    };
  }
  return { ok: false, error: 'unknown observe action: ' + p.action };
}

// ---------------------------------------------------------------- UI State 渲染
function render() {
  if (!uiState) return;
  const t = uiState.theme || {};
  let css = ':root{';
  for (const [k,v] of Object.entries(t.colors||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  for (const [k,v] of Object.entries(t.spacing||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  for (const [k,v] of Object.entries(t.typography||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  for (const [k,v] of Object.entries(t.shadows||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  for (const [k,v] of Object.entries(t.radii||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  css += '}';
  for (const rule of (uiState.styles||[])) {
    css += rule.selector + '{' + Object.entries(rule.properties||{}).map(([k,v])=>kebab(k)+':'+v).join(';') + '}';
  }
  dynamicStyle.textContent = css;
  // 手机端: 自定义 layout 树仅在桌面 grid 生效 (手机固定 Tab 结构, theme/styles 通用)
  if (matchMedia('(min-width: 768px)').matches) {
    const regions = uiState.layout?.children || [];
    document.getElementById('sky-content').style.setProperty('--desktop-cols',
      regions.map(r => (r.props && r.props.width) ? r.props.width : '1fr').join(' ') || '260px 1fr 340px');
  }
  // ChatConfig → CSS 变量 (消息宽度/字号/间距)
  const c = uiState.chat || {};
  const root = document.documentElement.style;
  root.setProperty('--msg-user-maxw', c.userMaxWidth || '85%');
  root.setProperty('--msg-assistant-maxw', c.assistantMaxWidth || '100%');
  root.setProperty('--chat-gap', c.messageGap || '10px');
  root.setProperty('--chat-fontsize', (c.fontSize || 15) + 'px');
  // 动态渲染 custom 组件 (AI 经 cap.ui.component 添加的)
  renderComponents();
}

// ---------------------------------------------------------------- 动态组件渲染
// mountPoint 映射: sidebar→comp-caps-list, main→comp-chat, right→comp-config
const MOUNT_MAP = { sidebar: 'comp-caps-list', main: 'comp-chat', right: 'comp-config' };
const renderedComponents = new Set();

function renderComponents() {
  if (!uiState || !uiState.components) return;
  for (const comp of uiState.components) {
    if (comp.type !== 'custom') continue;
    if (renderedComponents.has(comp.id)) continue; // 只渲染一次 (避免重复)
    const hostId = MOUNT_MAP[comp.mountPoint] || MOUNT_MAP.right;
    const host = document.getElementById(hostId);
    if (!host) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'sky-custom-comp';
    wrapper.dataset.compId = comp.id;
    if (comp.props && comp.props.html) {
      wrapper.innerHTML = comp.props.html;
    }
    host.appendChild(wrapper);
    renderedComponents.add(comp.id);
    // 绑定 onclick (如果 props 提供)
    if (comp.props && comp.props.onClick) {
      // 简化: onClick 是字符串描述, 不实际执行 (安全考虑)
    }
  }
}

// ---------------------------------------------------------------- 内置组件
async function loadCaps() {
  const r = await fetch('/api/caps').then(r=>r.json());
  const caps = r.caps || [];
  const badge = document.getElementById('cap-badge');
  if (badge) badge.textContent = caps.length + ' caps';
  const list = document.getElementById('comp-caps-list');
  if (list) {
    list.innerHTML = caps.map(c =>
      '<div class="cap-item"><div><span class="cap-id">' + c.id + '</span>' +
      (c.streaming ? '<span class="tag">stream</span>' : '') + '</div>' +
      '<div class="cap-desc">' + c.description + '</div></div>').join('');
  }
}

function buildChat() {
  const el = document.getElementById('comp-chat');
  if (!el || el.dataset.built) return;
  el.dataset.built = '1';
  el.innerHTML =
    '<div id="messages">' +
    '<div class="msg assistant">Sky 能力 OS. AI 可调用所有 cap 含 UI 演进. 试试: "把主题换成 midnight" 或 "改聊天字号 18px"</div>' +
    '</div>' +
    '<div id="input-bar"><input id="input" type="text" placeholder="发送消息..." autocomplete="off" enterkeyhint="send">' +
    '<button id="send-btn"><svg><use href="#ic-send"/></svg></button></div>';
  const btn = document.getElementById('send-btn');
  btn.onclick = send;
  const input = document.getElementById('input');
  input.onkeydown = (e) => { if (e.key === 'Enter' && !btn.disabled) send(); };
  input.addEventListener('focus', () => setTimeout(scrollMessages, 300));
}

// ---------------------------------------------------------------- 工具块 (调用+结果合并)
// running → ok/err, 默认折叠, 点击展开
// 分组折叠: 连续工具块超阈值 (默认 5) 时, 旧块折叠成"展开 N 个"按钮
const toolBlocks = new Map(); // name+round → { el, head, body, argsStr, resultStr, status }
let currentRoundBlocks = []; // 本轮连续工具块 (send 时清空, stream.end 时全折叠)

function toolBlockKey(name, ev) {
  return name + '#' + (ev.data?.callSeq ?? ev._seq ?? '');
}

function ensureToolGroup() {
  // 确保 messages 下有当前 tool-group 容器; 没有则创建
  const messages = document.getElementById('messages');
  if (!messages) return null;
  let group = messages.querySelector('.tool-group:last-child');
  if (!group || group.dataset.closed === '1') {
    group = document.createElement('div');
    group.className = 'tool-group';
    messages.appendChild(group);
    currentRoundBlocks = [];
  }
  return group;
}

function applyToolGroupFolding(group) {
  const cfg = (uiState && uiState.chat) || {};
  const threshold = cfg.toolCollapseThreshold ?? 5;
  const maxVisible = cfg.toolMaxVisible ?? 4;
  const blocks = [...group.querySelectorAll('.tool-block')];
  if (blocks.length <= threshold) {
    // 未超阈值: 全部可见, 移除折叠按钮
    blocks.forEach(b => b.classList.remove('folded-hidden'));
    const more = group.querySelector('.tool-group-more');
    if (more) more.remove();
    return;
  }
  // 超阈值: 隐藏第 maxVisible+1 起的块, 显示"展开 N 个"按钮
  const hidden = blocks.slice(maxVisible);
  hidden.forEach(b => b.classList.add('folded-hidden'));
  let more = group.querySelector('.tool-group-more');
  if (!more) {
    more = document.createElement('div');
    more.className = 'tool-group-more';
    more.innerHTML = '<svg><use href="#ic-chev"/></svg><span class="more-label">展开剩余</span><span class="more-count"></span>';
    more.onclick = () => group.classList.toggle('expanded');
    group.appendChild(more);
  }
  more.querySelector('.more-count').textContent = hidden.length;
}

function addToolCall(ev) {
  const messages = document.getElementById('messages');
  if (!messages) return;
  const cfg = (uiState && uiState.chat) || {};
  const group = ensureToolGroup();
  const seq = (ev.data?.callSeq ?? Date.now().toString(36));
  const key = ev.data.name + '#' + seq;
  const argsStr = cfg.toolShowFullArgs
    ? JSON.stringify(ev.data.args, null, 2)
    : JSON.stringify(ev.data.args).slice(0, cfg.toolSummaryLen || 120);
  const summary = ev.data.name + '(' + (cfg.toolShowFullArgs ? '' : (argsStr.length < JSON.stringify(ev.data.args).length ? argsStr + '…' : argsStr)) + ')';

  const block = document.createElement('div');
  block.className = 'tool-block running' + (cfg.toolStyle === 'card' ? ' card' : '');
  block.dataset.key = key;

  const head = document.createElement('div');
  head.className = 'tool-head';
  head.innerHTML =
    '<svg class="tool-icon"><use href="#ic-loader"/></svg>' +
    '<span class="tool-name">' + esc(ev.data.name) + '</span>' +
    '<span class="tool-summary">' + esc(summary) + '</span>' +
    '<svg class="tool-chev"><use href="#ic-chev"/></svg>';

  const body = document.createElement('div');
  body.className = 'tool-body';
  body.innerHTML =
    '<div class="tool-section">参数</div><div class="tool-json">' + esc(argsStr) + '</div>' +
    '<div class="tool-section">结果</div><div class="tool-json tool-result-pending">等待中…</div>';

  block.appendChild(head);
  block.appendChild(body);
  head.onclick = () => block.classList.toggle('expanded');

  // 默认展开行为: toolCollapsed=true → 折叠; false → 展开
  if (cfg.toolCollapsed === false) block.classList.add('expanded');

  if (group) {
    group.appendChild(block);
    currentRoundBlocks.push(key);
    applyToolGroupFolding(group);
  } else {
    messages.appendChild(block);
  }
  toolBlocks.set(key, { el: block, head, body, argsStr, status: 'running' });
  scrollMessages();
}

function addToolResult(ev) {
  // 找最近一个同名 running 块 (支持多次同 cap 调用: 取最后一个 running)
  const cfg = (uiState && uiState.chat) || {};
  let target = null, targetKey = null;
  for (const [k, v] of [...toolBlocks].reverse()) {
    if (k.startsWith(ev.data.name + '#') && v.status === 'running') {
      target = v; targetKey = k; break;
    }
  }
  const resultStr = cfg.toolShowFullArgs
    ? JSON.stringify(ev.data.result, null, 2)
    : JSON.stringify(ev.data.result).slice(0, cfg.toolSummaryLen || 120);
  if (!target) {
    // 没匹配到调用块 (跨流/丢失), 单独建一个 ok 块
    addToolCall({ data: { name: ev.data.name, args: {}, callSeq: Date.now().toString(36) + '-x' } });
    const lastKey = [...toolBlocks].pop()[0];
    target = toolBlocks.get(lastKey); targetKey = lastKey;
  }
  const ok = ev.data.result?.ok;
  target.status = ok ? 'ok' : 'err';
  target.el.classList.remove('running');
  target.el.classList.add(ok ? 'ok' : 'err');
  // 状态图标
  const iconUse = target.head.querySelector('.tool-icon use');
  iconUse.setAttribute('href', ok ? '#ic-check' : '#ic-x');
  // 结果区
  const pending = target.body.querySelector('.tool-result-pending');
  pending.classList.remove('tool-result-pending');
  pending.classList.add(ok ? 'tool-result-ok' : 'tool-result-err');
  pending.textContent = ok ? '成功' : '失败';
  const resultJson = document.createElement('div');
  resultJson.className = 'tool-json';
  resultJson.textContent = resultStr + (cfg.toolShowFullArgs ? '' : (JSON.stringify(ev.data.result).length > (cfg.toolSummaryLen||120) ? '…' : ''));
  pending.after(resultJson);
  scrollMessages();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------------------------------------------------------------- 基础 Markdown (assistant)
function renderMarkdown(text) {
  // 转义后处理: 代码块 → 行内代码 → 粗体 → 段落
  // (模板字符串内不能出现反引号, 用 String.fromCharCode 构造)
  const BT = String.fromCharCode(96);
  const fence = BT + BT + BT;
  let html = esc(text);
  const reFence = new RegExp(fence + '(\\\\w*)\\\\n([\\\\s\\\\S]*?)' + fence, 'g');
  html = html.replace(reFence, (_, lang, code) =>
    '<pre><code>' + code.replace(/&quot;/g,'"') + '</code></pre>');
  const reInline = new RegExp(BT + '([^' + BT + '\\\\n]+)' + BT, 'g');
  html = html.replace(reInline, '<code>$1</code>');
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  html = html.split(/\\n{2,}/).map(p => '<p>' + p.replace(/\\n/g, '<br>') + '</p>').join('');
  return html;
}

function addMsg(cls, text) {
  const messages = document.getElementById('messages');
  if (!messages) return null;
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  const cfg = (uiState && uiState.chat) || {};
  if (cls === 'assistant' && cfg.markdownEnabled !== false) {
    el.innerHTML = renderMarkdown(text);
  } else {
    el.textContent = text;
  }
  messages.appendChild(el);
  scrollMessages();
  return el;
}

function send() {
  const input = document.getElementById('input');
  const btn = document.getElementById('send-btn');
  const text = input.value.trim();
  if (!text) return;
  addMsg('user', text);
  input.value = '';
  btn.disabled = true;
  currentMsgEl = addMsg('assistant', '');
  currentStreamId = null;
  pendingEvents.length = 0;
  // 续聊: 若 session-id 为空, 自动生成并填入 (下一轮起带历史)
  const sessionIdEl = document.getElementById('session-id');
  let sessionId = (sessionIdEl && sessionIdEl.value) || '';
  if (!sessionId) {
    sessionId = 'session-' + Date.now().toString(36);
    if (sessionIdEl) sessionIdEl.value = sessionId;
  }
  // 标记上一轮 tool-group 关闭 (新一轮工具调用会建新 group)
  const messages = document.getElementById('messages');
  if (messages) {
    messages.querySelectorAll('.tool-group').forEach(g => { g.dataset.closed = '1'; });
  }
  currentRoundBlocks = [];
  const msg = {
    type: 'dispatch', reqId: 'req-' + Date.now().toString(36),
    cap: 'cap.ai.chat', stream: true,
    params: { messages: [{ role: 'user', content: text }], sessionId },
  };
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  else pendingDispatch.push(msg);
}

function buildConfig() {
  const el = document.getElementById('comp-config');
  if (!el || el.dataset.built) return;
  el.dataset.built = '1';
  el.innerHTML =
    '<h2>AI 配置</h2>' +
    '<div class="field"><label>Base URL</label><input id="base-url" type="text" placeholder="https://api.openai.com"></div>' +
    '<div class="field"><label>API Key</label><input id="api-key" type="password" placeholder="sk-..."></div>' +
    '<div class="field"><label>Model</label><input id="model" type="text" placeholder="gpt-4o-mini"></div>' +
    '<button class="btn" id="save-config">保存配置</button><div class="status" id="config-status"></div>' +
    '<h2 style="margin-top:20px">会话</h2><div class="field"><label>Session ID</label><input id="session-id" type="text" placeholder="留空=不持久化"></div>' +
    '<button class="btn secondary" id="new-session">新会话</button>';
  fetch('/api/config').then(r=>r.json()).then(r => {
    const cfg = r.result?.ok ? r.result.data : {};
    document.getElementById('base-url').value = cfg.ai?.baseUrl || '';
    document.getElementById('api-key').value = cfg.ai?.apiKey || '';
    document.getElementById('model').value = cfg.ai?.model || 'gpt-4o-mini';
  });
  document.getElementById('save-config').onclick = async () => {
    const status = document.getElementById('config-status');
    status.textContent = '保存中...'; status.className = 'status';
    const r = await fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ai: {
        baseUrl: document.getElementById('base-url').value,
        apiKey: document.getElementById('api-key').value,
        model: document.getElementById('model').value || 'gpt-4o-mini',
      }})}).then(r=>r.json());
    if (r.result?.ok) { status.textContent = '已保存'; status.className = 'status ok'; }
    else { status.textContent = '失败: ' + (r.result?.error || '未知错误'); status.className = 'status err'; }
  };
  document.getElementById('new-session').onclick = () => {
    document.getElementById('session-id').value = 'session-' + Date.now().toString(36);
    const messages = document.getElementById('messages');
    if (messages) messages.innerHTML = '';
  };
}

// ---------------------------------------------------------------- 事件
function handleEvent(ev) {
  if (ev.type === 'ui.update') { uiState = ev.data; render(); return; }
  if (ev.type === 'shell.notify') { addMsg('assistant', '[通知] ' + (ev.data?.message||'')); return; }
  if (ev.type === 'shell.reload') { location.reload(); return; }
  if (ev.stream_id !== currentStreamId) {
    if (currentStreamId === null && ev.type.startsWith('stream.')) pendingEvents.push(ev);
    return;
  }
  switch (ev.type) {
    case 'stream.chunk':
      if (currentMsgEl) {
        const cfg = (uiState && uiState.chat) || {};
        if (cfg.markdownEnabled !== false) {
          currentMsgEl._raw = (currentMsgEl._raw || '') + ev.data;
          currentMsgEl.innerHTML = renderMarkdown(currentMsgEl._raw);
        } else {
          currentMsgEl.textContent += ev.data;
        }
        scrollMessages();
      }
      break;
    case 'stream.tool': addToolCall(ev); break;
    case 'stream.toolResult': addToolResult(ev); break;
    case 'stream.end':
      currentStreamId = null;
      const btn = document.getElementById('send-btn');
      if (btn) btn.disabled = false;
      // 流式结束: 自动折叠本轮所有工具块 (autoCollapseOnEnd 默认 true, 对齐 Polaris)
      collapseCurrentRound();
      break;
  }
}

function collapseCurrentRound() {
  const cfg = (uiState && uiState.chat) || {};
  if (cfg.autoCollapseOnEnd === false) return;
  currentRoundBlocks.forEach(key => {
    const entry = toolBlocks.get(key);
    if (entry) {
      entry.el.classList.remove('expanded');
      entry.el.classList.add('folded');
    }
  });
  // 折叠当前 tool-group (隐藏"展开更多")
  const messages = document.getElementById('messages');
  if (messages) {
    const group = messages.querySelector('.tool-group:last-child');
    if (group) group.dataset.closed = '1';
  }
}

function kebab(s) { return s.replace(/([A-Z])/g, '-$1').toLowerCase(); }

// ---------------------------------------------------------------- 启动
connectWs();
// 构建组件 (页面结构静态, 不随 UI State 重建, theme/styles 热更新即可)
buildChat();
buildConfig();
loadCaps();
// 初始化激活默认页 (聊天): 否则 .sky-page 全 display:none, 内容不可见
switchPage('page-chat');
fetch('/api/ui-state').then(r=>r.json()).then(r => {
  if (r && r.theme) { uiState = r; render(); }
}).catch(()=>{});
</script>
</body>
</html>`;
