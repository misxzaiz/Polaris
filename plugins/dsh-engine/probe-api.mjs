#!/usr/bin/env node
/**
 * DSH Web API 路由探测工具
 *
 * 用法：
 *   1. 先启动 dsh web：dsh --profile web
 *   2. 运行探测：node probe-api.mjs [--port 3080] [--host 127.0.0.1]
 *
 * 输出一个 JSON 报告，包含所有可用的 HTTP/WS 端点。
 * 适配器的 webapi 驱动依赖此报告来构造正确的 API 路径。
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PORT = parseInt(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] || process.argv[process.argv.indexOf("--port") + 1] || "3080", 10);
const HOST = process.argv.find((a) => a.startsWith("--host="))?.split("=")[1] || process.argv[process.argv.indexOf("--host") + 1] || "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;

// ============================================================================
// 待探测的路由清单
// 来源：dsh-host-apiproxy 源码逆向 + dsh-web-app 的 Cordis 插件注册
// ============================================================================

const PROBE_ROUTES = [
  // --- 非 API 首页 ---
  { method: "GET", path: "/", label: "SPA 首页" },
  { method: "GET", path: "/index.html", label: "静态入口" },

  // --- 候选 API 前缀 ---
  { method: "GET", path: "/api/health", label: "健康检查" },
  { method: "GET", path: "/api/status", label: "状态" },
  { method: "GET", path: "/api/version", label: "版本" },

  // --- 会话 ---
  { method: "POST", path: "/api/session/create", label: "创建会话" },
  { method: "POST", path: "/api/sessions", label: "创建会话(复数)" },
  { method: "GET", path: "/api/sessions", label: "列出会话" },
  { method: "POST", path: "/api/chat/session", label: "创建聊天会话" },
  { method: "POST", path: "/api/chat/sessions", label: "创建聊天会话(复数)" },
  { method: "POST", path: "/api/message", label: "发送消息" },
  { method: "POST", path: "/api/chat/message", label: "发送聊天消息" },

  // --- 流式 ---
  { method: "GET", path: "/api/session/stream", label: "SSE 流" },
  { method: "GET", path: "/api/events", label: "事件流" },
  { method: "GET", path: "/api/stream", label: "通用流" },

  // --- WebSocket ---
  { method: "WS", path: "/ws", label: "WebSocket 根" },
  { method: "WS", path: "/api/ws", label: "API WebSocket" },
  { method: "WS", path: "/api/session/ws", label: "会话 WebSocket" },
  { method: "WS", path: "/api/chat/ws", label: "聊天 WebSocket" },

  // --- dsh-host-apiproxy 已知路由（来自源码分析）---
  // 这些路由在 dsh-host-apiproxy/lib/index.js 中通过 ctx.webServer.register() 注册
  { method: "POST", path: "/api/session/message", label: "会话消息" },
  { method: "GET", path: "/api/session/events", label: "会话事件" },
  { method: "POST", path: "/api/session/interrupt", label: "中断会话" },
  { method: "GET", path: "/api/session/list", label: "会话列表" },
  { method: "GET", path: "/api/session/get", label: "获取会话" },
  { method: "DELETE", path: "/api/session/delete", label: "删除会话" },
  { method: "POST", path: "/api/goal/create", label: "创建目标" },
  { method: "POST", path: "/api/goal/update", label: "更新目标" },
  { method: "GET", path: "/api/goal/list", label: "目标列表" },
  { method: "POST", path: "/api/skill/invoke", label: "调用技能" },
  { method: "GET", path: "/api/skill/list", label: "技能列表" },
  { method: "POST", path: "/api/subagent/create", label: "创建子代理" },
  { method: "POST", path: "/api/workflow/run", label: "运行工作流" },
  { method: "POST", path: "/api/jobs/create", label: "创建任务" },
  { method: "GET", path: "/api/jobs/list", label: "任务列表" },
  { method: "POST", path: "/api/workspace/select", label: "选择工作区" },
  { method: "GET", path: "/api/workspace/current", label: "当前工作区" },
  { method: "POST", path: "/api/settings/get", label: "获取设置" },
  { method: "POST", path: "/api/settings/set", label: "设置设置" },
  { method: "GET", path: "/api/models", label: "模型列表" },
  { method: "POST", path: "/api/ask/question", label: "提问用户" },
  { method: "POST", path: "/api/ask/answer", label: "回答用户问题" },
  { method: "GET", path: "/api/credentials", label: "凭据列表" },
  { method: "GET", path: "/api/attachments", label: "附件列表" },
  { method: "POST", path: "/api/attachment/upload", label: "上传附件" },
];

// ============================================================================
// 探测函数
// ============================================================================

async function probeHTTP(method, path) {
  const url = `${BASE}${path}`;
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    const elapsed = Date.now() - start;
    const body = await resp.text().catch(() => "");
    return {
      path,
      method,
      status: resp.status,
      statusText: resp.statusText,
      contentType: resp.headers.get("content-type") || "N/A",
      bodyPreview: body.slice(0, 200),
      elapsedMs: elapsed,
      reachable: true,
    };
  } catch (err) {
    return {
      path,
      method,
      status: null,
      error: err.message,
      reachable: false,
    };
  }
}

async function probeWS(path) {
  const url = `ws://${HOST}:${PORT}${path}`;
  const start = Date.now();
  try {
    const ws = new WebSocket(url);
    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve({ path, method: "WS", status: "timeout", reachable: false, error: "连接超时（5s）" });
      }, 5000);
      ws.onopen = () => {
        clearTimeout(timeout);
        ws.close();
        resolve({ path, method: "WS", status: "connected", reachable: true, elapsedMs: Date.now() - start });
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        resolve({ path, method: "WS", status: "error", reachable: false, error: "连接失败" });
      };
    });
    return result;
  } catch (err) {
    return { path, method: "WS", status: "error", reachable: false, error: err.message };
  }
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  process.stdout.write(`\n🔍 探测 DSH Web API: ${BASE}\n`);
  process.stdout.write(`   ${new Date().toISOString()}\n`);
  process.stdout.write(`   ${"=".repeat(50)}\n\n`);

  const results = [];
  let reachable = 0;
  let total = 0;

  for (const route of PROBE_ROUTES) {
    total++;
    process.stdout.write(`   [${total}/${PROBE_ROUTES.length}] ${route.method} ${route.path}  (${route.label})... `);

    let result;
    if (route.method === "WS") {
      result = await probeWS(route.path);
    } else {
      result = await probeHTTP(route.method, route.path);
    }

    results.push({ ...result, label: route.label });

    if (result.reachable) {
      reachable++;
      if (result.method === "WS") {
        process.stdout.write(`✅ ${result.status}\n`);
      } else {
        process.stdout.write(`✅ ${result.status} ${result.statusText} (${result.elapsedMs}ms)\n`);
      }
    } else {
      process.stdout.write(`❌ ${result.error || "no response"}\n`);
    }
  }

  // 摘要
  process.stdout.write(`\n${"=".repeat(50)}\n`);
  process.stdout.write(`📊 探测结果: ${reachable}/${total} 可达\n\n`);

  // 按可达性分组
  const working = results.filter((r) => r.reachable);
  const failed = results.filter((r) => !r.reachable);

  if (working.length > 0) {
    process.stdout.write(`✅ 可达端点:\n`);
    for (const r of working) {
      process.stdout.write(`   ${r.method} ${r.path}  ← ${r.label}\n`);
    }
    process.stdout.write("\n");
  }

  if (failed.length > 0) {
    process.stdout.write(`❌ 不可达端点 (前 20):\n`);
    for (const r of failed.slice(0, 20)) {
      process.stdout.write(`   ${r.method} ${r.path}  ← ${r.label}\n`);
    }
    if (failed.length > 20) {
      process.stdout.write(`   ... 还有 ${failed.length - 20} 个\n`);
    }
    process.stdout.write("\n");
  }

  // 生成适配器配置文件
  if (working.length > 0) {
    const config = {
      baseUrl: BASE,
      probes: working,
      timestamp: new Date().toISOString(),
      suggestedApiEndpoints: inferApiEndpoints(working),
    };
    const configPath = resolve("dsh-api-probe-result.json");
    await writeFile(configPath, JSON.stringify(config, null, 2));
    process.stdout.write(`📝 配置文件已写入: ${configPath}\n`);
    process.stdout.write(`   将此文件复制到适配器工作目录以使 webapi 驱动使用这些端点。\n`);
  }

  process.stdout.write("\n");
}

/**
 * 从探测结果推断 API 端点模式
 */
function inferApiEndpoints(working) {
  const endpoints = {};

  // 按功能分组
  const sessionEP = working.find((r) => r.path.includes("session") && r.method === "POST");
  const messageEP = working.find((r) => r.path.includes("message") && r.method === "POST");
  const streamEP = working.find((r) => r.path.includes("stream") || r.path.includes("events"));
  const wsEP = working.find((r) => r.method === "WS");
  const interruptEP = working.find((r) => r.path.includes("interrupt"));
  const healthEP = working.find((r) => r.path.includes("health") || r.path.includes("status"));

  if (healthEP) endpoints.health = healthEP.path;
  if (sessionEP) endpoints.createSession = sessionEP.path;
  if (messageEP) endpoints.sendMessage = messageEP.path;
  if (streamEP) endpoints.stream = streamEP.path;
  if (wsEP) endpoints.websocket = wsEP.path;
  if (interruptEP) endpoints.interrupt = interruptEP.path;

  return endpoints;
}

main().catch((err) => {
  console.error("探测失败:", err);
  process.exit(1);
});