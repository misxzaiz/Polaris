/**
 * Web Shell — 响应式 UI State 渲染器
 *
 * 前端 = UI State 的渲染结果. AI 改状态 (cap.ui.*) → WS 推 ui.update → 重渲染.
 *
 * 四层渲染:
 * 1. theme tokens → CSS 变量 (:root)
 * 2. layout 树 → grid 结构
 * 3. components → 挂到 region
 * 4. styles → 注入 <style>
 *
 * Shell 反向注册: 连 WS 后声明提供 cap.ui.observe (screenshot/inspect/metrics),
 * 后端经 shell-invoke 反向调用, AI 能"看见"渲染效果 (闭环演进).
 */

export const SHELL_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sky · Capability OS</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font: var(--sky-size)/var(--sky-line-height) var(--sky-font);
    background: var(--sky-bg); color: var(--sky-text);
    overflow: hidden;
  }
  #sky-root { display: grid; height: 100vh; }
  .sky-region { overflow: auto; border-right: 1px solid var(--sky-border); padding: var(--sky-md); }
  .sky-region:last-child { border-right: none; }
  h2 { font-size: var(--sky-size-sm); text-transform: uppercase; color: var(--sky-text-muted); letter-spacing: 0.5px; margin-bottom: var(--sky-sm); }
  .cap-item { background: var(--sky-bg-elevated); padding: var(--sky-sm) calc(var(--sky-sm) + 2px); border-radius: var(--sky-md); margin-bottom: 6px; font-size: var(--sky-size-sm); }
  .cap-id { color: var(--sky-accent); font-family: var(--sky-mono); }
  .cap-desc { color: var(--sky-text-muted); margin-top: 2px; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: var(--sky-sm); background: var(--sky-primary); color: #fff; font-size: 10px; margin-left: 6px; }
  .msg { padding: var(--sky-sm) calc(var(--sky-sm) + 2px); border-radius: var(--sky-md); margin-bottom: var(--sky-sm); max-width: 85%; word-wrap: break-word; white-space: pre-wrap; }
  .msg.user { background: var(--sky-primary); color: #fff; margin-left: auto; }
  .msg.assistant { background: var(--sky-bg-elevated); }
  .msg.tool { background: var(--sky-border); font-family: var(--sky-mono); font-size: var(--sky-size-sm); color: var(--sky-text-muted); }
  .msg.toolResult { background: var(--sky-bg); border: 1px solid var(--sky-border); font-family: var(--sky-mono); font-size: var(--sky-size-sm); }
  .input-row { display: flex; gap: var(--sky-sm); padding: calc(var(--sky-sm) + 4px); border-top: 1px solid var(--sky-border); }
  .input-row input { flex: 1; background: var(--sky-bg-input); border: 1px solid var(--sky-border); color: var(--sky-text); border-radius: var(--sky-md); padding: var(--sky-sm) calc(var(--sky-sm) + 4px); font: inherit; }
  .input-row button { background: var(--sky-success); color: #fff; border: none; border-radius: var(--sky-md); padding: 0 var(--sky-lg); cursor: pointer; }
  .input-row button:disabled { opacity: 0.5; cursor: not-allowed; }
  .chat-area { flex: 1; overflow: auto; padding: var(--sky-md); display: flex; flex-direction: column; }
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 11px; color: var(--sky-text-muted); margin-bottom: 4px; }
  .field input { width: 100%; background: var(--sky-bg-input); border: 1px solid var(--sky-border); color: var(--sky-text); border-radius: var(--sky-sm); padding: 6px var(--sky-sm); font: inherit; }
  .btn { background: var(--sky-primary); color: #fff; border: none; border-radius: var(--sky-sm); padding: 6px calc(var(--sky-sm) + 4px); cursor: pointer; font: inherit; }
  .btn.secondary { background: var(--sky-border); color: var(--sky-text); }
  .status { font-size: 11px; color: var(--sky-text-muted); margin-top: var(--sky-sm); }
  .status.ok { color: var(--sky-success); }
  .status.err { color: var(--sky-danger); }
  .side-panel > h2 { margin-top: var(--sky-lg); }
  .side-panel > h2:first-child { margin-top: 0; }
</style>
<style id="sky-dynamic"></style>
</head>
<body>
<div id="sky-root"></div>

<script>
// ===========================================================================
// Sky Shell runtime
// ===========================================================================
const $root = document.getElementById('sky-root');
const dynamicStyle = document.getElementById('sky-dynamic');
let ws = null;
let currentStreamId = null;
let currentMsgEl = null;
const pendingEvents = [];
const pendingDispatch = [];
let uiState = null;

// ---------------------------------------------------------------- WS
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = new URLSearchParams(location.search).get('token') || '';
  const url = proto + '://' + location.host + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');
  ws = new WebSocket(url);
  ws.onopen = () => {
    // 反向注册: 本 Shell 提供 cap.ui.observe
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
        document.getElementById('send-btn').disabled = false;
      }
    }
  };
  ws.onclose = () => setTimeout(connectWs, 1000);
}

// ------------------------------------------------- Shell invoke (前端执行 cap)
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
    // 无依赖截图: DOM 序列化 + 布局信息 (AI 可读结构)
    const html = document.documentElement.outerHTML;
    return {
      ok: true,
      type: 'dom-snapshot',
      note: 'DOM structure snapshot (no pixel capture in preview). Styles are in #sky-dynamic and :root CSS vars.',
      size: html.length,
      dom: html.slice(0, 50000),
      viewport: { w: innerWidth, h: innerHeight },
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
      rootRegions: [...$root.children].map(c => ({ id: c.id, w: c.offsetWidth, h: c.offsetHeight })),
      scrollY: scrollY,
      title: document.title,
    };
  }
  return { ok: false, error: 'unknown observe action: ' + p.action };
}

// ------------------------------------------------- UI State 渲染
function render() {
  if (!uiState) return;
  // 1. theme → CSS 变量
  const t = uiState.theme || {};
  let css = ':root{';
  for (const [k,v] of Object.entries(t.colors||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  for (const [k,v] of Object.entries(t.spacing||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  for (const [k,v] of Object.entries(t.typography||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  for (const [k,v] of Object.entries(t.shadows||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  for (const [k,v] of Object.entries(t.radii||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  css += '}';
  dynamicStyle.textContent = css;

  // 2. styles 注入
  for (const rule of (uiState.styles||[])) {
    css += rule.selector + '{' + Object.entries(rule.properties||{}).map(([k,v])=>kebab(k)+':'+v).join(';') + '}';
  }
  dynamicStyle.textContent = css;

  // 3. layout → grid columns
  const regions = uiState.layout?.children || [];
  const cols = regions.map(r => (r.props && r.props.width) ? r.props.width : '1fr');
  $root.style.gridTemplateColumns = cols.join(' ');

  // 4. components 挂到 region (保留 chat 动态内容: 仅首次创建, 之后只同步静态部分)
  const existing = new Map([...$root.children].map(c => [c.id, c]));
  for (const region of regions) {
    let el = existing.get(region.id);
    if (!el) {
      el = document.createElement('div');
      el.id = region.id;
      el.className = 'sky-region';
      $root.appendChild(el);
    }
    renderRegion(el, region);
  }
  // 移除多余 region
  for (const [id, el] of existing) {
    if (!regions.find(r => r.id === id)) el.remove();
  }
}

function renderRegion(el, region) {
  const comps = (uiState.components||[]).filter(c => c.mountPoint === region.id);
  // 对 chat 区: 保留已有动态子节点, 只补缺失组件
  for (const comp of comps) {
    let cel = document.getElementById('comp-' + comp.id);
    if (cel && cel.dataset.type === comp.type) {
      // custom 组件内容需更新
      if (comp.type === 'custom' && cel.innerHTML !== (comp.props.html||'')) {
        cel.innerHTML = comp.props.html || '';
        applyCompCss(comp);
      }
      continue;
    }
    cel = document.createElement('div');
    cel.id = 'comp-' + comp.id;
    cel.dataset.type = comp.type;
    // 先挂载到 DOM 再渲染组件 (组件内 bindXxx 需 getElementById 生效)
    el.appendChild(cel);
    renderComponent(cel, comp);
  }
  // 移除被删组件
  for (const child of [...el.children]) {
    const cid = child.id.replace('comp-','');
    if (child.id.startsWith('comp-') && !comps.find(c => c.id === cid)) child.remove();
  }
}

function renderComponent(el, comp) {
  switch (comp.type) {
    case 'caps-list':
      el.innerHTML = '<h2>Caps (<span id="cap-count">0</span>)</h2><div id="cap-list"></div>';
      loadCaps();
      break;
    case 'chat':
      el.innerHTML =
        '<div class="chat-area" id="messages">' +
        '<div class="msg assistant">Sky 能力 OS. AI 可调用所有 cap, 包括 UI 演进 (cap.ui.*). 试试: "把主题换成 midnight" 或 "给按钮加圆角".</div>' +
        '</div>' +
        '<div class="input-row"><input id="input" type="text" placeholder="发送消息..." autocomplete="off">' +
        '<button id="send-btn">发送</button></div>';
      bindChat();
      break;
    case 'config':
      el.className += ' side-panel';
      el.innerHTML =
        '<h2>AI 配置</h2>' +
        '<div class="field"><label>Base URL</label><input id="base-url" type="text" placeholder="https://api.openai.com"></div>' +
        '<div class="field"><label>API Key</label><input id="api-key" type="password" placeholder="sk-..."></div>' +
        '<div class="field"><label>Model</label><input id="model" type="text" placeholder="gpt-4o-mini"></div>' +
        '<button class="btn" id="save-config">保存配置</button><div class="status" id="config-status"></div>' +
        '<h2>会话</h2><div class="field"><label>Session ID</label><input id="session-id" type="text" placeholder="留空=不持久化"></div>' +
        '<button class="btn secondary" id="new-session">新会话</button>';
      bindConfig();
      break;
    case 'custom':
      el.innerHTML = comp.props.html || '';
      applyCompCss(comp);
      break;
    default:
      el.innerHTML = '<div class="cap-item">未知组件类型: ' + comp.type + '</div>';
  }
}

function applyCompCss(comp) {
  if (!comp.props.css) return;
  let s = document.getElementById('comp-style-' + comp.id);
  if (!s) {
    s = document.createElement('style');
    s.id = 'comp-style-' + comp.id;
    document.head.appendChild(s);
  }
  s.textContent = comp.props.css;
}

// ------------------------------------------------- 内置组件逻辑
async function loadCaps() {
  const r = await fetch('/api/caps').then(r=>r.json());
  const caps = r.caps || [];
  const cnt = document.getElementById('cap-count');
  const list = document.getElementById('cap-list');
  if (!cnt || !list) return;
  cnt.textContent = caps.length;
  list.innerHTML = caps.map(c =>
    '<div class="cap-item"><div><span class="cap-id">' + c.id + '</span>' +
    (c.streaming ? '<span class="tag">stream</span>' : '') + '</div>' +
    '<div class="cap-desc">' + c.description + '</div></div>').join('');
}

function bindChat() {
  const input = document.getElementById('input');
  const btn = document.getElementById('send-btn');
  if (!input || !btn) return;
  btn.onclick = send;
  input.onkeydown = (e) => { if (e.key === 'Enter' && !btn.disabled) send(); };
}

function addMsg(cls, text) {
  const messages = document.getElementById('messages');
  if (!messages) return null;
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.textContent = text;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
  return el;
}

async function send() {
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
  const sessionId = (document.getElementById('session-id')||{}).value || '';
  const msg = {
    type: 'dispatch', reqId: 'req-' + Date.now().toString(36),
    cap: 'cap.ai.chat', stream: true,
    params: { messages: [{ role: 'user', content: text }], sessionId: sessionId || undefined },
  };
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  else pendingDispatch.push(msg);
}

function bindConfig() {
  fetch('/api/config').then(r=>r.json()).then(r => {
    const cfg = r.result?.ok ? r.result.data : {};
    const bu = document.getElementById('base-url');
    const ak = document.getElementById('api-key');
    const mo = document.getElementById('model');
    if (bu) bu.value = cfg.ai?.baseUrl || '';
    if (ak) ak.value = cfg.ai?.apiKey || '';
    if (mo) mo.value = cfg.ai?.model || 'gpt-4o-mini';
  });
  const save = document.getElementById('save-config');
  if (save) save.onclick = async () => {
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
  const ns = document.getElementById('new-session');
  if (ns) ns.onclick = () => {
    document.getElementById('session-id').value = 'session-' + Date.now().toString(36);
    const messages = document.getElementById('messages');
    if (messages) messages.innerHTML = '';
  };
}

// ------------------------------------------------- 事件处理
function handleEvent(ev) {
  // UI State 更新 → 重渲染
  if (ev.type === 'ui.update') {
    uiState = ev.data;
    render();
    return;
  }
  if (ev.type === 'shell.notify') { addMsg('tool', '📢 ' + (ev.data?.message||'')); return; }
  if (ev.type === 'shell.reload') { location.reload(); return; }
  if (ev.stream_id !== currentStreamId) {
    // 流 ID 未定: 缓冲
    if (currentStreamId === null && ev.type.startsWith('stream.')) pendingEvents.push(ev);
    return;
  }
  switch (ev.type) {
    case 'stream.chunk': if (currentMsgEl) currentMsgEl.textContent += ev.data; break;
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

connectWs();
// 初始拉一次 UI State (防 WS 事件早于脚本就绪丢失)
fetch('/api/ui-state').then(r=>r.json()).then(r => {
  if (r && r.theme) { uiState = r; render(); }
}).catch(()=>{});
</script>
</body>
</html>`;
