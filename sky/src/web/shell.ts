/**
 * Web Shell HTML(内嵌避免文件依赖)
 *
 * 极简但功能完整:
 * - AI 对话(流式 + 工具调用可视化)
 * - Cap 列表
 * - 配置编辑(baseUrl/apiKey/model)
 * - Bash 任务面板(简版)
 */

export const SHELL_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sky · Capability OS Preview</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; }
  .app { display: grid; grid-template-columns: 240px 1fr 320px; height: 100vh; }
  .panel { border-right: 1px solid #21262d; padding: 16px; overflow: auto; }
  .main { display: flex; flex-direction: column; border-right: 1px solid #21262d; }
  .side { padding: 16px; overflow: auto; }
  h2 { font-size: 12px; text-transform: uppercase; color: #8b949e; letter-spacing: 0.5px; margin-bottom: 12px; }
  .cap-item { background: #161b22; padding: 8px 10px; border-radius: 6px; margin-bottom: 6px; font-size: 12px; }
  .cap-id { color: #58a6ff; font-family: ui-monospace, monospace; }
  .cap-desc { color: #8b949e; margin-top: 2px; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 3px; background: #1f6feb; color: #fff; font-size: 10px; margin-left: 6px; }
  .tag.stream { background: #238636; }
  .msg { padding: 8px 10px; border-radius: 6px; margin-bottom: 8px; max-width: 85%; word-wrap: break-word; white-space: pre-wrap; }
  .msg.user { background: #1f6feb; color: #fff; margin-left: auto; }
  .msg.assistant { background: #161b22; }
  .msg.tool { background: #21262d; font-family: monospace; font-size: 12px; color: #8b949e; }
  .msg.toolResult { background: #0d1117; border: 1px solid #21262d; font-family: monospace; font-size: 12px; }
  .tool-name { color: #f0883e; font-weight: 600; }
  .input-row { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #21262d; }
  .input-row input { flex: 1; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; border-radius: 6px; padding: 8px 12px; font: inherit; }
  .input-row button { background: #238636; color: #fff; border: none; border-radius: 6px; padding: 0 16px; cursor: pointer; }
  .input-row button:disabled { opacity: 0.5; cursor: not-allowed; }
  .messages { flex: 1; overflow: auto; padding: 16px; }
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 11px; color: #8b949e; margin-bottom: 4px; }
  .field input, .field textarea { width: 100%; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; border-radius: 4px; padding: 6px 8px; font: inherit; }
  .field textarea { resize: vertical; min-height: 60px; }
  .btn { background: #1f6feb; color: #fff; border: none; border-radius: 4px; padding: 6px 12px; cursor: pointer; font: inherit; }
  .btn.secondary { background: #21262d; color: #c9d1d9; }
  .status { font-size: 11px; color: #8b949e; margin-top: 8px; }
  .status.ok { color: #3fb950; }
  .status.err { color: #f85149; }
  details { margin-bottom: 8px; }
  summary { cursor: pointer; font-size: 12px; color: #58a6ff; }
  pre { background: #0d1117; padding: 8px; border-radius: 4px; overflow: auto; font-size: 11px; }
</style>
</head>
<body>
<div class="app">
  <div class="panel">
    <h2>Caps (<span id="cap-count">0</span>)</h2>
    <div id="cap-list"></div>
  </div>

  <div class="main">
    <div class="messages" id="messages">
      <div class="msg assistant">Sky 预览版. 先在右侧配置 AI (baseUrl + apiKey), 然后开始对话. AI 可调用左侧所有 cap (bash/kv/config/history 等).</div>
    </div>
    <div class="input-row">
      <input id="input" type="text" placeholder="发送消息..." autocomplete="off">
      <button id="send">发送</button>
    </div>
  </div>

  <div class="side">
    <h2>AI 配置</h2>
    <div class="field">
      <label>Base URL (OpenAI 兼容)</label>
      <input id="base-url" type="text" placeholder="https://api.openai.com">
    </div>
    <div class="field">
      <label>API Key</label>
      <input id="api-key" type="password" placeholder="sk-...">
    </div>
    <div class="field">
      <label>Model</label>
      <input id="model" type="text" placeholder="gpt-4o-mini">
    </div>
    <button class="btn" id="save-config">保存配置</button>
    <div class="status" id="config-status"></div>

    <h2 style="margin-top:24px">会话</h2>
    <div class="field">
      <label>Session ID</label>
      <input id="session-id" type="text" placeholder="留空=不持久化">
    </div>
    <button class="btn secondary" id="new-session">新会话</button>

    <h2 style="margin-top:24px">Token</h2>
    <input id="token" type="text" placeholder="服务端 token(本地可空)" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;border-radius:4px;padding:6px 8px;font:inherit">
  </div>
</div>

<script>
const $ = id => document.getElementById(id);
const messages = $('messages');
const input = $('input');
const sendBtn = $('send');
const sessionId = () => $('session-id').value || '';
const token = () => $('token').value || new URLSearchParams(location.search).get('token') || '';

let ws = null;
let currentStreamId = null;
let currentMsgEl = null;
// 缓冲: dispatch 返回 streamId 前到达的流事件暂存, streamId 确定后回放
const pendingEvents = [];
let wsReady = false;
// 待发送队列: WS 未就绪时缓存的 dispatch 请求
const pendingDispatch = [];

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = \`\${proto}://\${location.host}/ws\${token() ? '?token=' + encodeURIComponent(token()) : ''}\`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    wsReady = true;
    // flush 待发队列
    while (pendingDispatch.length) {
      const msg = pendingDispatch.shift();
      ws.send(JSON.stringify(msg));
    }
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'event') handleEvent(msg.event);
    else if (msg.type === 'reply') {
      // dispatch 的同步回复(含 streamId)
      const data = msg.reply?.result?.ok ? msg.reply.result.data : null;
      if (data && data.streamId) {
        currentStreamId = data.streamId;
        // 回放缓冲事件
        while (pendingEvents.length) {
          handleEvent(pendingEvents.shift());
        }
      } else if (!msg.reply?.result?.ok) {
        // 错误回复直接显示
        if (currentMsgEl) currentMsgEl.textContent = '错误: ' + JSON.stringify(msg.reply?.result?.error || msg.reply);
        sendBtn.disabled = false;
      }
    }
  };
  ws.onclose = () => { wsReady = false; setTimeout(connectWs, 1000); };
  ws.onerror = () => { /* onclose 会处理 */ };
}
connectWs();

function handleEvent(ev) {
  // currentStreamId 未定 → 缓冲(dispatch reply 还没到)
  if (currentStreamId === null) {
    pendingEvents.push(ev);
    return;
  }
  if (ev.stream_id !== currentStreamId) return;
  const data = ev.data;
  switch (ev.type) {
    case 'stream.chunk':
      if (currentMsgEl) currentMsgEl.textContent += data;
      break;
    case 'stream.tool':
      addMsg('tool', \`🔧 \${data.name}(\${JSON.stringify(data.args).slice(0,200)})\`);
      break;
    case 'stream.toolResult':
      addMsg('toolResult', \`→ \${data.name}: \${JSON.stringify(data.result).slice(0,500)}\`);
      break;
    case 'stream.end':
      currentStreamId = null;
      sendBtn.disabled = false;
      if (data && data.maxRoundsHit) addMsg('tool', '⚠ 达到最大工具调用轮数');
      break;
  }
}

function addMsg(cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.textContent = text;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
  return el;
}

async function send() {
  const text = input.value.trim();
  if (!text) return;
  addMsg('user', text);
  input.value = '';
  sendBtn.disabled = true;

  // 新建 assistant 消息气泡
  currentMsgEl = addMsg('assistant', '');

  // 重置流状态(准备接收新流)
  currentStreamId = null;
  pendingEvents.length = 0;

  // 用 WS 发 dispatch: reply(含 streamId) 和 stream.chunk 走同一通道,
  // 缓冲逻辑保证 chunk 早于 reply 到达时不丢失
  const reqId = 'req-' + Date.now().toString(36);
  const msg = {
    type: 'dispatch',
    reqId,
    cap: 'cap.ai.chat',
    stream: true,
    params: { messages: [{ role: 'user', content: text }], sessionId: sessionId() || undefined },
  };

  if (wsReady && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    // WS 未就绪 → 缓冲, onopen 时 flush
    pendingDispatch.push(msg);
    addMsg('tool', '(连接中, 消息已排队...)');
  }
}

sendBtn.onclick = send;
input.onkeydown = (e) => { if (e.key === 'Enter' && !sendBtn.disabled) send(); };

// 加载 caps
async function loadCaps() {
  const r = await fetch('/api/caps').then(r => r.json());
  const caps = r.caps || [];
  $('cap-count').textContent = caps.length;
  $('cap-list').innerHTML = caps.map(c => \`
    <div class="cap-item">
      <div><span class="cap-id">\${c.id}</span>\${c.streaming ? '<span class="tag stream">stream</span>' : ''}</div>
      <div class="cap-desc">\${c.description}</div>
    </div>\`).join('');
}
loadCaps();

// 加载配置
async function loadConfig() {
  const r = await fetch('/api/config').then(r => r.json());
  const cfg = r.result?.ok ? r.result.data : {};
  $('base-url').value = cfg.ai?.baseUrl || '';
  $('api-key').value = cfg.ai?.apiKey || '';
  $('model').value = cfg.ai?.model || 'gpt-4o-mini';
}
loadConfig();

$('save-config').onclick = async () => {
  const status = $('config-status');
  status.textContent = '保存中...';
  status.className = 'status';
  const r = await fetch('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai: {
      baseUrl: $('base-url').value, apiKey: $('api-key').value, model: $('model').value || 'gpt-4o-mini',
    }}),
  }).then(r => r.json());
  if (r.result?.ok) { status.textContent = '✓ 已保存'; status.className = 'status ok'; }
  else { status.textContent = '✗ ' + (r.result?.error || '失败'); status.className = 'status err'; }
};

$('new-session').onclick = () => {
  $('session-id').value = 'session-' + Date.now().toString(36);
  messages.innerHTML = '';
  addMsg('assistant', '新会话, 历史已清空(服务端 JSONL 保留)');
};
</script>
</body>
</html>`;
