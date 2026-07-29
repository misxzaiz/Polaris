/**
 * useAgentLoop — Agent 循环 Hook
 *
 * 封装 agent 循环的核心逻辑：
 * 1. 构建带 tools 参数的 API 请求
 * 2. 流式解析响应，同时捕获 text delta 和 tool_use delta
 * 3. 解析 tool_calls 后并发执行、按序回传
 * 4. 循环防护（maxTurns + 重复调用检测）
 * 5. 中止/超时控制
 *
 * 交叉对抗性审查修正：
 * - SSE 解析器同时处理 content 和 tool_calls 增量
 * - wireApi 感知的请求体构建（Anthropic / OpenAI 字段名差异）
 * - tool_result 在 Anthropic 协议中作为 user role 消息发送
 * - 每个工具调用独立超时 + 全局 AbortController
 * - 重复调用检测防止模型陷入死循环
 */

import { useState, useRef, useCallback } from "react";
import type {
  ToolCall,
  ContentValue,
  MsgBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  WireApi,
  ToolDefinition,
  ToolAvailability,
} from "./toolTypes";
import {
  supportsToolUse,
  getProtocolAdapter,
  executeToolsInOrder,
  createLoopGuard,
  buildSystemPromptWithTools,
  type LoopGuard,
} from "./toolRegistry";

// ============================================================================
// 类型
// ============================================================================

export interface AgentLoopCallbacks {
  /** 每轮 API 请求前回调 */
  onTurnStart?: (turn: number) => void;
  /** 收到流式文本增量（实时渲染） */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** 解析到工具调用（模型决定调工具） */
  onToolCalls?: (calls: ToolCall[]) => void;
  /** 工具开始执行 */
  onToolStart?: (toolUseId: string, name: string, input: Record<string, unknown>) => void;
  /** 工具执行完成 */
  onToolResult?: (toolUseId: string, content: string, isError: boolean) => void;
  /** 一轮结束（有完整 assistant 消息，含 text + tool_use 块） */
  onAssistantMessage?: (blocks: MsgBlock[]) => void;
  /** 工具结果已加入消息列表（准备下一轮请求） */
  onToolResultBlocks?: (blocks: ToolResultBlock[]) => void;
  /** 错误 */
  onError?: (message: string) => void;
  /** 循环结束 */
  onDone?: (reason: "completed" | "aborted" | "error" | "max_turns") => void;
}

interface AgentLoopOptions {
  profile: {
    baseUrl: string;
    apiKey: string;
    model: string;
    wireApi?: WireApi;
    name?: string;
  };
  availableTools: ToolAvailability[];
  /** 初始消息列表（不含本轮 user 消息） */
  baseMessages: Array<{ role: string; content: ContentValue }>;
  /** 本轮用户输入 */
  userInput: string;
  callbacks: AgentLoopCallbacks;
  /** 单轮请求超时（ms），默认 60_000 */
  requestTimeout?: number;
  /** 单工具执行超时（ms），默认 20_000 */
  toolTimeout?: number;
  /** 最大循环轮数，默认 6 */
  maxTurns?: number;
}

// ============================================================================
// SSE 流解析器（wireApi 感知）
// ============================================================================

interface StreamAccumulator {
  text: string;
  toolCalls: ToolCall[];
  /** OpenAI: tool_calls 增量按 index 缓冲拼接 */
  openaiBuffers: Map<number, { id: string; name: string; argsBuffer: string }>;
  /** Anthropic: tool_use 块按 index 缓冲 input JSON 片段 */
  anthropicInputBuffers: Map<number, string>;
  /** Anthropic: tool_use 块按 index 记录 id/name */
  anthropicToolMeta: Map<number, { id: string; name: string }>;
}

function createStreamAccumulator(): StreamAccumulator {
  return {
    text: "",
    toolCalls: [],
    openaiBuffers: new Map(),
    anthropicInputBuffers: new Map(),
    anthropicToolMeta: new Map(),
  };
}

/**
 * 处理单条 SSE data JSON。
 * 适配两种协议的流式增量格式。
 */
function handleSSEData(
  data: string,
  wireApi: WireApi,
  acc: StreamAccumulator,
  callbacks: AgentLoopCallbacks
): void {
  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }

  if (wireApi === "anthropic-messages") {
    handleAnthropicDelta(parsed, acc, callbacks);
  } else if (wireApi === "openai-chat-completions") {
    handleOpenAIDelta(parsed, acc, callbacks);
  }
}

function handleAnthropicDelta(
  parsed: any,
  acc: StreamAccumulator,
  callbacks: AgentLoopCallbacks
): void {
  // Anthropic SSE: 每条是一个 event 对象 { type, ... }
  const type = parsed.type || parsed.event;
  if (!type) return;

  switch (type) {
    case "content_block_start": {
      const block = parsed.delta || parsed.content_block;
      const idx = parsed.index ?? acc.anthropicToolMeta.size;
      if (block?.type === "tool_use") {
        acc.anthropicToolMeta.set(idx, {
          id: block.id || "",
          name: block.name || "",
        });
        acc.anthropicInputBuffers.set(idx, "");
      }
      break;
    }
    case "content_block_delta": {
      const delta = parsed.delta;
      if (!delta) break;
      if (delta.type === "text_delta") {
        const chunk = delta.text || "";
        acc.text += chunk;
        callbacks.onTextDelta?.(chunk, acc.text);
      } else if (delta.type === "input_json_delta") {
        const idx = parsed.index ?? 0;
        const prev = acc.anthropicInputBuffers.get(idx) || "";
        acc.anthropicInputBuffers.set(idx, prev + (delta.partial_json || ""));
      }
      break;
    }
    case "content_block_stop": {
      const idx = parsed.index ?? 0;
      const meta = acc.anthropicToolMeta.get(idx);
      const rawInput = acc.anthropicInputBuffers.get(idx);
      if (meta) {
        let input: Record<string, unknown> = {};
        if (rawInput) {
          try {
            input = JSON.parse(rawInput);
          } catch {
            input = { _raw: rawInput };
          }
        }
        acc.toolCalls.push({
          id: meta.id,
          name: meta.name,
          input,
        });
      }
      break;
    }
    // message_start / message_delta / message_stop 忽略
  }
}

function handleOpenAIDelta(
  parsed: any,
  acc: StreamAccumulator,
  callbacks: AgentLoopCallbacks
): void {
  const choice = parsed.choices?.[0];
  if (!choice) return;
  const delta = choice.delta;
  if (!delta) return;

  if (delta.content) {
    acc.text += delta.content;
    callbacks.onTextDelta?.(delta.content, acc.text);
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!acc.openaiBuffers.has(idx)) {
        acc.openaiBuffers.set(idx, { id: "", name: "", argsBuffer: "" });
      }
      const buf = acc.openaiBuffers.get(idx)!;
      if (tc.id) buf.id = tc.id;
      if (tc.function?.name) buf.name = tc.function.name;
      if (tc.function?.arguments) {
        buf.argsBuffer += tc.function.arguments;
      }
    }
  }

  // 流结束信号：合并缓冲到 toolCalls
  if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
    // 按 index 排序合并
    const sortedIdx = Array.from(acc.openaiBuffers.keys()).sort((a, b) => a - b);
    for (const idx of sortedIdx) {
      const buf = acc.openaiBuffers.get(idx)!;
      let input: Record<string, unknown> = {};
      if (buf.argsBuffer) {
        try {
          input = JSON.parse(buf.argsBuffer);
        } catch {
          input = { _raw: buf.argsBuffer };
        }
      }
      acc.toolCalls.push({
        id: buf.id || `call_${idx}_${Date.now()}`,
        name: buf.name,
        input,
      });
    }
    acc.openaiBuffers.clear();
  }
}

// ============================================================================
// 单轮请求 + 流式解析
// ============================================================================

async function runOneTurn(
  opts: AgentLoopOptions,
  messages: Array<{ role: string; content: ContentValue }>,
  turn: number,
  signal: AbortSignal
): Promise<{ text: string; toolCalls: ToolCall[] } | null> {
  const { profile, availableTools, callbacks, requestTimeout } = opts;
  const wireApi = profile.wireApi!;
  const adapter = getProtocolAdapter(wireApi)!;

  // 工具定义（仅可用的）
  const enabledTools = availableTools
    .filter((t) => t.capability === "available")
    .map((t) => t.definition);

  // 构建请求体
  const apiBase = profile.baseUrl.replace(/\/+$/, "");
  const url = `${apiBase}/chat/completions`;

  const body: Record<string, unknown> = {
    model: profile.model,
    messages: adapter.formatMessages(messages),
    stream: true,
  };

  // 注入 system prompt（引导模型使用工具）
  const sysPrompt = buildSystemPromptWithTools(enabledTools);
  if (sysPrompt) {
    body.system = sysPrompt;
  }

  // tools 参数
  if (enabledTools.length > 0) {
    body.tools = enabledTools.map((t) => adapter.formatTool(t));
    body.tool_choice = "auto";
  }

  // 发起请求 — 通过 Tauri 后端代理绕过 CORS
  const { proxyStreamFetch } = await import("./chatProxy");

  return new Promise<{ text: string; toolCalls: ToolCall[] } | null>((resolve) => {
    let resolved = false;
    let cancel = () => {};
    const acc = createStreamAccumulator();
    let buffer = "";

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cancel();
        callbacks.onError?.("请求超时");
        resolve(null);
      }
    }, requestTimeout ?? 60_000);

    // proxyStreamFetch 返回 Promise<() => void>，需要 await
    proxyStreamFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${profile.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      (chunk, done, error) => {
        if (resolved) return;

        if (error) {
          resolved = true;
          clearTimeout(timeoutId);
          cancel();
          callbacks.onError?.(error);
          resolve(null);
          return;
        }

        if (chunk) {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;
            handleSSEData(data, wireApi, acc, callbacks);
          }
        }

        if (done) {
          // 处理残留 buffer
          if (buffer.startsWith("data: ")) {
            const data = buffer.slice(6);
            if (data !== "[DONE]") {
              handleSSEData(data, wireApi, acc, callbacks);
            }
          }
          resolved = true;
          clearTimeout(timeoutId);
          resolve({ text: acc.text, toolCalls: acc.toolCalls });
        }
      }
    ).then((c) => {
      cancel = c;
      // 外部 signal 中止
      if (signal.aborted) {
        resolved = true;
        clearTimeout(timeoutId);
        cancel();
        resolve(null);
      }
    });

    signal.addEventListener("abort", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        cancel();
        resolve(null);
      }
    });
  });
}

// ============================================================================
// Agent 循环 Hook
// ============================================================================

export function useAgentLoop() {
  const [isRunning, setIsRunning] = useState(false);
  const [currentTurn, setCurrentTurn] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async (opts: AgentLoopOptions): Promise<void> => {
    const {
      profile,
      availableTools,
      baseMessages,
      userInput,
      callbacks,
      toolTimeout = 20_000,
      maxTurns = 6,
    } = opts;

    // ----- 前置检查 -----
    const wireApi = profile.wireApi;
    if (!supportsToolUse(wireApi)) {
      callbacks.onError?.(
        `当前 Profile 的协议（${wireApi || "未设置"}）不支持工具调用。请在「设置 → AI 供应商」中将协议切换为 Anthropic Messages 或 OpenAI Chat Completions。`
      );
      callbacks.onDone?.("error");
      return;
    }

    const adapter = getProtocolAdapter(wireApi);
    if (!adapter) {
      callbacks.onError?.(`不支持的协议：${wireApi}`);
      callbacks.onDone?.("error");
      return;
    }

    const enabledTools = availableTools
      .filter((t) => t.capability === "available")
      .map((t) => t.definition);
    if (enabledTools.length === 0) {
      callbacks.onError?.("没有可用的工具。请检查设备能力或重新构建 APK。");
      callbacks.onDone?.("error");
      return;
    }

    // ----- 初始化循环 -----
    const guard = createLoopGuard();
    guard.reset();

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setIsRunning(true);
    setCurrentTurn(0);

    // 构建初始消息列表（含本轮 user 消息）
    const messages: Array<{ role: string; content: ContentValue }> = [
      ...baseMessages,
      { role: "user", content: userInput },
    ];

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (ctrl.signal.aborted) {
          callbacks.onDone?.("aborted");
          return;
        }

        setCurrentTurn(turn + 1);
        callbacks.onTurnStart?.(turn);

        // 1) 发起一轮请求
        const result = await runOneTurn(opts, messages, turn, ctrl.signal);
        if (!result) {
          // 错误或中止
          if (ctrl.signal.aborted) {
            callbacks.onDone?.("aborted");
          } else {
            callbacks.onDone?.("error");
          }
          return;
        }

        // 2) 构建 assistant 消息块
        const assistantBlocks: MsgBlock[] = [];
        if (result.text) {
          assistantBlocks.push({ type: "text", text: result.text } as TextBlock);
        }
        for (const tc of result.toolCalls) {
          assistantBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input,
          } as ToolUseBlock);
        }

        // 通知 UI 有完整 assistant 消息
        if (assistantBlocks.length > 0) {
          callbacks.onAssistantMessage?.(assistantBlocks);
        }

        // 3) 没有工具调用 → 循环结束
        if (result.toolCalls.length === 0) {
          callbacks.onDone?.("completed");
          return;
        }

        // 4) 有工具调用 → 执行
        callbacks.onToolCalls?.(result.toolCalls);

        // 循环防护：检测重复
        for (const tc of result.toolCalls) {
          if (guard.hasDuplicate(tc.name, tc.input)) {
            callbacks.onError?.(
              `检测到模型重复调用工具 "${tc.name}"（相同参数），已中止以防止死循环。`
            );
            callbacks.onDone?.("error");
            return;
          }
          guard.record(tc.name, tc.input);
        }

        // 把 assistant 消息加入列表（供下一轮请求）
        messages.push({ role: "assistant", content: assistantBlocks });

        // 5) 并发执行所有工具，按序回传
        const toolCallsWithIds = result.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
        }));

        // 通知每个工具开始
        for (const tc of toolCallsWithIds) {
          callbacks.onToolStart?.(tc.id, tc.name, tc.input);
        }

        // 工具执行总超时
        const toolCtrl = new AbortController();
        const toolTimeoutId = setTimeout(
          () => toolCtrl.abort(),
          toolTimeout * Math.max(1, toolCallsWithIds.length)
        );

        let toolResults: Array<{ tool_use_id: string; content: string; is_error: boolean }>;
        try {
          toolResults = await executeToolsInOrder(toolCallsWithIds, toolCtrl.signal);
        } catch (e: unknown) {
          clearTimeout(toolTimeoutId);
          callbacks.onError?.(`工具执行异常：${(e as Error).message}`);
          callbacks.onDone?.("error");
          return;
        }
        clearTimeout(toolTimeoutId);

        // 通知每个工具结果
        for (const tr of toolResults) {
          callbacks.onToolResult?.(tr.tool_use_id, tr.content, tr.is_error);
        }

        // 6) 构建 tool_result 块，作为 user 消息加入列表
        const toolResultBlocks: ToolResultBlock[] = toolResults.map((tr) => ({
          type: "tool_result",
          tool_use_id: tr.tool_use_id,
          content: tr.content,
          is_error: tr.is_error,
        }));

        callbacks.onToolResultBlocks?.(toolResultBlocks);
        messages.push({ role: "user", content: toolResultBlocks });

        // 继续下一轮
      }

      // 达到最大轮数
      callbacks.onError?.(`已达到最大循环轮数（${maxTurns}），可能模型无法完成任务。`);
      callbacks.onDone?.("max_turns");
    } finally {
      setIsRunning(false);
      setCurrentTurn(0);
      abortRef.current = null;
    }
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    isRunning,
    currentTurn,
    run,
    abort,
  };
}
