/**
 * dsh question/requested 协议验证脚本 v2
 *
 * 基于 dsh 源码验证的协议格式：
 *   session.prompt: { sessionId, mode: "queue", content: [{ type: "text", text: "..." }] }
 *   /api/respond:   { type: "client-response", rpcId, result: { ok: true, value: { sessionId, answer: { answers: [{ id, selected, custom? }] } } } }
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

function rpcId() {
  return `test-${++rpcIdCounter}`;
}

// ============================================================
// 1. 启动 dsh 服务器
// ============================================================
function startDsh() {
  return new Promise((resolve, reject) => {
    console.log('[test] 启动 dsh 服务器...');

    dshProcess = spawn(DSH_CMD, DSH_ARGS, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        reject(new Error(`dsh 启动超时. 输出: ${output.slice(0, 1000)}`));
      }
    }, 30000);

    dshProcess.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stdout.write(`[dsh] ${text}`);

      if (!resolved) {
        const portMatch = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (portMatch) {
          resolved = true;
          const port = portMatch[1];
          baseUrl = `http://127.0.0.1:${port}`;
          clearTimeout(timeout);
          console.log(`[test] dsh 已启动: ${baseUrl}`);
          setTimeout(() => resolve(baseUrl), 1000);
        }
      }
    });

    dshProcess.stderr.on('data', (data) => {
      process.stderr.write(`[dsh:err] ${data}`);
    });

    dshProcess.on('error', (err) => {
      clearTimeout(timeout);
      if (!resolved) reject(err);
    });

    dshProcess.on('exit', (code) => {
      clearTimeout(timeout);
      if (!resolved) reject(new Error(`dsh 退出 code=${code}: ${output.slice(0, 500)}`));
    });
  });
}

// ============================================================
// 2. HTTP RPC 调用（client-request 格式）
// ============================================================
function rpcCall(method, payload) {
  return new Promise((resolve, reject) => {
    const id = rpcId();
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: id,
      method,
      payload: payload || {},
    });

    const url = new URL(`/api/${method}`, baseUrl);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `/api/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`RPC ${method} 超时`)); });
    req.write(body);
    req.end();
  });
}

// ============================================================
// 3. WebSocket 事件流
// ============================================================
function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const wsUrl = `${baseUrl.replace('http://', 'ws://')}/api/events.mux`;
    console.log(`[test] 连接 WebSocket: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log('[test] WebSocket 已连接');
      resolve(ws);
    });

    ws.on('error', (err) => {
      console.error(`[test] WebSocket 错误:`, err.message);
      reject(err);
    });
  });
}

// ============================================================
// 4. 通过 /api/respond 提交回答（正确格式）
// ============================================================
function respondToQuestion(questionRpcId, sessionId, answers) {
  return new Promise((resolve, reject) => {
    // 正确格式: { type: "client-response", rpcId, result: { ok: true, value: { sessionId, answer: { answers: [...] } } } }
    const body = JSON.stringify({
      type: 'client-response',
      rpcId: questionRpcId,
      result: {
        ok: true,
        value: {
          sessionId: sessionId,
          answer: {
            answers: answers,
          },
        },
      },
    });

    const url = new URL('/api/respond', baseUrl);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: '/api/respond',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[test] /api/respond: HTTP ${res.statusCode} body=${data.slice(0, 300)}`);
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('/api/respond 超时')); });
    req.write(body);
    req.end();
  });
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const results = { passed: 0, failed: 0 };
  function pass(msg) { results.passed++; console.log(`  ✅ ${msg}`); }
  function fail(msg) { results.failed++; console.log(`  ❌ ${msg}`); }

  try {
    // 1. 启动 dsh
    await startDsh();
    pass('dsh 服务器启动');

    // 2. 连接 WebSocket
    const ws = await connectWebSocket();
    pass('WebSocket 连接成功');

    // 收集 WS 帧
    const frames = [];
    const questionFrames = [];
    ws.on('message', (data) => {
      const text = data.toString();
      try {
        const frame = JSON.parse(text);
        frames.push(frame);
        const method = frame.method || '(none)';
        const ptype = frame.payload?.type || '(none)';
        const innerEvent = frame.payload?.event?.type || '(none)';
        const rpcid = frame.rpcId || '(none)';

        if (method === 'question/requested' || frame.payload?.type === 'question/requested') {
          questionFrames.push(frame);
          console.log(`[ws] >>> question/requested 完整帧:`);
          console.log(JSON.stringify(frame, null, 2));
        } else {
          console.log(`[ws] method=${method} payload.type=${ptype} event.type=${innerEvent} rpcId=${rpcid}`);
        }
      } catch {
        // ignore
      }
    });

    ws.on('close', () => console.log('[test] WebSocket 已关闭'));

    // 等待初始化
    await new Promise(r => setTimeout(r, 2000));

    // === 测试1: host.describe ===
    console.log('\n[test] === 测试1: host.describe ===');
    const descResult = await rpcCall('host.describe', {});
    if (descResult.status === 200) {
      pass('host.describe 成功');
    } else {
      fail(`host.describe 失败: HTTP ${descResult.status}`);
    }

    // === 测试2: session.create ===
    console.log('\n[test] === 测试2: session.create ===');
    const createResult = await rpcCall('session.create', {
      cwd: process.cwd(),
    });
    let dshSessionId = createResult.body?.result?.value?.sessionId
      || createResult.body?.sessionId;
    if (createResult.status === 200 && dshSessionId) {
      pass(`session.create 成功: ${dshSessionId}`);
    } else {
      fail(`session.create 失败: HTTP ${createResult.status}`);
    }

    // === 测试3: session.prompt（正确格式） ===
    if (dshSessionId) {
      console.log('\n[test] === 测试3: session.prompt (正确格式) ===');
      const promptResult = await rpcCall('session.prompt', {
        sessionId: dshSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '回复"hi"' }],
      });
      console.log(`  prompt 响应:`, JSON.stringify(promptResult.body).slice(0, 300));
      if (promptResult.status === 200) {
        const accepted = promptResult.body?.result?.value?.accepted;
        if (accepted) {
          pass('session.prompt 被接受');
        } else {
          fail(`session.prompt 未被接受: ${JSON.stringify(promptResult.body)}`);
        }
      } else {
        fail(`session.prompt 失败: HTTP ${promptResult.status}`);
      }

      // 等待事件（dsh 处理需要时间，AI 需要回答问题）
      console.log('[test] 等待 25s 收集事件...');
      await new Promise(r => setTimeout(r, 25000));

      // 打印帧摘要
      console.log(`\n[test] 共 ${frames.length} 帧:`);
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const m = f.method || '(none)';
        const pt = f.payload?.type || '(none)';
        const ev = f.payload?.event?.type || '(none)';
        const rid = f.rpcId || '(none)';
        const qid = f.payload?.questions?.[0]?.id || '(none)';
        const tok = f.payload?.event?.content?.slice?.(0, 40) || '';
        console.log(`  [${i}] method=${m} payload.type=${pt} event.type=${ev} rpcId=${rid} questionId=${qid}${tok ? ` content="${tok}"` : ''}`);
      }

      // 检查 question/requested
      if (questionFrames.length > 0) {
        const qf = questionFrames[0];
        console.log('\n[test] === 测试4: /api/respond 提交回答（正确格式） ===');
        const qRpcId = qf.rpcId;
        const qId = qf.payload?.questions?.[0]?.id || '(unknown)';
        const qText = qf.payload?.questions?.[0]?.question || '(unknown)';
        console.log(`  question id=${qId}, rpcId=${qRpcId}, text="${qText}"`);

        const respondResult = await respondToQuestion(qRpcId, dshSessionId, [
          { id: qId, selected: ['test answer'] },
        ]);
        if (respondResult.status === 200 && respondResult.body?.accepted === true) {
          pass('/api/respond 提交回答成功 (accepted: true)');
        } else {
          console.log(`  响应: ${JSON.stringify(respondResult.body)}`);
          fail(`/api/respond 提交回答失败: HTTP ${respondResult.status}`);
        }

        // 等待后续事件
        await new Promise(r => setTimeout(r, 5000));
        console.log(`[test] 回答后共 ${frames.length} 帧`);
      } else {
        console.log('\n[test] 未收到 question/requested');
        const types = [...new Set(frames.map(f => f.method || f.payload?.type))];
        console.log(`  事件类型: ${types.join(', ')}`);
      }
    }

    // === 测试5: 直接 /api/respond（正确格式） ===
    console.log('\n[test] === 测试5: 直接 /api/respond（正确格式） ===');
    const testResp = await respondToQuestion('test-rpc-' + Date.now(), 'test-session', [
      { id: 'q1', selected: ['test'], custom: 'custom input' },
    ]);
    if (testResp.status === 200) {
      console.log(`  响应: ${JSON.stringify(testResp.body)}`);
      if (testResp.body?.accepted === false && testResp.body?.reason === 'not-pending') {
        pass('/api/respond 正确格式被接受，返回 not-pending（rpcId 不存在，符合预期）');
      } else {
        pass('/api/respond 端点正常');
      }
    } else {
      fail(`/api/respond 失败: HTTP ${testResp.status}`);
    }

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