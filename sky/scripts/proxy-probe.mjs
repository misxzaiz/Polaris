/**
 * 复刻 sky 的真实 AI 请求 (含全部工具定义) — 看流式返回里到底有什么
 */
const BASE_PROXY = 'http://localhost:9850/v1';
const KEY = 'sk-NfG41BEMNGNKTXxK7ghPB43dDuM4eJB7twyi0dKxRzC2wq6H';

// 拿 sky 的工具列表 (和 ai.ts buildTools 一致: 所有 cap)
const MASTER = process.env.SKY_TOKEN || '';
const capsR = await fetch('http://127.0.0.1:9825/api/caps', {
  headers: MASTER ? { Authorization: 'Bearer ' + MASTER } : {},
}).then(r => r.json());
const tools = (capsR.caps || [])
  .filter(c => c.id !== 'cap.ai.chat')
  .map(c => ({ type: 'function', function: { name: c.id, description: c.description, parameters: c.inputSchema } }));
console.log('[1] 工具数:', tools.length, '| caps HTTP 原始数:', (capsR.caps || []).length);

const body = {
  model: 'sensenova-6.8-flash-lite',
  messages: [{ role: 'user', content: '用一句话回答：天空为什么是蓝色的' }],
  stream: true,
  max_tokens: 4096,
  tools,
  tool_choice: 'auto',
};

const resp = await fetch(BASE_PROXY + '/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
  body: JSON.stringify(body),
});
console.log('[2] HTTP', resp.status);
if (!resp.ok) { console.log('错误体:', (await resp.text()).slice(0, 300)); process.exit(1); }

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buf = '', reasoning = 0, content = 0, finish = '', sampleC = '', rawLines = 0, nonData = [];
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    rawLines++;
    if (!t.startsWith('data:')) { if (nonData.length < 3) nonData.push(t.slice(0, 80)); continue; }
    const data = t.slice(5).trim();
    if (data === '[DONE]') continue;
    try {
      const j = JSON.parse(data);
      const ch = j.choices && j.choices[0];
      const delta = (ch && ch.delta) || {};
      if (delta.reasoning_content) reasoning++;
      if (delta.content) { content++; if (!sampleC) sampleC = delta.content.slice(0, 60); }
      if (ch && ch.finish_reason) finish = ch.finish_reason;
    } catch (e) { if (nonData.length < 3) nonData.push('PARSE-FAIL: ' + t.slice(0, 80)); }
  }
}
console.log('[3] 总行数:', rawLines, '| reasoning 块:', reasoning, '| content 块:', content);
console.log('[4] 首个 content:', JSON.stringify(sampleC));
console.log('[5] finish:', finish);
console.log('[6] 非 data 行样例:', JSON.stringify(nonData));
