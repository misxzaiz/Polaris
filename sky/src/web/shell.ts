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
  .tab-btn .icon { font-size: 18px; line-height: 1; }

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
  }
  .msg {
    padding: 10px 12px; border-radius: var(--sky-md, 6px); margin-bottom: 8px;
    max-width: 88%; word-wrap: break-word; white-space: pre-wrap;
    font-size: 15px; line-height: 1.5;
  }
  .msg.user { background: var(--sky-primary, #1f6feb); color: #fff; margin-left: auto; border-bottom-right-radius: 2px; }
  .msg.assistant { background: var(--sky-bg-elevated, #161b22); border-bottom-left-radius: 2px; }
  .msg.tool { background: var(--sky-border, #21262d); font-family: var(--sky-mono, monospace); font-size: 12px; color: var(--sky-text-muted, #8b949e); }
  .msg.toolResult { background: var(--sky-bg, #0d1117); border: 1px solid var(--sky-border, #21262d); font-family: var(--sky-mono, monospace); font-size: 12px; max-width: 95%; }
  #input-bar {
    display: flex; gap: 8px;
    padding: 10px 12px calc(10px + var(--safe-bottom));
    border-top: 1px solid var(--sky-border, #21262d);
    background: var(--sky-bg-elevated, #161b22);
    flex-shrink: 0;
    /* 键盘弹出时由 JS 调整 padding-bottom */
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
  }
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
    <button class="tab-btn" data-page="page-caps"><span class="icon">⚡</span>Caps</button>
    <button class="tab-btn active" data-page="page-chat"><span class="icon">💬</span>聊天</button>
    <button class="tab-btn" data-page="page-settings"><span class="icon">⚙️</span>设置</button>
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
    '<div class="msg assistant">Sky 能力 OS (手机端). AI 可调用所有 cap 含 UI 演进. 试试: "把主题换成 midnight"</div>' +
    '</div>' +
    '<div id="input-bar"><input id="input" type="text" placeholder="发送消息..." autocomplete="off" enterkeyhint="send">' +
    '<button id="send-btn">发送</button></div>';
  const btn = document.getElementById('send-btn');
  btn.onclick = send;
  const input = document.getElementById('input');
  input.onkeydown = (e) => { if (e.key === 'Enter' && !btn.disabled) send(); };
  // iOS: 聚焦滚动到底
  input.addEventListener('focus', () => setTimeout(scrollMessages, 300));
}

function addMsg(cls, text) {
  const messages = document.getElementById('messages');
  if (!messages) return null;
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.textContent = text;
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
  const sessionIdEl = document.getElementById('session-id');
  const msg = {
    type: 'dispatch', reqId: 'req-' + Date.now().toString(36),
    cap: 'cap.ai.chat', stream: true,
    params: { messages: [{ role: 'user', content: text }], sessionId: (sessionIdEl && sessionIdEl.value) || undefined },
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
    if (r.result?.ok) { status.textContent = '✓ 已保存'; status.className = 'status ok'; }
    else { status.textContent = '✗ ' + (r.result?.error || '失败'); status.className = 'status err'; }
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
  if (ev.type === 'shell.notify') { addMsg('tool', '📢 ' + (ev.data?.message||'')); return; }
  if (ev.type === 'shell.reload') { location.reload(); return; }
  if (ev.stream_id !== currentStreamId) {
    if (currentStreamId === null && ev.type.startsWith('stream.')) pendingEvents.push(ev);
    return;
  }
  switch (ev.type) {
    case 'stream.chunk':
      if (currentMsgEl) { currentMsgEl.textContent += ev.data; scrollMessages(); }
      break;
    case 'stream.tool': addMsg('tool', '🔧 ' + ev.data.name + '(' + JSON.stringify(ev.data.args).slice(0,200) + ')'); break;
    case 'stream.toolResult': addMsg('toolResult', '→ ' + ev.data.name + ': ' + JSON.stringify(ev.data.result).slice(0,400)); break;
    case 'stream.end':
      currentStreamId = null;
      const btn = document.getElementById('send-btn');
      if (btn) btn.disabled = false;
      if (ev.data && ev.data.maxRoundsHit) addMsg('tool', '⚠ 达到最大工具调用轮数');
      break;
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
