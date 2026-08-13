#!/usr/bin/env node
/**
 * DSH engine-v1 适配器端到端烟测试
 *
 * 测试场景：
 *   1. 启动适配器进程
 *   2. 发送 start_session 请求
 *   3. 验证收到了 ai_event 帧（assistant_message + session_end）
 *   4. 发送 continue_session 请求（续接对话）
 *   5. 发送 interrupt 请求
 *   6. 验证适配器优雅退出
 *
 * 用法：
 *   node smoke.mjs                          # 默认：headless 驱动
 *   DSH_DRIVER=headless node smoke.mjs      # 明确指定
 *   DSH_DRIVER=webapi node smoke.mjs        # webapi 模式（需先起 dsh web）
 *   DSH_ADAPTER_DEBUG=1 node smoke.mjs      # 带调试日志
 *
 * 前置条件：
 *   - dsh 命令可用（npx @deepseek-ai/dsh 或 npm i -g @deepseek-ai/dsh）
 *   - dsh 已配置好 LLM 凭据（dsh 首次启动会自动引导）
 *   - webapi 模式需要额外运行 dsh --profile web
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = resolve(__dirname, "adapter.mjs");

// ============================================================================
// 辅助函数
// ============================================================================

const PASS = "✅";
const FAIL = "❌";
const INFO = "ℹ️";

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    testsPassed++;
  } else {
    console.log(`  ${FAIL} ${label}`);
    testsFailed++;
  }
}

// ============================================================================
// 测试流程
// ============================================================================

async function testAdapter() {
  console.log(`\n${INFO} DSH 引擎适配器烟测试`);
  console.log(`${"=".repeat(50)}`);
  console.log(`  驱动模式: ${process.env.DSH_DRIVER || "headless (default)"}`);
  console.log(`  适配器:   ${ADAPTER_PATH}`);
  console.log(`  dsh 路径: ${process.env.DSH_CMD || "dsh (PATH)"}`);
  console.log(`  ${"=".repeat(50)}\n`);

  // ------------------------------------------------------------------
  // 1. 启动适配器进程
  // ------------------------------------------------------------------
  console.log(`\n${INFO} 1. 启动适配器进程...`);

  const adapter = spawn("node", [ADAPTER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      DSH_ADAPTER_DEBUG: process.env.DSH_ADAPTER_DEBUG || "1",
    },
  });

  // 适配器输出收集
  const events = [];
  const results = [];

  const rl = createInterface({ input: adapter.stdout });
  rl.on("line", (line) => {
    try {
      const obj = JSON.parse(line);
      if (obj.event === "ai_event") {
        events.push(obj);
        console.log(`  [event] ${obj.type}: ${(obj.content || "").slice(0, 80)}`);
      } else if (obj.id !== undefined) {
        results.push(obj);
        if (obj.error) {
          console.log(`  [error] id=${obj.id}: ${obj.error.message}`);
        } else {
          console.log(`  [result] id=${obj.id}: session_id=${obj.result?.session_id}`);
        }
      } else {
        console.log(`  [raw] ${line.slice(0, 120)}`);
      }
    } catch {
      console.log(`  [raw] ${line.slice(0, 120)}`);
    }
  });

  // 收集 stderr
  let stderr = "";
  adapter.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  // 等待适配器就绪
  await new Promise((r) => setTimeout(r, 500));
  assert(adapter.exitCode === null, "适配器进程已启动，未退出");

  // ------------------------------------------------------------------
  // 2. send start_session
  // ------------------------------------------------------------------
  console.log(`\n${INFO} 2. 发送 start_session 请求...`);

  const startSessionReq = {
    id: 1,
    method: "start_session",
    params: {
      work_dir: process.cwd(),
      model: process.env.DSH_DEFAULT_MODEL || "deepseek-chat",
      message: "Hello! 请用一句中文打招呼。",
    },
  };

  adapter.stdin.write(JSON.stringify(startSessionReq) + "\n");
  await new Promise((r) => setTimeout(r, 15000));

  // 验证
  const hasAssistantMessage = events.some(
    (e) => e.type === "assistant_message"
  );
  const hasSessionEnd = events.some((e) => e.type === "session_end");
  const hasResult = results.some((r) => r.id === 1 && r.result);

  assert(hasAssistantMessage, "收到 assistant_message 事件");
  assert(hasSessionEnd, "收到 session_end 事件");
  assert(hasResult, "收到 start_session 结果帧");

  const sessionId = results.find((r) => r.id === 1)?.result?.session_id;
  console.log(`  ${INFO} 会话 ID: ${sessionId}`);

  // ------------------------------------------------------------------
  // 3. send continue_session
  // ------------------------------------------------------------------
  if (sessionId) {
    console.log(`\n${INFO} 3. 发送 continue_session 请求（续接对话）...`);

    const eventsBeforeContinue = events.length;
    const continueReq = {
      id: 2,
      method: "continue_session",
      params: {
        session_id: sessionId,
        message: "请用英文回复刚才的话。",
      },
    };

    adapter.stdin.write(JSON.stringify(continueReq) + "\n");
    await new Promise((r) => setTimeout(r, 15000));

    const hasNewMessages = events.length > eventsBeforeContinue;
    const hasContinueResult = results.some((r) => r.id === 2 && r.result);

    assert(hasNewMessages, "续接后收到新事件");
    assert(hasContinueResult, "收到 continue_session 结果帧");
  } else {
    console.log(`  ${FAIL} 跳过 continue_session 测试（无 session_id）`);
    testsFailed++;
  }

  // ------------------------------------------------------------------
  // 4. send interrupt
  // ------------------------------------------------------------------
  console.log(`\n${INFO} 4. 发送 interrupt 请求...`);

  const interruptReq = {
    id: 3,
    method: "interrupt",
    params: {
      session_id: sessionId || "test-session",
    },
  };

  adapter.stdin.write(JSON.stringify(interruptReq) + "\n");
  await new Promise((r) => setTimeout(r, 1000));

  const hasInterruptResult = results.some((r) => r.id === 3 && r.result);
  assert(hasInterruptResult, "收到 interrupt 结果帧");

  // ------------------------------------------------------------------
  // 5. 关闭 stdin → 等待适配器退出
  // ------------------------------------------------------------------
  console.log(`\n${INFO} 5. 关闭 stdin，等待适配器退出...`);

  adapter.stdin.end();

  const exitCode = await new Promise((resolve) => {
    adapter.on("close", (code) => resolve(code));
    // 超时保护
    setTimeout(() => {
      adapter.kill();
      resolve(-1);
    }, 5000);
  });

  assert(exitCode === 0, `适配器正常退出 (exit code: ${exitCode})`);

  // ------------------------------------------------------------------
  // 6. 打印 stderr 诊断
  // ------------------------------------------------------------------
  if (stderr) {
    console.log(`\n${INFO} 适配器 stderr 输出:`);
    const lines = stderr.trim().split("\n");
    for (const line of lines.slice(-10)) {
      console.log(`  ${line}`);
    }
    if (lines.length > 10) {
      console.log(`  ... (${lines.length - 10} 行之前)`);
    }
  }

  // ==========================================================================
  // 结果汇总
  // ==========================================================================
  console.log(`\n${"=".repeat(50)}`);
  console.log(`测试结果: ${testsPassed} 通过, ${testsFailed} 失败`);
  console.log(`${"=".repeat(50)}\n`);

  if (testsFailed > 0) {
    process.exit(1);
  }
}

testAdapter().catch((err) => {
  console.error(`\n${FAIL} 测试异常:`, err);
  process.exit(1);
});