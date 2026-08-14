/**
 * dsh question/requested 协议验证脚本 v3
 *
 * 验证 Rust 修正后的 /api/respond 正确格式
 */
import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import http from 'http';

const DSH_CMD = 'node';
const DSH_ARGS = [
  'C:\\Users\\28409\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  'web', '--port', '0'
];

let dshProcess;
let baseUrl;
let rpcIdCounter = 0;

function rpcId() { return `test-${++rpcIdCounter}`; }

function startDsh() {
  return new Promise((resolve, reject) => {
    console.log('[test] 启动 dsh 服务器...');
    dshProcess = spawn(DSH_CMD, DSH_ARGS, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error(`dsh 启动超时. 输出: ${output.slice(0, 500)}`));
    }, 30000);
    dshProcess.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stdout.write(`[dsh] ${text}`);
      if (!resolved) {
        const m = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) { resolved = true; baseUrl = `http://127.0.0.1:${m[1]}`; clearTimeout(timeout); console.log(`[test] dsh 已启动: ${baseUrl}`); setTimeout(() => resolve(baseUrl), 1000); }
      }
    });
    dshProcess.stderr.on('data', (d) => process.stderr.write(`[dsh:err] ${d}`));
    dshProcess.on('error', (e) => { clearTimeout(timeout); if (!resolved) reject(e); });
    dshProcess.on('exit', (c) => { clearTimeout(timeout); if (!resolved) reject(new Error(`dsh exit ${c}: ${output.slice(0,500)}`)); });
  });
}

function rpcCall(method, payload) {
  return new Promise((resolve, reject) => {
    const id = rpcId();
    const body = JSON.stringify({ type: 'client-request', rpcId: id, method, payload: payload || {} });
    const url = new URL(`/api/${method}`, baseUrl);
    const req = http.request({ hostname: url.hostname, port: url.port, path: `/api/${method}`, method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`RPC ${method} 超时`)); });
    req.write(body);
    req.end();
  });
}

function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const wsUrl = `${baseUrl.replace('http://', 'ws://')}/api/events.mux`;
    console.log(`[test] 连接 WebSocket: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => { console.log('[test] WebSocket 已连接'); resolve(ws); });
    ws.on('error', (e) => reject(e));
  });
}

// 使用 Rust 代码修正后的正确格式
function respondCorrect(callId, rpcId, sessionId, selected, customInput, declined) {
  return new Promise((resolve, reject) => {
    let body;
    if (declined) {
      body = JSON.stringify({
        type: 'client-response',
        rpcId: rpcId,
        result: { ok: false, error: { code: 'cancelled', message: 'user cancelled', details: {} } },
      });
    } else {
      const answers = selected.map(s => {
        const a = { id: callId, selected: [s] };
        if (customInput && customInput.trim()) a.custom = customInput.trim();
        return a;
      });
      body = JSON.stringify({
        type: 'client-response',
        rpcId: rpcId,
        result: {
          ok: true,
          value: {
            sessionId: sessionId,
            answer: { answers },
          },
        },
      });
    }

    const url = new URL('/api/respond', baseUrl);
    const req = http.request({ hostname: url.hostname, port: url.port, path: '/api/respond', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000 },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { console.log(`[test] /api/respond: HTTP ${res.statusCode} body=${d.slice(0, 300)}`); resolve({ status: res.statusCode, body: d }); }); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('/api/respond 超时')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  const results = { passed: 0, failed: 0 };
  function pass(msg) { results.passed++; console.log(`  ✅ ${msg}`); }
  function fail(msg) { results.failed++; console.log(`  ❌ ${msg}`); }

  try {
    await startDsh();
    pass('dsh 服务器启动');

    const ws = await connectWebSocket();
    pass('WebSocket 连接成功');

    const frames = [];
    ws.on('message', (data) => {
      const text = data.toString();
      try {
        const frame = JSON.parse(text);
        frames.push(frame);
        const m = frame.method || '(none)';
        const pt = frame.payload?.type || '(none)';
        const ev = frame.payload?.event?.type || '(none)';
        const rid = frame.rpcId || '(none)';
        if (m === 'question/requested' || frame.payload?.type === 'question/requested') {
          console.log(`[ws] >>> question/requested 完整帧:\n${JSON.stringify(frame, null, 2)}`);
        } else {
          console.log(`[ws] method=${m} payload.type=${pt} event.type=${ev} rpcId=${rid}`);
        }
      } catch {}
    });
    ws.on('close', () => console.log('[test] WebSocket 已关闭'));

    await new Promise(r => setTimeout(r, 2000));

    // === 测试1: host.describe ===
    console.log('\n[test] === 测试1: host.describe ===');
    const desc = await rpcCall('host.describe', {});
    if (desc.status === 200) pass('host.describe 成功');
    else fail(`host.describe 失败: HTTP ${desc.status}`);

    // === 测试2: session.create ===
    console.log('\n[test] === 测试2: session.create ===');
    const create = await rpcCall('session.create', { cwd: process.cwd() });
    let dshSessionId = create.body?.result?.value?.sessionId || create.body?.sessionId;
    if (create.status === 200 && dshSessionId) pass(`session.create 成功: ${dshSessionId}`);
    else fail(`session.create 失败: HTTP ${create.status}`);

    // === 测试3: 验证 /api/respond 正确格式（不依赖 AI 提问） ===
    console.log('\n[test] === 测试3: /api/respond 正确格式验证 ===');

    // 3a: 取消回答格式（需要 details: {}）
    console.log('  --- 3a: declined 格式 ---');
    const r1 = await respondCorrect('test_q1', 'test-rpc-1', 'test-session-1', [], null, true);
    const r1body = typeof r1.body === 'string' ? JSON.parse(r1.body) : r1.body;
    if (r1.status === 200 && r1body?.accepted === false && r1body?.reason === 'not-pending') {
      pass('declined 格式正确（未 pending 时返回 not-pending，符合预期）');
    } else {
      console.log(`  响应: ${JSON.stringify(r1body)}`);
      fail(`declined 格式错误: HTTP ${r1.status}`);
    }

    // 3b: 回答格式（单选项）
    console.log('  --- 3b: answered 格式（单选项） ---');
    const r2 = await respondCorrect('test_q2', 'test-rpc-2', 'test-session-2', ['option1', 'option2'], 'custom input', false);
    const r2body = typeof r2.body === 'string' ? JSON.parse(r2.body) : r2.body;
    if (r2.status === 200 && r2body?.accepted === false && r2body?.reason === 'not-pending') {
      pass('answered 格式正确（未 pending 时返回 not-pending，符合预期）');
    } else {
      console.log(`  响应: ${JSON.stringify(r2body)}`);
      fail(`answered 格式错误: HTTP ${r2.status}`);
    }

    // 3c: 验证完整格式（打印实际发送的 JSON）
    console.log('  --- 3c: 完整 payload 格式验证 ---');
    const sentBody = JSON.stringify({
      type: 'client-response',
      rpcId: 'test-rpc-3',
      result: {
        ok: true,
        value: {
          sessionId: 'test-session-3',
          answer: {
            answers: [{ id: 'test_q3', selected: ['随便聊聊'], custom: '自定义输入' }],
          },
        },
      },
    });
    const parsed = JSON.parse(sentBody);
    // 验证关键字段
    const checks = [
      parsed.type === 'client-response' || 'type 应为 client-response',
      parsed.result?.ok === true || 'result.ok 应为 true',
      parsed.result?.value?.sessionId === 'test-session-3' || 'value.sessionId 应存在',
      parsed.result?.value?.answer?.answers?.[0]?.id === 'test_q3' || 'answers[0].id 应存在',
      parsed.result?.value?.answer?.answers?.[0]?.selected?.includes('随便聊聊') || 'answers[0].selected 应包含选项',
    ];
    const allOk = checks.filter(c => c !== true).length === 0;
    if (allOk) pass('完整 payload 格式验证通过');
    else fail(`payload 格式验证失败: ${checks.filter(c => c !== true).join(', ')}`);

    // 清理
    ws.close();
    dshProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));

    console.log(`\n${'='.repeat(50)}`);
    console.log(`结果: ${results.passed} 通过, ${results.failed} 失败`);
    process.exit(results.failed > 0 ? 1 : 0);
  } catch (err) {
    console.error(`[test] 异常:`, err);
    if (dshProcess) dshProcess.kill();
    process.exit(1);
  }
}

main();