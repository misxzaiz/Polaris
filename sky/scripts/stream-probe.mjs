/**
 * 服务端事件流隔离测试: 直接 dispatch_stream cap.ai.chat, 观察事件
 */
import WebSocket from '../node_modules/ws/wrapper.mjs';
const MASTER = process.env.SKY_TOKEN || '';

const ws = new WebSocket(`ws://127.0.0.1:9825/ws${MASTER ? '?token=' + encodeURIComponent(MASTER) : ''}`);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

const events = [];
let reply = null;
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'event') events.push(msg.event);
  if (msg.type === 'reply') reply = msg.reply;
  if (msg.type === 'error') console.log('[WS error]', msg.error);
});

ws.send(JSON.stringify({
  type: 'dispatch', reqId: 'probe-1', cap: 'cap.ai.chat', stream: true,
  params: { messages: [{ role: 'user', content: '用一句话回答：天空为什么是蓝色的' }] },
}));

// 等 reply
const t0 = Date.now();
while (!reply && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 200));
console.log('[1] reply:', JSON.stringify(reply && reply.result).slice(0, 120));
const streamId = reply && reply.result && reply.result.data && reply.result.data.streamId;

// 等 stream.end (最长 40s)
let end = null;
while (!end && Date.now() - t0 < 50000) {
  await new Promise(r => setTimeout(r, 300));
  end = events.find(e => e.type === 'stream.end');
}
const chunks = events.filter(e => e.type === 'stream.chunk');
const toolsEv = events.filter(e => e.type === 'stream.tool');
console.log('[2] chunk 数:', chunks.length, '| tool 数:', toolsEv.length);
console.log('[3] 内容拼接:', JSON.stringify(chunks.map(c => c.data).join('')).slice(0, 120));
console.log('[4] end:', JSON.stringify(end && end.data).slice(0, 150));
if (toolsEv.length) console.log('[5] 工具调用:', toolsEv.map(t => t.data && t.data.name).join(', '));
ws.close();
