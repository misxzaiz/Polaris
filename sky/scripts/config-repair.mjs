/**
 * 配置修复 — 把被误存为字符串的 config 还原为对象
 * (保留用户设置的 master token + authRequired, 恢复 ai 配置)
 */
const BASE = 'http://127.0.0.1:9825';

const r = await fetch(BASE + '/api/dispatch', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ cap: 'cap.config', params: { action: 'get' } }),
});
const reply = await r.json();
const raw = reply.result.data;
console.log('当前类型:', typeof raw);

let obj;
if (typeof raw === 'string') {
  obj = JSON.parse(raw);
  console.log('字符串已解析为对象, keys:', Object.keys(obj));
} else {
  obj = raw;
}

// 兜底补齐 ai (若丢失)
if (!obj.ai || !obj.ai.baseUrl) {
  obj.ai = {
    provider: 'openai-compatible',
    baseUrl: 'http://localhost:9850/v1',
    apiKey: 'sk-NfG41BEMNGNKTXxK7ghPB43dDuM4eJB7twyi0dKxRzC2wq6H',
    model: 'sensenova-6.8-flash-lite',
    maxTokens: 4096,
  };
  console.log('ai 配置已补齐');
}

// 用 set 整体写回 (对象)
const w = await fetch(BASE + '/api/dispatch', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ cap: 'cap.config', params: { action: 'set', value: obj } }),
});
const wr = await w.json();
console.log('写回:', wr.result.ok ? 'OK' : wr.result.error);

// 验证
const v = await fetch(BASE + '/api/dispatch', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ cap: 'cap.config', params: { action: 'get' } }),
});
const vr = (await v.json()).result.data;
console.log('验证: type =', typeof vr, '| ai.baseUrl =', vr.ai ? vr.ai.baseUrl : '(无 ai)');
console.log('验证: server.authRequired =', vr.server ? vr.server.authRequired : '(无 server)');
console.log(typeof vr === 'object' && vr.ai && vr.ai.baseUrl ? '===== 配置修复 PASS =====' : '===== FAIL =====');
