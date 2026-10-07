/**
 * cap.edit 端到端测试 — 工作区文件编辑 + 搜索
 *
 * 前置: dev 模式 Core 运行. 建临时工作区目录, set → 全动作 → 清理 → delete.
 * 用法: node scripts/edit-e2e.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:9825';
const MASTER = process.env.SKY_TOKEN || '';  // 强制认证开启时必需
let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

async function dispatch(cap, params) {
  const headers = { 'Content-Type': 'application/json' };
  if (MASTER) headers['Authorization'] = 'Bearer ' + MASTER;
  const r = await fetch(BASE + '/api/dispatch', {
    method: 'POST', headers,
    body: JSON.stringify({ cap, params }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, data: j?.result?.data ?? null, error: j?.result?.error };
}

async function waitCore() {
  for (let i = 0; i < 20; i++) {
    try { const r = await fetch(BASE + '/api/health'); if ((await r.json()).ok) return; } catch { /* retry */ }
    await new Promise(res => setTimeout(res, 500));
  }
  throw new Error('Core not up');
}

await waitCore();

// 前置: 恢复之前测试可能占用的工作区 (记下当前, 结束恢复)
const prevWs = await dispatch('cap.workspace', { action: 'get', includeTree: false });
const prevRoot = prevWs.data?.root ?? null;
const prevId = prevWs.data?.id ?? null;

// 临时工作区
const wsDir = mkdtempSync(join(tmpdir(), 'sky-edit-e2e-'));
mkdirSync(join(wsDir, 'src'), { recursive: true });
writeFileSync(join(wsDir, 'app.ts'), [
  'import { log } from "./src/util.ts";',
  '',
  'const name = "world";',
  'log("hello " + name);',
  'log("bye " + name);',
  '',
].join('\n'));
writeFileSync(join(wsDir, 'src', 'util.ts'), 'export function log(s: string) { console.log(s); }\n');
writeFileSync(join(wsDir, 'note.md'), '# title\n\nsome text here\n');

console.log('\n== set 工作区 ==');
{
  const r = await dispatch('cap.workspace', { action: 'set', root: wsDir, name: 'edit-e2e' });
  ok('set 临时工作区', r.data?.ok === true, JSON.stringify(r.data).slice(0, 120));

  const noWs = await dispatch('cap.edit', { action: 'read', path: 'app.ts' });
  ok('edit read 经工作区解析', noWs.data?.ok === true);
}

console.log('\n== read ==');
{
  const r = await dispatch('cap.edit', { action: 'read', path: 'app.ts' });
  ok('read 返回行号数组', Array.isArray(r.data?.lines) && r.data.lines.length === 6);
  ok('行号从 1 起', r.data.lines[0].n === 1 && r.data.lines[0].text.startsWith('import'));
  ok('total 正确', r.data.total === 6);

  const w = await dispatch('cap.edit', { action: 'read', path: 'app.ts', offsetLine: 3, limitLines: 2 });
  ok('offset/limit 分段', w.data.lines.length === 2 && w.data.lines[0].n === 3);

  const nf = await dispatch('cap.edit', { action: 'read', path: 'nope.ts' });
  ok('不存在 → notFound', nf.data?.ok === false && nf.data?.notFound === true);

  const esc = await dispatch('cap.edit', { action: 'read', path: '../outside.txt' });
  ok('越界拒绝', esc.reply?.result?.ok === false || esc.error, esc.error || JSON.stringify(esc.data));
}

console.log('\n== replace ==');
{
  // 唯一替换
  let r = await dispatch('cap.edit', { action: 'replace', path: 'app.ts', old: 'const name = "world";', new: 'const name = "sky";' });
  ok('唯一替换成功', r.data?.ok === true && r.data.replaced === 1);
  ok('替换后 snippet 带 3| 行', typeof r.data?.snippet === 'string' && r.data.snippet.includes('3|'), r.data?.snippet);

  // 多处匹配 → 拒绝并列出计数
  r = await dispatch('cap.edit', { action: 'replace', path: 'app.ts', old: '" + name', new: 'X' });
  ok('多处匹配拒绝', r.data?.ok === false && r.data?.occurrences === 2, JSON.stringify(r.data));

  r = await dispatch('cap.edit', { action: 'replace', path: 'app.ts', old: 'log("hello " + name);', new: 'log("HELLO " + name);' });
  ok('加上下文后唯一', r.data?.ok === true);

  // all=true
  r = await dispatch('cap.edit', { action: 'replace', path: 'app.ts', old: ' + name);', new: ' + name.toUpperCase());', all: true });
  ok('all=true 替换 2 处', r.data?.ok === true && r.data.replaced === 2, JSON.stringify(r.data));

  // 落盘验证
  const disk = readFileSync(join(wsDir, 'app.ts'), 'utf8');
  ok('磁盘内容已变更', disk.includes('HELLO') && disk.includes('toUpperCase()'));

  // 未找到
  r = await dispatch('cap.edit', { action: 'replace', path: 'app.ts', old: 'NOT_EXIST_TOKEN', new: 'x' });
  ok('未找到 → occurrences=0', r.data?.ok === false && r.data?.occurrences === 0);
}

console.log('\n== insert / deleteLines ==');
{
  let r = await dispatch('cap.edit', { action: 'insert', path: 'app.ts', line: 2, content: '// inserted by cap.edit' });
  ok('insert 返回插入位置', r.data?.ok === true && r.data.insertedAt === 3 && r.data.insertedLines === 1);
  const disk = readFileSync(join(wsDir, 'app.ts'), 'utf8');
  ok('insert 落盘', disk.split('\n')[2] === '// inserted by cap.edit');

  r = await dispatch('cap.edit', { action: 'insert', path: 'app.ts', line: 0, content: '// header' });
  ok('line=0 前插', r.data?.ok === true && r.data.insertedAt === 1);

  r = await dispatch('cap.edit', { action: 'deleteLines', path: 'app.ts', line: 1, count: 1 });
  ok('deleteLines 删 1 行', r.data?.ok === true && r.data.removedLines === 1);
  const disk2 = readFileSync(join(wsDir, 'app.ts'), 'utf8');
  ok('header 已删除', !disk2.startsWith('// header'));
  ok('注释仍在', disk2.includes('// inserted by cap.edit'));

  // 越界行号
  r = await dispatch('cap.edit', { action: 'insert', path: 'app.ts', line: 99999, content: 'x' });
  ok('行号越界报错', !!r.error && /beyond end of file/.test(r.error), JSON.stringify({ data: r.data, error: r.error }));

  // 越界报错不得污染 undo 栈: undo 应恢复的是最后一次成功操作之前的内容
  const beforeUndo = readFileSync(join(wsDir, 'app.ts'), 'utf8');
  await dispatch('cap.edit', { action: 'insert', path: 'app.ts', line: 99999, content: 'x' });
  const u0 = await dispatch('cap.edit', { action: 'undo', path: 'app.ts' });
  const afterUndo = readFileSync(join(wsDir, 'app.ts'), 'utf8');
  ok('失败操作不入 undo 栈', u0.data?.ok === true && afterUndo !== beforeUndo || u0.data?.ok === false, JSON.stringify(u0.data));
}

console.log('\n== undo ==');
{
  const before = readFileSync(join(wsDir, 'app.ts'), 'utf8');
  const r = await dispatch('cap.edit', { action: 'undo', path: 'app.ts' });
  ok('undo 成功', r.data?.ok === true && r.data.remainingUndos >= 0);
  const after = readFileSync(join(wsDir, 'app.ts'), 'utf8');
  ok('undo 恢复了上一步内容', before !== after, `before ${before.length}B after ${after.length}B`);
}

console.log('\n== search ==');
{
  const r = await dispatch('cap.edit', { action: 'search', path: '', query: 'log(' });
  ok('search 命中', r.data?.ok === true && r.data.matches >= 2, JSON.stringify(r.data).slice(0, 200));
  ok('路径相对工作区', r.data.results.every(x => !x.path.includes('\\') || x.path.includes('/')));

  const rr = await dispatch('cap.edit', { action: 'search', query: 'export function \\w+', regex: true });
  ok('regex 搜索', rr.data?.matches >= 1 && rr.data.results[0].path === 'src/util.ts', JSON.stringify(rr.data?.results));

  const gf = await dispatch('cap.edit', { action: 'search', query: 'title', glob: '.md' });
  ok('glob 过滤', gf.data?.matches === 1 && gf.data.results[0].path === 'note.md', JSON.stringify(gf.data?.results));
}

console.log('\n== 收尾 ==');
{
  // 恢复原工作区
  if (prevId) await dispatch('cap.workspace', { action: 'switch', id: prevId });
  else await dispatch('cap.workspace', { action: 'delete', id: (await dispatch('cap.workspace', { action: 'list' })).data?.workspaces?.find(w => w.name === 'edit-e2e')?.id, force: true });
  rmSync(wsDir, { recursive: true, force: true });
  ok('临时目录已清理', !existsSync(wsDir));
  const ws = await dispatch('cap.workspace', { action: 'get', includeTree: false });
  ok('工作区已恢复', ws.data?.root === prevRoot, JSON.stringify({ now: ws.data?.root, prev: prevRoot }));
}

console.log(`\n===== 结果: ${pass} pass / ${fail} fail =====`);
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
