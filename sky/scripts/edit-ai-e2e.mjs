/**
 * AI × cap.edit 端到端 — 让真实 AI 用 search/read/replace 完成一次编辑任务
 *
 * 场景: 临时工作区有一个含 bug 的小程序, 让 AI 用 cap.edit 找到并修复.
 * 验收: AI 的工具序列应出现 cap.edit search/read/replace (而不是 cap.fs 整文件
 * 覆盖或 cap.bash 绕路), 且磁盘内容真实修复.
 *
 * 前置: dev 模式 Core + AI 代理可用. 用法: node scripts/edit-ai-e2e.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from '../node_modules/ws/wrapper.mjs';

const BASE = 'http://127.0.0.1:9825';
const HOST = '127.0.0.1:9825';

async function dispatch(cap, params) {
  const r = await fetch(BASE + '/api/dispatch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cap, params }),
  });
  const j = await r.json().catch(() => null);
  return j?.result?.data ?? null;
}

const wsDir = mkdtempSync(join(tmpdir(), 'sky-edit-ai-'));
mkdirSync(join(wsDir, 'src'), { recursive: true });
writeFileSync(join(wsDir, 'src', 'calc.ts'), [
  'export function add(a: number, b: number) {',
  '  return a - b; // FIXME: 这里写错了, 应该是加法',
  '}',
  '',
  'export function format(n: number) {',
  '  return `result=${n}`;',
  '}',
  '',
].join('\n'));
writeFileSync(join(wsDir, 'README.md'), '# demo\n\nadd(a, b) 应返回 a + b\n');

console.log('[1] 设置临时工作区:', wsDir);
const setR = await dispatch('cap.workspace', { action: 'set', root: wsDir, name: 'edit-ai-e2e' });
if (!setR?.ok) { console.error('set 工作区失败', setR); process.exit(1); }

console.log('[2] 连接 WS 跑 AI 工具循环');
const ws = new WebSocket(`ws://${HOST}/ws`);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

const toolCalls = [];
const events = [];
let streamDone = false;
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'event') {
    const ev = msg.event;
    events.push(ev);
    if (ev.type === 'stream.tool') toolCalls.push({ name: ev.data?.name, args: ev.data?.args });
    if (ev.type === 'stream.end') streamDone = true;
  }
});

ws.send(JSON.stringify({
  type: 'dispatch', reqId: 'ai-edit-1', cap: 'cap.ai.chat', stream: true,
  params: { messages: [{ role: 'user', content:
    '工作区 src/calc.ts 里有个 FIXME 标记的 bug: add 函数把加法写成了减法. ' +
    '请用 cap.edit (search 找到位置, read 看上下文, replace 修复), 把 `return a - b;` 修复为 `return a + b;`, ' +
    '同时删掉行尾的 FIXME 注释. 只做这个修复, 不要动其他文件, 完成后简短报告.' }] },
}));

// 等待流结束 (上限 120s)
const t0 = Date.now();
while (!streamDone && Date.now() - t0 < 120_000) await new Promise(r => setTimeout(r, 500));
ws.close();

console.log('[3] AI 工具序列:');
for (const t of toolCalls) console.log(`    ${t.name} ${JSON.stringify(t.args ?? {}).slice(0, 110)}`);

const disk = readFileSync(join(wsDir, 'src', 'calc.ts'), 'utf8');
const fixed = disk.includes('return a + b;') && !disk.includes('FIXME');
const usedEdit = toolCalls.some(t => t.name === 'cap.edit');
const usedSearch = toolCalls.some(t => t.name === 'cap.edit' && /search|"action"\s*:\s*"search"/.test(JSON.stringify(t.args ?? {})));
const usedReplace = toolCalls.some(t => t.name === 'cap.edit' && /replace/.test(JSON.stringify(t.args ?? {})));
const noFullOverwrite = !toolCalls.some(t => t.name === 'cap.fs' && /write/.test(JSON.stringify(t.args ?? {})));

console.log('[4] 磁盘修复:', fixed);
console.log(`[5] 判定: 用了 cap.edit=${usedEdit} search=${usedSearch} replace=${usedReplace} 无 cap.fs 整写=${noFullOverwrite} 流结束=${streamDone}`);

// 清理
await dispatch('cap.workspace', { action: 'delete', id: (await dispatch('cap.workspace', { action: 'list' }))?.workspaces?.find(w => w.name === 'edit-ai-e2e')?.id, force: true });
rmSync(wsDir, { recursive: true, force: true });

const allOk = fixed && usedEdit && usedReplace && streamDone;
console.log(allOk ? '\n===== AI × cap.edit 端到端: PASS =====' : '\n===== FAIL =====');
process.exit(allOk ? 0 : 1);
