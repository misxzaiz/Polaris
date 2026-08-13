#!/usr/bin/env node
/**
 * @deepseek-ai/dsh → Polaris engine-v1 适配器
 *
 * 实现了 engine-v1 JSONRPC 协议，通过 stdin/stdout JSONL 与 Polaris 的
 * PluginProcessEngine 通信，背后驱动 DSH（DeepSeek Harness）的两种模式：
 *
 *   DSH_DRIVER=headless  (默认) — 每轮 spawn dsh --profile headless
 *   DSH_DRIVER=webapi           — 调用 dsh web 的 HTTP API + WebSocket
 *
 * 用法 (standalone 测试)：
 *   echo '{"id":1,"method":"start_session","params":{"work_dir":"/tmp"}}' | node adapter.mjs
 *
 * 协议参考：src-tauri/src/ai/engine/plugin_process_engine.rs
 */

import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { EOL } from "node:os";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// ============================================================================
// 配置
// ============================================================================

const DSH_DRIVER = (process.env.DSH_DRIVER || "headless").toLowerCase();
const DSH_CMD = process.env.DSH_CMD || "dsh";
const DSH_WEB_PORT = parseInt(process.env.DSH_WEB_PORT || "3080", 10);
const DSH_WEB_HOST = process.env.DSH_WEB_HOST || "127.0.0.1";
const DSH_PROFILE = process.env.DSH_PROFILE || "headless";
const DEBUG = !!process.env.DSH_ADAPTER_DEBUG;

function debug(...args) {
  if (DEBUG) writeStderr("[dsh-adapter]", ...args);
}

function writeStderr(...args) {
  process.stderr.write(args.join(" ") + EOL);
}

// ============================================================================
// 会话状态
// ============================================================================

/** 当前活跃的会话 map */
const sessions = new Map();

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} workDir
 * @property {string} systemPrompt
 * @property {string} appendSystemPrompt
 * @property {Array<{role:string, content:string}>} messageHistory
 * @property {string|null} model
 * @property {Object<string,string>} envOverrides
 * @property {boolean} running
 * @property {AbortController|null} abortController
 * @property {string|null} resumeToken
 */

// ============================================================================
// 工具函数
// ============================================================================

/** 向 stdout 写入一行 JSON（适配器 → Polaris） */
function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + EOL);
}

/** 发送 ai_event 帧 */
function emitEvent(sessionId, type, payload = {}) {
  writeLine({
    event: "ai_event",
    type,
    session_id: sessionId,
    ...payload,
  });
}

/** 发送 JSONRPC 结果帧 */
function sendResult(id, result) {
  writeLine({ id, result });
}

/** 发送 JSONRPC 错误帧 */
function sendError(id, code, message) {
  writeLine({ id, error: { code, message } });
}

/** 从 message_history 构建对话文本（用于 headless 单次 prompt） */
function buildConversationPrompt(history, newUserMessage) {
  const lines = [];
  for (const msg of history) {
    const role = msg.role === "assistant" ? "Assistant" : "User";
    lines.push(`${role}: ${msg.content}`);
  }
  if (newUserMessage) {
    lines.push(`User: ${newUserMessage}`);
  }
  return lines.join(EOL + EOL);
}

/** 构建 DSH headless 任务的完整 prompt */
function buildHeadlessTask(session, userMessage) {
  const parts = [];

  // 系统提示词
  if (session.systemPrompt) {
    parts.push(`[System Instructions]${EOL}${session.systemPrompt}`);
  }
  if (session.appendSystemPrompt) {
    parts.push(`[Additional Context]${EOL}${session.appendSystemPrompt}`);
  }

  // 对话历史
  if (session.messageHistory.length > 0 || userMessage) {
    parts.push(
      `[Conversation]${EOL}${buildConversationPrompt(session.messageHistory, userMessage)}`
    );
  }

  return parts.join(EOL + EOL);
}

// ============================================================================
// 驱动：headless
// ============================================================================

const headless = {
  /**
   * 启动 DSH headless 任务
   * @param {Session} session
   * @param {string} userMessage
   * @param {AbortSignal} signal
   * @returns {Promise<{text:string, exitCode:number}>}
   */
  async runTask(session, userMessage, signal) {
    const task = buildHeadlessTask(session, userMessage);
    if (!task.trim()) {
      return { text: "", exitCode: 0 };
    }

    debug("headless task (first 200 chars):", task.slice(0, 200));

    return new Promise((resolve, reject) => {
      const args = ["--profile", DSH_PROFILE, task];
      const env = {
        ...process.env,
        ...session.envOverrides,
      };

      // 如果指定了 model，通过环境变量传递（DSH 支持 DSH_DEFAULT_MODEL）
      if (session.model) {
        env.DSH_DEFAULT_MODEL = session.model;
      }

      const child = spawn(DSH_CMD, args, {
        env,
        cwd: session.workDir || undefined,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });

      session.abortController = new AbortController();
      // 把 signal 连到我们的 abortController
      signal?.addEventListener("abort", () => {
        child.kill("SIGTERM");
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("close", (exitCode) => {
        session.running = false;
        if (stderr && !stdout) {
          reject(new Error(stderr.trim()));
        } else {
          resolve({ text: stdout.trim(), exitCode: exitCode ?? 0 });
        }
      });

      child.on("error", (err) => {
        session.running = false;
        reject(err);
      });

      session.running = true;
    });
  },
};

// ============================================================================
// 驱动：webapi（通过 dsh web 的 HTTP API + WebSocket）
// ============================================================================

const webapi = {
  /** dsh web 进程的引用 */
  _webProcess: null,
  _webPort: DSH_WEB_PORT,

  /**
   * 确保 dsh web 已启动
   */
  async ensureWebRunning() {
    if (this._webProcess) {
      // 检查是否还活着
      try {
        this._webProcess.kill(0); // 信号 0 仅检查存活
        return; // 还活着
      } catch {
        this._webProcess = null;
      }
    }

    // 先尝试探测已有 dsh web 实例
    const alive = await this._probeExisting();
    if (alive) return;

    // 启动 dsh web
    debug("spawning dsh web...");
    const child = spawn(DSH_CMD, ["--profile", "web"], {
      env: { ...process.env, PORT: String(DSH_WEB_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this._webProcess = child;

    // 等待端口就绪
    let port = DSH_WEB_PORT;
    try {
      port = await this._waitForPort(DSH_WEB_PORT, 30000);
    } catch (err) {
      writeStderr("[dsh-adapter] WARN: dsh web may not be ready:", err.message);
      // 仍然尝试，可能已经就绪
    }
    this._webPort = port;
    debug("dsh web ready on port", port);
  },

  async _probeExisting() {
    try {
      const resp = await fetch(`http://${DSH_WEB_HOST}:${DSH_WEB_PORT}/`);
      if (resp.ok) {
        this._webPort = DSH_WEB_PORT;
        return true;
      }
    } catch {
      // not running
    }
    return false;
  },

  _waitForPort(port, timeoutMs) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = async () => {
        try {
          const resp = await fetch(`http://${DSH_WEB_HOST}:${port}/`);
          if (resp.ok) {
            // 尝试读出实际端口（可能被重定向或 dsh 打印了端口）
            const text = await resp.text();
            // 从 HTML 中找端口号？不现实。
            resolve(port);
            return;
          }
        } catch {
          // not ready
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`dsh web did not start on port ${port} within ${timeoutMs}ms`));
          return;
        }
        setTimeout(check, 500);
      };
      check();
    });
  },

  /**
   * 通过 HTTP API 发送消息
   * TODO: 需要运行时探测 dsh-host-apiproxy 的具体路由
   * 已知可能的端点：
   *   POST /api/session/create
   *   POST /api/session/{id}/message
   *   GET  /api/session/{id}/events (SSE)
   *   WS   /api/session/{id}/stream
   */
  async sendMessage(session, userMessage, signal) {
    await this.ensureWebRunning();

    const baseUrl = `http://${DSH_WEB_HOST}:${this._webPort}`;

    // ------------------------------------------------------------------
    // 探测阶段：尝试常见 API 路由
    // 记录在 probe-api.mjs 的输出中，这里仅做初步尝试
    // ------------------------------------------------------------------
    const routes = [
      { method: "POST", path: "/api/session/create" },
      { method: "POST", path: "/api/sessions" },
      { method: "POST", path: "/api/chat/session" },
      { method: "GET", path: "/api/health" },
      { method: "GET", path: "/api/status" },
    ];

    // 先尝试探测存活 + 获取 API 基路径
    let apiBase = null;
    for (const route of routes) {
      try {
        const resp = await fetch(`${baseUrl}${route.path}`, {
          method: route.method,
          headers: { "Content-Type": "application/json" },
          ...(route.method === "POST"
            ? { body: JSON.stringify({}) }
            : {}),
          signal: AbortSignal.timeout(3000),
        });
        if (resp.status !== 404 && resp.status !== 405) {
          debug(`[probe] ${route.method} ${route.path} → ${resp.status}`);
          // 找到了一个非 404 的端点，这可能是 API 前缀
          const pathParts = route.path.split("/");
          // 尝试推断 API 基路径
          if (pathParts.length >= 3) {
            apiBase = pathParts.slice(0, 3).join("/"); // /api/session 或 /api/chat
          }
          if (!apiBase) apiBase = "/api";
        }
      } catch {
        // 超时或连接失败，继续
      }
    }

    if (!apiBase) {
      writeStderr(
        "[dsh-adapter] WARN: 无法探测到 dsh web API 端点。头模式 (headless) 已保底可用。"
      );
      writeStderr(
        "[dsh-adapter] 请运行 probe-api.mjs 获取路由信息，然后更新 webapi driver 的路径。"
      );
      // 回退到 headless
      return headless.runTask(session, userMessage, signal);
    }

    // ------------------------------------------------------------------
    // TODO: 根据探测结果，构造完整的会话创建 + 消息发送 + 事件流读取
    // 以下为示意框架，需要实际路由确认后补全
    // ------------------------------------------------------------------
    debug(`[webapi] using apiBase=${apiBase}, sessionId=${session.id}`);

    // 创建会话
    const createResp = await fetch(`${baseUrl}${apiBase}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workDir: session.workDir,
        systemPrompt: session.systemPrompt,
        model: session.model,
      }),
      signal,
    });

    if (!createResp.ok) {
      throw new Error(`创建会话失败: ${createResp.status} ${await createResp.text()}`);
    }

    const sessionData = await createResp.json();
    const dshSessionId = sessionData.id || sessionData.sessionId;

    debug(`[webapi] session created: ${dshSessionId}`);

    // 发送用户消息并获取流式响应
    // 假设有 SSE 端点: GET /api/session/{id}/stream?message=...
    const msgUrl = new URL(`${baseUrl}/api/session/${dshSessionId}/stream`);
    msgUrl.searchParams.set("message", userMessage);

    const streamResp = await fetch(msgUrl, { signal });

    if (!streamResp.ok) {
      throw new Error(
        `发送消息失败: ${streamResp.status} ${await streamResp.text()}`
      );
    }

    // 读取 SSE 流并转换为 ai_event 帧
    const reader = streamResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          this._translateEvent(session.id, data);
        } catch {
          // 非 JSON 事件，跳过
        }
      }
    }

    // 标记会话结束
    emitEvent(session.id, "session_end", { reason: "completed" });
    return { text: "", exitCode: 0 };
  },

  /**
   * 将 DSH API 事件转换为 Polaris ai_event 帧
   * TODO: 需要根据实际 API 响应格式补充映射
   */
  _translateEvent(sessionId, data) {
    // 占位：根据 DSH 的实际事件格式映射
    if (data.type === "message" || data.type === "assistant/message") {
      const content = data.content || data.text || "";
      emitEvent(sessionId, "assistant_message", {
        content,
        is_delta: data.delta === true,
      });
    } else if (data.type === "tool_call" || data.type === "tool/start") {
      emitEvent(sessionId, "tool_call_start", {
        tool: data.tool || data.name,
        args: data.args || data.arguments,
        call_id: data.id || data.callId,
      });
    } else if (data.type === "tool_result" || data.type === "tool/end") {
      emitEvent(sessionId, "tool_call_end", {
        tool: data.tool || data.name,
        success: data.error ? false : true,
        result: data.result || data.output || "",
        call_id: data.id || data.callId,
      });
    }
  },

  /** 中断当前会话 */
  async interrupt() {
    // 对于 webapi，通过 HTTP 发送中断请求
    try {
      await fetch(
        `http://${DSH_WEB_HOST}:${this._webPort}/api/session/interrupt`,
        { method: "POST" }
      );
    } catch {
      // 忽略
    }
  },
};

// ============================================================================
// 请求处理
// ============================================================================

/** 处理 start_session */
async function handleStartSession(id, params) {
  const sessionId = params.session_id || `dsh-${randomUUID()}`;
  const session = {
    id: sessionId,
    workDir: params.work_dir || params.workDir || process.cwd(),
    systemPrompt: params.system_prompt || params.systemPrompt || "",
    appendSystemPrompt: params.append_system_prompt || params.appendSystemPrompt || "",
    messageHistory: params.message_history || params.messageHistory || [],
    model: params.model || null,
    envOverrides: params.env_overrides || params.envOverrides || {},
    running: false,
    abortController: null,
    resumeToken: null,
  };

  sessions.set(sessionId, session);

  const userMessage = params.message || params.userMessage || params.text || "";

  debug("start_session:", sessionId, "driver:", DSH_DRIVER, "workDir:", session.workDir);

  try {
    let result;
    if (DSH_DRIVER === "webapi") {
      result = await webapi.sendMessage(session, userMessage, null);
    } else {
      result = await headless.runTask(session, userMessage, null);
    }

    // 如果有输出文本，发出 assistant_message
    if (result.text) {
      emitEvent(sessionId, "assistant_message", {
        content: result.text,
        is_delta: false,
      });
    }

    // 会话结束
    emitEvent(sessionId, "session_end", { reason: "completed" });

    // 生成 resume token
    const resumeToken = await saveResumeToken(sessionId, session);
    sendResult(id, {
      session_id: sessionId,
      resume_token: resumeToken,
    });
  } catch (err) {
    emitEvent(sessionId, "error", { error: err.message });
    emitEvent(sessionId, "session_end", { reason: "error" });
    sendError(id, -1, err.message);
  }

  // 清理：headless 模式每轮退出后适配器保持存活等待下一轮
  // 但 Polaris 的 Model A 生命周期每轮启动新进程，所以这里只是记录
}

/** 处理 continue_session（恢复已有会话） */
async function handleContinueSession(id, params) {
  const sessionId = params.session_id || params.sessionId;
  let session = sessions.get(sessionId);

  if (!session) {
    // 尝试从 resume_token 恢复
    session = await loadFromResumeToken(params.resume_token || params.resumeToken);
    if (!session) {
      sendError(id, -1, `会话 ${sessionId} 未找到且无法恢复`);
      return;
    }
    sessions.set(session.id, session);
  }

  // 追加新消息到历史
  const userMessage = params.message || params.userMessage || params.text || "";
  const newHistory = params.message_history || params.messageHistory || [];

  // 合并 history
  if (newHistory.length > 0) {
    // 替换整个历史（Polaris 可能传完整历史）
    session.messageHistory = newHistory;
  }

  // 构建 prompt 并执行
  try {
    let result;
    if (DSH_DRIVER === "webapi") {
      result = await webapi.sendMessage(session, userMessage, null);
    } else {
      result = await headless.runTask(session, userMessage, null);
    }

    if (result.text) {
      emitEvent(sessionId, "assistant_message", {
        content: result.text,
        is_delta: false,
      });
    }

    emitEvent(sessionId, "session_end", { reason: "completed" });

    // 更新 resume token
    const resumeToken = await saveResumeToken(sessionId, session);
    sendResult(id, {
      session_id: sessionId,
      resume_token: resumeToken,
    });
  } catch (err) {
    emitEvent(sessionId, "error", { error: err.message });
    emitEvent(sessionId, "session_end", { reason: "error" });
    sendError(id, -1, err.message);
  }
}

/** 处理 interrupt */
async function handleInterrupt(id, params) {
  const sessionId = params.session_id || params.sessionId;
  const session = sessions.get(sessionId);

  if (session?.abortController) {
    session.abortController.abort();
    session.running = false;
  }

  if (DSH_DRIVER === "webapi") {
    await webapi.interrupt();
  }

  sendResult(id, { interrupted: true });
}

// ============================================================================
// Resume Token 持久化
// ============================================================================

const RESUME_DIR = process.env.DSH_RESUME_DIR || join(process.cwd(), ".dsh-resume");

function ensureResumeDir() {
  if (!existsSync(RESUME_DIR)) {
    mkdirSync(RESUME_DIR, { recursive: true });
  }
}

async function saveResumeToken(sessionId, session) {
  ensureResumeDir();
  const tokenPath = join(RESUME_DIR, `${sessionId}.json`);
  const data = {
    id: session.id,
    workDir: session.workDir,
    systemPrompt: session.systemPrompt,
    appendSystemPrompt: session.appendSystemPrompt,
    messageHistory: session.messageHistory,
    model: session.model,
    envOverrides: session.envOverrides,
    timestamp: Date.now(),
  };
  writeFileSync(tokenPath, JSON.stringify(data, null, 2));
  return tokenPath;
}

async function loadFromResumeToken(resumeToken) {
  if (!resumeToken || !existsSync(resumeToken)) return null;
  try {
    const data = JSON.parse(await readFile(resumeToken, "utf-8"));
    return {
      id: data.id,
      workDir: data.workDir,
      systemPrompt: data.systemPrompt,
      appendSystemPrompt: data.appendSystemPrompt,
      messageHistory: data.messageHistory || [],
      model: data.model,
      envOverrides: data.envOverrides || {},
      running: false,
      abortController: null,
      resumeToken,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// 主循环
// ============================================================================

async function main() {
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      writeStderr("[dsh-adapter] 无法解析 JSON:", trimmed.slice(0, 200));
      continue;
    }

    const { id, method, params = {} } = request;

    if (!method) {
      writeStderr("[dsh-adapter] 缺少 method:", trimmed.slice(0, 200));
      continue;
    }

    debug("request:", method, "id:", id);

    try {
      switch (method) {
        case "start_session":
          await handleStartSession(id, params);
          break;

        case "continue_session":
          await handleContinueSession(id, params);
          break;

        case "interrupt":
          await handleInterrupt(id, params);
          break;

        default:
          sendError(id, -32601, `未知方法: ${method}`);
      }
    } catch (err) {
      writeStderr("[dsh-adapter] 处理请求出错:", err);
      sendError(id, -1, err.message);
    }
  }

  // stdin 关闭后退出
  process.exit(0);
}

main().catch((err) => {
  writeStderr("[dsh-adapter] 致命错误:", err);
  process.exit(1);
});