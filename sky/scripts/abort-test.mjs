/**
 * abort 链路隔离测试: 独立 WS 客户端 (reply 监听在发送前挂好)
 */
import WebSocket from '../node_modules/ws/wrapper.mjs';

const HOST = '127.0.0.1:9825';
const ws = new WebSocket(`ws://${HOST}/ws`);
const events = [];
const waiters = [];

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'event') {
    events.push(msg.event);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].check(msg.event)) { waiters.splice(i, 1)[0].resolve(msg.event); }
    }
  }
});
ws.on('open', () => console.log('[1] WS 已连接'));

await new Promise((res) => { if (ws.readyState === 1) res(); else ws.on('open', res); });

const reqId = 'abort-test-1';
const gotStreamId = new Promise((resolve) => {
  const h = (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'reply' && msg.reqId === reqId) {
      ws.off('message', h);
      resolve(msg.reply?.result?.data?.streamId || null);
    }
  };
  ws.on('message', h);
});
ws.send(JSON.stringify({
  type: 'dispatch', reqId, cap: 'cap.ai.chat', stream: true,
  params: { messages: [{ role: 'user', content: '写一篇 2000 字的短文介绍宇宙' }] },
}));

const streamId = await gotStreamId;
console.log('[2] streamId:', streamId);
if (!streamId) { console.log('FAIL: 未拿到 streamId'); process.exit(1); }

await new Promise(r => setTimeout(r, 4000));
const chunksBefore = events.filter(e => e.type === 'stream.chunk').length;
console.log('[3] abort 前 chunk 数:', chunksBefore);

ws.send(JSON.stringify({ type: 'stream.abort', streamId }));
console.log('[4] 已发送 stream.abort');

const end = await new Promise((resolve) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const e = events.find(e => e.type === 'stream.end');
    if (e) { clearInterval(iv); resolve(e); }
    if (Date.now() - t0 > 8000) { clearInterval(iv); resolve(null); }
  }, 300);
});
console.log('[5] stream.end:', end ? JSON.stringify(end.data).slice(0, 120) : '未收到 (8s 超时)');
ws.close();
console.log(end && end.data && end.data.aborted ? '===== ABORT 链路 PASS =====' : '===== ABORT 链路 FAIL =====');
process.exit(0);
