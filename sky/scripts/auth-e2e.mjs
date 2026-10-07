/**
 * cap.auth 端到端测试 — Phase 1 (dev 模式) + Phase 2 (强制认证模式)
 *
 * Phase 1: dev 模式 (无 master token, 未强制认证)
 *   - verify 未认证; issue/list (dev=admin); revoke 后失效; config 密钥对 admin 明文
 * Phase 2: patch config 开启 authRequired + master token → 重启 Core
 *   - 无 token → 401 (除 health/verify/shell)
 *   - user token → dispatch 可用, cap.auth list 拒绝, config 密钥脱敏
 *   - admin token / master token → 管理操作可用, config 明文
 *   - WS: 无 token 关闭 4001, 有 token 正常
 *   - 吊销后 token 立即失效
 * 收尾: 恢复 dev 配置 + 清理 token 库 → 重启
 *
 * 用法: node scripts/auth-e2e.mjs
 */

import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:9825';
let pass = 0, fail = 0;
const failures = [];
let userTok = null, adminTok = null, masterTok = 'sk-master-e2e';

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch { /* ignore */ }
  return { status: r.status, data };
}

async function dispatch(cap, params, token) {
  const r = await api('/api/dispatch', { method: 'POST', token, body: { cap, params } });
  return { status: r.status, reply: r.data, data: r.data?.result?.data ?? null, error: r.data?.result?.error };
}

function restartCore() {
  console.log('  … 重启 Core');
  execSync(
    `powershell -NoProfile -Command "` +
    `$pid9825 = (Get-NetTCPConnection -LocalPort 9825 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; ` +
    `if ($pid9825) { Stop-Process -Id $pid9825 -Force }; Start-Sleep -Milliseconds 800; ` +
    `Start-Process -FilePath 'D:\\install\\nodejs\\node.exe' -ArgumentList '--require','D:\\space\\base\\Polaris\\sky\\node_modules\\tsx\\dist\\preflight.cjs','--import','file:///D:/space/base/Polaris/sky/node_modules/tsx/dist/loader.mjs','D:\\space\\base\\Polaris\\sky\\src\\main.ts' -WorkingDirectory 'D:\\space\\base\\Polaris\\sky' -WindowStyle Hidden; ` +
    `Start-Sleep -Seconds 3"`,
    { stdio: 'pipe', timeout: 30000 },
  );
}

async function waitCore() {
  for (let i = 0; i < 20; i++) {
    try { const r = await api('/api/health'); if (r.data?.ok) return r.data; } catch { /* retry */ }
    await new Promise(res => setTimeout(res, 500));
  }
  throw new Error('Core did not come up');
}

function wsProbe(token) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const url = BASE.replace('http', 'ws') + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return done({ opened: false, code: -1 }); }
    const timer = setTimeout(() => { try { ws.close(); } catch {} done({ opened: false, code: -2 }); }, 4000);
    ws.onopen = () => { clearTimeout(timer); ws.close(); done({ opened: true }); };
    ws.onclose = (ev) => { clearTimeout(timer); done({ opened: false, code: ev.code, reason: ev.reason }); };
    ws.onerror = () => { /* close event will follow */ };
  });
}

// ============================================================================
console.log('\n== 序章: 确保新代码 + dev 配置 ==');
{
  const h = await api('/api/health').catch(() => ({ data: null }));
  if (h.data?.authRequired === true) {
    console.log('  … 检测到上次运行残留的强制认证, 用 master token 恢复');
    await dispatch('cap.config', { action: 'patch', value: { server: { token: '', authRequired: false } } }, masterTok);
  }
  restartCore();
  await waitCore();
}

// ============================================================================
console.log('\n== Phase 1: dev 模式 ==');
{
  const h = await waitCore();
  ok('health 可用', h.ok === true);

  let r = await api('/api/auth/verify');
  ok('verify (无 token): authed=false', r.data?.authed === false);
  ok('verify (无 token): authRequired=false', r.data?.authRequired === false);

  // dev 模式: 无 token = admin → 可签发
  r = await dispatch('cap.auth', { action: 'issue', name: 'e2e-user', role: 'user' });
  userTok = r.data?.token;
  ok('issue user token 返回原文', typeof userTok === 'string' && userTok.startsWith('sk-'), JSON.stringify(r.data).slice(0, 100));
  ok('issue 返回 id', typeof r.data?.id === 'string');

  r = await dispatch('cap.auth', { action: 'issue', name: 'e2e-admin', role: 'admin' });
  adminTok = r.data?.token;
  ok('issue admin token', typeof adminTok === 'string' && adminTok.startsWith('sk-'));

  r = await dispatch('cap.auth', { action: 'list' });
  const toks = r.data?.tokens ?? [];
  ok('list 显示 2 个 token', toks.length === 2, 'got ' + toks.length);
  ok('list 不泄露原文', JSON.stringify(r.data).includes(userTok) === false);

  r = await dispatch('cap.auth', { action: 'verify' }, userTok);
  ok('verify (user token): authed=true', r.data?.authed === true && r.data?.role === 'user');
  r = await dispatch('cap.auth', { action: 'verify' }, adminTok);
  ok('verify (admin token): admin=true', r.data?.authed === true && r.data?.admin === true);

  // 过期 token
  r = await dispatch('cap.auth', { action: 'issue', name: 'e2e-exp', expiresInSeconds: 1 });
  const expTok = r.data?.token;
  await new Promise(res => setTimeout(res, 1600));
  r = await dispatch('cap.auth', { action: 'verify' }, expTok);
  ok('过期 token 验证失败', r.data?.authed === false);

  // config 密钥: dev 模式 admin → 明文; 先写入已知值
  await dispatch('cap.config', { action: 'patch', value: { ai: { apiKey: 'sk-e2e-secret-123' } } });
  r = await dispatch('cap.config', { action: 'get' });
  ok('config get (dev admin): apiKey 明文', r.data?.ai?.apiKey === 'sk-e2e-secret-123', JSON.stringify(r.data?.ai?.apiKey));

  // 遮蔽值回写保护: patch 带 '••••••' 不应清掉真实值
  r = await dispatch('cap.config', { action: 'patch', value: { ai: { apiKey: '••••••', model: 'gpt-4o-mini' } } });
  r = await dispatch('cap.config', { action: 'get' });
  ok('patch 遮蔽值保留真实密钥', r.data?.ai?.apiKey === 'sk-e2e-secret-123', JSON.stringify(r.data?.ai?.apiKey));

  // 吊销 user token → 立即失效
  const listR = await dispatch('cap.auth', { action: 'list' });
  const userId = listR.data?.tokens?.find(t => t.name === 'e2e-user')?.id;
  r = await dispatch('cap.auth', { action: 'revoke', id: userId });
  ok('revoke 成功', r.data?.ok === true);
  r = await dispatch('cap.auth', { action: 'verify' }, userTok);
  ok('吊销后 verify: authed=false', r.data?.authed === false);

  // 非法 token
  r = await dispatch('cap.auth', { action: 'verify' }, 'sk-fake-token-000');
  ok('伪造 token: authed=false', r.data?.authed === false);
}

// ============================================================================
console.log('\n== Phase 2: 强制认证模式 ==');
{
  // 开启认证: master token + authRequired
  let r = await dispatch('cap.config', { action: 'patch', value: { server: { token: masterTok, authRequired: true } } });
  ok('patch 开启 authRequired', r.data?.ok === true);
  restartCore();
  const h = await waitCore();
  ok('重启后 health (公开路径) 可用', h.ok === true);
  ok('health 报告 authRequired=true', h.authRequired === true);

  r = await api('/api/auth/verify');
  ok('verify (无 token): authed=false + authRequired=true', r.data?.authed === false && r.data?.authRequired === true);

  // 无 token → 401
  r = await api('/api/dispatch', { method: 'POST', body: { cap: 'cap.echo', params: {} } });
  ok('dispatch 无 token → 401', r.status === 401);
  r = await api('/api/config');
  ok('config 无 token → 401', r.status === 401);
  r = await api('/api/ui-state');
  ok('ui-state 无 token → 401', r.status === 401);

  // 伪造 token → 401
  r = await dispatch('cap.echo', {}, 'sk-fake-xxx');
  ok('dispatch 伪造 token → 401', r.status === 401);

  // 之前签发的 user token (未吊销的 adminTok) 仍有效
  r = await dispatch('cap.echo', {}, adminTok);
  ok('user/admin token dispatch 正常', r.status === 200 && r.reply?.result?.ok === true, JSON.stringify(r.reply).slice(0, 120));

  // user token: cap.auth list 拒绝 (admin required) — 注意 adminTok 是 admin 角色
  r = await dispatch('cap.auth', { action: 'issue', name: 'x' }, adminTok);
  ok('admin token 可 issue', r.data?.ok === true);
  const userTok2 = r.data?.token;
  r = await dispatch('cap.auth', { action: 'list' }, userTok2);
  ok('user token list → 拒绝', r.reply?.result?.ok === false && /admin/.test(r.reply?.result?.error || ''), r.reply?.result?.error);

  // 密钥脱敏: user token 看到 ••••••, admin/master 看到明文
  r = await dispatch('cap.config', { action: 'get' }, userTok2);
  ok('config get (user): apiKey 脱敏', r.data?.ai?.apiKey === '••••••', JSON.stringify(r.data?.ai?.apiKey));
  r = await dispatch('cap.config', { action: 'get' }, adminTok);
  ok('config get (admin): apiKey 明文', r.data?.ai?.apiKey === 'sk-e2e-secret-123', JSON.stringify(r.data?.ai?.apiKey));
  r = await dispatch('cap.config', { action: 'get' }, masterTok);
  ok('config get (master): apiKey 明文', r.data?.ai?.apiKey === 'sk-e2e-secret-123');
  ok('master token 是 admin', r.data?.server?.token !== undefined);

  // user token patch 遮蔽值不破坏真实密钥
  r = await dispatch('cap.config', { action: 'patch', value: { ai: { apiKey: '••••••' } } }, userTok2);
  r = await dispatch('cap.config', { action: 'get' }, masterTok);
  ok('user patch 遮蔽值 → 真实密钥保留', r.data?.ai?.apiKey === 'sk-e2e-secret-123');

  // WS: 无 token 在 upgrade 阶段被拒 (401 + 连接销毁, 客户端不会 open), 有 token 打开
  const wsNo = await wsProbe(null);
  ok('WS 无 token → upgrade 被拒', !wsNo.opened, JSON.stringify(wsNo));
  const wsYes = await wsProbe(masterTok);
  ok('WS master token → 打开', wsYes.opened, JSON.stringify(wsYes));

  // 吊销后立即失效
  r = await dispatch('cap.auth', { action: 'list' }, masterTok);
  const u2id = r.data?.tokens?.find(t => t.name === 'x')?.id;
  await dispatch('cap.auth', { action: 'revoke', id: u2id }, masterTok);
  r = await dispatch('cap.echo', {}, userTok2);
  ok('吊销后 dispatch → 401', r.status === 401);
}

// ============================================================================
console.log('\n== 收尾: 恢复 dev 模式 + 清理 ==');
{
  await dispatch('cap.config', { action: 'patch', value: { server: { token: '', authRequired: false }, ai: { apiKey: '' } } }, masterTok);
  restartCore();
  const h = await waitCore();
  ok('恢复 dev: health authRequired=false', h.ok === true && h.authRequired === false);
  // 清理 token 库 (kv domain=auth)
  const r = await dispatch('cap.kv', { action: 'delete', domain: 'auth', key: 'tokens' });
  ok('清理 token 库', r.data?.ok === true);
  // 恢复用户原有的 ai 配置 (e2e 期间可能覆盖了 apiKey/model — 恢复为测试前的代理配置)
  await dispatch('cap.config', { action: 'patch', value: { ai: { apiKey: 'sk-NfG41BEMNGNKTXxK7ghPB43dDuM4eJB7twyi0dKxRzC2wq6H', model: 'sensenova-6.8-flash-lite', baseUrl: 'http://localhost:9850/v1' } } });
  const cfg = await dispatch('cap.config', { action: 'get' });
  ok('AI 配置已恢复', cfg.data?.ai?.apiKey === 'sk-NfG41BEMNGNKTXxK7ghPB43dDuM4eJB7twyi0dKxRzC2wq6H');
}

// ============================================================================
console.log(`\n===== 结果: ${pass} pass / ${fail} fail =====`);
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
